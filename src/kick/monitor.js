import { tg } from '../telegram';
import { fetchChannelInfo } from './api';
import { detectDrops } from './drops';

const VIEWER_MILESTONES = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const MAX_CONCURRENT = 5;
const MAX_CHANNELS_PER_RUN = 30;
const API_TIMEOUT_MS = 4000;
const CRON_BUDGET_MS = 50000;
const OFFLINE_SKIP_MS = 300000;
const BACKOFF_THRESHOLD = 2;
const MAX_BACKOFF_MINUTES = 15;

export async function runMonitor({ env, executionCtx }) {
  const runId = crypto.randomUUID().slice(0, 6);
  const runStart = Date.now();

  const stats = { checked: 0, live: 0, offline: 0, alerts: 0, drops: 0, errors: 0, skipped: 0 };

  try {
    await checkStreams(env, runId, stats, runStart);
  } catch (err) {
    stats.errors++;
  }

  const duration = Date.now() - runStart;
  console.log(`[${runId}] done ${duration}ms c=${stats.checked} l=${stats.live} o=${stats.offline} a=${stats.alerts} d=${stats.drops} e=${stats.errors} s=${stats.skipped}`);
}

async function checkStreams(env, runId, stats, runStart) {
  const channels = await env.DB.prepare(
    `SELECT * FROM kick_channels WHERE active = 1 
     ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END, 
     last_is_live DESC, last_checked ASC`
  ).bind(env.OWNER_KICK_SLUG || 'lakkygen').all();

  if (!channels.results?.length) return;

  const toCheck = channels.results.slice(0, MAX_CHANNELS_PER_RUN);

  for (let i = 0; i < toCheck.length; i += MAX_CONCURRENT) {
    if (Date.now() - runStart > CRON_BUDGET_MS) {
      stats.skipped += toCheck.length - stats.checked;
      break;
    }
    const batch = toCheck.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(ch => checkSingleChannel(env, ch, runId, stats)));
  }
}

async function checkSingleChannel(env, ch, runId, stats) {
  const now = Date.now();

  if (!ch.last_is_live && ch.last_checked && (now - ch.last_checked) < OFFLINE_SKIP_MS) {
    stats.skipped++;
    return;
  }

  if (ch.fail_count >= BACKOFF_THRESHOLD && ch.last_checked) {
    const backoff = Math.min(Math.pow(2, ch.fail_count - BACKOFF_THRESHOLD), MAX_BACKOFF_MINUTES);
    if (now - ch.last_checked < backoff * 60000) {
      stats.skipped++;
      return;
    }
  }

  try {
    const info = await fetchWithTimeout(ch.slug, env, API_TIMEOUT_MS);
    if (!info) {
      await markFail(env, ch);
      stats.errors++;
      return;
    }

    if (ch.fail_count > 0) {
      await env.DB.prepare('UPDATE kick_channels SET fail_count = 0 WHERE id = ?').bind(ch.id).run();
    }

    const livestream = info.livestream;
    const isLive = Boolean(livestream);
    stats.checked++;

    await processStateChange(env, ch, isLive, livestream, stats);

  } catch (err) {
    await markFail(env, ch);
    stats.errors++;
  }
}

async function fetchWithTimeout(slug, env, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetchChannelInfo(slug, env);
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function processStateChange(env, ch, isLive, livestream, stats) {
  const now = Date.now();
  const title = livestream?.session_title || '';
  const category = livestream?.categories?.[0]?.name || '';
  const viewers = livestream?.viewer_count || 0;

  if (isLive && !ch.last_is_live) {
    await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id,
      `🔴 <b>${ch.name || ch.slug} LIVE!</b>\n📺 ${title}\n👁 ${viewers.toLocaleString()}\n👉 kick.com/${ch.slug}`,
      { parse_mode: 'HTML' });

    try {
      const { detectDrops } = await import('./drops.js');
      const dr = await detectDrops(env, ch.notify_chat_id, { slug: ch.slug, name: ch.name }, livestream);
      if (dr.matched && !dr.alreadyAlerted && !dr.cooledDown) stats.drops++;
    } catch (e) {}

    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live=1, last_title=?, last_viewer_count=?, last_category=?, last_checked=? WHERE id=?`
    ).bind(title, viewers, category, now, ch.id).run();

    stats.alerts++;
    stats.live++;
    return;
  }

  if (!isLive && ch.last_is_live) {
    await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id,
      `⚫ <b>${ch.name || ch.slug}</b> offline.`, { parse_mode: 'HTML' });

    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live=0, last_viewer_count=0, last_checked=? WHERE id=?`
    ).bind(now, ch.id).run();

    for (const m of VIEWER_MILESTONES) await env.KV.delete(`milestone:${ch.slug}:${m}`);

    stats.offline++;
    return;
  }

  if (isLive && ch.last_is_live) {
    if (title && title !== ch.last_title) {
      await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id,
        `📝 <b>${ch.name || ch.slug}</b> title: <i>${title}</i>`, { parse_mode: 'HTML' });
      stats.alerts++;
    }

    if (category && category !== ch.last_category) {
      await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id,
        `🏷 <b>${ch.name || ch.slug}</b> → ${category}`, { parse_mode: 'HTML' });
      stats.alerts++;
    }

    if (viewers > (ch.last_viewer_count || 0)) {
      for (const m of VIEWER_MILESTONES) {
        if (viewers >= m && (ch.last_viewer_count || 0) < m) {
          const key = `milestone:${ch.slug}:${m}`;
          if (await env.KV.get(key)) continue;
          await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id,
            `🎉 <b>${ch.name || ch.slug}</b> hit ${m.toLocaleString()} viewers!`, { parse_mode: 'HTML' });
          await env.KV.put(key, '1', { expirationTtl: 21600 });
          stats.alerts++;
        }
      }
    }

    await env.DB.prepare(
      `UPDATE kick_channels SET last_title=?, last_viewer_count=?, last_category=?, last_checked=? WHERE id=?`
    ).bind(title, viewers, category, now, ch.id).run();

    stats.live++;
    return;
  }

  await env.DB.prepare('UPDATE kick_channels SET last_checked=? WHERE id=?').bind(now, ch.id).run();
}

async function markFail(env, ch) {
  const fc = (ch.fail_count || 0) + 1;
  await env.DB.prepare('UPDATE kick_channels SET fail_count=?, last_checked=? WHERE id=?')
    .bind(fc, Date.now(), ch.id).run();
}
