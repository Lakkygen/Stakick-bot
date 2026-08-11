import { tg } from '../telegram';
import { fetchChannelInfo } from './api';

// ============================================================
// STAKICK PREMIUM MONITOR
// ============================================================
//
// Goals:
// 1. Detect any campaign the Kick drops API exposes.
// 2. DO NOT discard future campaigns.
// 3. Alert immediately on first API sighting.
// 4. Alert again at 60s and 15s before starts_at.
// 5. Alert again when the drop becomes active.
// 6. Handle short-lived Stake drops that may disappear quickly.
// 7. Fetch the drops inventory ONCE per monitor run.
// 8. Match campaign.channels[] from the actual API structure.
// 9. Deduplicate notifications with KV.
// 10. Continue normal stream monitoring.
// 11. Work with 1-minute Cron OR ~15-20s Durable Object alarms.
//
// ============================================================

// ----------------------------
// Performance / tuning
// ----------------------------

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

const API_TIMEOUT_MS = 4000;
const DROP_FETCH_TIMEOUT_MS = 4000;

const CRON_BUDGET_MS = 50000;

// Offline streamers do not need aggressive polling because
// global drop discovery is handled separately.
const OFFLINE_SKIP_MS = 60000;

const BACKOFF_THRESHOLD = 2;
const MAX_BACKOFF_MINUTES = 15;

// Upcoming-drop notifications.
// Initial discovery is immediate.
// These are additional pre-start alerts.
const DROP_PREALERT_SECONDS = [60, 15];

const DROP_STATE_TTL = 7 * 24 * 60 * 60;
const DROP_ALERT_TTL = 7 * 24 * 60 * 60;

// ============================================================
// GENERIC HELPERS
// ============================================================

function nowMs() {
  return Date.now();
}

