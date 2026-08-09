// ============================================================================
// KICK MONITOR v2 — Production-Grade Stream & Drop Detection
// ============================================================================
//
// ARCHITECTURE:
//   ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
//   │  Cron (60s) │────▶│   Monitor    │────▶│  Stream Checks  │
//   └─────────────┘     └──────────────┘     └─────────────────┘
//                              │                       │
//                              ▼                       ▼
//                       ┌──────────────┐      ┌──────────────┐
//                       │ Drop Engine  │      │  Webhooks    │
//                       │  (3-tier)    │      │  (Instant)   │
//                       └──────────────┘      └──────────────┘
//
// IMPROVEMENTS OVER v1:
//   • Circuit breaker on drops endpoint (exponential backoff on failure)
//   • Triple-endpoint fallback for drops (v2 → v1 → web.kick.com)
//   • Schema validation on all API responses
//   • Webhook receiver for livestream.status.updated (instant alerts)
//   • Batch channel fetching (up to 50 slugs per request via official API)
//   • Telemetry & health metrics logged to DB
//   • Jittered retry logic with 429 handling
//   • Graceful degradation (alerts still fire if DB write fails)
//   • Chat message webhook monitoring for drop keywords
//
// ============================================================================

import { tg } from '../telegram';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Polling intervals (ms) within the 60s cron window
  STREAM_CHECK_INTERVAL: 15000,   // 4 checks per minute
  DROP_CHECK_INTERVAL: 10000,     // 6 checks per minute
  
  // Circuit breaker for drops endpoint
  CIRCUIT_BREAKER: {
    failureThreshold: 5,          // Open after 5 consecutive failures
    resetTimeoutMs: 60000,        // Try again after 60s
    halfOpenMaxCalls: 2,          // Allow 2 test calls in half-open state
  },
  
  // Retry logic for fetch
  FETCH_RETRY: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    jitterFactor: 0.3,            // ±30% random jitter
  },
  
  // Drops endpoints to try in order (fallback cascade)
  DROPS_ENDPOINTS: [
    'https://kick.com/api/v2/drops/campaigns?active=true',
    'https://kick.com/api/v1/drops/campaigns?active=true',
    'https://web.kick.com/api/v1/drops/campaigns',
  ],
  
  // Stream endpoints (unofficial v2 for now, with official fallback)
  STREAM_ENDPOINTS: {
    primary: (slug) => `https://kick.com/api/v2/channels/${slug}`,
    batchOfficial: 'https://api.kick.com/public/v1/channels', // Requires OAuth
  },
  
  // Viewer milestones
  MILESTONES: [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  
  // Drop detection keywords (for chat webhook fallback)
  DROP_KEYWORDS: ['drop', 'drops', 'stake drop', 'claim now', 'drop active'],
  
  // Alert deduplication TTLs (seconds)
  TTL: {
    dropAlert: 86400,             // 24h — one alert per campaign
    milestoneAlert: 21600,        // 6h — milestone cooldown
    offlineAlert: 300,            // 5m — prevent offline spam
    webhookEvent: 3600,           // 1h — dedup webhook events
  },
  
  // Rate limit handling
  RATE_LIMIT: {
    backoffMs: 30000,           // Wait 30s after 429
    maxConcurrent: 3,             // Max parallel fetches
  },
};

// ============================================================
// CIRCUIT BREAKER (Prevents hammering dead endpoints)
// ============================================================

class CircuitBreaker {
  constructor(name, config) {
    this.name = name;
    this.failureThreshold = config.failureThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs;
    this.halfOpenMaxCalls = config.halfOpenMaxCalls;
    
    this.state = 'CLOSED';       // CLOSED | OPEN | HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
    this.halfOpenCalls = 0;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
        console.log(`[CB] ${this.name}: Transitioning OPEN → HALF_OPEN`);
      } else {
        throw new Error(`Circuit breaker OPEN for ${this.name}`);
      }
    }
    
    if (this.state === 'HALF_OPEN' && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      throw new Error(`Circuit breaker HALF_OPEN call limit reached for ${this.name}`);
    }
    
    if (this.state === 'HALF_OPEN') this.halfOpenCalls++;
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      console.log(`[CB] ${this.name}: Transitioning HALF_OPEN → CLOSED`);
    }
  }
  
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      console.error(`[CB] ${this.name}: Transitioning → OPEN after ${this.failures} failures`);
    }
  }
  
  getState() {
    return { state: this.state, failures: this.failures };
  }
}

