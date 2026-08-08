import { fetchChannelInfo } from './api';
import { formatAlert } from './alerts';
import { tg } from '../telegram';
import { detectDrops } from './drops';

const MILESTONES = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];

export async function runMonitor(ctx) {
  const { env } = ctx;

  const rows = await env.DB.prepare(
    `SELECT * FROM kick_channels
     WHERE active = 1
     ORDER BY
       CASE WHEN slug = ? THEN 0 ELSE 1 END,
       last_checked ASC
     LIMIT 40`
  ).bind(env.OWNER_KICK_SLUG).all();

  const channels = rows.results || [];
  if (channels.length === 0) return;

  await Promise.all(channels.map(ch => checkChannel(ch, env).catch(e => {
    console.error(`Monitor error for ${ch.slug}:`, e);
  })));
}

async function checkChannel(ch, env) {
  const info = await fetchChannelInfo(ch.slug);
  if (!info) {
    await env.DB.prepare('UPDATE kick_channels SET last_checked = ? WHERE id = ?')
      .bind(Date.now(), ch.id).run();
    return;
  }

  const livestream = info.livestream;
  const isLive = !!livestream;
  const wasLive = ch.last_is_live === 1;

  const defaultGroup = await env.KV.get('default_notify_group');
  const notifyChatId = ch.notify_chat_id || (defaultGroup ? parseInt(defaultGroup) : null);

  if (!notifyChatId) return;

  if (isLive && !wasLive) {
    await sendAlert(env, notifyChatId, ch, 'live', livestream);
    await env.DB.prepare(
      'INSERT INTO kick_stream_history (channel_slug, started_at, title, category) VALUES (?, ?, ?, ?)'
    ).bind(ch.slug, Date.now(), livestream.session_title, livestream.categories?.[0]?.name).run();
  }
  else if (!isLive && wasLive) {
    await sendAlert(env, notifyChatId, ch, 'offline', null);
    await env.DB.prepare(
      'UPDATE kick_stream_history SET ended_at = ? WHERE channel_slug = ? AND ended_at IS NULL'
    ).bind(Date.now(), ch.slug).run();
  }
  else if (isLive && wasLive) {
    if (livestream.session_title !== ch.last_title) {
      await sendAlert(env, notifyChatId, ch, 'title_change', livestream);
    }
    if (livestream.categories?.[0]?.name !== ch.last_category) {
      await sendAlert(env, notifyChatId, ch, 'category_change', livestream);
    }

    const oldViewers = ch.last_viewer_count || 0;
    const newViewers = livestream.viewer_count || 0;
    for (const m of MILESTONES) {
      if (oldViewers < m && newViewers >= m) {
        await sendAlert(env, notifyChatId, ch, 'milestone', livestream, m);
      }
    }

    await detectDrops(env, notifyChatId, ch, livestream);

    await env.DB.prepare(
      'UPDATE kick_stream_history SET peak_viewers = MAX(peak_viewers, ?) WHERE channel_slug = ? AND ended_at IS NULL'
    ).bind(newViewers, ch.slug).run();
  }

  await env.DB.prepare(
    `UPDATE kick_channels SET
      last_is_live = ?, last_title = ?, last_viewer_count = ?,
      last_category = ?, last_checked = ? WHERE id = ?`
  ).bind(
    isLive ? 1 : 0,
    livestream?.session_title || null,
    livestream?.viewer_count || 0,
    livestream?.categories?.[0]?.name || null,
    Date.now(),
    ch.id
  ).run();
}

async function sendAlert(env, chatId, ch, type, livestream, milestone = null) {
  const cooldownKey = `kick_cd:${ch.slug}:${type}:${chatId}`;
  const lastSent = await env.KV.get(cooldownKey);
  if (lastSent && (Date.now() - parseInt(lastSent)) < 300000) return;

  const text = formatAlert(ch.slug, type, livestream, milestone, ch.name);

  try {
    await tg.sendMessage(env.BOT_TOKEN, chatId, text, { parse_mode: 'HTML', disable_web_page_preview: false });
    await env.KV.put(cooldownKey, Date.now().toString(), { expirationTtl: 600 });
    await env.DB.prepare(
      'INSERT INTO kick_alert_log (channel_slug, alert_type, sent_at, chat_id) VALUES (?, ?, ?, ?)'
    ).bind(ch.slug, type, Date.now(), chatId).run();
  } catch (e) {
    console.error(`Failed to send alert for ${ch.slug}:`, e);
  }
}
