import { tg } from '../telegram';
import { fetchChannelInfo, fetchLivestreamInfo } from './api';
import { detectDrops } from './drops';

const VIEWER_MILESTONES = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const MAX_CONCURRENT = 5;
const MAX_CHANNELS_PER_RUN = 25;
const API_TIMEOUT_MS = 8000;
const CRON_BUDGET_MS = 50000;
const BACKOFF_THRESHOLD = 3;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MINUTES = 30;

export async function runMonitor({ env, executionCtx }) {
  const runId = crypto.randomUUID().slice(0, 8);
  const runStart = Date.now();
  console.log(`[${runId}] 🔥 runMonitor ENTERED at ${new Date().toISOString()}`);

  const stats = {
    checked: 0,
    live: 0,
    offline: 0,
    alerts: 0,
    drops: 0,
    errors: 0,
    skipped: 0,
    durationMs: 0,
  };

  try {
    await checkStreams(env, runId, stats, runStart);
    await checkKickDropsEarly(env, runId, stats);
  } catch (err) {
    console.error(`[${runId}] 💀 runMonitor fatal:`, err);
    stats.errors++;
  }

  stats.durationMs = Date.now() - runStart;
  console.log(`[${runId}] ✅ runMonitor DONE in ${stats.durationMs}ms | checked=${stats.checked} live=${stats.live} offline=${stats.offline} alerts=${stats.alerts} drops=${stats.drops} errors=${stats.errors}`);

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(
      env.DB.prepare(
        'INSERT INTO bot_health_log (check_type, status, details, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        'cron_monitor',
        stats.errors > 0 ? 'warning' : 'ok',
        JSON.stringify(stats),
        stats.durationMs,
        Date.now()
      ).run().catch(() => {})
    );
  }
}

async function checkStreams(env, runId, stats, runStart) {
  console.log(`[${runId}] 📡 checkStreams() called`);

  const channels = await env.DB.prepare(
    `SELECT * FROM kick_channels WHERE active = 1 ORDER BY 
     CASE WHEN slug = ? THEN 0 ELSE 1 END,
     fail_count ASC,
     last_checked ASC`
  ).bind(env.OWNER_KICK_SLUG || 'lakkygen').all();

  if (!channels.results?.length) {
    console.log(`[${runId}] ⚠️ No active channels found in DB.`);
    return;
  }

  const toCheck = channels.results.slice(0, MAX_CHANNELS_PER_RUN);
  console.log(`[${runId}] ✅ Found ${channels.results.length} active channels. Checking ${toCheck.length} this run.`);

  const batches = [];
  for (let i = 0; i < toCheck.length; i += MAX_CONCURRENT) {
    batches.push(toCheck.slice(i, i + MAX_CONCURRENT));
  }

  for (const batch of batches) {
    if (Date.now() - runStart > CRON_BUDGET_MS) {
      console.log(`[${runId}] ⏰ Time budget exceeded. Skipping remaining ${toCheck.length - stats.checked} channels.`);
      stats.skipped += toCheck.length - stats.checked;
      break;
    }

    await Promise.all(batch.map(ch => checkSingleChannel(env, ch, runId, stats)));
  }
}

async function checkSingleChannel(env, ch, runId, stats) {
  const now = Date.now();

  if (ch.fail_count >= BACKOFF_THRESHOLD && ch.last_checked) {
    const backoffMinutes = Math.min(
      Math.pow(BACKOFF_MULTIPLIER, ch.fail_count - BACKOFF_THRESHOLD),
      MAX_BACKOFF_MINUTES
    );
    const nextCheck = ch.last_checked + (backoffMinutes * 60000);
    if (now < nextCheck) {
      console.log(`[${runId}] ⏭️ ${ch.slug} in backoff (${backoffMinutes}m). Skipping.`);
      stats.skipped++;
      return;
    }
  }

  try {
    const info = await fetchChannelInfoWithTimeout(ch.slug, env, API_TIMEOUT_MS);

    if (!info) {
      await handleChannelError(env, ch, 'fetch_null', 'Channel info returned null', runId);
      stats.errors++;
      return;
    }

    if (ch.fail_count > 0) {
      await env.DB.prepare(
        'UPDATE kick_channels SET fail_count = 0, last_error = NULL WHERE id = ?'
      ).bind(ch.id).run();
    }

    const livestream = info.livestream;
    const isLive = Boolean(livestream);
    const currentViewers = livestream?.viewer_count || 0;

    console.log(`[${runId}] 📊 ${ch.slug}: isLive=${isLive}, viewers=${currentViewers}`);
    stats.checked++;

    await processStream(env, ch, livestream, isLive, currentViewers, runId, stats);

  } catch (err) {
    console.error(`[${runId}] 💥 Stream check crash for ${ch.slug}:`, err.message);
    await handleChannelError(env, ch, 'exception', err.message, runId);
    stats.errors++;
  }
}