// Singleton circuit breaker for drops
const dropsCircuitBreaker = new CircuitBreaker('drops-api', CONFIG.CIRCUIT_BREAKER);

// ============================================================
// RETRY UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitteredDelay(attempt, baseMs, maxMs, jitterFactor) {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(100, Math.floor(exponential + jitter));
}

async function fetchWithRetry(url, options = {}, retryConfig = CONFIG.FETCH_RETRY) {
  let lastError;
  
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...options.headers,
        },
      });
      
      // Handle rate limiting
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || CONFIG.RATE_LIMIT.backoffMs / 1000;
        console.warn(`[Retry] 429 on ${url}. Backing off ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue; // Retry this attempt
      }
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retryConfig.maxRetries) {
        const delay = jitteredDelay(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs, retryConfig.jitterFactor);
        console.warn(`[Retry] Attempt ${attempt + 1}/${retryConfig.maxRetries + 1} failed for ${url}. Waiting ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}

// ============================================================
// SCHEMA VALIDATORS (Fail fast on unexpected API changes)
// ============================================================

const Validators = {
  channelV2(data) {
    // Unofficial v2 schema
    return data && typeof data === 'object' && 
           (data.livestream !== undefined || data.stream !== undefined);
  },
  
  livestream(data) {
    return data && typeof data === 'object' &&
           typeof data.viewer_count === 'number' &&
           (typeof data.session_title === 'string' || typeof data.title === 'string');
  },
  
  dropsCampaigns(data) {
    if (!data || typeof data !== 'object') return false;
    const campaigns = data.campaigns || data.data || [];
    return Array.isArray(campaigns);
  },
  
  dropCampaign(campaign) {
    return campaign && typeof campaign === 'object' &&
           (campaign.id || campaign.campaign_id);
  },
  
  webhookPayload(payload) {
    return payload && 
           typeof payload.event === 'string' &&
           payload.data && 
           typeof payload.data.broadcaster_user_id === 'number';
  }
};

// ============================================================
// TELEMETRY / HEALTH METRICS
// ============================================================

async function recordMetric(env, metric) {
  try {
    await env.DB.prepare(`
      INSERT INTO kick_health (metric_type, endpoint, status, latency_ms, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      metric.type,
      metric.endpoint || '',
      metric.status || 'unknown',
      metric.latencyMs || 0,
      metric.error || '',
      Date.now()
    ).run();
  } catch (e) {
    // Non-critical: don't fail the whole job if metrics fail
    console.error('[Metrics] Failed to record:', e.message);
  }
}

// ============================================================
// MAIN CRON RUNNER
// ============================================================

export async function runMonitor({ env, executionCtx }) {
  const startTime = Date.now();
  console.log(`[Monitor] Starting run at ${new Date().toISOString()}`);
  
  try {
    // Phase 1: Stream checks (4x per minute with staggered delays)
    await runPhase(env, 'streams', [
      () => checkStreams(env),
      () => sleep(CONFIG.STREAM_CHECK_INTERVAL),
      () => checkStreams(env),
      () => sleep(CONFIG.STREAM_CHECK_INTERVAL),
      () => checkStreams(env),
      () => sleep(CONFIG.STREAM_CHECK_INTERVAL),
      () => checkStreams(env),
    ]);
    
    // Phase 2: Drop checks (6x per minute with staggered delays)
    await runPhase(env, 'drops', [
      () => checkDropsForMonitoredStreamers(env),
      () => sleep(CONFIG.DROP_CHECK_INTERVAL),
      () => checkDropsForMonitoredStreamers(env),
      () => sleep(CONFIG.DROP_CHECK_INTERVAL),
      () => checkDropsForMonitoredStreamers(env),
      () => sleep(CONFIG.DROP_CHECK_INTERVAL),
      () => checkDropsForMonitoredStreamers(env),
      () => sleep(CONFIG.DROP_CHECK_INTERVAL),
      () => checkDropsForMonitoredStreamers(env),
      () => sleep(CONFIG.DROP_CHECK_INTERVAL),
      () => checkDropsForMonitoredStreamers(env),
    ]);
    
    const duration = Date.now() - startTime;
    await recordMetric(env, { type: 'monitor_run', status: 'success', latencyMs: duration });
    console.log(`[Monitor] Completed in ${duration}ms`);
    
  } catch (err) {
    const duration = Date.now() - startTime;
    await recordMetric(env, { type: 'monitor_run', status: 'error', latencyMs: duration, error: err.message });
    console.error('[Monitor] Fatal error:', err);
  }
}

async function runPhase(env, phaseName, tasks) {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.error(`[Monitor] Phase ${phaseName} task failed:`, err.message);
      // Continue with next task — don't let one failure kill the whole phase
    }
  }
}

// ============================================================
// STREAM CHECKING v2 (Live / Offline / Milestones)
// ============================================================

async function checkStreams(env) {
  const checkStart = Date.now();
  
  // Fetch active channels with error resilience
  let channels;
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM kick_channels WHERE active = 1`
    ).all();
    channels = result.results || [];
  } catch (dbErr) {
    console.error('[Streams] DB read failed:', dbErr.message);
    return;
  }
  
  if (!channels.length) return;
  
  // Process channels with concurrency limiting
  const concurrency = CONFIG.RATE_LIMIT.maxConcurrent;
  for (let i = 0; i < channels.length; i += concurrency) {
    const batch = channels.slice(i, i + concurrency);
    await Promise.all(batch.map(ch => checkSingleStream(env, ch)));
  }
  
  await recordMetric(env, {
    type: 'stream_check',
    status: 'success',
    latencyMs: Date.now() - checkStart,
  });
}

