import { tg } from '../telegram';
import { fetchDropCampaigns } from './api';
import { startWatcher } from './watcher';

// ============================================================
// STAKICK DROP + STREAM MONITOR
// ============================================================
//
// DROP ENGINE
// -------------
// Every execution:
//   1. Fetch KICK Drops API
//   2. Parse ALL campaigns
//   3. Detect upcoming campaigns
//   4. Detect active campaigns
//   5. Match campaigns to tracked channels
//   6. Notify first discovery
//   7. Notify pre-start thresholds
//   8. Notify when LIVE
//   9. Store state in KV to prevent duplicates
//
// STREAM ENGINE
// -------------
// Checks tracked kick_channels and detects:
//   - going live
//   - going offline
//   - title changes
//   - category changes
//   - viewer milestones
//
// IMPORTANT
// ---------
// This file DOES NOT use Durable Objects.
// It does not require DropAlarm.
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const DROP_API_URL =
  'https://web.kick.com/api/v1/drops/campaigns';

const CHANNEL_API_BASE =
  'https://kick.com/api/v2/channels';

const DROP_TIMEOUT_MS = 5000;
const CHANNEL_TIMEOUT_MS = 4500;

const MAX_CHANNELS_PER_RUN = 30;
const MAX_CONCURRENT_CHANNELS = 5;

const WORKER_BUDGET_MS = 50000;

// Pre-start warning thresholds.
// The monitor sends each threshold once.
const PRE_ALERTS = [
  120,
  60,
  30,
  15,
  5
];

// State retention.
const STATE_TTL =
  7 * 24 * 60 * 60;

const ALERT_TTL =
  7 * 24 * 60 * 60;

// Offline polling.
const OFFLINE_NORMAL_MS =
  5 * 60 * 1000;

const OFFLINE_DROP_RELEVANT_MS =
  60 * 1000;

// Viewer milestones.
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


// ============================================================
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
}

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function stringId(value) {
  if (value == null) return null;
  return String(value);
}

function unique(values) {
  return [
    ...new Set(
      values
        .filter(v => v != null)
        .map(v => String(v))
    )
  ];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseDate(value) {
  if (!value) return null;

  const time =
    new Date(value).getTime();

  return Number.isFinite(time)
    ? time
    : null;
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'unknown';
  }

  if (seconds <= 0) {
    return 'now';
  }

  const total =
    Math.floor(seconds);

  const minutes =
    Math.floor(total / 60);

  const secondsLeft =
    total % 60;

  if (minutes > 0) {
    return `${minutes}m ${secondsLeft}s`;
  }

  return `${secondsLeft}s`;
}


// ============================================================
// KV HELPERS
// ============================================================

async function kvGet(env, key) {
  try {
    return await env.KV.get(key);
  } catch (error) {
    console.error(
      `[KV GET] ${key}:`,
      error?.message || error
    );

    return null;
  }
}