async function fetchChannelInfoWithTimeout(slug, env, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { fetchChannelInfo } = await import('./api.js');
    const result = await fetchChannelInfo(slug, env);
    clearTimeout(timeout);
    return result;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Request timeout');
    throw e;
  }
}

async function handleChannelError(env, ch, errorType, errorMessage, runId) {
  const newFailCount = (ch.fail_count || 0) + 1;

  await env.DB.prepare(
    'UPDATE kick_channels SET fail_count = ?, last_error = ?, last_checked = ? WHERE id = ?'
  ).bind(newFailCount, errorMessage.slice(0, 500), Date.now(), ch.id).run();

  await env.DB.prepare(
    `INSERT INTO channel_errors (channel_slug, error_type, error_message, fail_count, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_slug, error_type) DO UPDATE SET
     error_message = excluded.error_message,
     fail_count = excluded.fail_count,
     last_seen = excluded.last_seen`
  ).bind(ch.slug, errorType, errorMessage.slice(0, 500), newFailCount, Date.now(), Date.now()).run().catch(() => {});

  console.log(`[${runId}] ⚠️ ${ch.slug} error (${errorType}): ${errorMessage} | fail_count=${newFailCount}`);
}

async function processStream(env, ch, livestream, isLive, currentViewers, runId, stats) {
  const now = Date.now();

  if (isLive && !ch.last_is_live) {
    console.log(`[${runId}] 🔴 ${ch.slug} went LIVE!`);
    await alertLive(env, ch, livestream);
    await logStreamStart(env, ch, livestream);
    stats.alerts++;

    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live = 1, last_title = ?, last_viewer_count = ?, last_category = ?, last_checked = ? WHERE id = ?`
    ).bind(
      livestream.session_title || '',
      currentViewers,
      livestream.categories?.[0]?.name || '',
      now,
      ch.id
    ).run();

    try {
      const dropResult = await detectDrops(env, ch.notify_chat_id, { slug: ch.slug, name: ch.name }, livestream);
      if (dropResult.matched && !dropResult.alreadyAlerted && !dropResult.cooledDown) {
        stats.drops++;
      }
    } catch (e) {
      console.error(`[${runId}] Drop detection error for ${ch.slug}:`, e.message);
    }
  }

  if (!isLive && ch.last_is_live) {
    console.log(`[${runId}] ⚫ ${ch.slug} went OFFLINE`);
    await alertOffline(env, ch);
    await logStreamEnd(env, ch);
    stats.offline++;

    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live = 0, last_viewer_count = 0, last_checked = ? WHERE id = ?`
    ).bind(now, ch.id).run();

    await clearMilestones(env, ch.slug);
  }

  if (isLive && ch.last_is_live) {
    const newTitle = livestream.session_title || '';
    if (newTitle && newTitle !== ch.last_title) {
      console.log(`[${runId}] 📝 ${ch.slug} title changed: "${ch.last_title}" -> "${newTitle}"`);
      await alertTitleChange(env, ch, livestream);
      stats.alerts++;
    }

    const newCategory = livestream.categories?.[0]?.name || '';
    if (newCategory && newCategory !== ch.last_category) {
      console.log(`[${runId}] 🏷 ${ch.slug} category changed: "${ch.last_category}" -> "${newCategory}"`);
      await alertCategoryChange(env, ch, livestream);
      stats.alerts++;
    }

    if (currentViewers > (ch.last_viewer_count || 0)) {
      const milestoneAlerted = await checkViewerMilestones(env, ch, currentViewers, runId);
      if (milestoneAlerted) stats.alerts++;
    }

    await env.DB.prepare(
      `UPDATE kick_channels SET last_title = ?, last_viewer_count = ?, last_category = ?, last_checked = ? WHERE id = ?`
    ).bind(newTitle, currentViewers, newCategory, now, ch.id).run();

    stats.live++;
  }

  if (!isLive && !ch.last_is_live) {
    await env.DB.prepare(
      'UPDATE kick_channels SET last_checked = ? WHERE id = ?'
    ).bind(now, ch.id).run();
  }
}