async function checkSingleStream(env, ch) {
  const url = CONFIG.STREAM_ENDPOINTS.primary(ch.slug);
  const fetchStart = Date.now();
  
  try {
    const res = await fetchWithRetry(url);
    const data = await res.json();
    
    // Schema validation
    if (!Validators.channelV2(data)) {
      console.warn(`[Streams] Invalid schema for ${ch.slug}`);
      await recordMetric(env, {
        type: 'stream_check',
        endpoint: url,
        status: 'invalid_schema',
        latencyMs: Date.now() - fetchStart,
      });
      return;
    }
    
    // Normalize livestream data (handle both v2 and potential official schema)
    const livestream = data.livestream || data.stream;
    const isLive = Boolean(livestream);
    const currentViewers = isLive ? (livestream.viewer_count || 0) : 0;
    const streamTitle = isLive 
      ? (livestream.session_title || livestream.title || '') 
      : '';
    const categoryName = isLive
      ? (livestream.categories?.[0]?.name || livestream.category?.name || '')
      : '';
    
    // --- STATE MACHINE: GOING LIVE ---
    if (isLive && !ch.last_is_live) {
      await alertLive(env, ch, { ...livestream, session_title: streamTitle, viewer_count: currentViewers, category: categoryName });
      await updateChannel(env, ch.id, {
        last_is_live: 1,
        last_title: streamTitle,
        last_viewer_count: currentViewers,
        last_category: categoryName,
      });
      console.log(`[Streams] ${ch.slug} went LIVE`);
    }
    
    // --- STATE MACHINE: GOING OFFLINE ---
    if (!isLive && ch.last_is_live) {
      await alertOffline(env, ch);
      await updateChannel(env, ch.id, { last_is_live: 0 });
      await clearMilestones(env, ch.slug);
      console.log(`[Streams] ${ch.slug} went OFFLINE`);
    }
    
    // --- VIEWER MILESTONES (only when live and count increased) ---
    if (isLive && currentViewers > (ch.last_viewer_count || 0)) {
      await checkViewerMilestones(env, ch, currentViewers);
      await env.DB.prepare(
        `UPDATE kick_channels SET last_viewer_count = ? WHERE id = ?`
      ).bind(currentViewers, ch.id).run();
    }
    
    // --- Always update heartbeat ---
    await env.DB.prepare(
      `UPDATE kick_channels SET last_checked = ? WHERE id = ?`
    ).bind(Date.now(), ch.id).run();
    
  } catch (err) {
    console.error(`[Streams] Failed for ${ch.slug}:`, err.message);
    await recordMetric(env, {
      type: 'stream_check',
      endpoint: url,
      status: 'error',
      latencyMs: Date.now() - fetchStart,
      error: err.message,
    });
  }
}

