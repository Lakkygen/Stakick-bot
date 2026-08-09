// src/kick/monitor.js
//
// WHAT THIS FILE DOES:
// 1. Watches Kick channels YOU added via /kickadd
// 2. Alerts when they go LIVE or OFFLINE
// 3. Alerts viewer milestones (500, 1K, 2.5K, 5K, 10K, 25K, 50K, 100K)
// 4. Detects ACTIVE drops on your monitored channels via Kick API
// 5. Polls aggressively (3x per minute) to catch drops fast
//
// WHAT IT DOES NOT DO:
// - Predict random drops before they hit Kick's API
// - Monitor viewer accounts like stake-will or stakecharlie
// - Read web page floating indicators (no public API for that)

import { tg } from '../telegram';

// ============================================================
// CONFIG
// ============================================================

const VIEWER_MILESTONES = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

// ============================================================
// MAIN MONITOR (runs every 60s via cron)
// ============================================================

export async function runMonitor({ env, executionCtx }) {
  try {
    // Poll 3 times within the 1-minute cron window for speed
    await checkStreams(env);
    await sleep(15000);
    await checkStreams(env);
    await sleep(15000);
    await checkStreams(env);

    // Check drops 2x per minute
    await checkDropsForMonitoredStreamers(env);
    await sleep(10000);
    await checkDropsForMonitoredStreamers(env);

  } catch (err) {
    console.error('runMonitor error:', err);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// STREAM CHECKING (live / offline / milestones)
// ============================================================

async function checkStreams(env) {
  const channels = await env.DB.prepare(
    `SELECT * FROM kick_channels WHERE active = 1`
  ).all();

  if (!channels.results?.length) return;

  for (const ch of channels.results) {
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${ch.slug}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!res.ok) continue;

      const data = await res.json();
      const livestream = data.livestream;
      const isLive = Boolean(livestream);
      const currentViewers = livestream?.viewer_count || 0;

      // --- GOING LIVE ---
      if (isLive && !ch.last_is_live) {
        await alertLive(env, ch, livestream);
        await updateChannel(env, ch.id, {
          last_is_live: 1,
          last_title: livestream.session_title || '',
          last_viewer_count: currentViewers,
          last_category: livestream.categories?.[0]?.name || '',
        });
      }

      // --- GOING OFFLINE ---
      if (!isLive && ch.last_is_live) {
        await alertOffline(env, ch);
        await updateChannel(env, ch.id, { last_is_live: 0 });
        await clearMilestones(env, ch.slug);
      }

      // --- VIEWER MILESTONES (only when live) ---
      if (isLive && currentViewers > (ch.last_viewer_count || 0)) {
        await checkViewerMilestones(env, ch, currentViewers);
        await env.DB.prepare(
          `UPDATE kick_channels SET last_viewer_count = ? WHERE id = ?`
        ).bind(currentViewers, ch.id).run();
      }

      // --- Always update last_checked ---
      await env.DB.prepare(
        `UPDATE kick_channels SET last_checked = ? WHERE id = ?`
      ).bind(Date.now(), ch.id).run();

    } catch (err) {
      console.error(`Stream check failed for ${ch.slug}:`, err);
    }
  }
}

// ============================================================
// ALERTS
// ============================================================

async function alertLive(env, ch, livestream) {
  const title = livestream.session_title || 'Live now!';
  const viewers = livestream.viewer_count || 0;
  const category = livestream.categories?.[0]?.name || 'Just Chatting';

  const msg = `🔴 <b>${ch.name || ch.slug} is LIVE!</b>\n\n` +
    `📺 ${title}\n` +
    `👥 ${viewers.toLocaleString()} viewers\n` +
    `🏷️ ${category}\n\n` +
    `👉 https://kick.com/${ch.slug}`;

  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, msg, { parse_mode: 'HTML' });
}

async function alertOffline(env, ch) {
  const msg = `⚫ <b>${ch.name || ch.slug}</b> has gone offline.`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, msg, { parse_mode: 'HTML' });
}

// ============================================================
// VIEWER MILESTONES
// ============================================================

async function checkViewerMilestones(env, ch, currentViewers) {
  const lastCount = ch.last_viewer_count || 0;

  for (const milestone of VIEWER_MILESTONES) {
    if (currentViewers >= milestone && lastCount < milestone) {
      const key = `milestone:${ch.slug}:${milestone}`;
      const alreadyAlerted = await env.KV.get(key);
      if (alreadyAlerted) continue;

      const msg = `📈 <b>${ch.name || ch.slug} hit ${milestone.toLocaleString()} viewers!</b>\n\n` +
        `🔴 Currently live with ${currentViewers.toLocaleString()} viewers\n` +
        `👉 https://kick.com/${ch.slug}`;

      try {
        await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, msg, { parse_mode: 'HTML' });
        await env.KV.put(key, '1', { expirationTtl: 21600 }); // 6 hours
      } catch (err) {
        console.error(`Milestone alert failed: ${err.message}`);
      }
    }
  }
}