async function kvJsonGet(env, key) {
  const raw =
    await kvGet(env, key);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvPut(
  env,
  key,
  value,
  ttl = STATE_TTL
) {
  try {
    await env.KV.put(
      key,
      typeof value === 'string'
        ? value
        : JSON.stringify(value),
      {
        expirationTtl: ttl
      }
    );

    return true;
  } catch (error) {
    console.error(
      `[KV PUT] ${key}:`,
      error?.message || error
    );

    return false;
  }
}

async function alertAlreadySent(
  env,
  campaignId,
  alertType
) {
  return Boolean(
    await kvGet(
      env,
      `drop_alert:${campaignId}:${alertType}`
    )
  );
}

async function markAlertSent(
  env,
  campaignId,
  alertType
) {
  return kvPut(
    env,
    `drop_alert:${campaignId}:${alertType}`,
    '1',
    ALERT_TTL
  );
}


// ============================================================
// CAMPAIGN IDENTIFICATION
// ============================================================

function campaignId(campaign) {
  return stringId(
    campaign?.id ??
    campaign?.campaign_id ??
    campaign?.uuid ??
    campaign?.slug ??
    null
  );
}

function campaignName(campaign) {
  return (
    campaign?.name ??
    campaign?.title ??
    campaign?.campaign_name ??
    'KICK Drop'
  );
}

function campaignStart(campaign) {
  return parseDate(
    campaign?.starts_at ??
    campaign?.start_at ??
    campaign?.start_time ??
    campaign?.startsAt
  );
}

function campaignEnd(campaign) {
  return parseDate(
    campaign?.ends_at ??
    campaign?.end_at ??
    campaign?.end_time ??
    campaign?.endsAt
  );
}

function isExpired(
  campaign,
  current = now()
) {
  const end =
    campaignEnd(campaign);

  if (end && current >= end) {
    return true;
  }

  const status =
    normalize(campaign?.status);

  return (
    status === 'expired' ||
    status === 'ended' ||
    status === 'finished'
  );
}

function isActive(
  campaign,
  current = now()
) {
  if (
    isExpired(
      campaign,
      current
    )
  ) {
    return false;
  }

  const start =
    campaignStart(campaign);

  if (
    start &&
    current < start
  ) {
    return false;
  }

  if (
    campaign?.is_active === false
  ) {
    return false;
  }

  const status =
    normalize(campaign?.status);

  if (
    status === 'inactive' ||
    status === 'disabled'
  ) {
    return false;
  }

  return true;
}


// ============================================================
// KICK DROPS API
// ============================================================

async function fetchDrops(env) {
  try {
    const campaigns =
      await fetchDropCampaigns(env);

    if (campaigns === null) {
      console.error(
        '[DROPS API] unavailable'
      );

      return null;
    }

    console.log(
      `[DROPS API] received ${campaigns.length} campaign(s)`
    );

    return campaigns;

  } catch (error) {
    console.error(
      '[DROPS API] FAILED:',
      error?.message || error
    );

    return null;

  }
}


// ============================================================
// CHANNEL EXTRACTION FROM CAMPAIGN
// ============================================================

function extractCampaignChannels(
  campaign
) {
  const result = [];
  const seen = new Set();

  function add({
    id = null,
    userId = null,
    slug = null,
    username = null,
    name = null
  }) {
    id =
      stringId(id);

    userId =
      stringId(userId);

    slug =
      normalize(slug);

    username =
      normalize(username);

    name =
      String(name ?? '');

    if (
      !id &&
      !userId &&
      !slug &&
      !username
    ) {
      return;
    }

    const key =
      [
        id || '',
        userId || '',
        slug || '',
        username || ''
      ].join('|');

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    result.push({
      id,
      userId,
      slug,
      username,
      name
    });
  }

  // ----------------------------------------
  // campaign.channels[]
  // ----------------------------------------

  if (
    Array.isArray(
      campaign?.channels
    )
  ) {
    for (
      const channel
      of campaign.channels
    ) {
      add({
        id:
          channel?.id ??
          channel?.channel_id,

        userId:
          channel?.user_id ??
          channel?.broadcaster_user_id ??
          channel?.user?.id,

        slug:
          channel?.slug ??
          channel?.channel_slug,

        username:
          channel?.username ??
          channel?.user?.username,

        name:
          channel?.name ??
          channel?.username ??
          channel?.user?.username
      });
    }
  }

  // ----------------------------------------
  // channel_ids[]
  // ----------------------------------------

  if (
    Array.isArray(
      campaign?.channel_ids
    )
  ) {
    for (
      const id
      of campaign.channel_ids
    ) {
      add({ id });
    }
  }

  // ----------------------------------------
  // channel_slugs[]
  // ----------------------------------------

  if (
    Array.isArray(
      campaign?.channel_slugs
    )
  ) {
    for (
      const slug
      of campaign.channel_slugs
    ) {
      add({ slug });
    }
  }

  // ----------------------------------------
  // channels as strings
  // ----------------------------------------

  if (
    Array.isArray(
      campaign?.channel_names
    )
  ) {
    for (
      const name
      of campaign.channel_names
    ) {
      add({
        slug: name,
        username: name,
        name
      });
    }
  }

  // ----------------------------------------
  // streamer
  // ----------------------------------------

  for (
    const source
    of [
      campaign?.streamer,
      campaign?.creator,
      campaign?.broadcaster,
      campaign?.channel
    ]
  ) {
    if (!source) continue;

    add({
      id:
        source?.id ??
        source?.channel_id,

      userId:
        source?.user_id ??
        source?.broadcaster_user_id ??
        source?.user?.id,

      slug:
        source?.slug ??
        source?.channel_slug,

      username:
        source?.username ??
        source?.user?.username,

      name:
        source?.name ??
        source?.username ??
        source?.user?.username
    });
  }

  return result;
}


// ============================================================
// TRACKED CHANNEL MATCHING
// ============================================================

function campaignMatchesChannel(
  campaign,
  tracked
) {
  const candidates =
    extractCampaignChannels(
      campaign
    );

  if (!candidates.length) {
    return false;
  }

  const trackedId =
    stringId(tracked?.id);

  const trackedBroadcasterId =
    stringId(
      tracked?.broadcaster_user_id
    );

  const trackedSlug =
    normalize(
      tracked?.slug
    );

  const trackedName =
    normalize(
      tracked?.name
    );

  for (
    const candidate
    of candidates
  ) {
    if (
      trackedId &&
      candidate.id === trackedId
    ) {
      return true;
    }

    if (
      trackedBroadcasterId &&
      (
        candidate.id ===
          trackedBroadcasterId ||
        candidate.userId ===
          trackedBroadcasterId
      )
    ) {
      return true;
    }

    if (
      trackedSlug &&
      (
        candidate.slug ===
          trackedSlug ||
        candidate.username ===
          trackedSlug
      )
    ) {
      return true;
    }

    if (
      trackedName &&
      (
        candidate.slug ===
          trackedName ||
        candidate.username ===
          trackedName
      )
    ) {
      return true;
    }
  }

  return false;
}

function matchedChannels(
  campaign,
  trackedChannels
) {
  return trackedChannels.filter(
    channel =>
      campaignMatchesChannel(
        campaign,
        channel
      )
  );
}


// ============================================================
// TARGET CHATS
// ============================================================

async function getTargets(
  env,
  matched,
  allTracked
) {
  const targets = new Set();

  for (
    const channel
    of matched
  ) {
    if (
      channel?.notify_chat_id
    ) {
      targets.add(
        String(
          channel.notify_chat_id
        )
      );
    }
  }

  /*

   Always include the configured default notification group.

   This allows global KICK Drops to be announced even when

   the campaign does not expose a recognizable channel match.
  */
  try {
    const defaultGroup =
      await env.KV.get(
        'default_notify_group'
      );


    if (defaultGroup) {
      targets.add(
        String(defaultGroup)
      );
    }

  } catch (error) {
    console.error(
      '[DROP TARGET] KV error:',
      error?.message || error
    );
  }

  /*

   Last-resort fallback for existing watched channels.
  */
  if (!targets.size) {
    for (
      const channel
      of allTracked
    ) {
      if (
        channel?.notify_chat_id
      ) {
        targets.add(
          String(
            channel.notify_chat_id
          )
        );
      }
    }
  }


  return [
    ...targets
  ];
}


// ============================================================
// REWARD / WATCH INFO
// ============================================================

function rewardText(campaign) {
  const rewards =
    Array.isArray(
      campaign?.rewards
    )
      ? campaign.rewards
      : [];

  if (!rewards.length) {
    return (
      campaign?.reward ??
      'Drop reward'
    );
  }

  return rewards
    .slice(0, 5)
    .map(
      reward => {
        const name =
          reward?.name ??
          reward?.title ??
          'Reward';

        const units =
          reward?.required_units ??
          reward?.units ??
          null;

        return units != null
          ? `${name} (${units} units)`
          : name;
      }
    )
    .join(' • ');
}

function watchText(campaign) {
  const seconds =
    Number(
      campaign?.watch_seconds ??
      campaign?.required_watch_seconds
    );

  if (
    Number.isFinite(seconds) &&
    seconds > 0
  ) {
    return `${Math.ceil(seconds / 60)} min watch`;
  }

  const minutes =
    Number(
      campaign?.watch_time_minutes
    );

  if (
    Number.isFinite(minutes) &&
    minutes > 0
  ) {
    return `${Math.ceil(minutes)} min watch`;
  }

  const rewards =
    Array.isArray(
      campaign?.rewards
    )
      ? campaign.rewards
      : [];

  const units =
    rewards
      .map(
        reward =>
          Number(
            reward?.required_units
          )
      )
      .filter(
        Number.isFinite
      );

  if (units.length) {
    return `${Math.min(...units)} required units`;
  }

  return 'Watch stream to redeem';
}


// ============================================================
// DROP URL
// ============================================================

function campaignUrl(
  campaign,
  matched
) {
  if (campaign?.url) {
    return campaign.url;
  }

  if (
    campaign?.link
  ) {
    return campaign.link;
  }

  if (
    matched.length === 1 &&
    matched[0]?.slug
  ) {
    return (
      `https://kick.com/${matched[0].slug}`
    );
  }

  const candidates =
    extractCampaignChannels(
      campaign
    );

  if (
    candidates.length === 1 &&
    candidates[0]?.slug
  ) {
    return (
      `https://kick.com/${candidates[0].slug}`
    );
  }

  return 'https://kick.com';
}


// ============================================================
// DROP MESSAGE
// ============================================================

function buildDropMessage({
  campaign,
  type,
  remainingSeconds,
  matched
}) {
  const name =
    escapeHtml(
      campaignName(campaign)
    );

  const reward =
    escapeHtml(
      rewardText(campaign)
    );

  const watch =
    escapeHtml(
      watchText(campaign)
    );

  let status;

  if (
    type === 'discovered'
  ) {
    if (
      Number.isFinite(
        remainingSeconds
      ) &&
      remainingSeconds > 0
    ) {
      status =
        `⏳ <b>STARTS IN ${escapeHtml(
          duration(
            remainingSeconds
          )
        )}</b>`;
    } else {
      status =
        '🔴 <b>DROP IS LIVE NOW</b>';
    }
  } else if (
    type === 'prealert'
  ) {
    status =
      `⏳ <b>STARTS IN ${escapeHtml(
        duration(
          remainingSeconds
        )
      )}</b>`;
  } else {
    status =
      '🔴 <b>DROP IS LIVE NOW</b>';
  }

  let streamer =
    '👤 Channel: KICK';

  if (
    matched.length
  ) {
    const names =
      unique(
        matched.map(
          channel =>
            channel?.name ||
            channel?.slug
        )
      );

    streamer =
      names.length === 1
        ? `👤 <b>${escapeHtml(
            names[0]
          )}</b>`
        : `👥 <b>${escapeHtml(
            names.join(', ')
          )}</b>`;
  }

  const url =
    campaignUrl(
      campaign,
      matched
    );

  return (
    `🎁 <b>STA/KICK DROP DETECTED</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `📛 <b>${name}</b>\n` +
    `${streamer}\n` +
    `🎁 ${reward}\n` +
    `⏱ ${watch}\n` +
    `${status}\n` +
    `🔗 ${escapeHtml(url)}`
  );
}


// ============================================================
// SEND DROP ALERT
// ============================================================

async function sendDropAlert({
  env,
  campaign,
  alertType,
  messageType,
  remainingSeconds,
  matched,
  allTracked,
  stats
}) {
  const id =
    campaignId(campaign);

  if (!id) {
    console.error(
      '[DROP] Campaign has no ID:',
      JSON.stringify(campaign)
    );

    return false;
  }

  if (
    await alertAlreadySent(
      env,
      id,
      alertType
    )
  ) {
    return false;
  }

  const targets =
    await getTargets(
      env,
      matched,
      allTracked
    );

  if (!targets.length) {
    console.warn(
      `[DROP] ${id} detected but no notification chats exist`
    );

    return false;
  }

  const message =
    buildDropMessage({
      campaign,
      type: messageType,
      remainingSeconds,
      matched
    });

  let sent = 0;

  await Promise.all(
    targets.map(
      async chatId => {
        try {
          await tg.sendMessage(
            env.BOT_TOKEN,
            chatId,
            message,
            {
              parse_mode: 'HTML',
              disable_web_page_preview:
                false
            }
          );

          sent++;

        } catch (error) {
          console.error(
            `[DROP ALERT] ${id} -> ${chatId}:`,
            error?.message ||
              error
          );
        }
      }
    )
  );

  if (!sent) {
    return false;
  }

  await markAlertSent(
    env,
    id,
    alertType
  );

  stats.alerts++;
  stats.drops++;

  console.log(
    `[DROP ALERT SENT] ` +
    `id=${id} ` +
    `type=${alertType} ` +
    `targets=${sent}`
  );

  return true;
}


// ============================================================
// DROP STATE
// ============================================================

async function saveCampaignState(
  env,
  campaign,
  matched
) {
  const id =
    campaignId(campaign);

  if (!id) return;

  const key =
    `drop_state:${id}`;

  const existing =
    await kvJsonGet(
      env,
      key
    );

  const current =
    now();

  const state = {
    campaignId: id,

    firstSeenAt:
      existing?.firstSeenAt ??
      new Date(current).toISOString(),

    firstSeenMs:
      existing?.firstSeenMs ??
      current,

    lastSeenAt:
      new Date(current).toISOString(),

    lastSeenMs:
      current,

    name:
      campaignName(campaign),

    startsAt:
      campaign?.starts_at ??
      null,

    endsAt:
      campaign?.ends_at ??
      null,

    matched:
      matched.length > 0,

    matchedChannels:
      matched.map(
        channel =>
          channel?.slug
      )
  };

  await kvPut(
    env,
    key,
    state,
    STATE_TTL
  );
}


// ============================================================
// DROP ENGINE
// ============================================================

async function processDrop({
  env,
  campaign,
  trackedChannels,
  stats
}) {
  const id =
    campaignId(campaign);

  if (!id) {
    console.warn(
      '[DROP] Ignoring campaign without ID'
    );

    return;
  }

  const current =
    now();

  if (
    isExpired(
      campaign,
      current
    )
  ) {
    return;
  }

  const matched =
    matchedChannels(
      campaign,
      trackedChannels
    );

  await saveCampaignState(
    env,
    campaign,
    matched
  );

  const start =
    campaignStart(
      campaign
    );

  const isLive =
    isActive(
      campaign,
      current
    );

  const remaining =
    start
      ? (
          start - current
        ) / 1000
      : null;

  const existing =
    await kvJsonGet(
      env,
      `drop_state:${id}`
    );

  /*
   * ----------------------------------------------------------
   * FIRST DISCOVERY
   * ----------------------------------------------------------
   */

  const firstSeen =
    existing?.firstSeenMs ===
    current;

  /*
   * saveCampaignState() means firstSeenMs may equal current.
   * We therefore use a separate discovery marker.
   */

  const discoveryKey =
    `drop_discovered:${id}`;

  const discovered =
    await kvGet(
      env,
      discoveryKey
    );

  if (!discovered) {
    await kvPut(
      env,
      discoveryKey,
      '1',
      STATE_TTL
    );

    console.log(
      `[DROP DISCOVERED] ` +
      `id=${id} ` +
      `name="${campaignName(campaign)}" ` +
      `start=${campaign?.starts_at || 'unknown'} ` +
      `remaining=${remaining == null ? 'unknown' : duration(remaining)} ` +
      `matched=${matched.length}`
    );

    if (
      isLive
    ) {
      await sendDropAlert({
        env,
        campaign,
        alertType: 'live',
        messageType: 'active',
        remainingSeconds:
          remaining,
        matched,
        allTracked:
          trackedChannels,
        stats
      });
    } else {
      await sendDropAlert({
        env,
        campaign,
        alertType:
          'discovered',
        messageType:
          'discovered',
        remainingSeconds:
          remaining,
        matched,
        allTracked:
          trackedChannels,
        stats
      });
    }
  }

  /*
   * ----------------------------------------------------------
   * UPCOMING DROP
   * ----------------------------------------------------------
   */

  if (
    start &&
    current < start
  ) {
    const secondsLeft =
      (start - current) /
      1000;

    for (
      const threshold
      of PRE_ALERTS
    ) {
      /*
       * IMPORTANT:
       *
       * The KV key is unique per threshold.
       * So if the Worker is running once per minute,
       * only the threshold that has been reached gets sent.
       *
       * If the first API discovery happens at 45 seconds,
       * it sends the 30-second warning only once it reaches it.
       */
      if (
        secondsLeft <=
        threshold
      ) {
        await sendDropAlert({
          env,
          campaign,
          alertType:
            `pre_${threshold}`,
          messageType:
            'prealert',
          remainingSeconds:
            secondsLeft,
          matched,
          allTracked:
            trackedChannels,
          stats
        });
      }
    }

    return;
  }

  /*
   * ----------------------------------------------------------
   * ACTIVE NOW
   * ----------------------------------------------------------
   */

  if (
    isLive
  ) {
    await sendDropAlert({
      env,
      campaign,
      alertType:
        'active',
      messageType:
        'active',
      remainingSeconds:
        0,
      matched,
      allTracked:
        trackedChannels,
      stats
    });

    console.log(
      `[DROP ACTIVE] ` +
      `id=${id} ` +
      `name="${campaignName(campaign)}"`
    );
  }
}


// ============================================================
// GLOBAL DROP SCAN
// ============================================================

async function scanDrops({
  env,
  campaigns,
  trackedChannels,
  stats
}) {
  if (
    !Array.isArray(
      campaigns
    )
  ) {
    return;
  }

  /*
   * Process every campaign returned by KICK.
   *
   * DO NOT filter to "active" here.
   * Upcoming campaigns are valuable because they
   * allow us to notify before the drop starts.
   */

  for (
    const campaign
    of campaigns
  ) {
    try {
      await processDrop({
        env,
        campaign,
        trackedChannels,
        stats
      });
    } catch (error) {
      stats.errors++;

      console.error(
        '[DROP PROCESS ERROR]:',
        error?.message ||
          error
      );
    }
  }
}


// ============================================================
// CHANNEL API
// ============================================================

async function fetchChannel(
  env,
  slug
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      CHANNEL_TIMEOUT_MS
    );

  try {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept:
        'application/json'
    };

    if (
      env.KICK_SESSION_TOKEN
    ) {
      headers.Authorization =
        `Bearer ${env.KICK_SESSION_TOKEN}`;
    }

    const response =
      await fetch(
        `${CHANNEL_API_BASE}/${encodeURIComponent(slug)}`,
        {
          method: 'GET',
          headers,
          signal:
            controller.signal,
          cf: {
            cacheTtl: 0,
            cacheEverything: false
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `Channel HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timeout);
  }
}