function safeDateMs(value) {
  if (!value) return null;

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';

  if (seconds <= 0) return 'now';

  const s = Math.floor(seconds);

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;

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

function campaignStartMs(campaign) {
  return safeDateMs(campaign?.starts_at);
}

function campaignEndMs(campaign) {
  return safeDateMs(campaign?.ends_at);
}

function isCampaignExpired(campaign, now = nowMs()) {
  const end = campaignEndMs(campaign);

  if (end && now >= end) {
    return true;
  }

  if (String(campaign?.status || '').toLowerCase() === 'expired') {
    return true;
  }

  return false;
}

function isCampaignActive(campaign, now = nowMs()) {
  if (isCampaignExpired(campaign, now)) {
    return false;
  }

  const start = campaignStartMs(campaign);

  if (start && now < start) {
    return false;
  }

  if (campaign?.is_active === false) {
    return false;
  }

  return true;
}

function campaignState(campaign, now = nowMs()) {
  if (isCampaignExpired(campaign, now)) {
    return 'expired';
  }

  const start = campaignStartMs(campaign);

  if (start && now < start) {
    return 'upcoming';
  }

  return 'active';
}

// ============================================================
// DROP API
// ============================================================

async function fetchCampaigns(env) {
  const baseUrl = 'https://web.kick.com/api/v1/drops/campaigns';

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
    'Cache-Control': 'no-cache, no-store, max-age=0',
    Pragma: 'no-cache',

    ...(env.KICK_SESSION_TOKEN && {
      Authorization: `Bearer ${env.KICK_SESSION_TOKEN}`
    })
  };

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    DROP_FETCH_TIMEOUT_MS
  );

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    });

    if (!response.ok) {
      throw new Error(`Drops API HTTP ${response.status}`);
    }

    const payload = await response.json();

    /*
     * Your real response was:
     *
     * {
     *   "data": [...],
     *   "message": "Success"
     * }
     *
     * But we also support:
     *
     * {
     *   "campaigns": [...]
     * }
     */

    let campaigns = [];

    if (Array.isArray(payload)) {
      campaigns = payload;
    } else if (Array.isArray(payload?.data)) {
      campaigns = payload.data;
    } else if (Array.isArray(payload?.campaigns)) {
      campaigns = payload.campaigns;
    }

    return campaigns.filter(Boolean);
  } catch (error) {
    console.error(
      'fetchCampaigns error:',
      error?.name === 'AbortError'
        ? 'timeout'
        : error?.message || error
    );

    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// CAMPAIGN IDENTIFIERS / CHANNELS
// ============================================================

function getCampaignId(campaign) {
  return campaign?.id || campaign?.campaign_id || null;
}

function getCampaignName(campaign) {
  return (
    campaign?.name ||
    campaign?.title ||
    'KICK Drop'
  );
}

function getCampaignUrl(campaign, fallbackSlug = null) {
  return (
    campaign?.url ||
    (fallbackSlug
      ? `https://kick.com/${fallbackSlug}`
      : 'https://kick.com/drops')
  );
}

function getCampaignChannels(campaign) {
  if (!Array.isArray(campaign?.channels)) {
    return [];
  }

  return campaign.channels;
}

function getCampaignChannelSlugs(campaign) {
  return getCampaignChannels(campaign)
    .map(channel => String(channel?.slug || '').toLowerCase())
    .filter(Boolean);
}

function getCampaignRewards(campaign) {
  if (Array.isArray(campaign?.rewards)) {
    return campaign.rewards;
  }

  return [];
}

function getCampaignRewardText(campaign) {
  const rewards = getCampaignRewards(campaign);

  if (!rewards.length) {
    return 'Unknown';
  }

  return rewards
    .slice(0, 3)
    .map(reward => {
      const name = reward?.name || 'Reward';
      const units =
        reward?.required_units != null
          ? ` (${reward.required_units} units)`
          : '';

      return `${name}${units}`;
    })
    .join(' • ');
}

function getCampaignWatchText(campaign) {
  const rewards = getCampaignRewards(campaign);

  if (rewards.length) {
    const units = rewards
      .map(r => r?.required_units)
      .filter(v => Number.isFinite(Number(v)));

    if (units.length) {
      return `${Math.min(...units)} required units`;
    }
  }

  const seconds =
    campaign?.watch_seconds ??
    (campaign?.watch_time_minutes
      ? Number(campaign.watch_time_minutes) * 60
      : null);

  if (Number.isFinite(Number(seconds))) {
    return `${Math.ceil(Number(seconds) / 60)} min watch`;
  }

  return 'Watch to redeem';
}

// ============================================================
// CAMPAIGN ↔ CHANNEL MATCHING
// ============================================================

function campaignInvolvesChannel(campaign, channel) {
  if (!campaign || !channel) {
    return false;
  }

  const slug = String(channel.slug || '').toLowerCase();

  const channelId = channel.broadcaster_user_id != null
    ? String(channel.broadcaster_user_id)
    : null;

  if (!slug && !channelId) {
    return false;
  }

  const campaignChannels = getCampaignChannels(campaign);

  for (const candidate of campaignChannels) {
    const candidateSlug =
      String(candidate?.slug || '').toLowerCase();

    const candidateId =
      candidate?.id != null
        ? String(candidate.id)
        : null;

    const candidateUserId =
      candidate?.user?.id != null
        ? String(candidate.user.id)
        : null;

    const candidateUsername =
      String(candidate?.user?.username || '').toLowerCase();

    if (slug && candidateSlug === slug) {
      return true;
    }

    if (
      channelId &&
      candidateId &&
      channelId === candidateId
    ) {
      return true;
    }

    if (
      channelId &&
      candidateUserId &&
      channelId === candidateUserId
    ) {
      return true;
    }

    if (
      slug &&
      candidateUsername === slug
    ) {
      return true;
    }
  }

  // Compatibility with alternate response formats.
  if (
    channelId &&
    Array.isArray(campaign.channel_ids) &&
    campaign.channel_ids.some(
      id => String(id) === channelId
    )
  ) {
    return true;
  }

  if (
    slug &&
    Array.isArray(campaign.channel_slugs) &&
    campaign.channel_slugs.some(
      value => String(value).toLowerCase() === slug
    )
  ) {
    return true;
  }

  const streamer =
    campaign?.streamer?.username ||
    campaign?.creator?.username ||
    '';

  if (
    slug &&
    String(streamer).toLowerCase() === slug
  ) {
    return true;
  }

  return false;
}

// ============================================================
// CAMPAIGN TARGET RESOLUTION
// ============================================================

async function getNotificationTargets(env, campaign) {
  const rows = await env.DB.prepare(
    `SELECT
       id,
       slug,
       name,
       broadcaster_user_id,
       notify_chat_id,
       active,
       last_is_live
     FROM kick_channels
     WHERE active = 1`
  ).all();

  const tracked = rows.results || [];

  if (!tracked.length) {
    return [];
  }

  const campaignChannels = getCampaignChannels(campaign);

  /*
   * If Kick gives explicit channels, notify only chats tracking
   * those channels.
   */
  if (campaignChannels.length) {
    const matched = tracked.filter(channel =>
      campaignInvolvesChannel(campaign, channel)
    );

    return uniqueChatIds(
      matched.map(channel => channel.notify_chat_id)
    );
  }

  /*
   * Generic campaign without explicit channels:
   * notify all active notification targets.
   */
  return uniqueChatIds(
    tracked.map(channel => channel.notify_chat_id)
  );
}

function uniqueChatIds(values) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    if (value == null) continue;

    const normalized = String(value);

    if (seen.has(normalized)) continue;

    seen.add(normalized);
    output.push(value);
  }

  return output;
}

