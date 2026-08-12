import { tg } from '../telegram';
import { fetchDropCampaigns } from './api';

const DROP_CHECK_TTL = 20;
const MAX_CAMPAIGNS = 20;
const MAX_CHANNELS_PER_CAMPAIGN = 12;

function safeDate(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = safeDate(value);
  if (!date) return 'Unknown';

  return date.toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' UTC';
}

function getCampaignStatus(campaign, now = Date.now()) {
  const start = safeDate(campaign.starts_at)?.getTime() ?? null;
  const end = safeDate(campaign.ends_at)?.getTime() ?? null;

  if (campaign.status === 'expired') return 'expired';

  if (start && now < start) return 'upcoming';

  if (end && now >= end) return 'expired';

  if (campaign.status === 'active') return 'active';

  if (start && (!end || now < end)) return 'active';

  return String(campaign.status || 'unknown').toLowerCase();
}

function getChannels(campaign) {
  if (!Array.isArray(campaign?.channels)) return [];

  return campaign.channels
    .filter(Boolean)
    .map(channel => {
      const slug = channel.slug || channel.user?.username || null;
      const username = channel.user?.username || slug;

      return {
        slug,
        username,
      };
    })
    .filter(channel => channel.slug);
}

function getRewards(campaign) {
  if (!Array.isArray(campaign?.rewards)) return [];

  return campaign.rewards
    .filter(Boolean)
    .map(reward => ({
      name: reward.name || 'Unnamed reward',
      requiredUnits: reward.required_units ?? null,
    }));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function campaignKey(campaign) {
  return String(
    campaign?.id ||
    `${campaign?.name || 'unknown'}:${campaign?.starts_at || ''}:${campaign?.ends_at || ''}`
  );
}

function campaignTitle(campaign) {
  return campaign?.name || 'Unnamed Kick Drop';
}

function buildCampaignBlock(campaign, status) {
  const name = escapeHtml(campaignTitle(campaign));
  const organization = escapeHtml(
    campaign?.organization?.name || 'Unknown organization'
  );

  const rewards = getRewards(campaign);
  const channels = getChannels(campaign);

  const rewardText = rewards.length
    ? rewards.map(reward => {
        const units = reward.requiredUnits != null
          ? ` — ${escapeHtml(reward.requiredUnits)} units`
          : '';

        return `🎁 ${escapeHtml(reward.name)}${units}`;
      }).join('\n')
    : '🎁 Reward information unavailable';

  const channelText = channels.length
    ? channels
        .slice(0, MAX_CHANNELS_PER_CAMPAIGN)
        .map(channel => `• <code>${escapeHtml(channel.slug)}</code>`)
        .join('\n') +
      (channels.length > MAX_CHANNELS_PER_CAMPAIGN
        ? `\n• +${channels.length - MAX_CHANNELS_PER_CAMPAIGN} more`
        : '')
    : '• No channels listed';

  const rule = campaign?.rule?.name || 'Unknown';

  let statusIcon = 'ℹ️';

  if (status === 'active') statusIcon = '🟢';
  if (status === 'upcoming') statusIcon = '🟡';
  if (status === 'expired') statusIcon = '⚫';

  return [
    `${statusIcon} <b>${name}</b>`,
    `🏢 ${organization}`,
    `📌 Status: <b>${status.toUpperCase()}</b>`,
    `⏱ Starts: <code>${formatDate(campaign?.starts_at)}</code>`,
    `⏳ Ends: <code>${formatDate(campaign?.ends_at)}</code>`,
    `📜 Rule: <b>${escapeHtml(rule)}</b>`,
    '',
    '<b>Rewards</b>',
    rewardText,
    '',
    '<b>Eligible channels</b>',
    channelText,
    campaign?.url
      ? `\n🔗 <a href="${escapeHtml(campaign.url)}">Campaign link</a>`
      : '',
  ].join('\n');
}

function sortCampaigns(campaigns) {
  return [...campaigns].sort((a, b) => {
    const aStart = safeDate(a?.starts_at)?.getTime() ?? Infinity;
    const bStart = safeDate(b?.starts_at)?.getTime() ?? Infinity;

    return aStart - bStart;
  });
}

function normalizeCampaigns(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.data)) return payload.data;

  if (Array.isArray(payload.campaigns)) return payload.campaigns;

  if (Array.isArray(payload.data?.campaigns)) {
    return payload.data.campaigns;
  }

  return [];
}

async function getCachedCampaigns(env) {
  const cacheKey = 'kickdrops:campaigns';

  try {
    const cached = await env?.KV?.get(cacheKey, 'json');

    if (Array.isArray(cached)) {
      return cached;
    }
  } catch (error) {
    console.error('Kick drops KV read failed:', error);
  }

  return null;
}

async function cacheCampaigns(env, campaigns) {
  if (!env?.KV) return;

  try {
    await env.KV.put(
      'kickdrops:campaigns',
      JSON.stringify(campaigns),
      {
        expirationTtl: DROP_CHECK_TTL,
      }
    );
  } catch (error) {
    console.error('Kick drops KV write failed:', error);
  }
}

async function loadCampaigns(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getCachedCampaigns(env);

    if (cached) {
      return {
        campaigns: cached,
        cached: true,
      };
    }
  }

  const payload = await fetchDropCampaigns(env);
  const campaigns = normalizeCampaigns(payload);

  if (!campaigns.length) {
    return {
      campaigns: [],
      cached: false,
    };
  }

  await cacheCampaigns(env, campaigns);

  return {
    campaigns,
    cached: false,
  };
}

