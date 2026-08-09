// src/kick/monitor.js
import { tg } from '../telegram';

const VIEWER_MILESTONES = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

export async function runMonitor({ env, executionCtx }) {
  console.log('🔥 runMonitor ENTERED at', new Date().toISOString());

  try {
    await checkStreams(env);
    await checkKickDropsEarly(env);
  } catch (err) {
    console.error('💀 runMonitor fatal:', err);
  }
}

// ============================================================
// STREAM CHECKING – with full logging & fallback
// ============================================================

async function checkStreams(env) {
  console.log('📡 checkStreams() called');

  const channels = await env.DB.prepare(
    `SELECT * FROM kick_channels WHERE active = 1`
  ).all();

  if (!channels.results?.length) {
    console.log('⚠️ No active channels found in DB.');
    return;
  }

  console.log(`✅ Found ${channels.results.length} active channels.`);

  for (const ch of channels.results) {
    try {
      const url = `https://kick.com/api/v2/channels/${ch.slug}`;
      console.log(`🌐 Fetching ${url} ...`);

      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      let data, livestream, isLive, currentViewers;

      if (!res.ok) {
        console.error(`❌ ${ch.slug} API error: ${res.status} ${res.statusText}`);
        console.log(`🔄 Trying fallback /livestream for ${ch.slug}`);
        const fallbackRes = await fetch(`https://kick.com/api/v2/channels/${ch.slug}/livestream`, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        if (!fallbackRes.ok) {
          console.error(`❌ Fallback also failed for ${ch.slug}`);
          continue;
        }
        const fallbackData = await fallbackRes.json();
        livestream = fallbackData.livestream || fallbackData;
        isLive = Boolean(livestream);
        currentViewers = livestream?.viewer_count || 0;
        // we'll process with this data
        await processStream(env, ch, livestream, isLive, currentViewers);
        continue;
      }

      data = await res.json();
      livestream = data.livestream;
      isLive = Boolean(livestream);
      currentViewers = livestream?.viewer_count || 0;

      console.log(`📊 ${ch.slug}: isLive=${isLive}, viewers=${currentViewers}`);

      await processStream(env, ch, livestream, isLive, currentViewers);

    } catch (err) {
      console.error(`💥 Stream check crash for ${ch.slug}:`, err.message);
    }
  }
}

async function processStream(env, ch, livestream, isLive, currentViewers) {
  // Going live
  if (isLive && !ch.last_is_live) {
    console.log(`🔴 ${ch.slug} went LIVE!`);
    await alertLive(env, ch, livestream);
    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live = 1, last_title = ?, last_viewer_count = ?, last_category = ?, last_checked = ? WHERE id = ?`
    ).bind(
      livestream.session_title || '',
      currentViewers,
      livestream.categories?.[0]?.name || '',
      Date.now(),
      ch.id
    ).run();
  }

  // Going offline
  if (!isLive && ch.last_is_live) {
    console.log(`⚫ ${ch.slug} went OFFLINE`);
    await alertOffline(env, ch);
    await env.DB.prepare(
      `UPDATE kick_channels SET last_is_live = 0, last_checked = ? WHERE id = ?`
    ).bind(Date.now(), ch.id).run();
    await clearMilestones(env, ch.slug);
  }

  // Viewer milestones
  if (isLive && currentViewers > (ch.last_viewer_count || 0)) {
    await checkViewerMilestones(env, ch, currentViewers);
    await env.DB.prepare(
      `UPDATE kick_channels SET last_viewer_count = ?, last_checked = ? WHERE id = ?`
    ).bind(currentViewers, Date.now(), ch.id).run();
  }

  // Always update last_checked
  await env.DB.prepare(
    `UPDATE kick_channels SET last_checked = ? WHERE id = ?`
  ).bind(Date.now(), ch.id).run();
}

// ============================================================
// ALERTS (unchanged)
// ============================================================

async function alertLive(env, ch, livestream) {
  const title = livestream.session_title || 'Live now!';
  const viewers = livestream.viewer_count || 0;
  const category = livestream.categories?.[0]?.name || 'Just Chatting';
  const message = `🔴 <b>${ch.name || ch.slug} is LIVE!</b>\n\n📺 ${title}\n👥 ${viewers.toLocaleString()} viewers\n🏷️ ${category}\n\n👉 https://kick.com/${ch.slug}`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
}

async function alertOffline(env, ch) {
  const message = `⚫ <b>${ch.name || ch.slug}</b> has gone offline.`;
  await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
}

// ============================================================
// MILESTONES (unchanged)
// ============================================================

async function checkViewerMilestones(env, ch, currentViewers) {
  const lastCount = ch.last_viewer_count || 0;
  for (const milestone of VIEWER_MILESTONES) {
    if (currentViewers >= milestone && lastCount < milestone) {
      const milestoneKey = `milestone:${ch.slug}:${milestone}`;
      const alreadyAlerted = await env.KV.get(milestoneKey);
      if (alreadyAlerted) continue;
      const message = `📈 <b>${ch.name || ch.slug} hit ${milestone.toLocaleString()} viewers!</b>\n\n🔴 Currently live with ${currentViewers.toLocaleString()} viewers\n👉 https://kick.com/${ch.slug}`;
      try {
        await tg.sendMessage(env.BOT_TOKEN, ch.notify_chat_id, message, { parse_mode: 'HTML' });
        await env.KV.put(milestoneKey, '1', { expirationTtl: 21600 });
      } catch (err) {
        console.error(`Milestone alert failed for ${ch.slug}:`, err);
      }
    }
  }
}

async function clearMilestones(env, slug) {
  for (const milestone of VIEWER_MILESTONES) {
    await env.KV.delete(`milestone:${slug}:${milestone}`);
  }
}

// ============================================================
// DROP DETECTION (your exact functions – kept intact)
// ============================================================

async function checkKickDropsEarly(env) {
  try {
    await checkScheduledDrops(env);
    await checkActiveDrops(env);
  } catch (err) {
    console.error('checkKickDropsEarly error:', err);
  }
}

async function checkScheduledDrops(env) {
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
            console.error(`Upcoming drop alert failed for chat ${chatId}:`, err);
          }
        }

        await env.KV.put(upcomingKey, '1', { expirationTtl: 7200 });
      }
    }
  } catch (err) {
    console.error('checkScheduledDrops error:', err);
  }
}

async function checkActiveDrops(env) {
  try {
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
          console.error(`Drop alert failed for chat ${chatId}:`, err);
        }
      }

      try {
        await env.DB.prepare(
          `INSERT INTO kick_drops (channel_slug, stream_id, title, detected_at, chat_id) VALUES (?, ?, ?, ?, ?)`
        ).bind(streamer, campaignId, dropTitle, Date.now(), chatIds[0]).run();
      } catch (e) {
        // ignore
      }

      await env.KV.put(`drop_alerted:${campaignId}`, '1', { expirationTtl: 86400 });
      console.log(`Early drop alerted: ${dropTitle} for ${streamer}`);
    }
  } catch (err) {
    console.error('checkActiveDrops error:', err);
  }
}