// ============================================================
// CHANNEL BACKOFF
// ============================================================

function shouldSkipChannel(
  channel,
  relevantSlugs
) {
  const current =
    now();

  const lastChecked =
    Number(
      channel?.last_checked ||
      0
    );

  /*
   * Live channels:
   * check every execution.
   */

  if (
    Number(
      channel?.last_is_live
    ) === 1
  ) {
    return false;
  }

  /*
   * Drop-relevant channels:
   * check every minute.
   */

  const slug =
    normalize(
      channel?.slug
    );

  const relevant =
    relevantSlugs.has(
      slug
    );

  const interval =
    relevant
      ? OFFLINE_DROP_RELEVANT_MS
      : OFFLINE_NORMAL_MS;

  if (
    lastChecked &&
    current -
      lastChecked <
      interval
  ) {
    return true;
  }

  return false;
}


// ============================================================
// STREAM STATE
// ============================================================

async function updateChannel(
  env,
  channel,
  info,
  campaigns,
  stats
) {
  const livestream =
    info?.livestream ??
    null;

  const live =
    Boolean(
      livestream
    );

  const wasLive =
    Number(
      channel?.last_is_live ||
      0
    ) === 1;

  const title =
    livestream?.session_title ??
    '';

  const category =
    livestream
      ?.categories?.[0]
      ?.name ??
    '';

  const viewers =
    Number(
      livestream?.viewer_count ||
      0
    );

  const displayName =
    channel?.name ||
    channel?.slug;

  /*
   * GOING LIVE
   */

  if (
    live &&
    !wasLive
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
          parse_mode: 'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `[LIVE ALERT] ${channel.slug}:`,
        error?.message ||
          error
      );
    }
  }

  /*
   * OFFLINE
   */

  if (
    !live &&
    wasLive
  ) {
    try {
      await tg.sendMessage(
        env.BOT_TOKEN,
        channel.notify_chat_id,
        `⚫ <b>${escapeHtml(
          displayName
        )}</b> went offline.`,
        {
          parse_mode: 'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `[OFFLINE ALERT] ${channel.slug}:`,
        error?.message ||
          error
      );
    }

    for (
      const milestone
      of VIEWER_MILESTONES
    ) {
      await env.KV.delete(
        `milestone:${channel.slug}:${milestone}`
      );
    }
  }

  /*
   * TITLE CHANGE
   */

  if (
    live &&
    wasLive &&
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
          parse_mode: 'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `[TITLE ALERT] ${channel.slug}:`,
        error?.message ||
          error
      );
    }
  }

  /*
   * CATEGORY CHANGE
   */

  if (
    live &&
    wasLive &&
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
          parse_mode: 'HTML'
        }
      );

      stats.alerts++;
    } catch (error) {
      console.error(
        `[CATEGORY ALERT] ${channel.slug}:`,
        error?.message ||
          error
      );
    }
  }

  /*
   * VIEWER MILESTONES
   */

  if (
    live &&
    wasLive
  ) {
    const previous =
      Number(
        channel.last_viewer_count ||
        0
      );

    if (
      viewers > previous
    ) {
      for (
        const milestone
        of VIEWER_MILESTONES
      ) {
        if (
          previous <
            milestone &&
          viewers >=
            milestone
        ) {
          const key =
            `milestone:${channel.slug}:${milestone}`;

          if (
            await kvGet(
              env,
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
                parse_mode: 'HTML'
              }
            );

            await kvPut(
              env,
              key,
              '1',
              21600
            );

            stats.alerts++;
          } catch (error) {
            console.error(
              `[MILESTONE] ${channel.slug}:`,
              error?.message ||
                error
            );
          }
        }
      }
    }
  }

  /*
   * SAVE STATE
   */

  await env.DB.prepare(
    `UPDATE kick_channels
     SET last_is_live = ?,
         last_title = ?,
         last_viewer_count = ?,
         last_category = ?,
         last_checked = ?,
         fail_count = 0
     WHERE id = ?`
  )
    .bind(
      live ? 1 : 0,
      title,
      viewers,
      category,
      now(),
      channel.id
    )
    .run();

  if (live) {
    stats.live++;
  } else {
    stats.offline++;
  }
}