async function clearMilestones(env, slug) {
  for (const m of VIEWER_MILESTONES) {
    await env.KV.delete(`milestone:${slug}:${m}`);
  }
}

// ============================================================
// DROP DETECTION — MONITORED STREAMERS ONLY
// ============================================================
//
// This polls Kick's campaigns API and ONLY alerts if the drop
// belongs to a streamer you added via /kickadd.
//
// HONEST LIMITATIONS:
// - Only sees drops when Kick's API lists them as active
// - Cannot see drops before they hit the API
// - Cannot monitor viewer accounts (stake-will, stakecharlie)
// - Typical delay: 0-30 seconds behind the actual drop start
// ============================================================

async function checkDropsForMonitoredStreamers(env) {
  try {
    // 1. Get your monitored channels
    const channels = await env.DB.prepare(
      `SELECT slug, notify_chat_id FROM kick_channels WHERE active = 1`
    ).all();

    if (!channels.results?.length) return;

    const monitoredSlugs = channels.results.map(r => r.slug.toLowerCase());
    const chatMap = {};
    for (const r of channels.results) {
      chatMap[r.slug.toLowerCase()] = r.notify_chat_id;
    }

    // 2. Fetch active campaigns from Kick
    const res = await fetch('https://kick.com/api/v2/drops/campaigns?active=true', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) return;

    const data = await res.json();
    const campaigns = data.campaigns || data.data || [];
    if (!campaigns.length) return;

    // 3. Filter to YOUR streamers only
    for (const campaign of campaigns) {
      const campaignId = campaign.id || campaign.campaign_id;
      if (!campaignId) continue;

      const streamerSlug = (
        campaign.streamer?.username ||
        campaign.channel?.slug ||
        campaign.creator?.username ||
        ''
      ).toLowerCase();

      // SKIP if this is not a streamer you monitor
      if (!monitoredSlugs.includes(streamerSlug)) continue;

      // SKIP if already alerted
      const alerted = await env.KV.get(`drop_alerted:${campaignId}`);
      if (alerted) continue;

      const dropTitle = campaign.title || campaign.name || 'Kick Drop';
      const reward = campaign.reward || campaign.reward_amount || '$5';
      const endTime = campaign.ends_at || campaign.end_date || null;

      let timeLeft = '';
      if (endTime) {
        const diff = new Date(endTime).getTime() - Date.now();
        const mins = Math.floor(diff / 60000);
        if (mins > 0) timeLeft = `⏳ ~${mins}m left`;
      }

      const msg = `🎁 <b>DROP ACTIVE — ${streamerSlug.toUpperCase()}</b>\n\n` +
        `💰 Reward: <b>${reward}</b>\n` +
        `📝 ${dropTitle}\n` +
        `${timeLeft ? timeLeft + '\n' : ''}` +
        `\n⚡ DROP IS LIVE NOW!\n` +
        `👉 https://kick.com/${streamerSlug}\n\n` +
        `🔥 Join immediately and stay until you claim!`;

      const chatId = chatMap[streamerSlug];
      if (chatId) {
        try {
          await tg.sendMessage(env.BOT_TOKEN, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (err) {
          console.error(`Drop alert failed for ${streamerSlug}:`, err.message);
        }
      }

      // Log to database
      try {
        await env.DB.prepare(
          `INSERT INTO kick_drops (channel_slug, stream_id, title, detected_at, chat_id) VALUES (?, ?, ?, ?, ?)`
        ).bind(streamerSlug, campaignId, dropTitle, Date.now(), chatId).run();
      } catch (e) {
        // ignore duplicates
      }

      // Mark alerted (24h expiry)
      await env.KV.put(`drop_alerted:${campaignId}`, '1', { expirationTtl: 86400 });
      console.log(`Drop alerted: ${streamerSlug} — ${dropTitle}`);
    }

  } catch (err) {
    console.error('checkDrops error:', err.message);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function updateChannel(env, id, fields) {
  const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), id];
  await env.DB.prepare(`UPDATE kick_channels SET ${setClause}, last_checked = ? WHERE id = ?`)
    .bind(...values, Date.now(), id).run();
}