async function alertLive(env, ch, livestream) {
  const title = livestream.session_title || 'Live now!';
  const viewers = livestream.viewer_count || 0;
  const category = livestream.categories?.[0]?.name || 'Just Chatting';
  const message = `🔴 <b>${ch.name || ch.slug} is LIVE!</b>\n\n📺 ${title}\n👥 ${viewers.toLocaleString()} viewers\n🏷️ ${category}\n\n👉 https://kick.com/${ch.slug}`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
  await logAlert(env, ch.slug, 'live', ch.notify_chat_id);
}

async function alertOffline(env, ch) {
  const message = `⚫ <b>${ch.name || ch.slug}</b> has gone offline.`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
  await logAlert(env, ch.slug, 'offline', ch.notify_chat_id);
}

async function alertTitleChange(env, ch, livestream) {
  const message = `📝 <b>${ch.name || ch.slug}</b> updated title:\n<i>${livestream.session_title}</i>\n🔗 https://kick.com/${ch.slug}`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
  await logAlert(env, ch.slug, 'title_change', ch.notify_chat_id);
}

async function alertCategoryChange(env, ch, livestream) {
  const message = `🏷 <b>${ch.name || ch.slug}</b> switched to <b>${livestream.categories?.[0]?.name}</b>\n👁 ${livestream.viewer_count?.toLocaleString()} viewers\n🔗 https://kick.com/${ch.slug}`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
  await logAlert(env, ch.slug, 'category_change', ch.notify_chat_id);
}

async function logAlert(env, slug, type, chatId) {
  await env.DB.prepare(
    'INSERT INTO kick_alert_log (channel_slug, alert_type, sent_at, chat_id) VALUES (?, ?, ?, ?)'
  ).bind(slug, type, Date.now(), chatId).run().catch(() => {});
}

async function logStreamStart(env, ch, livestream) {
  await env.DB.prepare(
    `INSERT INTO kick_stream_history (channel_slug, started_at, title, category, peak_viewers)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    ch.slug,
    Date.now(),
    livestream.session_title || null,
    livestream.categories?.[0]?.name || null,
    livestream.viewer_count || 0
  ).run().catch(() => {});
}

async function logStreamEnd(env, ch) {
  await env.DB.prepare(
    `UPDATE kick_stream_history SET ended_at = ?
     WHERE channel_slug = ? AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`
  ).bind(Date.now(), ch.slug).run().catch(() => {});
}

async function checkViewerMilestones(env, ch, currentViewers, runId) {
  const lastCount = ch.last_viewer_count || 0;
  let alerted = false;

  for (const milestone of VIEWER_MILESTONES) {
    if (currentViewers >= milestone && lastCount < milestone) {
      const milestoneKey = `milestone:${ch.slug}:${milestone}`;
      const alreadyAlerted = await env.KV.get(milestoneKey);
      if (alreadyAlerted) continue;

      const message = `📈 <b>${ch.name || ch.slug} hit ${milestone.toLocaleString()} viewers!</b>\n\n🔴 Currently live with ${currentViewers.toLocaleString()} viewers\n👉 https://kick.com/${ch.slug}`;
      try {
        await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
        await env.KV.put(milestoneKey, '1', { expirationTtl: 21600 });
        await logAlert(env, ch.slug, `milestone_${milestone}`, ch.notify_chat_id);
        alerted = true;
        console.log(`[${runId}] 🎉 ${ch.slug} milestone ${milestone}!`);
      } catch (err) {
        console.error(`Milestone alert failed for ${ch.slug}:`, err);
      }
    }
  }
  return alerted;
}

async function clearMilestones(env, slug) {
  for (const milestone of VIEWER_MILESTONES) {
    await env.KV.delete(`milestone:${slug}:${milestone}`);
  }
}

async function checkKickDropsEarly(env, runId, stats) {
  try {
    await checkScheduledDrops(env, runId, stats);
    await checkActiveDrops(env, runId, stats);
  } catch (err) {
    console.error(`[${runId}] checkKickDropsEarly error:`, err);
  }
}