// ============================================================
// STREAM DROP CONFIRMATION
// ============================================================
//
// This is a SECONDARY safety net.
//
// The global Drops API is the primary detector.
//
// If a tracked streamer is live and a matching campaign
// is active, we make sure the active alert exists.
//
// ============================================================

async function confirmActiveDrops({
  env,
  channel,
  campaigns,
  stats
}) {
  if (
    !Array.isArray(
      campaigns
    )
  ) {
    return;
  }

  for (
    const campaign
    of campaigns
  ) {
    if (
      !isActive(
        campaign
      )
    ) {
      continue;
    }

    if (
      !campaignMatchesChannel(
        campaign,
        channel
      )
    ) {
      continue;
    }

    await sendDropAlert({
      env,
      campaign,
      alertType:
        'active',
      messageType:
        'active',
      remainingSeconds:
        0,
      matched: [
        channel
      ],
      allTracked: [
        channel
      ],
      stats
    });
  }
}


// ============================================================
// SINGLE CHANNEL CHECK
// ============================================================

async function checkChannel({
  env,
  channel,
  campaigns,
  relevantSlugs,
  stats
}) {
  if (
    shouldSkipChannel(
      channel,
      relevantSlugs
    )
  ) {
    stats.skipped++;
    return;
  }

  try {
    const info =
      await fetchChannel(
        env,
        channel.slug
      );

    stats.checked++;

    await updateChannel(
      env,
      channel,
      info,
      campaigns,
      stats
    );

    /*
     * Secondary active-drop confirmation.
     */

    if (
      info?.livestream
    ) {
      await confirmActiveDrops({
        env,
        channel,
        campaigns,
        stats
      });
    }

  } catch (error) {
    stats.errors++;

    console.error(
      `[CHANNEL ERROR] ${channel.slug}:`,
      error?.message ||
        error
    );

    try {
      await env.DB.prepare(
        `UPDATE kick_channels
         SET fail_count =
             COALESCE(fail_count, 0) + 1,
             last_checked = ?
         WHERE id = ?`
      )
        .bind(
          now(),
          channel.id
        )
        .run();
    } catch (dbError) {
      console.error(
        '[CHANNEL DB ERROR]',
        dbError?.message ||
          dbError
      );
    }
  }
}