function splitCampaigns(campaigns) {
  const now = Date.now();

  const active = [];
  const upcoming = [];
  const expired = [];

  for (const campaign of campaigns) {
    const status = getCampaignStatus(campaign, now);

    if (status === 'active') {
      active.push(campaign);
    } else if (status === 'upcoming') {
      upcoming.push(campaign);
    } else if (status === 'expired') {
      expired.push(campaign);
    }
  }

  return {
    active: sortCampaigns(active),
    upcoming: sortCampaigns(upcoming),
    expired: sortCampaigns(expired),
  };
}

function buildHeader(source, counts) {
  const sourceText = source === 'cache'
    ? 'cached API data'
    : 'live Kick Drops API';

  return [
    '🎁 <b>KICK DROPS</b>',
    '',
    `📡 Source: <b>${sourceText}</b>`,
    `🟢 Active: <b>${counts.active}</b>`,
    `🟡 Upcoming: <b>${counts.upcoming}</b>`,
    `⚫ Expired: <b>${counts.expired}</b>`,
  ].join('\n');
}

function buildSection(title, campaigns) {
  if (!campaigns.length) {
    return `${title}\n<i>None found.</i>`;
  }

  const limited = campaigns.slice(0, MAX_CAMPAIGNS);

  return [
    title,
    '',
    limited.map(campaign => {
      const status = getCampaignStatus(campaign);
      return buildCampaignBlock(campaign, status);
    }).join('\n\n━━━━━━━━━━━━━━\n\n'),
  ].join('\n');
}

function buildMessage(campaigns, source) {
  const groups = splitCampaigns(campaigns);

  const header = buildHeader(source, {
    active: groups.active.length,
    upcoming: groups.upcoming.length,
    expired: groups.expired.length,
  });

  const sections = [];

  if (groups.active.length) {
    sections.push(
      buildSection(
        '🟢 <b>ACTIVE NOW</b>',
        groups.active
      )
    );
  }

  if (groups.upcoming.length) {
    sections.push(
      buildSection(
        '🟡 <b>UPCOMING</b>',
        groups.upcoming
      )
    );
  }

  if (groups.expired.length) {
    sections.push(
      buildSection(
        '⚫ <b>PREVIOUS / EXPIRED</b>',
        groups.expired
      )
    );
  }

  if (!sections.length) {
    return `${header}\n\n❌ No Kick Drop campaigns were returned by the API.`;
  }

  return `${header}\n\n${sections.join('\n\n━━━━━━━━━━━━━━━━\n\n')}`;
}

async function sendLongMessage(env, chatId, text) {
  const MAX_LENGTH = 3900;

  if (text.length <= MAX_LENGTH) {
    await tg.sendMessage(env.BOT_TOKEN, chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    return;
  }

  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LENGTH);

    if (splitAt < 1000) {
      splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    }

    if (splitAt < 500) {
      splitAt = MAX_LENGTH;
    }

    const chunk = remaining.slice(0, splitAt);

    await tg.sendMessage(env.BOT_TOKEN, chatId, chunk, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    await tg.sendMessage(env.BOT_TOKEN, chatId, remaining, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

/**
 * Main /kickdrops command.
 *
 * Shows real Kick Drops campaigns globally.
 *
 * It does NOT:
 * - inspect stream titles
 * - guess from words like "bonus"
 * - depend on tracked streamers
 * - require a channel to be in the bot's tracking list
 *
 * It DOES:
 * - query Kick's Drops campaigns endpoint through fetchDropCampaigns()
 * - show active campaigns
 * - show upcoming campaigns
 * - show previous/expired campaigns
 * - show exact starts_at / ends_at
 * - show rewards
 * - show watch-to-redeem rules
 * - show eligible channels
 */
export async function kickdrops(env, chatId) {
  if (!env?.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is missing');
  }

  if (!chatId) {
    throw new Error('Telegram chat ID is missing');
  }

  try {
    const result = await loadCampaigns(env, true);

    const campaigns = result.campaigns;

    if (!campaigns.length) {
      await tg.sendMessage(
        env.BOT_TOKEN,
        chatId,
        [
          '🎁 <b>KICK DROPS</b>',
          '',
          '⚠️ Kick returned no campaign objects.',
          '',
          'The bot did not guess or infer a drop.',
          'It only reports campaigns returned by the real Kick Drops API.',
          '',
          '🔄 Try <code>/kickdrops</code> again shortly.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }
      );

      return {
        ok: true,
        count: 0,
      };
    }

    const text = buildMessage(campaigns, result.cached ? 'cache' : 'api');

    await sendLongMessage(env, chatId, text);

    return {
      ok: true,
      count: campaigns.length,
      active: splitCampaigns(campaigns).active.length,
      upcoming: splitCampaigns(campaigns).upcoming.length,
      expired: splitCampaigns(campaigns).expired.length,
    };
  } catch (error) {
    console.error('kickdrops command failed:', error);

    await tg.sendMessage(
      env.BOT_TOKEN,
      chatId,
      [
        '❌ <b>Kick Drops check failed</b>',
        '',
        'The bot could not read the Kick Drops campaigns API.',
        '',
        `<code>${escapeHtml(error?.message || 'Unknown error')}</code>`,
        '',
        '🔄 Try <code>/kickdrops</code> again.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }
    );

    return {
      ok: false,
      error: error?.message || 'Unknown error',
    };
  }
}

/**
 * Optional aliases so existing command routers can use
 * whichever name they already expect.
 */
export const handleKickDrops = kickdrops;
export const handleKickdrops = kickdrops;
export default kickdrops;
