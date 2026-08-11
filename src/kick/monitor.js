import { tg } from '../telegram';

// ============================================================
// STAKICK MONITOR — PRODUCTION / PREMIUM
// ============================================================
//
// Design goals:
//
// 1. Drops API is the EARLIEST discovery source.
// 2. Never discard future campaigns just because starts_at
//    has not arrived.
// 3. Notify immediately when a relevant campaign is first seen.
// 4. Give pre-start alerts at 120 / 60 / 30 / 15 / 5 seconds.
// 5. Give an ACTIVE NOW alert.
// 6. Only notify campaigns that match tracked channels.
// 7. Stream monitoring only uses kick_channels WHERE active=1.
// 8. Fetch Drops API exactly once per execution.
// 9. Fetch tracked-channel DB rows exactly once per execution.
// 10. Prioritize live/relevant/owner channels.
// 11. Dynamic offline polling:
//       - 5 minutes normally
//       - 60 seconds when a drop may involve the channel
// 12. Abort channel and drops requests properly.
// 13. Deduplicate notifications through KV.
// 14. Preserve campaign firstSeen / lastSeen telemetry.
// 15. Tolerate campaigns disappearing after short-lived drops.
// 16. Strong HTML escaping.
// 17. Avoid one broken streamer breaking the entire scan.
// 18. Keep execution inside the Worker budget.
// 19. Compatible with 1-minute Cron today and sub-minute
//     invocation later without rewriting the monitor.
//
// ============================================================

// ------------------------------------------------------------
// PERFORMANCE
// ------------------------------------------------------------

const VIEWER_MILESTONES = [
  500,
  1000,
  2500,
  5000,
  10000,
  25000,
  50000,
  100000
];

const MAX_CONCURRENT = 5;
const MAX_CHANNELS_PER_RUN = 30;

const CHANNEL_FETCH_TIMEOUT_MS = 3500;
const DROP_FETCH_TIMEOUT_MS = 4000;

const WORKER_BUDGET_MS = 50000;

// Normal offline channels do NOT need constant polling.
// Relevant channels get checked much more aggressively.
const OFFLINE_SKIP_LONG_MS = 5 * 60 * 1000;
const OFFLINE_SKIP_SHORT_MS = 60 * 1000;

// If an API failure happens repeatedly, progressively back off.
const BACKOFF_THRESHOLD = 2;
const MAX_BACKOFF_MINUTES = 15;

// Pre-start warning ladder.
// The campaign itself is still detected immediately.
const DROP_PREALERT_SECONDS = [
  120,
  60,
  30,
  15,
  5
];

// State retention.
const DROP_STATE_TTL = 7 * 24 * 60 * 60;
const DROP_ALERT_TTL = 7 * 24 * 60 * 60;

// How long to retain a "campaign last seen" marker.
const DROP_LAST_SEEN_TTL = 7 * 24 * 60 * 60;

// By default, campaigns with NO explicit channels are not
// broadcast to every tracked chat because that creates noise.
// We still log/store them.
// Set env.ALERT_UNSCOPED_DROPS = "true" later if you want them.
const ALERT_UNSCOPED_DROPS = false;

// ------------------------------------------------------------
// GENERIC HELPERS
// ------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function safeDateMs(value) {
  if (!value) return null;

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeSlug(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeId(value) {
  if (value == null) return null;
  return String(value);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';

  if (seconds <= 0) {
    return 'now';
  }

  const total = Math.floor(seconds);

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }

  return `${secs}s`;
}

function unique(values) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    if (value == null) continue;

    const key = String(value);

    if (seen.has(key)) continue;

    seen.add(key);
    output.push(value);
  }

  return output;
}

// ============================================================
// CAMPAIGN TIME / STATE
// ============================================================

function getCampaignStartMs(campaign) {
  return safeDateMs(campaign?.starts_at);
}

function getCampaignEndMs(campaign) {
  return safeDateMs(campaign?.ends_at);
}

function isCampaignExpired(campaign, now = nowMs()) {
  const end = getCampaignEndMs(campaign);

  if (end && now >= end) {
    return true;
  }

  if (
    String(campaign?.status || '').toLowerCase() ===
    'expired'
  ) {
    return true;
  }

  return false;
}

function isCampaignActive(campaign, now = nowMs()) {
  if (isCampaignExpired(campaign, now)) {
    return false;
  }

  const start = getCampaignStartMs(campaign);

  if (start && now < start) {
    return false;
  }

  if (campaign?.is_active === false) {
    return false;
  }

  return true;
}

function getCampaignState(campaign, now = nowMs()) {
  if (isCampaignExpired(campaign, now)) {
    return 'expired';
  }

  const start = getCampaignStartMs(campaign);

  if (start && now < start) {
    return 'upcoming';
  }

  return 'active';
}

// ============================================================
// DROP API
// ============================================================