// ============================================================
// STREAM SCANNER
// ============================================================

async function scanStreams({
  env,
  campaigns,
  trackedChannels,
  runStart,
  stats
}) {
  if (
    !trackedChannels.length
  ) {
    return;
  }

  /*
   * Find channel slugs involved in any current campaign.
   */

  const relevantSlugs =
    new Set();

  for (
    const campaign
    of campaigns
  ) {
    if (
      isExpired(
        campaign
      )
    ) {
      continue;
    }

    const candidates =
      extractCampaignChannels(
        campaign
      );

    for (
      const candidate
      of candidates
    ) {
      if (
        candidate.slug
      ) {
        relevantSlugs.add(
          candidate.slug
        );
      }

      if (
        candidate.username
      ) {
        relevantSlugs.add(
          candidate.username
        );
      }
    }
  }

  /*
   * Prioritize:
   *
   * 1. Live
   * 2. Drop-related
   * 3. Never checked
   * 4. Oldest checked
   */

  const sorted =
    [...trackedChannels]
      .sort(
        (a, b) => {
          function score(channel) {
            let value = 0;

            if (
              Number(
                channel.last_is_live ||
                0
              ) === 1
            ) {
              value += 1000;
            }

            if (
              relevantSlugs.has(
                normalize(
                  channel.slug
                )
              )
            ) {
              value += 500;
            }

            if (
              !channel.last_checked
            ) {
              value += 200;
            } else {
              value += Math.min(
                120,
                (
                  now() -
                  Number(
                    channel.last_checked
                  )
                ) / 60000
              );
            }

            return value;
          }

          return (
            score(b) -
            score(a)
          );
        }
      );

  const channels =
    sorted.slice(
      0,
      MAX_CHANNELS_PER_RUN
    );

  for (
    let i = 0;
    i < channels.length;
    i += MAX_CONCURRENT_CHANNELS
  ) {
    if (
      now() -
        runStart >=
      WORKER_BUDGET_MS
    ) {
      stats.skipped +=
        channels.length -
        i;

      break;
    }

    const batch =
      channels.slice(
        i,
        i +
          MAX_CONCURRENT_CHANNELS
      );

    await Promise.all(
      batch.map(
        channel =>
          checkChannel({
            env,
            channel,
            campaigns,
            relevantSlugs,
            stats
          })
      )
    );
  }
}