// ============================================================
// KV STATE
// ============================================================

async function getJson(env, key) {
  try {
    const value = await env.KV.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function putJson(env, key, value, ttl = DROP_STATE_TTL) {
  await env.KV.put(
    key,
    JSON.stringify(value),
    { expirationTtl: ttl }
  );
}

async function hasAlert(env, campaignId, stage) {
  return Boolean(
    await env.KV.get(
      `drop_alert:${campaignId}:${stage}`
    )
  );
}

async function markAlert(env, campaignId, stage) {
  await env.KV.put(
    `drop_alert:${campaignId}:${stage}`,
    '1',
    { expirationTtl: DROP_ALERT_TTL }
  );
}

// ============================================================
// DROP MESSAGE FORMATTERS
// ============================================================

function buildDropMessage(
  campaign,
  mode,
  remainingSeconds = null,
  trackedSlug = null
) {
  const name = escapeHtml(getCampaignName(campaign));
  const reward = escapeHtml(getCampaignRewardText(campaign));
  const watch = escapeHtml(getCampaignWatchText(campaign));

  const channels = getCampaignChannels(campaign);

  const channelText = trackedSlug
    ? `👤 <b>${escapeHtml(trackedSlug)}</b>`
    : channels.length
      ? `👥 ${channels.length} channel${channels.length === 1 ? '' : 's'}`
      : '👥 Channel not specified';

  const start = campaignStartMs(campaign);

  let timing = '';

  if (mode === 'discovered') {
    if (start && remainingSeconds != null && remainingSeconds > 0) {
      timing =
        `⏳ Starts in <b>${escapeHtml(
          formatDuration(remainingSeconds)
        )}</b>`;
    } else if (start && remainingSeconds <= 0) {
      timing = `🔴 <b>LIVE / ACTIVE NOW</b>`;
    } else {
      timing = `⚡ <b>API DETECTED</b>`;
    }
  }

  if (mode === 'prealert') {
    timing =
      `⏳ Starts in <b>${escapeHtml(
        formatDuration(remainingSeconds)
      )}</b>`;
  }

  if (mode === 'active') {
    timing = `🔴 <b>DROP LIVE NOW</b>`;
  }

  return (
    `🎁 <b>KICK DROP</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📛 ${name}\n` +
    `${channelText}\n` +
    `🎁 ${reward}\n` +
    `⏱ ${watch}\n` +
    `${timing}\n` +
    `🔗 ${escapeHtml(
      getCampaignUrl(campaign, trackedSlug)
    )}`
  );
}

// ============================================================
// SEND WITH DEDUPLICATION
// ============================================================

async function sendDropAlert({
  env,
  campaign,
  stage,
  mode,
  targets,
  remainingSeconds = null,
  trackedSlug = null,
  stats
}) {
  const campaignId = getCampaignId(campaign);

  if (!campaignId) {
    return false;
  }

  if (await hasAlert(env, campaignId, stage)) {
    return false;
  }

  if (!targets.length) {
    return false;
  }

  const message = buildDropMessage(
    campaign,
    mode,
    remainingSeconds,
    trackedSlug
  );

  let sent = false;

  for (const chatId of targets) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        chatId,
        message,
        { parse_mode: 'HTML' }
      );

      sent = true;
    } catch (error) {
      console.error(
        `drop alert failed (${campaignId}/${stage}) -> ${chatId}:`,
        error?.message || error
      );
    }
  }

  if (sent) {
    await markAlert(
      env,
      campaignId,
      stage
    );

    stats.drops++;
    stats.alerts++;

    return true;
  }

  return false;
}

// ============================================================
// DROP CAMPAIGN ENGINE
// ============================================================