async function fetchCampaigns(env) {
  const url =
    'https://web.kick.com/api/v1/drops/campaigns';

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
    'Cache-Control': 'no-cache, no-store, max-age=0',
    Pragma: 'no-cache',

    ...(env.KICK_SESSION_TOKEN && {
      Authorization:
        `Bearer ${env.KICK_SESSION_TOKEN}`
    })
  };

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      DROP_FETCH_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      });

    if (!response.ok) {
      throw new Error(
        `Drops API HTTP ${response.status}`
      );
    }

    const payload =
      await response.json();

    /*
     * Supports the actual response you showed:
     *
     * {
     *   data: [...],
     *   message: "Success"
     * }
     *
     * Also supports alternate structures.
     */

    if (Array.isArray(payload)) {
      return payload.filter(Boolean);
    }

    if (Array.isArray(payload?.data)) {
      return payload.data.filter(Boolean);
    }

    if (Array.isArray(payload?.campaigns)) {
      return payload.campaigns.filter(Boolean);
    }

    return [];
  } catch (error) {
    console.error(
      'fetchCampaigns:',
      error?.name === 'AbortError'
        ? 'timeout'
        : error?.message || error
    );

    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// CAMPAIGN NORMALIZATION
// ============================================================

function getCampaignId(campaign) {
  return (
    campaign?.id ||
    campaign?.campaign_id ||
    null
  );
}

function getCampaignName(campaign) {
  return (
    campaign?.name ||
    campaign?.title ||
    'KICK Drop'
  );
}

function getCampaignUrl(
  campaign,
  fallbackSlug = null
) {
  return (
    campaign?.url ||
    (fallbackSlug
      ? `https://kick.com/${fallbackSlug}`
      : 'https://kick.com/drops')
  );
}

/*
 * Normalizes all channel representations we know about
 * into one simple structure:
 *
 * {
 *   id,
 *   userId,
 *   slug,
 *   username
 * }
 */
function getCampaignChannelKeys(campaign) {
  const result = [];
  const seen = new Set();

  function add(item) {
    if (!item) return;

    const id =
      item?.id != null
        ? normalizeId(item.id)
        : null;

    const userId =
      item?.user?.id != null
        ? normalizeId(item.user.id)
        : null;

    const slug =
      normalizeSlug(item?.slug);

    const username =
      normalizeSlug(item?.user?.username);

    const key = [
      id || '',
      userId || '',
      slug,
      username
    ].join('|');

    if (
      key === '|||'
    ) {
      return;
    }

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    result.push({
      id,
      userId,
      slug,
      username
    });
  }

  /*
   * Primary structure from your real API response:
   *
   * campaign.channels[]
   */
  if (Array.isArray(campaign?.channels)) {
    for (const channel of campaign.channels) {
      add(channel);
    }
  }

  /*
   * Legacy channel IDs.
   */
  if (Array.isArray(campaign?.channel_ids)) {
    for (const id of campaign.channel_ids) {
      add({
        id
      });
    }
  }

  /*
   * Legacy channel slugs.
   */
  if (Array.isArray(campaign?.channel_slugs)) {
    for (const slug of campaign.channel_slugs) {
      add({
        slug
      });
    }
  }

  /*
   * Alternate streamer / creator structure.
   */
  if (campaign?.streamer) {
    add({
      id: campaign.streamer.id,
      slug: campaign.streamer.slug,
      user: {
        id: campaign.streamer.user?.id,
        username:
          campaign.streamer.username ||
          campaign.streamer.user?.username
      }
    });
  }

  if (campaign?.creator) {
    add({
      id: campaign.creator.id,
      slug: campaign.creator.slug,
      user: {
        id: campaign.creator.user?.id,
        username:
          campaign.creator.username ||
          campaign.creator.user?.username
      }
    });
  }

  return result;
}

function getCampaignRewards(campaign) {
  if (
    Array.isArray(campaign?.rewards)
  ) {
    return campaign.rewards;
  }

  return [];
}

function getCampaignRewardText(campaign) {
  const rewards =
    getCampaignRewards(campaign);

  if (!rewards.length) {
    return 'Unknown';
  }

  return rewards
    .slice(0, 3)
    .map(reward => {
      const name =
        reward?.name ||
        'Reward';

      const units =
        reward?.required_units != null
          ? ` (${reward.required_units} units)`
          : '';

      return `${name}${units}`;
    })
    .join(' • ');
}

function getCampaignWatchText(campaign) {
  const rewards =
    getCampaignRewards(campaign);

  const requiredUnits =
    rewards
      .map(reward =>
        Number(reward?.required_units)
      )
      .filter(Number.isFinite);

  if (requiredUnits.length) {
    return `${Math.min(...requiredUnits)} required units`;
  }

  const watchSeconds =
    campaign?.watch_seconds ??
    (
      campaign?.watch_time_minutes != null
        ? Number(
            campaign.watch_time_minutes
          ) * 60
        : null
    );

  if (
    Number.isFinite(
      Number(watchSeconds)
    )
  ) {
    return `${Math.ceil(
      Number(watchSeconds) / 60
    )} min watch`;
  }

  return 'Watch to redeem';
}

// ============================================================
// TRACKED CHANNEL INDEX
// ============================================================

function buildTrackedChannelIndex(
  trackedChannels
) {
  const bySlug =
    new Map();

  const byId =
    new Map();

  const byUserId =
    new Map();

  for (const channel of trackedChannels) {
    const slug =
      normalizeSlug(channel.slug);

    const id =
      normalizeId(channel.id);

    const broadcasterUserId =
      normalizeId(
        channel.broadcaster_user_id
      );

    if (slug) {
      bySlug.set(slug, channel);
    }

    if (id) {
      byId.set(id, channel);
    }

    if (broadcasterUserId) {
      byUserId.set(
        broadcasterUserId,
        channel
      );
    }
  }

  return {
    bySlug,
    byId,
    byUserId
  };
}

function campaignMatchesTrackedChannel(
  campaign,
  channel
) {
  if (!channel) {
    return false;
  }

  const channelKeys =
    getCampaignChannelKeys(
      campaign
    );

  if (!channelKeys.length) {
    return false;
  }

  const trackedSlug =
    normalizeSlug(channel.slug);

  const trackedDbId =
    normalizeId(channel.id);

  const trackedBroadcasterId =
    normalizeId(
      channel.broadcaster_user_id
    );

  for (const candidate of channelKeys) {
    if (
      trackedSlug &&
      (
        candidate.slug === trackedSlug ||
        candidate.username === trackedSlug
      )
    ) {
      return true;
    }

    if (
      trackedDbId &&
      candidate.id === trackedDbId
    ) {
      return true;
    }

    if (
      trackedBroadcasterId &&
      (
        candidate.id === trackedBroadcasterId ||
        candidate.userId === trackedBroadcasterId
      )
    ) {
      return true;
    }
  }

  return false;
}

function getMatchedTrackedChannels(
  campaign,
  trackedChannels
) {
  if (
    !Array.isArray(
      trackedChannels
    ) ||
    !trackedChannels.length
  ) {
    return [];
  }

  return trackedChannels.filter(
    channel =>
      campaignMatchesTrackedChannel(
        campaign,
        channel
      )
  );
}

// ============================================================
// RELEVANT DROP SET
// ============================================================

function buildRelevantDropSet(
  campaigns
) {
  const set =
    new Set();

  for (const campaign of campaigns) {
    if (
      isCampaignExpired(
        campaign
      )
    ) {
      continue;
    }

    for (
      const candidate
      of getCampaignChannelKeys(
        campaign
      )
    ) {
      if (candidate.slug) {
        set.add(
          `slug:${candidate.slug}`
        );
      }

      if (candidate.username) {
        set.add(
          `slug:${candidate.username}`
        );
      }

      if (candidate.id) {
        set.add(
          `id:${candidate.id}`
        );
      }

      if (candidate.userId) {
        set.add(
          `user:${candidate.userId}`
        );
      }
    }
  }

  return set;
}

function channelIsDropRelevant(
  channel,
  relevantDropSet
) {
  const slug =
    normalizeSlug(channel.slug);

  const dbId =
    normalizeId(channel.id);

  const userId =
    normalizeId(
      channel.broadcaster_user_id
    );

  return (
    (slug &&
      relevantDropSet.has(
        `slug:${slug}`
      )) ||
    (dbId &&
      relevantDropSet.has(
        `id:${dbId}`
      )) ||
    (userId &&
      relevantDropSet.has(
        `user:${userId}`
      ))
  );
}

// ============================================================
// KV JSON STATE
// ============================================================

async function getJson(
  env,
  key
) {
  try {
    const value =
      await env.KV.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function putJson(
  env,
  key,
  value,
  ttl = DROP_STATE_TTL
) {
  await env.KV.put(
    key,
    JSON.stringify(value),
    {
      expirationTtl: ttl
    }
  );
}

async function hasAlert(
  env,
  campaignId,
  stage
) {
  return Boolean(
    await env.KV.get(
      `drop_alert:${campaignId}:${stage}`
    )
  );
}

async function markAlert(
  env,
  campaignId,
  stage
) {
  await env.KV.put(
    `drop_alert:${campaignId}:${stage}`,
    '1',
    {
      expirationTtl:
        DROP_ALERT_TTL
    }
  );
}

// ============================================================
// CAMPAIGN TARGET RESOLUTION
// ============================================================

function getNotificationTargets(
  matchedChannels
) {
  return unique(
    matchedChannels
      .map(
        channel =>
          channel.notify_chat_id
      )
      .filter(Boolean)
  );
}

// ============================================================
// DROP MESSAGE BUILDING
// ============================================================

function buildDropMessage({
  campaign,
  mode,
  remainingSeconds = null,
  matchedChannels = []
}) {
  const name =
    escapeHtml(
      getCampaignName(
        campaign
      )
    );

  const reward =
    escapeHtml(
      getCampaignRewardText(
        campaign
      )
    );

  const watch =
    escapeHtml(
      getCampaignWatchText(
        campaign
      )
    );

  let timing =
    '⚡ <b>API DETECTED</b>';

  if (mode === 'discovered') {
    if (
      Number.isFinite(
        remainingSeconds
      ) &&
      remainingSeconds > 0
    ) {
      timing =
        `⏳ Starts in <b>${escapeHtml(
          formatDuration(
            remainingSeconds
          )
        )}</b>`;
    } else {
      timing =
        '🔴 <b>ACTIVE NOW</b>';
    }
  }

  if (mode === 'prealert') {
    timing =
      `⏳ Starts in <b>${escapeHtml(
        formatDuration(
          remainingSeconds
        )
      )}</b>`;
  }

  if (mode === 'active') {
    timing =
      '🔴 <b>DROP LIVE NOW — JOIN NOW</b>';
  }

  let streamerText =
    '👤 Streamer: unknown';

  if (
    matchedChannels.length
  ) {
    const names =
      unique(
        matchedChannels.map(
          channel =>
            channel.name ||
            channel.slug
        )
      );

    streamerText =
      names.length === 1
        ? `👤 <b>${escapeHtml(
            names[0]
          )}</b>`
        : `👥 <b>${escapeHtml(
            names.join(', ')
          )}</b>`;
  }

  const urlSlug =
    matchedChannels.length === 1
      ? matchedChannels[0].slug
      : null;

  return (
    `🎁 <b>STA/KICK DROP</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📛 ${name}\n` +
    `${streamerText}\n` +
    `🎁 ${reward}\n` +
    `⏱ ${watch}\n` +
    `${timing}\n` +
    `🔗 ${escapeHtml(
      getCampaignUrl(
        campaign,
        urlSlug
      )
    )}`
  );
}

// ============================================================
// ALERT SENDER
// ============================================================

async function sendDropAlert({
  env,
  campaign,
  stage,
  mode,
  matchedChannels,
  remainingSeconds,
  stats
}) {
  const campaignId =
    getCampaignId(
      campaign
    );

  if (!campaignId) {
    return false;
  }

  if (
    await hasAlert(
      env,
      campaignId,
      stage
    )
  ) {
    return false;
  }

  const chatIds =
    getNotificationTargets(
      matchedChannels
    );

  if (!chatIds.length) {
    return false;
  }

  const message =
    buildDropMessage({
      campaign,
      mode,
      remainingSeconds,
      matchedChannels
    });

  let successful =
    0;

  /*
   * We normally have very few target chats.
   * Parallel sends reduce notification latency.
   */
  await Promise.all(
    chatIds.map(
      async chatId => {
        try {
          await tg.sendMessage(
            env.BOT_TOKEN,
            chatId,
            message,
            {
              parse_mode: 'HTML'
            }
          );

          successful++;
        } catch (error) {
          console.error(
            `drop alert failed ` +
            `(${campaignId}/${stage}) ` +
            `chat=${chatId}:`,
            error?.message ||
              error
          );
        }
      }
    )
  );

  if (!successful) {
    return false;
  }

  await markAlert(
    env,
    campaignId,
    stage
  );

  stats.drops++;
  stats.alerts++;

  return true;
}

// ============================================================
// CAMPAIGN ENGINE
// ============================================================

async function processCampaign({
  env,
  campaign,
  trackedChannels,
  stats
}) {
  const campaignId =
    getCampaignId(
      campaign
    );

  if (!campaignId) {
    return;
  }

  const now =
    nowMs();

  if (
    isCampaignExpired(
      campaign,
      now
    )
  ) {
    return;
  }

  const matchedChannels =
    getMatchedTrackedChannels(
      campaign,
      trackedChannels
    );

  /*
   * We intentionally store campaigns even if they currently
   * have no tracked-channel match.
   *
   * But we do NOT spam every tracked user by default.
   */
  const hasTrackedMatch =
    matchedChannels.length > 0;

  if (
    !hasTrackedMatch &&
    !ALERT_UNSCOPED_DROPS
  ) {
    /*
     * Still remember discovery so the campaign isn't repeatedly
     * treated as "new" if its association later changes.
     */
    const stateKey =
      `drop_state:${campaignId}`;

    const previous =
      await getJson(
        env,
        stateKey
      );

    if (!previous) {
      await putJson(
        env,
        stateKey,
        {
          campaignId,
          firstSeenAt:
            new Date(now)
              .toISOString(),
          firstSeenMs: now,
          lastSeenAt:
            new Date(now)
              .toISOString(),
          lastSeenMs: now,
          createdAt:
            campaign?.created_at ||
            null,
          startsAt:
            campaign?.starts_at ||
            null,
          endsAt:
            campaign?.ends_at ||
            null,
          name:
            getCampaignName(
              campaign
            ),
          matched: false
        }
      );
    } else {
      previous.lastSeenAt =
        new Date(now)
          .toISOString();

      previous.lastSeenMs =
        now;

      await putJson(
        env,
        stateKey,
        previous
      );
    }

    return;
  }

  const stateKey =
    `drop_state:${campaignId}`;

  const previous =
    await getJson(
      env,
      stateKey
    );

  const firstSeen =
    !previous;

  if (!previous) {
    await putJson(
      env,
      stateKey,
      {
        campaignId,
        firstSeenAt:
          new Date(now)
            .toISOString(),
        firstSeenMs: now,
        lastSeenAt:
          new Date(now)
            .toISOString(),
        lastSeenMs: now,
        createdAt:
          campaign?.created_at ||
          null,
        startsAt:
          campaign?.starts_at ||
          null,
        endsAt:
          campaign?.ends_at ||
          null,
        name:
          getCampaignName(
            campaign
          ),
        matched: true,
        matchedChannels:
          matchedChannels.map(
            channel =>
              channel.slug
          )
      },
      DROP_STATE_TTL
    );
  } else {
    previous.lastSeenAt =
      new Date(now)
        .toISOString();

    previous.lastSeenMs =
      now;

    previous.matched =
      true;

    previous.matchedChannels =
      matchedChannels.map(
        channel =>
          channel.slug
      );

    await putJson(
      env,
      stateKey,
      previous,
      DROP_STATE_TTL
    );
  }

  const start =
    getCampaignStartMs(
      campaign
    );

  const state =
    getCampaignState(
      campaign,
      now
    );

  /*
   * ----------------------------------------------------------
   * FIRST API SIGHTING
   * ----------------------------------------------------------
   *
   * This is the critical signal for your early-warning system.
   */
  if (firstSeen) {
    const remainingSeconds =
      start
        ? Math.max(
            0,
            (start - now) / 1000
          )
        : null;

    /*
     * If the campaign is already active, do not send both
     * "detected" and "active" notifications.
     */
    if (state === 'active') {
      await sendDropAlert({
        env,
        campaign,
        stage: 'active',
        mode: 'active',
        matchedChannels,
        remainingSeconds,
        stats
      });
    } else {
      await sendDropAlert({
        env,
        campaign,
        stage: 'discovered',
        mode: 'discovered',
        matchedChannels,
        remainingSeconds,
        stats
      });
    }

    /*
     * Record actual API lead time when starts_at exists.
     */
    if (start) {
      const leadSeconds =
        (start - now) /
        1000;

      console.log(
        `[DROP DISCOVERY] ` +
        `${campaignId} ` +
        `"${getCampaignName(
          campaign
        )}" ` +
        `state=${state} ` +
        `apiLead=${formatDuration(
          leadSeconds
        )} ` +
        `starts=${new Date(
          start
        ).toISOString()}`
      );

      await putJson(
        env,
        `${stateKey}:telemetry`,
        {
          firstSeenAt:
            new Date(now)
              .toISOString(),
          startsAt:
            campaign.starts_at ||
            null,
          leadSeconds
        },
        DROP_STATE_TTL
      );
    } else {
      console.log(
        `[DROP DISCOVERY] ` +
        `${campaignId} ` +
        `"${getCampaignName(
          campaign
        )}" ` +
        `starts_at=unavailable`
      );
    }
  }

  /*
   * ----------------------------------------------------------
   * PRE-START ALERTS
   * ----------------------------------------------------------
   */

  if (
    start &&
    now < start
  ) {
    const remainingSeconds =
      (start - now) /
      1000;

    for (
      const threshold
      of DROP_PREALERT_SECONDS
    ) {
      if (
        remainingSeconds <=
        threshold
      ) {
        await sendDropAlert({
          env,
          campaign,
          stage:
            `pre_${threshold}`,
          mode: 'prealert',
          matchedChannels,
          remainingSeconds,
          stats
        });
      }
    }

    return;
  }

  /*
   * ----------------------------------------------------------
   * ACTIVE
   * ----------------------------------------------------------
   */

  if (
    isCampaignActive(
      campaign,
      now
    )
  ) {
    await sendDropAlert({
      env,
      campaign,
      stage: 'active',
      mode: 'active',
      matchedChannels,
      stats
    });
  }
}

// ============================================================
// DROP SCAN
// ============================================================

async function checkGlobalDrops({
  env,
  campaigns,
  trackedChannels,
  stats
}) {
  if (!campaigns.length) {
    return;
  }

  /*
   * Important:
   *
   * We process EVERYTHING returned by the API.
   *
   * We do NOT filter only active campaigns.
   *
   * This is what preserves the possibility of getting
   * seconds/minutes/hours of warning before starts_at.
   */
  for (
    const campaign
    of campaigns
  ) {
    try {
      await processCampaign({
        env,
        campaign,
        trackedChannels,
        stats
      });
    } catch (error) {
      stats.errors++;

      console.error(
        'processCampaign failed:',
        error?.message ||
          error
      );
    }
  }
}

// ============================================================
// ACTIVE STREAM DROP CONFIRMATION
// ============================================================

async function detectChannelDrop({
  env,
  channel,
  livestream,
  campaigns,
  stats
}) {
  if (!livestream) {
    return false;
  }

  for (
    const campaign
    of campaigns
  ) {
    if (
      !campaignMatchesTrackedChannel(
        campaign,
        channel
      )
    ) {
      continue;
    }

    const campaignId =
      getCampaignId(
        campaign
      );

    if (!campaignId) {
      continue;
    }

    const now =
      nowMs();

    if (
      !isCampaignActive(
        campaign,
        now
      )
    ) {
      continue;
    }

    const stage =
      `channel_active:${normalizeSlug(
        channel.slug
      )}`;

    if (
      await hasAlert(
        env,
        campaignId,
        stage
      )
    ) {
      continue;
    }

    const message =
      buildDropMessage({
        campaign,
        mode: 'active',
        matchedChannels: [
          channel
        ]
      });

    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        message,
        {
          parse_mode: 'HTML'
        }
      );

      await markAlert(
        env,
        campaignId,
        stage
      );

      stats.drops++;
      stats.alerts++;

      return true;
    } catch (error) {
      console.error(
        `channel drop alert failed ` +
        `(${channel.slug}):`,
        error?.message ||
          error
      );

      return false;
    }
  }

  return false;
}

// ============================================================
// CHANNEL API
// ============================================================

async function fetchChannelInfo(
  slug,
  env,
  signal
) {
  const url =
    `https://kick.com/api/v2/channels/${encodeURIComponent(
      slug
    )}`;

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',

    ...(env.KICK_SESSION_TOKEN && {
      Authorization:
        `Bearer ${env.KICK_SESSION_TOKEN}`
    })
  };

  const response =
    await fetch(
      url,
      {
        method: 'GET',
        headers,
        signal,
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Channel API HTTP ${response.status}`
    );
  }

  return response.json();
}

async function fetchChannelWithTimeout(
  slug,
  env
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      CHANNEL_FETCH_TIMEOUT_MS
    );

  try {
    return await fetchChannelInfo(
      slug,
      env,
      controller.signal
    );
  } catch (error) {
    if (
      error?.name ===
      'AbortError'
    ) {
      throw new Error(
        `channel fetch timeout after ${CHANNEL_FETCH_TIMEOUT_MS}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// FAILURE / BACKOFF
// ============================================================

async function markFail(
  env,
  channel
) {
  const failCount =
    Number(
      channel.fail_count || 0
    ) + 1;

  await env.DB.prepare(
    `UPDATE kick_channels
     SET fail_count = ?,
         last_checked = ?
     WHERE id = ?`
  )
    .bind(
      failCount,
      nowMs(),
      channel.id
    )
    .run();
}

function shouldSkipChannel({
  channel,
  now,
  relevantDropSet
}) {
  /*
   * Never use normal "offline skip" to hide a repeatedly failing
   * channel; failure backoff handles that separately.
   */
  if (
    channel.fail_count >=
      BACKOFF_THRESHOLD &&
    channel.last_checked
  ) {
    const backoffMinutes =
      Math.min(
        Math.pow(
          2,
          channel.fail_count -
            BACKOFF_THRESHOLD
        ),
        MAX_BACKOFF_MINUTES
      );

    if (
      now -
        channel.last_checked <
      backoffMinutes *
        60 *
        1000
    ) {
      return true;
    }
  }

  /*
   * Live channels should be checked every run.
   */
  if (
    channel.last_is_live
  ) {
    return false;
  }

  /*
   * Offline channel:
   *
   * 60 seconds if relevant to a campaign.
   * 5 minutes otherwise.
   */
  if (
    channel.last_checked
  ) {
    const relevant =
      channelIsDropRelevant(
        channel,
        relevantDropSet
      );

    const interval =
      relevant
        ? OFFLINE_SKIP_SHORT_MS
        : OFFLINE_SKIP_LONG_MS;

    if (
      now -
        channel.last_checked <
      interval
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// CHANNEL PRIORITY
// ============================================================

function channelPriority({
  channel,
  relevantDropSet,
  ownerSlug
}) {
  let score = 0;

  const slug =
    normalizeSlug(
      channel.slug
    );

  /*
   * Upcoming / active drop channel.
   */
  if (
    channelIsDropRelevant(
      channel,
      relevantDropSet
    )
  ) {
    score += 1000;
  }

  /*
   * Currently live.
   */
  if (
    channel.last_is_live
  ) {
    score += 500;
  }

  /*
   * Owner.
   */
  if (
    ownerSlug &&
    slug ===
      normalizeSlug(ownerSlug)
  ) {
    score += 250;
  }

  /*
   * Older last_checked => more priority.
   */
  if (
    channel.last_checked
  ) {
    const ageMinutes =
      Math.min(
        120,
        Math.max(
          0,
          (
            nowMs() -
            channel.last_checked
          ) /
            60000
        )
      );

    score += ageMinutes;
  } else {
    score += 150;
  }

  return score;
}

// ============================================================
// STREAM STATE
// ============================================================

async function processStateChange({
  env,
  channel,
  isLive,
  livestream,
  campaigns,
  stats
}) {
  const now =
    nowMs();

  const title =
    livestream?.session_title ||
    '';

  const category =
    livestream?.categories?.[0]
      ?.name ||
    '';

  const viewers =
    Number(
      livestream?.viewer_count ||
      0
    );

  const displayName =
    channel.name ||
    channel.slug;

  // ----------------------------------------------------------
  // GOING LIVE
  // ----------------------------------------------------------

  if (
    isLive &&
    !channel.last_is_live
  ) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        `🔴 <b>${escapeHtml(
          displayName
        )} LIVE!</b>\n` +
        `📺 ${escapeHtml(
          title
        )}\n` +
        `👁 ${viewers.toLocaleString()}\n` +
        `👉 https://kick.com/${escapeHtml(
          channel.slug
        )}`,
        {
          parse_mode:
            'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `live alert failed ` +
        `(${channel.slug}):`,
        error?.message ||
          error
      );
    }

    await detectChannelDrop({
      env,
      channel,
      livestream,
      campaigns,
      stats
    });

    await env.DB.prepare(
      `UPDATE kick_channels
       SET last_is_live = 1,
           last_title = ?,
           last_viewer_count = ?,
           last_category = ?,
           last_checked = ?
       WHERE id = ?`
    )
      .bind(
        title,
        viewers,
        category,
        now,
        channel.id
      )
      .run();

    stats.live++;

    return;
  }

  // ----------------------------------------------------------
  // GOING OFFLINE
  // ----------------------------------------------------------

  if (
    !isLive &&
    channel.last_is_live
  ) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        `⚫ <b>${escapeHtml(
          displayName
        )}</b> offline.`,
        {
          parse_mode:
            'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `offline alert failed ` +
        `(${channel.slug}):`,
        error?.message ||
          error
      );
    }

    await env.DB.prepare(
      `UPDATE kick_channels
       SET last_is_live = 0,
           last_viewer_count = 0,
           last_checked = ?
       WHERE id = ?`
    )
      .bind(
        now,
        channel.id
      )
      .run();

    for (
      const milestone
      of VIEWER_MILESTONES
    ) {
      await env.KV.delete(
        `milestone:${channel.slug}:${milestone}`
      );
    }

    stats.offline++;

    return;
  }

  // ----------------------------------------------------------
  // STAYING LIVE
  // ----------------------------------------------------------

  if (
    isLive &&
    channel.last_is_live
  ) {
    // Title change
    if (
      title &&
      title !==
        channel.last_title
    ) {
      try {
        await tg.sendMessage(
          env.BOT_TOKEN,
          channel.notify_chat_id,
          `📝 <b>${escapeHtml(
            displayName
          )}</b> title changed:\n` +
          `<i>${escapeHtml(
            title
          )}</i>`,
          {
            parse_mode:
              'HTML'
          }
        );

        stats.alerts++;
      } catch (error) {
        console.error(
          `title alert failed ` +
          `(${channel.slug}):`,
          error?.message ||
            error
        );
      }
    }

    // Category change
    if (
      category &&
      category !==
        channel.last_category
    ) {
      try {
        await tg.sendMessage(
          env.BOT_TOKEN,
          channel.notify_chat_id,
          `🏷 <b>${escapeHtml(
            displayName
          )}</b> → ${escapeHtml(
            category
          )}`,
          {
            parse_mode:
              'HTML'
          }
        );

        stats.alerts++;
      } catch (error) {
        console.error(
          `category alert failed ` +
          `(${channel.slug}):`,
          error?.message ||
            error
        );
      }
    }

    // Viewer milestones
    const previousViewers =
      Number(
        channel.last_viewer_count ||
        0
      );

    if (
      viewers >
      previousViewers
    ) {
      for (
        const milestone
        of VIEWER_MILESTONES
      ) {
        if (
          viewers >= milestone &&
          previousViewers <
            milestone
        ) {
          const key =
            `milestone:${channel.slug}:${milestone}`;

          if (
            await env.KV.get(
              key
            )
          ) {
            continue;
          }

          try {
            await tg.sendMessage(
              env.BOT_TOKEN,
              channel.notify_chat_id,
              `🎉 <b>${escapeHtml(
                displayName
              )}</b> hit ${milestone.toLocaleString()} viewers!`,
              {
                parse_mode:
                  'HTML'
              }
            );

            await env.KV.put(
              key,
              '1',
              {
                expirationTtl:
                  21600
              }
            );

            stats.alerts++;
          } catch (error) {
            console.error(
              `milestone alert failed ` +
              `(${channel.slug}):`,
              error?.message ||
                error
            );
          }
        }
      }
    }

    /*
     * CRITICAL:
     *
     * Drop detection also happens during an existing stream.
     * This catches drops that begin 10, 30, 60 minutes after
     * the streamer went live.
     */
    await detectChannelDrop({
      env,
      channel,
      livestream,
      campaigns,
      stats
    });

    await env.DB.prepare(
      `UPDATE kick_channels
       SET last_title = ?,
           last_viewer_count = ?,
           last_category = ?,
           last_checked = ?
       WHERE id = ?`
    )
      .bind(
        title,
        viewers,
        category,
        now,
        channel.id
      )
      .run();

    stats.live++;

    return;
  }

  // ----------------------------------------------------------
  // OFFLINE & WAS OFFLINE
  // ----------------------------------------------------------

  await env.DB.prepare(
    `UPDATE kick_channels
     SET last_checked = ?
     WHERE id = ?`
  )
    .bind(
      now,
      channel.id
    )
    .run();

  stats.offline++;
}

// ============================================================
// SINGLE CHANNEL CHECK
// ============================================================

async function checkSingleChannel({
  env,
  channel,
  campaigns,
  relevantDropSet,
  runId,
  stats
}) {
  const now =
    nowMs();

  if (
    shouldSkipChannel({
      channel,
      now,
      relevantDropSet
    })
  ) {
    stats.skipped++;
    return;
  }

  try {
    const info =
      await fetchChannelWithTimeout(
        channel.slug,
        env
      );

    if (!info) {
      await markFail(
        env,
        channel
      );

      stats.errors++;
      return;
    }

    /*
     * Successful request clears failure state.
     */
    if (
      Number(
        channel.fail_count ||
        0
      ) > 0
    ) {
      await env.DB.prepare(
        `UPDATE kick_channels
         SET fail_count = 0
         WHERE id = ?`
      )
        .bind(
          channel.id
        )
        .run();
    }

    const livestream =
      info?.livestream ||
      null;

    const isLive =
      Boolean(
        livestream
      );

    stats.checked++;

    await processStateChange({
      env,
      channel,
      isLive,
      livestream,
      campaigns,
      stats
    });
  } catch (error) {
    await markFail(
      env,
      channel
    );

    stats.errors++;

    console.error(
      `[${runId}] ` +
      `${channel.slug}:`,
      error?.message ||
        error
    );
  }
}

// ============================================================
// STREAM SCANNER
// ============================================================

async function checkStreams({
  env,
  campaigns,
  trackedChannels,
  runId,
  stats,
  runStart
}) {
  if (
    !trackedChannels.length
  ) {
    return;
  }

  const relevantDropSet =
    buildRelevantDropSet(
      campaigns
    );

  const ownerSlug =
    env.OWNER_KICK_SLUG ||
    '';

  /*
   * Sort in memory so relevant channels are checked FIRST.
   *
   * Priority:
   *   1. Campaign-related
   *   2. Live
   *   3. Owner
   *   4. Oldest last_checked
   */
  const sorted =
    [...trackedChannels]
      .sort(
        (a, b) =>
          channelPriority({
            channel: b,
            relevantDropSet,
            ownerSlug
          }) -
          channelPriority({
            channel: a,
            relevantDropSet,
            ownerSlug
          })
      );

  const toCheck =
    sorted.slice(
      0,
      MAX_CHANNELS_PER_RUN
    );

  for (
    let i = 0;
    i < toCheck.length;
    i += MAX_CONCURRENT
  ) {
    if (
      nowMs() - runStart >=
      WORKER_BUDGET_MS
    ) {
      stats.skipped +=
        Math.max(
          0,
          toCheck.length - i
        );

      break;
    }

    const batch =
      toCheck.slice(
        i,
        i + MAX_CONCURRENT
      );

    await Promise.all(
      batch.map(
        channel =>
          checkSingleChannel({
            env,
            channel,
            campaigns,
            relevantDropSet,
            runId,
            stats
          })
      )
    );
  }
}

// ============================================================
// MAIN MONITOR
// ============================================================

export async function runMonitor({
  env,
  executionCtx
}) {
  const runId =
    crypto.randomUUID()
      .slice(0, 8);

  const runStart =
    nowMs();

  const stats = {
    campaigns: 0,
    checked: 0,
    live: 0,
    offline: 0,
    alerts: 0,
    drops: 0,
    errors: 0,
    skipped: 0
  };

  try {
    /*
     * --------------------------------------------------------
     * 1. Load tracked channels ONCE.
     * --------------------------------------------------------
     *
     * This is the authoritative streamer list.
     * Nothing here monitors random Kick streamers.
     */
    const rows =
      await env.DB.prepare(
        `SELECT *
         FROM kick_channels
         WHERE active = 1`
      ).all();

    const trackedChannels =
      rows.results || [];

    /*
     * --------------------------------------------------------
     * 2. Fetch Drops API ONCE.
     * --------------------------------------------------------
     */
    const campaigns =
      await fetchCampaigns(
        env
      );

    /*
     * If the API request failed, do not interpret an empty
     * response as "there are no campaigns".
     *
     * Still perform stream monitoring.
     */
    if (campaigns === null) {
      stats.errors++;

      console.error(
        `[${runId}] Drops API unavailable`
      );

      await checkStreams({
        env,
        campaigns: [],
        trackedChannels,
        runId,
        stats,
        runStart
      });
    } else {
      stats.campaigns =
        campaigns.length;

      /*
       * ------------------------------------------------------
       * 3. Campaign engine FIRST.
       * ------------------------------------------------------
       *
       * This gives drops maximum priority.
       */
      await checkGlobalDrops({
        env,
        campaigns,
        trackedChannels,
        stats
      });

      /*
       * ------------------------------------------------------
       * 4. Stream engine.
       * ------------------------------------------------------
       */
      await checkStreams({
        env,
        campaigns,
        trackedChannels,
        runId,
        stats,
        runStart
      });
    }
  } catch (error) {
    stats.errors++;

    console.error(
      `[${runId}] monitor fatal error:`,
      error?.message ||
        error
    );
  }

  const duration =
    nowMs() -
    runStart;

  console.log(
    `[${runId}] done ` +
    `${duration}ms ` +
    `campaigns=${stats.campaigns} ` +
    `checked=${stats.checked} ` +
    `live=${stats.live} ` +
    `offline=${stats.offline} ` +
    `alerts=${stats.alerts} ` +
    `drops=${stats.drops} ` +
    `errors=${stats.errors} ` +
    `skipped=${stats.skipped}`
  );

  return stats;
}