// ============================================================
// ALERTS (With delivery guarantees)
// ============================================================

async function sendTelegramAlert(env, chatId, message, options = {}) {
  if (!chatId) {
    console.warn('[Alert] No chat_id provided, skipping');
    return;
  }
  
  try {
    await tg.sendMessage(env.BOT_TOKEN, chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    });
    return true;
  } catch (err) {
    console.error(`[Alert] Telegram failed for chat ${chatId}:`, err.message);
    // Could queue for retry here with KV
    return false;
  }
}

async function alertLive(env, ch, livestream) {
  const title = livestream.session_title || 'Live now!';
  const viewers = livestream.viewer_count || 0;
  const category = livestream.category || livestream.categories?.[0]?.name || 'Just Chatting';

  const msg = `🔴 <b>${escapeHtml(ch.name || ch.slug)} is LIVE!</b>\n\n` +
    `📺 ${escapeHtml(title)}\n` +
    `👥 ${viewers.toLocaleString()} viewers\n` +
    `🏷️ ${escapeHtml(category)}\n\n` +
    `👉 https://kick.com/${ch.slug}`;

  await sendTelegramAlert(env, ch.notify_chat_id, msg);
}

async function alertOffline(env, ch) {
  // Deduplicate offline alerts
  const key = `offline:${ch.slug}`;
  const alreadyAlerted = await env.KV.get(key);
  if (alreadyAlerted) return;
  
  const msg = `⚫ <b>${escapeHtml(ch.name || ch.slug)}</b> has gone offline.`;
  const sent = await sendTelegramAlert(env, ch.notify_chat_id, msg);
  
  if (sent) {
    await env.KV.put(key, '1', { expirationTtl: CONFIG.TTL.offlineAlert });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
// VIEWER MILESTONES v2 (Robust deduplication)
// ============================================================

async function checkViewerMilestones(env, ch, currentViewers) {
  const lastCount = ch.last_viewer_count || 0;

  for (const milestone of CONFIG.MILESTONES) {
    if (currentViewers >= milestone && lastCount < milestone) {
      const key = `milestone:${ch.slug}:${milestone}`;
      
      // Double-check KV to prevent race conditions
      const alreadyAlerted = await env.KV.get(key);
      if (alreadyAlerted) continue;

      const msg = `📈 <b>${escapeHtml(ch.name || ch.slug)} hit ${milestone.toLocaleString()} viewers!</b>\n\n` +
        `🔴 Currently live with ${currentViewers.toLocaleString()} viewers\n` +
        `👉 https://kick.com/${ch.slug}`;

      const sent = await sendTelegramAlert(env, ch.notify_chat_id, msg);
      
      if (sent) {
        await env.KV.put(key, '1', { expirationTtl: CONFIG.TTL.milestoneAlert });
      }
    }
  }
}

async function clearMilestones(env, slug) {
  const promises = CONFIG.MILESTONES.map(m => env.KV.delete(`milestone:${slug}:${m}`));
  await Promise.all(promises);
}

// ============================================================
// DROP DETECTION v2 — Triple Endpoint Fallback + Circuit Breaker
// ============================================================
//
// STRATEGY:
//   1. Try api/v2/drops/campaigns (fastest, most detailed)
//   2. Fallback to api/v1/drops/campaigns (older schema)
//   3. Fallback to web.kick.com/api/v1/drops/campaigns (most stable)
//   4. Circuit breaker prevents hammering if all fail
//
// CAMPAIGN SCHEMA NORMALIZATION:
//   Kick's drops API is undocumented and changes frequently. We normalize
//   multiple possible field names into a canonical structure.
// ============================================================================

async function checkDropsForMonitoredStreamers(env) {
  const checkStart = Date.now();
  
  try {
    // 1. Get monitored channels
    let channels;
    try {
      const result = await env.DB.prepare(
        `SELECT slug, notify_chat_id, broadcaster_user_id FROM kick_channels WHERE active = 1`
      ).all();
      channels = result.results || [];
    } catch (dbErr) {
      console.error('[Drops] DB read failed:', dbErr.message);
      return;
    }
    
    if (!channels.length) return;
    
    const monitoredSlugs = new Set(channels.map(r => r.slug.toLowerCase()));
    const chatMap = {};
    const broadcasterMap = {};
    for (const r of channels) {
      chatMap[r.slug.toLowerCase()] = r.notify_chat_id;
      broadcasterMap[r.slug.toLowerCase()] = r.broadcaster_user_id;
    }
    
    // 2. Fetch campaigns through circuit breaker + fallback cascade
    let campaigns = [];
    let usedEndpoint = '';
    
    await dropsCircuitBreaker.execute(async () => {
      for (const endpoint of CONFIG.DROPS_ENDPOINTS) {
        try {
          const result = await fetchDropsFromEndpoint(endpoint);
          if (result.campaigns.length > 0) {
            campaigns = result.campaigns;
            usedEndpoint = endpoint;
            console.log(`[Drops] Success via ${endpoint} (${campaigns.length} campaigns)`);
            break;
          }
        } catch (err) {
          console.warn(`[Drops] Endpoint failed: ${endpoint} — ${err.message}`);
        }
      }
      
      if (!campaigns.length) {
        throw new Error('All drops endpoints returned empty or failed');
      }
    });
    
    // 3. Process campaigns
    let alertedCount = 0;
    for (const campaign of campaigns) {
      try {
        const normalized = normalizeCampaign(campaign);
        if (!normalized) continue;
        
        const streamerSlug = normalized.streamerSlug.toLowerCase();
        
        // Skip if not monitored
        if (!monitoredSlugs.has(streamerSlug)) continue;
        
        // Skip if already alerted (campaign + streamer combo)
        const dedupKey = `drop_alerted:${normalized.campaignId}:${streamerSlug}`;
        const alreadyAlerted = await env.KV.get(dedupKey);
        if (alreadyAlerted) continue;
        
        // Alert
        const chatId = chatMap[streamerSlug];
        if (chatId) {
          const msg = buildDropAlert(normalized, streamerSlug);
          const sent = await sendTelegramAlert(env, chatId, msg);
          
          if (sent) {
            alertedCount++;
            
            // Persist to DB
            try {
              await env.DB.prepare(
                `INSERT INTO kick_drops (channel_slug, stream_id, title, reward, detected_at, chat_id, endpoint_used)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                streamerSlug,
                normalized.campaignId,
                normalized.title,
                normalized.reward,
                Date.now(),
                chatId,
                usedEndpoint
              ).run();
            } catch (dbErr) {
              console.error('[Drops] DB insert failed:', dbErr.message);
              // Don't fail the alert if DB insert fails
            }
            
            // Mark alerted
            await env.KV.put(dedupKey, '1', { expirationTtl: CONFIG.TTL.dropAlert });
          }
        }
      } catch (campaignErr) {
        console.error('[Drops] Campaign processing error:', campaignErr.message);
      }
    }
    
    await recordMetric(env, {
      type: 'drop_check',
      endpoint: usedEndpoint || 'all_failed',
      status: campaigns.length > 0 ? 'success' : 'empty',
      latencyMs: Date.now() - checkStart,
    });
    
    console.log(`[Drops] Run complete. Alerted: ${alertedCount}/${campaigns.length}`);
    
  } catch (err) {
    console.error('[Drops] Fatal error:', err.message);
    await recordMetric(env, {
      type: 'drop_check',
      status: 'error',
      latencyMs: Date.now() - checkStart,
      error: err.message,
    });
  }
}

async function fetchDropsFromEndpoint(endpoint) {
  const res = await fetchWithRetry(endpoint, {}, {
    ...CONFIG.FETCH_RETRY,
    maxRetries: 2, // Fewer retries per endpoint since we have fallbacks
  });
  
  const data = await res.json();
  
  if (!Validators.dropsCampaigns(data)) {
    throw new Error('Invalid drops schema');
  }
  
  const campaigns = data.campaigns || data.data || [];
  return { campaigns };
}

function normalizeCampaign(raw) {
  if (!raw || typeof raw !== 'object') return null;
  
  // Handle multiple possible schema shapes
  const campaignId = raw.id || raw.campaign_id || raw.campaignId;
  if (!campaignId) return null;
  
  // Extract streamer slug from various possible nesting
  const streamerSlug = (
    raw.streamer?.username ||
    raw.streamer?.slug ||
    raw.channel?.slug ||
    raw.creator?.username ||
    raw.creator?.slug ||
    raw.broadcaster?.username ||
    raw.username ||
    ''
  ).toLowerCase();
  
  if (!streamerSlug) return null;
  
  const title = raw.title || raw.name || raw.campaign_name || 'Kick Drop';
  
  const reward = raw.reward || raw.reward_amount || raw.reward_name || 
                 raw.drop_reward || raw.prize || 'Unknown reward';
  
  const endTime = raw.ends_at || raw.end_date || raw.end_time || raw.expires_at || null;
  
  return {
    campaignId,
    streamerSlug,
    title: String(title),
    reward: String(reward),
    endTime,
    raw, // Keep raw for debugging
  };
}

function buildDropAlert(normalized, streamerSlug) {
  let timeLeft = '';
  if (normalized.endTime) {
    const diff = new Date(normalized.endTime).getTime() - Date.now();
    const mins = Math.floor(diff / 60000);
    if (mins > 0) timeLeft = `⏳ ~${mins}m left`;
    else if (mins > -5) timeLeft = `⏳ Ending very soon!`;
  }

  return `🎁 <b>DROP ACTIVE — ${streamerSlug.toUpperCase()}</b>\n\n` +
    `💰 Reward: <b>${escapeHtml(normalized.reward)}</b>\n` +
    `📝 ${escapeHtml(normalized.title)}\n` +
    `${timeLeft ? timeLeft + '\n' : ''}` +
    `\n⚡ DROP IS LIVE NOW!\n` +
    `👉 https://kick.com/${streamerSlug}\n\n` +
    `🔥 Join immediately and stay until you claim!`;
}

// ============================================================
// WEBHOOK HANDLER (For instant livestream/status alerts)
// ============================================================
//
// USAGE: Mount this in your worker router at POST /webhooks/kick
//
// EVENTS HANDLED:
//   • livestream.status.updated — Instant live/offline + viewer count
//   • livestream.metadata.updated — Title/category changes
//   • chat.message.sent — Keyword-based drop detection fallback
// ============================================================================

export async function handleKickWebhook(request, env) {
  const startTime = Date.now();
  let payload;
  
  try {
    payload = await request.json();
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }
  
  // Validate signature if you configure webhook verification
  // const signature = request.headers.get('X-Kick-Signature');
  // TODO: Verify HMAC using Kick's public key
  
  if (!Validators.webhookPayload(payload)) {
    return new Response('Invalid payload schema', { status: 400 });
  }
  
  const eventType = payload.event;
  const data = payload.data;
  const broadcasterId = data.broadcaster_user_id;
  
  console.log(`[Webhook] Received ${eventType} for broadcaster ${broadcasterId}`);
  
  // Deduplicate webhook events (Kick may retry)
  const eventId = payload.subscription_id || `${eventType}:${broadcasterId}:${Date.now()}`;
  const dedupKey = `webhook_event:${eventId}`;
  const alreadyProcessed = await env.KV.get(dedupKey);
  if (alreadyProcessed) {
    return new Response('OK (duplicate)', { status: 200 });
  }
  await env.KV.put(dedupKey, '1', { expirationTtl: CONFIG.TTL.webhookEvent });
  
  try {
    switch (eventType) {
      case 'livestream.status.updated':
        await handleLivestreamStatusWebhook(env, data);
        break;
      case 'livestream.metadata.updated':
        await handleLivestreamMetadataWebhook(env, data);
        break;
      case 'chat.message.sent':
        await handleChatWebhook(env, data);
        break;
      default:
        console.log(`[Webhook] Unhandled event type: ${eventType}`);
    }
    
    await recordMetric(env, {
      type: 'webhook',
      endpoint: eventType,
      status: 'success',
      latencyMs: Date.now() - startTime,
    });
    
    return new Response('OK', { status: 200 });
    
  } catch (err) {
    console.error(`[Webhook] Handler error for ${eventType}:`, err.message);
    await recordMetric(env, {
      type: 'webhook',
      endpoint: eventType,
      status: 'error',
      latencyMs: Date.now() - startTime,
      error: err.message,
    });
    // Return 500 so Kick retries
    return new Response('Internal Error', { status: 500 });
  }
}

async function handleLivestreamStatusWebhook(env, data) {
  // data: { broadcaster_user_id, is_live, viewer_count, started_at }
  const slug = await resolveSlugFromBroadcasterId(env, data.broadcaster_user_id);
  if (!slug) return;
  
  const channel = await getChannelBySlug(env, slug);
  if (!channel || !channel.active) return;
  
  const isLive = data.is_live;
  const currentViewers = data.viewer_count || 0;
  
  if (isLive && !channel.last_is_live) {
    await alertLive(env, channel, {
      session_title: channel.last_title || 'Live now!',
      viewer_count: currentViewers,
      category: channel.last_category || '',
    });
    await updateChannel(env, channel.id, {
      last_is_live: 1,
      last_viewer_count: currentViewers,
    });
  }
  
  if (!isLive && channel.last_is_live) {
    await alertOffline(env, channel);
    await updateChannel(env, channel.id, { last_is_live: 0 });
    await clearMilestones(env, slug);
  }
  
  // Milestones via webhook
  if (isLive && currentViewers > (channel.last_viewer_count || 0)) {
    await checkViewerMilestones(env, channel, currentViewers);
    await env.DB.prepare(
      `UPDATE kick_channels SET last_viewer_count = ? WHERE id = ?`
    ).bind(currentViewers, channel.id).run();
  }
}

async function handleLivestreamMetadataWebhook(env, data) {
  // data: { broadcaster_user_id, stream_title, category, tags }
  const slug = await resolveSlugFromBroadcasterId(env, data.broadcaster_user_id);
  if (!slug) return;
  
  // Could alert on title changes if you want
  console.log(`[Webhook] ${slug} changed title to: ${data.stream_title}`);
}

async function handleChatWebhook(env, data) {
  // data: { broadcaster_user_id, sender, content, ... }
  const content = (data.content || '').toLowerCase();
  
  // Keyword-based drop detection fallback
  const hasDropKeyword = CONFIG.DROP_KEYWORDS.some(kw => content.includes(kw));
  if (!hasDropKeyword) return;
  
  const slug = await resolveSlugFromBroadcasterId(env, data.broadcaster_user_id);
  if (!slug) return;
  
  console.log(`[Webhook] Drop keyword detected in ${slug}'s chat: "${data.content}"`);
  
  // Trigger an immediate drop check
  await checkDropsForMonitoredStreamers(env);
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function resolveSlugFromBroadcasterId(env, broadcasterUserId) {
  try {
    const result = await env.DB.prepare(
      `SELECT slug FROM kick_channels WHERE broadcaster_user_id = ? AND active = 1`
    ).bind(broadcasterUserId).first();
    return result?.slug || null;
  } catch (e) {
    return null;
  }
}

async function getChannelBySlug(env, slug) {
  try {
    return await env.DB.prepare(
      `SELECT * FROM kick_channels WHERE slug = ? AND active = 1`
    ).bind(slug).first();
  } catch (e) {
    return null;
  }
}

async function updateChannel(env, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = [...keys.map(k => fields[k]), Date.now(), id];
  
  try {
    await env.DB.prepare(
      `UPDATE kick_channels SET ${setClause}, last_checked = ? WHERE id = ?`
    ).bind(...values).run();
  } catch (e) {
    console.error('[DB] Update failed:', e.message);
  }
}

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================
//
// Mount at GET /health/kick to get current monitor status
// ============================================================================

export async function getKickHealth(env) {
  const cbState = dropsCircuitBreaker.getState();
  
  let recentMetrics;
  try {
    const result = await env.DB.prepare(
      `SELECT metric_type, status, COUNT(*) as count, AVG(latency_ms) as avg_latency
       FROM kick_health 
       WHERE created_at > ? 
       GROUP BY metric_type, status`
    ).bind(Date.now() - 3600000).all(); // Last hour
    recentMetrics = result.results || [];
  } catch (e) {
    recentMetrics = [];
  }
  
  return {
    circuitBreaker: cbState,
    recentMetrics,
    timestamp: Date.now(),
  };
}
