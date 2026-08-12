import { tg } from '../telegram';
import {
  fetchChannelInfo,
  fetchChannelClips,
  fetchDropCampaigns
} from '../kick/api';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
}

function campaignId(campaign) {
  return String(
    campaign?.id ??
    campaign?.campaign_id ??
    campaign?.uuid ??
    campaign?.slug ??
    ''
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
  const value =
    campaign?.starts_at ??
    campaign?.start_at ??
    campaign?.start_time ??
    campaign?.startsAt;

  if (!value) return null;

  const time = new Date(value).getTime();

  return Number.isFinite(time)
    ? time
    : null;
}

function campaignEnd(campaign) {
  const value =
    campaign?.ends_at ??
    campaign?.end_at ??
    campaign?.end_time ??
    campaign?.endsAt;

  if (!value) return null;

  const time = new Date(value).getTime();

  return Number.isFinite(time)
    ? time
    : null;
}

function isExpired(campaign) {
  const end = campaignEnd(campaign);

  if (end && Date.now() >= end) {
    return true;
  }

  const status = normalize(campaign?.status);

  return (
    status === 'expired' ||
    status === 'ended' ||
    status === 'finished'
  );
}

function isLive(campaign) {
  if (isExpired(campaign)) {
    return false;
  }

  const start = campaignStart(campaign);

  if (start && Date.now() < start) {
    return false;
  }

  if (campaign?.is_active === false) {
    return false;
  }

  const status = normalize(campaign?.status);

  if (
    status === 'inactive' ||
    status === 'disabled'
  ) {
    return false;
  }

  return true;
}

function extractCampaignNames(campaign) {
  const names = [];

  const add = value => {
    const normalized = normalize(value);

    if (
      normalized &&
      !names.includes(normalized)
    ) {
      names.push(normalized);
    }
  };

  if (Array.isArray(campaign?.channels)) {
    for (const channel of campaign.channels) {
      add(channel?.slug);
      add(channel?.username);
      add(channel?.channel_slug);
      add(channel?.name);
      add(channel?.user?.username);
    }
  }

  if (Array.isArray(campaign?.channel_slugs)) {
    for (const slug of campaign.channel_slugs) {
      add(slug);
    }
  }

  if (Array.isArray(campaign?.channel_names)) {
    for (const name of campaign.channel_names) {
      add(name);
    }
  }

  for (const source of [
    campaign?.streamer,
    campaign?.creator,
    campaign?.broadcaster,
    campaign?.channel
  ]) {
    if (!source) continue;

    add(source?.slug);
    add(source?.username);
    add(source?.channel_slug);
    add(source?.name);
    add(source?.user?.username);
  }

  return names;
}

function campaignMatchesSlug(campaign, slug) {
  const target = normalize(slug);

  if (!target) {
    return true;
  }

  return extractCampaignNames(
    campaign
  ).includes(target);
}

function rewardText(campaign) {
  const rewards = Array.isArray(
    campaign?.rewards
  )
    ? campaign.rewards
    : [];

  if (!rewards.length) {
    return (
      campaign?.reward ||
      'Drop reward'
    );
  }

  return rewards
    .slice(0, 5)
    .map(reward => {
      const name =
        reward?.name ??
        reward?.title ??
        'Reward';

      const units =
        reward?.required_units ??
        reward?.units;

      return units != null
        ? `${name} (${units} units)`
        : name;
    })
    .join(' • ');
}

function watchText(campaign) {
  const seconds = Number(
    campaign?.watch_seconds ??
    campaign?.required_watch_seconds
  );

  if (
    Number.isFinite(seconds) &&
    seconds > 0
  ) {
    return `${Math.ceil(seconds / 60)} min watch`;
  }

  const minutes = Number(
    campaign?.watch_time_minutes
  );

  if (
    Number.isFinite(minutes) &&
    minutes > 0
  ) {
    return `${Math.ceil(minutes)} min watch`;
  }

  return 'Watch stream to redeem';
}

function campaignChannels(campaign) {
  const names =
    extractCampaignNames(campaign);

  if (!names.length) {
    return 'KICK';
  }

  return names
    .slice(0, 5)
    .map(name => `@${name}`)
    .join(', ');
}

function formatRemaining(ms) {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }

  if (ms <= 0) {
    return 'LIVE NOW';
  }

  const totalSeconds =
    Math.floor(ms / 1000);

  const minutes =
    Math.floor(totalSeconds / 60);

  const seconds =
    totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function campaignUrl(campaign) {
  if (campaign?.url) {
    return campaign.url;
  }

  if (campaign?.link) {
    return campaign.link;
  }

  const names =
    extractCampaignNames(campaign);

  if (names.length === 1) {
    return `https://kick.com/${names[0]}`;
  }

  return 'https://kick.com';
}

function formatCampaign(campaign) {
  const start =
    campaignStart(campaign);

  const live =
    isLive(campaign);

  const status =
    live
      ? '🔴 LIVE NOW'
      : start
        ? `⏳ Starts in ${formatRemaining(
            start - Date.now()
          )}`
        : '⏳ Upcoming';

  const name =
    escapeHtml(
      campaignName(campaign)
    );

  const channels =
    escapeHtml(
      campaignChannels(campaign)
    );

  const reward =
    escapeHtml(
      rewardText(campaign)
    );

  const watch =
    escapeHtml(
      watchText(campaign)
    );

  const url =
    escapeHtml(
      campaignUrl(campaign)
    );

  return (
    `🎁 <b>${name}</b>\n` +
    `👤 ${channels}\n` +
    `🎁 ${reward}\n` +
    `⏱ ${watch}\n` +
    `${status}\n` +
    `🔗 ${url}`
  );
}

export async function kickWatch(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const chatType =
    update.message.chat.type;

  let notifyChatId =
    chatId;

  if (
    chatType === 'private'
  ) {
    const defaultGroup =
      await c.env.KV.get(
        'default_notify_group'
      );

    if (!defaultGroup) {
      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        'Please add me to your group and run /kicksetnotify there first.'
      );

      return c.text('OK');
    }

    notifyChatId =
      parseInt(
        defaultGroup,
        10
      );
  }

  const slug =
    normalize(
      parsed.args || ''
    );

  if (!slug) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/kickwatch xqc</code>',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  const info =
    await fetchChannelInfo(
      slug,
      c.env
    );

  if (!info) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      `❌ Channel "<b>${escapeHtml(
        slug
      )}</b>" not found.`,
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  const broadcasterId =
    info.user_id ||
    info.id ||
    info.user?.id ||
    null;

  await c.env.DB.prepare(
    `INSERT INTO kick_channels
      (
        slug,
        broadcaster_user_id,
        name,
        notify_chat_id,
        active,
        added_by,
        added_at,
        last_checked
      )
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(slug, notify_chat_id)
     DO UPDATE SET
       active = 1,
       name = excluded.name,
       broadcaster_user_id =
         excluded.broadcaster_user_id,
       last_checked =
         excluded.last_checked`
  )
    .bind(
      slug,
      broadcasterId,
      info.user?.username ||
        info.user?.name ||
        slug,
      notifyChatId,
      update.message.from.id,
      Date.now(),
      Date.now() - 60000
    )
    .run();

  const live =
    info.livestream;

  const status =
    live
      ? `🔴 Currently LIVE (${Number(
          live.viewer_count || 0
        ).toLocaleString()} viewers)\n📺 ${escapeHtml(
          live.session_title || ''
        )}`
      : '⚫ Offline';

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `✅ Now watching <b>${escapeHtml(
      slug
    )}</b>!\n${status}\n\nAlerts: go-live, milestones, title changes, drops.`,
    {
      parse_mode: 'HTML'
    }
  );

  return c.text('OK');
}