// ============================================================
// MAIN ENTRY
// ============================================================

export async function runMonitor({
  env,
  executionCtx
}) {
  const runId =
    crypto.randomUUID()
      .slice(0, 8);

  const runStart =
    now();

  const stats = {
    campaigns: 0,
    checked: 0,
    live: 0,
    offline: 0,
    drops: 0,
    alerts: 0,
    errors: 0,
    skipped: 0
  };

  console.log(
    `\n========== STAKICK MONITOR ${runId} ==========`
  );

  try {
    /*
     * --------------------------------------------------------
     * 1. LOAD TRACKED CHANNELS
     * --------------------------------------------------------
     */

    const result =
      await env.DB.prepare(
        `SELECT *
         FROM kick_channels
         WHERE active = 1`
      ).all();

    const trackedChannels =
      result?.results ||
      [];

    console.log(
      `[${runId}] tracked channels=${trackedChannels.length}`
    );

    /*
     * --------------------------------------------------------
     * 2. FETCH DROPS API
     * --------------------------------------------------------
     *
     * THIS HAPPENS ON EVERY EXECUTION.
     *
     * No cached campaign list.
     * No "only if a streamer is live".
     * No previous state required.
     */

    const campaigns =
      await fetchDrops(
        env
      );

    /*
     * --------------------------------------------------------
     * 3. DROP ENGINE
     * --------------------------------------------------------
     */

    if (
      campaigns === null
    ) {
      stats.errors++;

      console.error(
        `[${runId}] Drops API unavailable`
      );
    } else {
      stats.campaigns =
        campaigns.length;

      console.log(
        `[${runId}] scanning ${campaigns.length} drop campaigns`
      );

      await scanDrops({
        env,
        campaigns,
        trackedChannels,
        stats
      });
    }

    /*
     * --------------------------------------------------------
     * 4. STREAM ENGINE
     * --------------------------------------------------------
     *
     * If Drops API failed, we still check streams.
     */

    await scanStreams({
      env,
      campaigns:
        campaigns || [],
      trackedChannels,
      runStart,
      stats
    });

  } catch (error) {
    stats.errors++;

    console.error(
      `[${runId}] FATAL MONITOR ERROR:`,
      error?.stack ||
        error?.message ||
        error
    );
  }

  const elapsed =
    now() -
    runStart;

  console.log(
    `========== STAKICK ${runId} DONE ==========\n` +
    `time=${elapsed}ms ` +
    `campaigns=${stats.campaigns} ` +
    `checked=${stats.checked} ` +
    `live=${stats.live} ` +
    `offline=${stats.offline} ` +
    `drops=${stats.drops} ` +
    `alerts=${stats.alerts} ` +
    `errors=${stats.errors} ` +
    `skipped=${stats.skipped}`
  );

  return stats;
}
