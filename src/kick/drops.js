import { tg } from '../telegram';

const DROP_PATTERNS = [
  { label: 'drops / drop', regex: /\bdrops?\b/i, weight: 1 },
  { label: 'reward / rewards', regex: /\brewards?\b/i, weight: 1 },
  { label: 'bonus', regex: /\bbonus\b/i, weight: 1 },
  { label: 'campaign', regex: /\bcampaign\b/i, weight: 1 },
  { label: 'claim / redeem', regex: /\b(claim|redeem)\b/i, weight: 2 },
  { label: 'watch to earn', regex: /watch\s+to\s+earn/i, weight: 3 },
  { label: 'active drops', regex: /active\s+drops?/i, weight: 3 },
  { label: 'drop rewards', regex: /drop\s+rewards?/i, weight: 3 },
  { label: 'earn rewards', regex: /earn\s+rewards?/i, weight: 3 },
  { label: 'drops enabled', regex: /drops?\s+(are\s+)?(enabled|active|on)/i, weight: 3 },
  { label: 'rewards enabled', regex: /rewards?\s+(are\s+)?(enabled|active|on)/i, weight: 3 },
  { label: 'giveaway / prize', regex: /\b(giveaway|prize|loot)\b/i, weight: 1 },
];

const FIELD_HINTS = /drop|reward|bonus|campaign|quest|claim|redeem|giveaway|prize|loot|challenge|perk/i;
const ACTIVE_HINTS = /\b(true|yes|on|enabled|active|available|live)\b/i;

function pushText(entries, path, value) {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text) return;
  entries.push({ path, text });
}

function collectTextEntries(value, path = '', entries = [], depth = 0) {
  if (depth > 4 || value == null) return entries;

  if (typeof value === 'string') {
    pushText(entries, path, value);
    return entries;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    if (value === true) entries.push({ path, text: 'true' });
    return entries;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectTextEntries(value[i], `${path}[${i}]`, entries, depth + 1);
    }
    return entries;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof child === 'string') {
        pushText(entries, nextPath, child);
      } else if (typeof child === 'number' || typeof child === 'boolean') {
        if (child === true) entries.push({ path: nextPath, text: 'true' });
      } else {
        collectTextEntries(child, nextPath, entries, depth + 1);
      }
    }
  }

  return entries;
}

function uniqReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const reason of reasons) {
    const key = `${reason.label}|${reason.path}|${reason.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

export function scanDropSignals(info, livestream) {
  const entries = collectTextEntries({
    livestream: livestream || null,
    channel: info || null,
  });

  const reasons = [];
  let score = 0;

  for (const { path, text } of entries) {
    const lowerPath = path.toLowerCase();
    const lowerText = text.toLowerCase();

    for (const pattern of DROP_PATTERNS) {
      if (!pattern.regex.test(lowerText)) continue;

      let weight = pattern.weight;
      if (FIELD_HINTS.test(lowerPath)) weight += 2;
      if (FIELD_HINTS.test(lowerText) && ACTIVE_HINTS.test(lowerText)) weight += 1;
      if (lowerPath.includes('description') || lowerPath.includes('bio') || lowerPath.includes('title')) {
        weight += 1;
      }

      score += weight;
      reasons.push({ label: pattern.label, path, text: text.slice(0, 140), weight });
    }
  }

  const explicitFlagPaths = entries.filter(({ path, text }) => {
    const lowerPath = path.toLowerCase();
    return FIELD_HINTS.test(lowerPath) && ACTIVE_HINTS.test(text);
  });

  for (const item of explicitFlagPaths) {
    score += 3;
    reasons.push({ label: 'explicit drop/reward flag', path: item.path, text: item.text.slice(0, 140), weight: 3 });
  }

  const uniq = uniqReasons(reasons).sort((a, b) => b.weight - a.weight);
  const strong = uniq.some(r => r.weight >= 4);
  const confidence = score >= 10 || (score >= 6 && strong)
    ? 'high'
    : score >= 4
    ? 'medium'
    : 'low';

  return { score, confidence, reasons: uniq };
}

function buildAlertText(ch, livestream, report) {
  const name = ch.name || ch.slug;
  const reasonLine = report.reasons.slice(0, 3)
    .map(r => r.label)
    .join(', ');

  return `🎁 <b>DROP ALERT!</b>\n\n🔴 <b>${name}</b> looks like it has active drops/rewards.\n📺 ${livestream.session_title || 'Live stream'}\n👁 ${livestream.viewer_count?.toLocaleString() || '?'} viewers\n🎮 ${livestream.categories?.[0]?.name || 'N/A'}\n${reasonLine ? `🧠 Signals: ${reasonLine}\n` : ''}⚡ OPEN KICK & CLAIM\n\n<i>Confidence: ${report.confidence}. This alert only detects signals — you still need to watch on Kick to qualify.</i>`;
}

export async function detectDrops(env, chatId, ch, livestream) {
  const report = scanDropSignals(ch, livestream);
  if (report.score < 4) return { matched: false, report };

  const streamId = livestream.id || `${ch.slug}:${livestream.session_title || 'unknown'}`;
  const alertedKey = `drop_alerted:${ch.slug}:${streamId}`;
  const alreadyAlerted = await env.KV.get(alertedKey);
  if (alreadyAlerted) return { matched: true, report, alreadyAlerted: true };

  const cooldownKey = `drop_cd:${ch.slug}:${chatId}`;
  const lastDropAlert = await env.KV.get(cooldownKey);
  if (lastDropAlert && (Date.now() - parseInt(lastDropAlert, 10)) < 1800000) {
    return { matched: true, report, cooledDown: true };
  }

  const text = buildAlertText(ch, livestream, report);
  await tg.sendMessage(env.BOT_TOKEN, chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  await env.KV.put(alertedKey, '1', { expirationTtl: 86400 });
  await env.KV.put(cooldownKey, Date.now().toString(), { expirationTtl: 3600 });

  await env.DB.prepare(
    'INSERT INTO kick_drops (channel_slug, stream_id, title, detected_at, chat_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(ch.slug, String(streamId), livestream.session_title || null, Date.now(), chatId).run();

  return { matched: true, report };
}
