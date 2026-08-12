import { tg } from './telegram';

// ============================================================
// STAKICK DROP DETECTOR
// ============================================================
//
// This module is intentionally lightweight.
//
// PRIMARY detection:
//   monitor.js -> KICK Drops API
//
// This module is a SECONDARY/LOCAL detector for situations where
// another part of the bot wants to inspect a livestream directly.
//
// It does NOT:
//   - guess drops from random words in titles
//   - treat "bonus" or "reward" text as proof of a drop
//   - create competing cooldown systems
//   - suppress legitimate API alerts
//
// It can:
//   - inspect known drop/reward fields in KICK responses
//   - detect explicit active flags
//   - correlate a livestream with known campaign data
//   - send a fallback alert when explicitly requested
//   - record detections in D1
//
// ============================================================

const DROP_FIELD_NAMES = new Set([
  'drop',
  'drops',
  'drop_active',
  'drops_active',
  'drop_enabled',
  'drops_enabled',
  'reward',
  'rewards',
  'reward_active',
  'rewards_active',
  'campaign',
  'campaigns',
  'quest',
  'quests',
  'claim',
  'claims',
  'redeem',
  'redeemable',
  'giveaway',
  'prize',
  'loot',
]);

const ACTIVE_VALUES = new Set([
  'true',
  'yes',
  'active',
  'enabled',
  'available',
  'live',
  'on',
]);

// ------------------------------------------------------------
// GENERIC HELPERS
// ------------------------------------------------------------

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value);
}