async function checkScheduledDrops(env, runId, stats) {
  try {
    const res = await fetch('https://kick.com/api/v2/drops/campaigns', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) return;

    const data = await res.json();
    const campaigns = data.campaigns || data.data || [];
    if (!campaigns.length) return;

    const channels = await env.DB.prepare(
      `SELECT DISTINCT notify_chat_id FROM kick_channels WHERE active = 1`
    ).all();

    const chatIds = (channels.results || []).map(r => r.notify_chat_id).filter(Boolean);
    if (!chatIds.length) return;

    const now = Date.now();

    for (const campaign of campaigns) {
      const campaignId = campaign.id || campaign.campaign_id;
      if (!campaignId) continue;

      const startTime = campaign.starts_at || campaign.start_date || campaign.scheduled_at;
      if (!startTime) continue;

      const startMs = new Date(startTime).getTime();
      const minutesUntilStart = Math.floor((startMs - now) / 60000);

      if (minutesUntilStart > 0 && minutesUntilStart <= 10) {
        const upcomingKey = `drop_upcoming:${campaignId}`;
        const alreadyAlerted = await env.KV.get(upcomingKey);
        if (alreadyAlerted) continue;

        const dropTitle = campaign.title || campaign.name || 'Kick Drop';
        const reward = campaign.reward || campaign.reward_amount || '$5';
        const streamer = campaign.streamer?.username || campaign.channel?.slug || campaign.creator?.username || 'a streamer';

        const message = `⏰ <b>DROP STARTING SOON</b>\n\n💰 Reward: <b>${reward}</b>\n📺 Streamer: <b>${streamer}</b>\n📝 ${dropTitle}\n⏳ Starts in <b>${minutesUntilStart} minute${minutesUntilStart !== 1 ? 's' : ''}</b>\n\n👉 Get ready at https://kick.com/${streamer}\n⚡ Be live BEFORE it starts to secure your spot!`;

        for (const chatId of chatIds) {
          try {
            await tg.sendMessage(env.BOT_TOKEN, chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
          } catch (err) {
            console.error(`[${runId}] Upcoming drop alert failed for chat ${chatId}:`, err);
          }
        }

        await env.KV.put(upcomingKey, '1', { expirationTtl: 7200 });
        stats.drops++;
      }
    }
  } catch (err) {
    console.error(`[${runId}] checkScheduledDrops error:`, err);
  }
}

async function checkActiveDrops(env, runId, stats) {
  try {
    const res = await fetch('https://kick.com/api/v2/drops/campaigns?active=true', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) {
      console.error(`[${runId}] Kick drops API failed:`, res.status);
      return;
    }

    const data = await res.json();
    const campaigns = data.campaigns || data.data || [];
    if (!campaigns.length) return;

    const channels = await env.DB.prepare(
      `SELECT DISTINCT notify_chat_id FROM kick_channels WHERE active = 1`
    ).all();

    const chatIds = (channels.results || []).map(r => r.notify_chat_id).filter(Boolean);
    if (!chatIds.length) return;

    for (const campaign of campaigns) {
      const campaignId = campaign.id || campaign.campaign_id;
      if (!campaignId) continue;

      const alreadyAlerted = await env.KV.get(`drop_alerted:${campaignId}`);
      if (alreadyAlerted) continue;

      const dropTitle = campaign.title || campaign.name || 'New Kick Drop';
      const reward = campaign.reward || campaign.reward_amount || '$5';
      const streamer = campaign.streamer?.username || campaign.channel?.slug || campaign.creator?.username || 'a streamer';
      const endTime = campaign.ends_at || campaign.end_date || null;

      let timeLeft = '';
      if (endTime) {
        const diff = new Date(endTime).getTime() - Date.now();
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        timeLeft = hours > 0 ? `⏳ ~${hours}h ${mins}m left` : `⏳ ~${mins}m left`;
      }

      const message = `🎁 <b>EARLY DROP DETECTED</b>\n\n💰 Reward: <b>${reward}</b>\n📺 Streamer: <b>${streamer}</b>\n📝 ${dropTitle}\n${timeLeft ? timeLeft + '\n' : ''}\n⚡ Not yet visible on Kick campaign page!\n👉 Go live at https://kick.com/${streamer} NOW to claim before everyone else!`;

      for (const chatId of chatIds) {
        try {
          await tg.sendMessage(env.BOT_TOKEN, chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (err) {
          console.error(`[${runId}] Drop alert failed for chat ${chatId}:`, err);
        }
      }

      try {
        await env.DB.prepare(
          `INSERT INTO kick_drops (channel_slug, stream_id, title, detected_at, chat_id) VALUES (?, ?, ?, ?, ?)`
        ).bind(streamer, campaignId, dropTitle, Date.now(), chatIds[0]).run();
      } catch (e) { /* ignore */ }

      await env.KV.put(`drop_alerted:${campaignId}`, '1', { expirationTtl: 86400 });
      console.log(`[${runId}] Early drop alerted: ${dropTitle} for ${streamer}`);
      stats.drops++;
    }
  } catch (err) {
    console.error(`[${runId}] checkActiveDrops error:`, err);
  }
}