export async function kickUnwatch(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const slug =
    normalize(
      parsed.args || ''
    );

  if (!slug) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/kickunwatch xqc</code>',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  await c.env.DB.prepare(
    'UPDATE kick_channels SET active = 0 WHERE slug = ? AND notify_chat_id = ?'
  )
    .bind(
      slug,
      chatId
    )
    .run();

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `🛑 Stopped watching <b>${escapeHtml(
      slug
    )}</b>.`,
    {
      parse_mode: 'HTML'
    }
  );

  return c.text('OK');
}

export async function kickList(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const rows =
    await c.env.DB.prepare(
      `SELECT
         slug,
         name,
         last_is_live,
         last_viewer_count
       FROM kick_channels
       WHERE notify_chat_id = ?
         AND active = 1
       ORDER BY
         last_is_live DESC,
         slug ASC`
    )
      .bind(chatId)
      .all();

  if (!rows.results?.length) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'No Kick channels watched. Use <code>/kickwatch &lt;slug&gt;</code>',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  const list =
    rows.results
      .map(row => {
        const status =
          row.last_is_live
            ? `🔴 LIVE — ${Number(
                row.last_viewer_count || 0
              ).toLocaleString()} viewers`
            : '⚫ Offline';

        return `• <b>${escapeHtml(
          row.slug
        )}</b> — ${status}`;
      })
      .join('\n');

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `📺 <b>Watched Kick Channels:</b>\n${list}`,
    {
      parse_mode: 'HTML'
    }
  );

  return c.text('OK');
}