function escapeHtml(value) {
  return safeString(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function unique(values) {
  return [...new Set(
    values
      .filter(value => value != null)
      .map(value => String(value))
  )];
}

// ------------------------------------------------------------
// VALUE CHECKING
// ------------------------------------------------------------

function isActiveValue(value) {
  if (value === true) return true;

  if (typeof value === 'number') {
    return value === 1;
  }

  return ACTIVE_VALUES.has(
    normalize(value)
  );
}

function looksLikeDropField(path) {
  const parts = String(path)
    .toLowerCase()
    .split(/[.[\]_ -]+/)
    .filter(Boolean);

  return parts.some(part =>
    DROP_FIELD_NAMES.has(part)
  );
}

// ------------------------------------------------------------
// SAFE OBJECT WALKER
// ------------------------------------------------------------

function collectSignals(
  value,
  path = '',
  output = [],
  depth = 0
) {
  if (
    value == null ||
    depth > 6
  ) {
    return output;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    output.push({
      path,
      value,
    });

    return output;
  }

  if (Array.isArray(value)) {
    for (
      let i = 0;
      i < value.length;
      i++
    ) {
      collectSignals(
        value[i],
        `${path}[${i}]`,
        output,
        depth + 1
      );
    }

    return output;
  }

  if (typeof value === 'object') {
    for (
      const [key, child]
      of Object.entries(value)
    ) {
      const nextPath =
        path
          ? `${path}.${key}`
          : key;

      collectSignals(
        child,
        nextPath,
        output,
        depth + 1
      );
    }
  }

  return output;
}

// ============================================================
// LOCAL DROP SIGNAL SCANNER
// ============================================================

export function scanDropSignals(
  info,
  livestream
) {
  const source = {
    channel: info || null,
    livestream: livestream || null,
  };

  const entries =
    collectSignals(source);

  const reasons = [];

  for (const entry of entries) {
    const path =
      String(entry.path || '');

    const value =
      entry.value;

    /*
     * Strongest signal:
     *
     * drop_active: true
     * drops_enabled: true
     * rewards_active: true
     * etc.
     */
    if (
      looksLikeDropField(path) &&
      isActiveValue(value)
    ) {
      reasons.push({
        type: 'explicit',
        path,
        value: safeString(value),
        weight: 10,
      });

      continue;
    }

    /*
     * Arrays/objects under known drop fields are useful
     * evidence, but are NOT automatically considered proof.
     */
    if (
      looksLikeDropField(path) &&
      (
        typeof value === 'string' ||
        typeof value === 'number'
      )
    ) {
      const normalized =
        normalize(value);

      if (
        normalized &&
        normalized !== 'false' &&
        normalized !== '0' &&
        normalized !== 'null' &&
        normalized !== 'undefined'
      ) {
        reasons.push({
          type: 'drop_field',
          path,
          value: safeString(value),
          weight: 4,
        });
      }
    }
  }

  /*
   * Only explicit signals are considered a positive match.
   *
   * This prevents titles such as:
   *
   * "Drop some kills"
   * "Big reward tonight"
   *
   * from generating fake alerts.
   */
  const explicit =
    reasons.filter(
      reason =>
        reason.type === 'explicit'
    );

  let confidence = 'none';

  if (explicit.length >= 2) {
    confidence = 'high';
  } else if (explicit.length === 1) {
    confidence = 'high';
  } else if (reasons.length) {
    confidence = 'low';
  }

  const score =
    reasons.reduce(
      (total, reason) =>
        total + reason.weight,
      0
    );

  return {
    matched: explicit.length > 0,
    score,
    confidence,
    reasons,
  };
}

// ============================================================
// CAMPAIGN HELPERS
// ============================================================

function getCampaignId(
  campaign
) {
  return (
    campaign?.id ??
    campaign?.campaign_id ??
    null
  );
}

function getCampaignName(
  campaign
) {
  return (
    campaign?.name ||
    campaign?.title ||
    'KICK Drop'
  );
}

function getCampaignStart(
  campaign
) {
  return (
    campaign?.starts_at ||
    campaign?.start_at ||
    null
  );
}

function getCampaignEnd(
  campaign
) {
  return (
    campaign?.ends_at ||
    campaign?.end_at ||
    null
  );
}

function campaignIsActive(
  campaign,
  now = Date.now()
) {
  const end =
    getCampaignEnd(campaign);

  if (end) {
    const endMs =
      new Date(end).getTime();

    if (
      Number.isFinite(endMs) &&
      now >= endMs
    ) {
      return false;
    }
  }

  const start =
    getCampaignStart(campaign);

  if (start) {
    const startMs =
      new Date(start).getTime();

    if (
      Number.isFinite(startMs) &&
      now < startMs
    ) {
      return false;
    }
  }

  if (
    campaign?.is_active === false
  ) {
    return false;
  }

  if (
    normalize(campaign?.status) ===
    'expired'
  ) {
    return false;
  }

  return true;
}

// ============================================================
// CAMPAIGN / CHANNEL CORRELATION
// ============================================================

function getCampaignChannels(
  campaign
) {
  const channels = [];

  if (
    Array.isArray(
      campaign?.channels
    )
  ) {
    channels.push(
      ...campaign.channels
    );
  }

  if (
    Array.isArray(
      campaign?.channel_ids
    )
  ) {
    channels.push(
      ...campaign.channel_ids.map(
        id => ({ id })
      )
    );
  }

  if (
    Array.isArray(
      campaign?.channel_slugs
    )
  ) {
    channels.push(
      ...campaign.channel_slugs.map(
        slug => ({ slug })
      )
    );
  }

  return channels;
}

function campaignMatchesChannel(
  campaign,
  channel
) {
  if (
    !campaign ||
    !channel
  ) {
    return false;
  }

  const trackedSlug =
    normalize(channel.slug);

  const trackedId =
    normalize(channel.id);

  const trackedBroadcasterId =
    normalize(
      channel.broadcaster_user_id
    );

  for (
    const candidate
    of getCampaignChannels(
      campaign
    )
  ) {
    const candidateSlug =
      normalize(
        candidate?.slug
      );

    const candidateUsername =
      normalize(
        candidate?.username ||
        candidate?.user?.username
      );

    const candidateId =
      normalize(
        candidate?.id
      );

    const candidateUserId =
      normalize(
        candidate?.userId ||
        candidate?.user?.id
      );

    if (
      trackedSlug &&
      (
        candidateSlug === trackedSlug ||
        candidateUsername === trackedSlug
      )
    ) {
      return true;
    }

    if (
      trackedId &&
      candidateId === trackedId
    ) {
      return true;
    }

    if (
      trackedBroadcasterId &&
      (
        candidateId ===
          trackedBroadcasterId ||
        candidateUserId ===
          trackedBroadcasterId
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// DROP MESSAGE
// ============================================================

function buildDropAlertText({
  channel,
  livestream,
  campaign,
  report,
}) {
  const name =
    channel?.name ||
    channel?.slug ||
    'Streamer';

  const title =
    livestream?.session_title ||
    'Live stream';

  const viewers =
    Number(
      livestream?.viewer_count
    );

  const category =
    livestream
      ?.categories?.[0]?.name ||
    'N/A';

  const campaignName =
    campaign
      ? getCampaignName(campaign)
      : 'Active Drop';

  const campaignId =
    campaign
      ? getCampaignId(campaign)
      : null;

  const reasons =
    report?.reasons
      ?.slice(0, 3)
      .map(
        reason =>
          reason.path
      )
      .join(', ');

  const kickUrl =
    channel?.slug
      ? `https://kick.com/${encodeURIComponent(
          channel.slug
        )}`
      : 'https://kick.com';

  return (
    `🎁 <b>STA/KICK DROP ALERT</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📛 <b>${escapeHtml(
      campaignName
    )}</b>\n` +
    `🔴 ${escapeHtml(
      name
    )} is LIVE\n` +
    `📺 ${escapeHtml(
      title
    )}\n` +
    `👁 ${
      Number.isFinite(viewers)
        ? viewers.toLocaleString()
        : '?'
    } viewers\n` +
    `🎮 ${escapeHtml(
      category
    )}\n` +
    (
      campaignId
        ? `🆔 ${escapeHtml(
            campaignId
          )}\n`
        : ''
    ) +
    (
      reasons
        ? `🧠 Signal: ${escapeHtml(
            reasons
          )}\n`
        : ''
    ) +
    `\n⚡ <b>OPEN KICK NOW</b>\n` +
    `🔗 ${escapeHtml(
      kickUrl
    )}\n\n` +
    `<i>Drop detection is based on explicit KICK/API signals. ` +
    `You still need to watch the stream to qualify.</i>`
  );
}

// ============================================================
// KV DEDUPLICATION
// ============================================================

async function wasAlerted(
  env,
  key
) {
  try {
    return Boolean(
      await env.KV.get(key)
    );
  } catch {
    return false;
  }
}

async function markAlerted(
  env,
  key,
  ttl = 86400
) {
  try {
    await env.KV.put(
      key,
      '1',
      {
        expirationTtl: ttl,
      }
    );
  } catch (error) {
    console.error(
      'markAlerted failed:',
      error?.message || error
    );
  }
}

// ============================================================
// D1 RECORDING
// ============================================================

async function recordDrop(
  env,
  {
    channel,
    livestream,
    campaign,
    chatId,
  }
) {
  try {
    await env.DB.prepare(
      `INSERT INTO kick_drops
       (
         channel_slug,
         stream_id,
         title,
         detected_at,
         chat_id
       )
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        channel?.slug || null,
        String(
          livestream?.id ||
          `${channel?.slug || 'unknown'}:${livestream?.session_title || 'unknown'}`
        ),
        livestream?.session_title ||
          campaign?.name ||
          null,
        Date.now(),
        chatId
      )
      .run();
  } catch (error) {
    /*
     * Recording failure should NEVER prevent the Telegram
     * notification from being sent.
     */
    console.error(
      'recordDrop failed:',
      error?.message || error
    );
  }
}

// ============================================================
// PUBLIC DETECTOR
// ============================================================

export async function detectDrops(
  env,
  chatId,
  channel,
  livestream,
  campaigns = []
) {
  /*
   * No live stream = nothing to detect locally.
   */
  if (!livestream) {
    return {
      matched: false,
      reason: 'not_live',
    };
  }

  /*
   * ----------------------------------------------------------
   * 1. PRIMARY LOCAL SIGNAL
   * ----------------------------------------------------------
   *
   * Look for explicit drop fields in the channel/livestream
   * response.
   */
  const report =
    scanDropSignals(
      channel,
      livestream
    );

  /*
   * ----------------------------------------------------------
   * 2. PRIMARY API CAMPAIGN CORRELATION
   * ----------------------------------------------------------
   *
   * If monitor.js supplied campaigns, use them.
   *
   * This is MUCH stronger than title/text guessing.
   */
  let matchedCampaign = null;

  if (
    Array.isArray(campaigns) &&
    campaigns.length
  ) {
    for (
      const campaign
      of campaigns
    ) {
      if (
        !campaignIsActive(
          campaign
        )
      ) {
        continue;
      }

      if (
        campaignMatchesChannel(
          campaign,
          channel
        )
      ) {
        matchedCampaign =
          campaign;
        break;
      }
    }
  }

  /*
   * ----------------------------------------------------------
   * 3. No reliable signal
   * ----------------------------------------------------------
   */
  if (
    !matchedCampaign &&
    !report.matched
  ) {
    return {
      matched: false,
      report,
      campaign: null,
    };
  }

  /*
   * ----------------------------------------------------------
   * 4. Build a stable deduplication key
   * ----------------------------------------------------------
   */
  const campaignId =
    matchedCampaign
      ? getCampaignId(
          matchedCampaign
        )
      : null;

  const streamId =
    livestream?.id ||
    `${channel?.slug || 'unknown'}:${livestream?.session_title || 'unknown'}`;

  const alertKey =
    campaignId
      ? `drop_alert:local:${campaignId}:${channel?.slug || 'unknown'}`
      : `drop_alert:local:${channel?.slug || 'unknown'}:${streamId}`;

  /*
   * Do NOT use a 30-minute cooldown.
   *
   * A campaign ID is the correct identity when available.
   */
  if (
    await wasAlerted(
      env,
      alertKey
    )
  ) {
    return {
      matched: true,
      alreadyAlerted: true,
      report,
      campaign: matchedCampaign,
    };
  }

  /*
   * ----------------------------------------------------------
   * 5. Send notification
   * ----------------------------------------------------------
   */
  if (!chatId) {
    return {
      matched: true,
      notified: false,
      reason: 'missing_chat_id',
      report,
      campaign: matchedCampaign,
    };
  }

  const text =
    buildDropAlertText({
      channel,
      livestream,
      campaign:
        matchedCampaign,
      report,
    });

  try {
    await tg.sendMessage(
      env.BOT_TOKEN,
      chatId,
      text,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }
    );
  } catch (error) {
    console.error(
      'DROP TELEGRAM ALERT FAILED:',
      error?.message || error
    );

    /*
     * Do not mark the alert as sent if Telegram failed.
     * The next monitor invocation can retry.
     */
    return {
      matched: true,
      notified: false,
      report,
      campaign: matchedCampaign,
      error: error?.message || String(error),
    };
  }

  /*
   * ----------------------------------------------------------
   * 6. Mark AFTER successful Telegram delivery
   * ----------------------------------------------------------
   */
  await markAlerted(
    env,
    alertKey,
    7 * 24 * 60 * 60
  );

  /*
   * ----------------------------------------------------------
   * 7. Record in D1
   * ----------------------------------------------------------
   */
  await recordDrop(
    env,
    {
      channel,
      livestream,
      campaign:
        matchedCampaign,
      chatId,
    }
  );

  return {
    matched: true,
    notified: true,
    report,
    campaign: matchedCampaign,
  };
}

// ============================================================
// API-COMPATIBILITY ALIAS
// ============================================================
//
// If older code imports detectDrop instead of detectDrops,
// this keeps that code working.
//
// ============================================================

export const detectDrop =
  detectDrops;
