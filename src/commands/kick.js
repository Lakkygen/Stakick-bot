import { tg } from '../telegram';
import { fetchChannelInfo, fetchChannelClips } from '../kick/api';

export async function kickWatch(c, update, parsed) {
  const chatId = update.message.chat.id;
  const chatType = update.message.chat.type;
  let notifyChatId = chatId;

  if (chatType === 'private') {
    const defaultGroup = await c.env.KV.get('default_notify_group');
    if (!defaultGroup) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId,
        'Please add me to your group and run /kicksetnotify there first.');
      return c.text('OK');
    }
    notifyChatId = parseInt(defaultGroup);
  }

  const slug = (parsed.args || '').trim().toLowerCase().replace(/^@/, '');
  if (!slug) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'Usage: <code>/kickwatch xqc</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const info = await fetchChannelInfo(slug, c.env);
  if (!info) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ Channel \"<b>${slug}</b>\" not found.`, { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const broadcasterId = info.user_id || info.id || null;

  await c.env.DB.prepare(
    `INSERT INTO kick_channels (slug, broadcaster_user_id, name, notify_chat_id, active, added_by, added_at, last_checked)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(slug, notify_chat_id) DO UPDATE SET
     active = 1, name = excluded.name, broadcaster_user_id = excluded.broadcaster_user_id,
     last_checked = excluded.last_checked`
  ).bind(slug, broadcasterId, info.user?.username || slug, notifyChatId, update.message.from.id, Date.now(), Date.now() - 60000).run();

  const live = info.livestream;
  const status = live
    ? `🔴 Currently LIVE (${live.viewer_count?.toLocaleString()} viewers)\\n📺 ${live.session_title}`
    : '⚫ Offline';

  await tg.sendMessage(c.env.BOT_TOKEN, chatId,
    `✅ Now watching <b>${slug}</b>!\\n${status}\\n\\nAlerts: go-live, milestones, title changes, drops.`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function kickUnwatch(c, update, parsed) {
  const chatId = update.message.chat.id;
  const slug = (parsed.args || '').trim().toLowerCase();
  if (!slug) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'Usage: <code>/kickunwatch xqc</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }
  await c.env.DB.prepare(
    'UPDATE kick_channels SET active = 0 WHERE slug = ? AND notify_chat_id = ?'
  ).bind(slug, chatId).run();

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, `🛑 Stopped watching <b>${slug}</b>.`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function kickList(c, update, parsed) {
  const chatId = update.message.chat.id;
  const rows = await c.env.DB.prepare(
    'SELECT slug, name, last_is_live, last_viewer_count FROM kick_channels WHERE notify_chat_id = ? AND active = 1 ORDER BY last_is_live DESC, slug ASC'
  ).bind(chatId).all();

  if (!rows.results?.length) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId,
      'No Kick channels watched. Use <code>/kickwatch &lt;slug&gt;</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const list = rows.results.map(r => {
    const status = r.last_is_live
      ? `🔴 LIVE — ${r.last_viewer_count?.toLocaleString()} viewers`
      : '⚫ Offline';
    return `• <b>${r.slug}</b> — ${status}`;
  }).join('\\n');

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, `📺 <b>Watched Kick Channels:</b>\\n${list}`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function kickStatus(c, update, parsed) {
  const chatId = update.message.chat.id;
  const slug = (parsed.args || c.env.OWNER_KICK_SLUG).trim().toLowerCase();
  const info = await fetchChannelInfo(slug, c.env);
  if (!info) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ Not found.`);
    return c.text('OK');
  }

  const live = info.livestream;
  const text = live
    ? `🔴 <b>${slug}</b> is LIVE\\n📺 ${live.session_title}\\n👁 ${live.viewer_count?.toLocaleString()} viewers\\n🎮 ${live.categories?.[0]?.name || 'N/A'}\\n🔗 https://kick.com/${slug}`
    : `⚫ <b>${slug}</b> is offline\\n👥 ${info.followers_count?.toLocaleString() || '?'} followers\\n🔗 https://kick.com/${slug}`;

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, text, { parse_mode: 'HTML', disable_web_page_preview: false });
  return c.text('OK');
}

export async function kickDrops(c, update, parsed) {
  const chatId = update.message.chat.id;
  const slug = (parsed.args || '').trim().toLowerCase();

  if (!slug) {
    const rows = await c.env.DB.prepare(
      'SELECT channel_slug, title, detected_at FROM kick_drops WHERE chat_id = ? ORDER BY detected_at DESC LIMIT 10'
    ).bind(chatId).all();

    if (!rows.results?.length) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'No drop alerts yet.', { parse_mode: 'HTML' });
      return c.text('OK');
    }

    const list = rows.results.map(r => {
      const time = new Date(r.detected_at).toLocaleString();
      return `• <b>${r.channel_slug}</b>: ${r.title}\\n<i>${time}</i>`;
    }).join('\\n');

    await tg.sendMessage(c.env.BOT_TOKEN, chatId, `🎁 <b>Recent Drop Alerts:</b>\\n${list}`, { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const info = await fetchChannelInfo(slug, c.env);
  if (!info?.livestream) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, `${slug} is offline.`);
    return c.text('OK');
  }

  const { detectDrops } = await import('../kick/drops.js');
  await detectDrops(c.env, chatId, { slug, name: slug }, info.livestream);
  return c.text('OK');
}

export async function kickSetNotify(c, update, parsed) {
  const chatId = update.message.chat.id;
  if (update.message.chat.type === 'private') {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'Run this in a group.');
    return c.text('OK');
  }
  await c.env.KV.put('default_notify_group', chatId.toString());
  await tg.sendMessage(c.env.BOT_TOKEN, chatId,
    '✅ This group is now the default notification channel.');
  return c.text('OK');
}

export async function kickLink(c, update, parsed) {
  const chatId = update.message.chat.id;
  if (!c.env.KICK_CLIENT_ID) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'OAuth not configured.');
    return c.text('OK');
  }
  const state = crypto.randomUUID();
  await c.env.KV.put(`oauth_state:${state}`, chatId.toString(), { expirationTtl: 600 });

  const host = c.req.header('host');
  const redirectUri = `https://${host}/kick/oauth/callback`;
  const authUrl = `https://id.kick.com/oauth/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: c.env.KICK_CLIENT_ID, redirect_uri: redirectUri,
    scope: 'chat:write channel:read channel:write moderation:ban moderation:timeout user:read events:subscribe', state
  });

  await tg.sendMessage(c.env.BOT_TOKEN, chatId,
    `🔗 <a href=\"${authUrl}\">Link your Kick account</a>`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function kickClips(c, update, parsed) {
  const chatId = update.message.chat.id;
  const slug = (parsed.args || c.env.OWNER_KICK_SLUG).trim().toLowerCase();
  const clips = await fetchChannelClips(slug, 5);
  if (!clips.length) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'No recent clips.');
    return c.text('OK');
  }

  const list = clips.map((clip, i) => `${i+1}. <b>${clip.title || 'Clip'}</b> — <a href=\"https://kick.com/${slug}?clip=${clip.id}\">Watch</a>`).join('\\n');
  await tg.sendMessage(c.env.BOT_TOKEN, chatId, `🎬 <b>${slug}</b> Clips:\\n${list}`, { parse_mode: 'HTML' });
  return c.text('OK');
}
