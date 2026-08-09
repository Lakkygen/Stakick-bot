// src/kick/monitor.js

import { tg } from '../telegram';

/**
 * ============================================================
 * KICK STREAM MONITORING
 * ============================================================
 */

export async function runMonitor({ env, executionCtx }) {
  try {
    // 1. Check all monitored channels for live status
    await checkStreams(env);

    // 2. NEW: Early drop detection
    await checkKickDropsEarly(env);

  } catch (err) {
    console.error('runMonitor error:', err);
  }
}

/**
 * ============================================================
 * STREAM CHECKING (existing functionality)
 * ============================================================
 */

async function checkStreams(env) {
  const channels = await env.DB.prepare(
    `SELECT * FROM kick_channels WHERE active = 1`
  ).all();

  if (!channels.results?.length) return;

  for (const ch of channels.results) {
    try {
      const liveRes = await fetch(`https://kick.com/api/v2/channels/${ch.slug}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!liveRes.ok) continue;

      const data = await liveRes.json();
      const livestream = data.livestream;
      const isLive = Boolean(livestream);

      // Detect going live
      if (isLive && !ch.last_is_live) {
        await alertLive(env, ch, livestream);
        await env.DB.prepare(
          `UPDATE kick_channels SET last_is_live = 1, last_title = ?, last_viewer_count = ?, last_category = ?, last_checked = ? WHERE id = ?`
        ).bind(livestream.session_title || '', livestream.viewer_count || 0, livestream.categories?.[0]?.name || '', Date.now(), ch.id).run();
      }

      // Detect going offline
      if (!isLive && ch.last_is_live) {
        await alertOffline(env, ch);
        await env.DB.prepare(
          `UPDATE kick_channels SET last_is_live = 0, last_checked = ? WHERE id = ?`
        ).bind(Date.now(), ch.id).run();
      }

      // Update last checked regardless
      await env.DB.prepare(
        `UPDATE kick_channels SET last_checked = ? WHERE id = ?`
      ).bind(Date.now(), ch.id).run();

    } catch (err) {
      console.error(`Stream check failed for ${ch.slug}:`, err);
    }
  }
}

async function alertLive(env, ch, livestream) {
  const title = livestream.session_title || 'Live now!';
  const viewers = livestream.viewer_count || 0;
  const category = livestream.categories?.[0]?.name || 'Just Chatting';

  const message = `🔴 <b>${ch.name || ch.slug} is LIVE!</b>\n\n` +
    `📺 ${title}\n` +
    `👥 ${viewers.toLocaleString()} viewers\n` +
    `🏷️ ${category}\n\n` +
    `👉 https://kick.com/${ch.slug}`;

  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
}

async function alertOffline(env, ch) {
  const message = `⚫ <b>${ch.name || ch.slug}</b> has gone offline.`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
}

/**
 * ============================================================
 * EARLY DROP DETECTION (NEW FEATURE)
 * ============================================================
 *
 * Polls Kick's internal drops API faster than the web UI
 * to alert groups before drops appear on the campaign page.
 *
 * ============================================================
 */

async function checkKickDropsEarly(env) {
  try {
    // Kick's undocumented campaigns endpoint
    const res = await fetch('https://kick.com/api/v2/drops/campaigns?active=true', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) {
      console.error('Kick drops API failed:', res.status);
      return;
    }

    const data = await res.json();
    const campaigns = data.campaigns || data.data || [];

    if (!campaigns.length) return;

    // Get all groups that want drop alerts
    const channels = await env.DB.prepare(
      `SELECT DISTINCT notify_chat_id FROM kick_channels WHERE active = 1`
    ).all();

    const chatIds = (channels.results || []).map(r => r.notify_chat_id).filter(Boolean);
    if (!chatIds.length) return;

    for (const campaign of campaigns) {
      const campaignId = campaign.id || campaign.campaign_id;
      if (!campaignId) continue;

      // Skip if already alerted
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

      const message = `🎁 <b>EARLY DROP DETECTED</b>\n\n` +
        `💰 Reward: <b>${reward}</b>\n` +
        `📺 Streamer: <b>${streamer}</b>\n` +
        `📝 ${dropTitle}\n` +
        `${timeLeft ? timeLeft + '\n' : ''}` +
        `\n⚡ Not yet visible on Kick campaign page!\n` +
        `👉 Go live at https://kick.com/${streamer} NOW to claim before everyone else!`;

      // Alert all monitored groups
      for (const chatId of chatIds) {
        try {
          await tg.sendMessage(env.BOT_TOKEN, chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (err) {
          console.error(`Drop alert failed for chat ${chatId}:`, err);
        }
      }

      // Log to database
      try {
        await env.DB.prepare(
          `INSERT INTO kick_drops (channel_slug, stream_id, title, detected_at, chat_id) VALUES (?, ?, ?, ?, ?)`
        ).bind(streamer, campaignId, dropTitle, Date.now(), chatIds[0]).run();
      } catch (e) {
        // Table might not exist or conflict, ignore
      }

      // Mark as alerted (expires in 24h)
      await env.KV.put(`drop_alerted:${campaignId}`, '1', { expirationTtl: 86400 });

      console.log(`Early drop alerted: ${dropTitle} for ${streamer}`);
    }

  } catch (err) {
    console.error('checkKickDropsEarly error:', err);
  }
}