async function processCampaign(
  env,
  campaign,
  stats
) {
  const campaignId = getCampaignId(campaign);

  if (!campaignId) {
    return;
  }

  const now = nowMs();

  if (isCampaignExpired(campaign, now)) {
    return;
  }

  const start = campaignStartMs(campaign);

  const stateKey =
    `drop_state:${campaignId}`;

  let state = await getJson(env, stateKey);

  /*
   * First API sighting.
   *
   * This is the most important part of the whole system.
   * We do NOT care whether the campaign has started yet.
   */
  if (!state) {
    state = {
      campaignId,
      firstSeenAt: new Date(now).toISOString(),
      firstSeenMs: now,
      createdAt: campaign?.created_at || null,
      startsAt: campaign?.starts_at || null,
      endsAt: campaign?.ends_at || null,
      name: getCampaignName(campaign)
    };

    await putJson(
      env,
      stateKey,
      state
    );

    const targets =
      await getNotificationTargets(env, campaign);

    const remainingSeconds =
      start
        ? Math.max(0, (start - now) / 1000)
        : null;

    await sendDropAlert({
      env,
      campaign,
      stage: 'discovered',
      mode: 'discovered',
      targets,
      remainingSeconds,
      stats
    });

    /*
     * Measure how early the API exposed the campaign relative
     * to its scheduled start.
     */
    if (start) {
      const leadSeconds =
        (start - now) / 1000;

      console.log(
        `[DROP DISCOVERY] ${campaignId} "${getCampaignName(campaign)}" ` +
        `lead=${formatDuration(leadSeconds)} ` +
        `starts=${new Date(start).toISOString()}`
      );
    } else {
      console.log(
        `[DROP DISCOVERY] ${campaignId} "${getCampaignName(campaign)}" ` +
        `starts_at unavailable`
      );
    }
  }

  /*
   * PRE-START ALERTS
   */
  if (start && now < start) {
    const remainingSeconds =
      (start - now) / 1000;

    const targets =
      await getNotificationTargets(env, campaign);

    for (const threshold of DROP_PREALERT_SECONDS) {
      if (remainingSeconds <= threshold) {
        await sendDropAlert({
          env,
          campaign,
          stage: `pre_${threshold}`,
          mode: 'prealert',
          targets,
          remainingSeconds,
          stats
        });
      }
    }

    return;
  }

  /*
   * ACTIVE ALERT
   *
   * This fires even if the campaign was first discovered
   * only after the start time.
   */
  if (isCampaignActive(campaign, now)) {
    const targets =
      await getNotificationTargets(env, campaign);

    await sendDropAlert({
      env,
      campaign,
      stage: 'active',
      mode: 'active',
      targets,
      stats
    });
  }
}

// ============================================================
// GLOBAL DROP SCAN
// ============================================================

async function checkGlobalDrops(
  env,
  campaigns,
  stats
) {
  if (!campaigns.length) {
    return;
  }

  /*
   * Process every currently returned campaign.
   *
   * IMPORTANT:
   * We intentionally do NOT filter to active campaigns.
   * This preserves future campaigns so we can warn before
   * starts_at.
   */
  for (const campaign of campaigns) {
    try {
      await processCampaign(
        env,
        campaign,
        stats
      );
    } catch (error) {
      stats.errors++;

      console.error(
        'processCampaign failed:',
        error?.message || error
      );
    }
  }
}

// ============================================================
// PER-CHANNEL DROP DETECTION
// ============================================================

async function detectChannelDrop(
  env,
  chatId,
  channel,
  livestream,
  campaigns,
  stats
) {
  if (!livestream) {
    return {
      matched: false
    };
  }

  for (const campaign of campaigns) {
    if (
      !campaignInvolvesChannel(
        campaign,
        channel
      )
    ) {
      continue;
    }

    const campaignId =
      getCampaignId(campaign);

    if (!campaignId) {
      continue;
    }

    const now = nowMs();

    /*
     * Campaign engine handles early alerts globally.
     *
     * Here we make sure a streamer-specific chat also receives
     * the active-drop signal when they are live.
     */

    if (!isCampaignActive(campaign, now)) {
      continue;
    }

    const already =
      await hasAlert(
        env,
        campaignId,
        `channel_active:${channel.slug}`
      );

    if (already) {
      continue;
    }

    const message =
      buildDropMessage(
        campaign,
        'active',
        null,
        channel.slug
      );

    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        chatId,
        message,
        { parse_mode: 'HTML' }
      );

      await markAlert(
        env,
        campaignId,
        `channel_active:${channel.slug}`
      );

      stats.drops++;
      stats.alerts++;

      return {
        matched: true,
        alreadyAlerted: false
      };
    } catch (error) {
      console.error(
        `channel drop alert failed (${channel.slug}):`,
        error?.message || error
      );

      return {
        matched: true,
        alreadyAlerted: false,
        error: true
      };
    }
  }

  return {
    matched: false
  };
}