export async function kickStatus(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const slug =
    normalize(
      parsed.args ||
      c.env.OWNER_KICK_SLUG ||
      ''
    );

  if (!slug) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/kickstatus xqc</code>',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  const info =
    await fetchChannelInfo(
      slug,
      c.env
    );

  if (!info) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ Channel not found.'
    );

    return c.text('OK');
  }

  const live =
    info.livestream;

  const text =
    live
      ? `🔴 <b>${escapeHtml(
          slug
        )}</b> is LIVE\n` +
        `📺 ${escapeHtml(
          live.session_title || ''
        )}\n` +
        `👁 ${Number(
          live.viewer_count || 0
        ).toLocaleString()} viewers\n` +
        `🎮 ${escapeHtml(
          live.categories?.[0]?.name ||
          'N/A'
        )}\n` +
        `🔗 https://kick.com/${escapeHtml(
          slug
        )}`
      : `⚫ <b>${escapeHtml(
          slug
        )}</b> is offline\n` +
        `👥 ${Number(
          info.followers_count || 0
        ).toLocaleString()} followers\n` +
        `🔗 https://kick.com/${escapeHtml(
          slug
        )}`;

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    text,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    }
  );

  return c.text('OK');
}

export async function kickDrops(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const slug =
    normalize(
      parsed.args || ''
    );

  let campaigns;

  try {
    campaigns =
      await fetchDropCampaigns(
        c.env
      );
  } catch (error) {
    console.error(
      '[KICKDROPS]',
      error
    );

    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ KICK Drops API request failed. Try again shortly.'
    );

    return c.text('OK');
  }

  if (campaigns === null) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ KICK Drops API is currently unavailable.'
    );

    return c.text('OK');
  }

  let filtered =
    campaigns.filter(
      campaign =>
        !isExpired(campaign)
    );

  if (slug) {
    filtered =
      filtered.filter(
        campaign =>
          campaignMatchesSlug(
            campaign,
            slug
          )
      );
  }

  if (!filtered.length) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      slug
        ? `🎁 No active/upcoming KICK Drops found for <b>${escapeHtml(
            slug
          )}</b>.`
        : '🎁 No active/upcoming KICK Drops found.',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  filtered.sort(
    (a, b) => {
      const aStart =
        campaignStart(a) ??
        0;

      const bStart =
        campaignStart(b) ??
        0;

      return aStart - bStart;
    }
  );

  const limited =
    filtered.slice(0, 10);

  const header =
    slug
      ? `🎁 <b>KICK Drops — ${escapeHtml(
          slug
        )}</b>`
      : '🎁 <b>Current KICK Drops</b>';

  const body =
    limited
      .map(formatCampaign)
      .join(
        '\n\n━━━━━━━━━━━━━━━━\n\n'
      );

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `${header}\n\n${body}`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    }
  );

  return c.text('OK');
}

export async function kickSetNotify(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  if (
    update.message.chat.type ===
    'private'
  ) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Run this in a group.'
    );

    return c.text('OK');
  }

  await c.env.KV.put(
    'default_notify_group',
    String(chatId)
  );

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    '✅ This group is now the default notification channel.'
  );

  return c.text('OK');
}

export async function kickLink(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  if (!c.env.KICK_CLIENT_ID) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'OAuth not configured.'
    );

    return c.text('OK');
  }

  const state =
    crypto.randomUUID();

  await c.env.KV.put(
    `oauth_state:${state}`,
    chatId.toString(),
    {
      expirationTtl: 600
    }
  );

  const host =
    c.req.header('host');

  const redirectUri =
    `https://${host}/kick/oauth/callback`;

  const authUrl =
    `https://id.kick.com/oauth/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id:
        c.env.KICK_CLIENT_ID,
      redirect_uri:
        redirectUri,
      scope:
        'chat:write channel:read channel:write moderation:ban moderation:timeout user:read events:subscribe',
      state
    });

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `🔗 <a href="${authUrl}">Link your Kick account</a>`,
    {
      parse_mode: 'HTML'
    }
  );

  return c.text('OK');
}

export async function kickClips(
  c,
  update,
  parsed
) {
  const chatId =
    update.message.chat.id;

  const slug =
    normalize(
      parsed.args ||
      c.env.OWNER_KICK_SLUG ||
      ''
    );

  if (!slug) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/kickclips xqc</code>',
      {
        parse_mode: 'HTML'
      }
    );

    return c.text('OK');
  }

  const clips =
    await fetchChannelClips(
      slug,
      5
    );

  if (!clips.length) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'No recent clips.'
    );

    return c.text('OK');
  }

  const list =
    clips
      .map(
        (clip, index) =>
          `${index + 1}. <b>${escapeHtml(
            clip.title || 'Clip'
          )}</b> — <a href="https://kick.com/${escapeHtml(
            slug
          )}?clip=${encodeURIComponent(
            clip.id
          )}">Watch</a>`
      )
      .join('\n');

  await tg.sendMessage(
    c.env.BOT_TOKEN,
    chatId,
    `🎬 <b>${escapeHtml(
      slug
    )} Clips:</b>\n${list}`,
    {
      parse_mode: 'HTML'
    }
  );

  return c.text('OK');
}