// ============================================================
// STREAM FETCH
// ============================================================

async function fetchWithTimeout(
  slug,
  env,
  ms
) {
  const timeoutPromise =
    new Promise((_, reject) => {
      setTimeout(
        () => reject(
          new Error(
            `channel fetch timeout after ${ms}ms`
          )
        ),
        ms
      );
    });

  return Promise.race([
    fetchChannelInfo(slug, env),
    timeoutPromise
  ]);
}

// ============================================================
// FAILURE / BACKOFF
// ============================================================

async function markFail(
  env,
  channel
) {
  const failCount =
    (channel.fail_count || 0) + 1;

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

function shouldSkipChannel(channel, now) {
  if (
    !channel.last_is_live &&
    channel.last_checked &&
    now - channel.last_checked < OFFLINE_SKIP_MS
  ) {
    return true;
  }

  if (
    channel.fail_count >= BACKOFF_THRESHOLD &&
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
      now - channel.last_checked <
      backoffMinutes * 60000
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// STREAM STATE PROCESSOR
// ============================================================

async function processStateChange(
  env,
  channel,
  isLive,
  livestream,
  campaigns,
  stats
) {
  const now = nowMs();

  const title =
    livestream?.session_title || '';

  const category =
    livestream?.categories?.[0]?.name || '';

  const viewers =
    Number(livestream?.viewer_count || 0);

  // ==========================================================
  // GOING LIVE
  // ==========================================================

  if (isLive && !channel.last_is_live) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        `🔴 <b>${escapeHtml(
          channel.name || channel.slug
        )} LIVE!</b>\n` +
        `📺 ${escapeHtml(title)}\n` +
        `👁 ${viewers.toLocaleString()}\n` +
        `👉 https://kick.com/${escapeHtml(channel.slug)}`,
        { parse_mode: 'HTML' }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `live alert failed (${channel.slug}):`,
        error?.message || error
      );
    }

    await detectChannelDrop(
      env,
      channel.notify_chat_id,
      {
        slug: channel.slug,
        name: channel.name,
        broadcaster_user_id:
          channel.broadcaster_user_id
      },
      livestream,
      campaigns,
      stats
    );

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

  // ==========================================================
  // GOING OFFLINE
  // ==========================================================

  if (!isLive && channel.last_is_live) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        `⚫ <b>${escapeHtml(
          channel.name || channel.slug
        )}</b> offline.`,
        { parse_mode: 'HTML' }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `offline alert failed (${channel.slug}):`,
        error?.message || error
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

    for (const milestone of VIEWER_MILESTONES) {
      await env.KV.delete(
        `milestone:${channel.slug}:${milestone}`
      );
    }

    stats.offline++;

    return;
  }

  // ==========================================================
  // STAYING LIVE
  // ==========================================================

  if (isLive && channel.last_is_live) {
    // --------------------------
    // Title changed
    // --------------------------

    if (
      title &&
      title !== channel.last_title
    ) {
      try {
        await tg.sendMessage(
          env.BOT_TOKEN,
          channel.notify_chat_id,
          `📝 <b>${escapeHtml(
            channel.name || channel.slug
          )}</b> title changed:\n` +
          `<i>${escapeHtml(title)}</i>`,
          { parse_mode: 'HTML' }
        );

        stats.alerts++;
      } catch (error) {
        console.error(
          `title alert failed (${channel.slug}):`,
          error?.message || error
        );
      }
    }

    // --------------------------
    // Category changed
    // --------------------------

    if (
      category &&
      category !== channel.last_category
    ) {
      try {
        await tg.sendMessage(
          env.BOT_TOKEN,
          channel.notify_chat_id,
          `🏷 <b>${escapeHtml(
            channel.name || channel.slug
          )}</b> → ${escapeHtml(category)}`,
          { parse_mode: 'HTML' }
        );

        stats.alerts++;
      } catch (error) {
        console.error(
          `category alert failed (${channel.slug}):`,
          error?.message || error
        );
      }
    }

    // --------------------------
    // Viewer milestones
    // --------------------------

    if (
      viewers >
      Number(channel.last_viewer_count || 0)
    ) {
      for (const milestone of VIEWER_MILESTONES) {
        const previous =
          Number(channel.last_viewer_count || 0);

        if (
          viewers >= milestone &&
          previous < milestone
        ) {
          const key =
            `milestone:${channel.slug}:${milestone}`;

          if (await env.KV.get(key)) {
            continue;
          }

          try {
            await tg.sendMessage(
              env.BOT_TOKEN,
              channel.notify_chat_id,
              `🎉 <b>${escapeHtml(
                channel.name || channel.slug
              )}</b> hit ${milestone.toLocaleString()} viewers!`,
              { parse_mode: 'HTML' }
            );

            await env.KV.put(
              key,
              '1',
              { expirationTtl: 21600 }
            );

            stats.alerts++;
          } catch (error) {
            console.error(
              `milestone alert failed (${channel.slug}):`,
              error?.message || error
            );
          }
        }
      }
    }

    // --------------------------
    // Drop check while LIVE
    // --------------------------

    await detectChannelDrop(
      env,
      channel.notify_chat_id,
      {
        slug: channel.slug,
        name: channel.name,
        broadcaster_user_id:
          channel.broadcaster_user_id
      },
      livestream,
      campaigns,
      stats
    );

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

  // ==========================================================
  // OFFLINE & PREVIOUSLY OFFLINE
  // ==========================================================

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

async function checkSingleChannel(
  env,
  channel,
  campaigns,
  runId,
  stats
) {
  const now = nowMs();

  if (
    shouldSkipChannel(
      channel,
      now
    )
  ) {
    stats.skipped++;
    return;
  }

  try {
    const info =
      await fetchWithTimeout(
        channel.slug,
        env,
        API_TIMEOUT_MS
      );

    if (!info) {
      await markFail(
        env,
        channel
      );

      stats.errors++;

      return;
    }

    if (channel.fail_count > 0) {
      await env.DB.prepare(
        `UPDATE kick_channels
         SET fail_count = 0
         WHERE id = ?`
      )
        .bind(channel.id)
        .run();
    }

    const livestream =
      info?.livestream || null;

    const isLive =
      Boolean(livestream);

    stats.checked++;

    await processStateChange(
      env,
      channel,
      isLive,
      livestream,
      campaigns,
      stats
    );
  } catch (error) {
    await markFail(
      env,
      channel
    );

    stats.errors++;

    console.error(
      `[${runId}] channel ${channel.slug} failed:`,
      error?.message || error
    );
  }
}

// ============================================================
// STREAM SCANNER
// ============================================================

async function checkStreams(
  env,
  campaigns,
  runId,
  stats,
  runStart
) {
  const rows =
    await env.DB.prepare(
      `SELECT *
       FROM kick_channels
       WHERE active = 1
       ORDER BY
         CASE
           WHEN last_is_live = 1 THEN 0
           ELSE 1
         END,
         last_checked ASC`
    ).all();

  const channels =
    rows.results || [];

  if (!channels.length) {
    return;
  }

  const toCheck =
    channels.slice(
      0,
      MAX_CHANNELS_PER_RUN
    );

  for (
    let i = 0;
    i < toCheck.length;
    i += MAX_CONCURRENT
  ) {
    if (
      nowMs() - runStart >
      CRON_BUDGET_MS
    ) {
      stats.skipped +=
        toCheck.length -
        stats.checked -
        i;

      break;
    }

    const batch =
      toCheck.slice(
        i,
        i + MAX_CONCURRENT
      );

    await Promise.all(
      batch.map(channel =>
        checkSingleChannel(
          env,
          channel,
          campaigns,
          runId,
          stats
        )
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
    crypto.randomUUID().slice(0, 8);

  const runStart =
    nowMs();

  const stats = {
    checked: 0,
    live: 0,
    offline: 0,
    alerts: 0,
    drops: 0,
    errors: 0,
    skipped: 0,
    campaigns: 0
  };

  try {
    /*
     * CRITICAL:
     *
     * Fetch the drops endpoint EXACTLY ONCE.
     *
     * This is shared by both global drop discovery and
     * per-channel live checks.
     */
    const campaigns =
      await fetchCampaigns(env);

    stats.campaigns =
      campaigns.length;

    /*
     * EARLY DROP ENGINE FIRST.
     *
     * This happens before stream scanning so an API-visible
     * drop gets priority.
     */
    await checkGlobalDrops(
      env,
      campaigns,
      stats
    );

    /*
     * Normal stream monitoring.
     */
    await checkStreams(
      env,
      campaigns,
      runId,
      stats,
      runStart
    );
  } catch (error) {
    stats.errors++;

    console.error(
      `[${runId}] monitor fatal error:`,
      error?.message || error
    );
  }

  const duration =
    nowMs() - runStart;

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
