// src/services/groupIntelligence.js
// ============================================================
// STAKICKBOT — ADVANCED GROUP INTELLIGENCE
// ============================================================
//
// CORE FEATURES
// ------------------------------------------------------------
// 1. Natural autonomous participation
// 2. Group lore + persistent long-term memory
// 3. REPLY / WAIT / IGNORE decision system
// 4. Telegram reply / follow-up awareness
//
// EXTRA FEATURES
// ------------------------------------------------------------
// 5. Conversation momentum detection
// 6. Stakick self-awareness / continuity
// 7. Dynamic participation priority
// 8. Anti-repetition protection
// 9. Recurring-joke memory
// 10. Group-vibe adaptation
// 11. Sensitive-topic handling
// 12. Human-like micro delay
// 13. One AI call per decision
// 14. Smart cooldown adjustment
// 15. Pending conversation state
//
// STORAGE
// ------------------------------------------------------------
// KV:
//   group_ai:history:<chatId>
//   group_ai:cooldown:<chatId>
//   group_ai:pending:<chatId>
//   group_ai:last_topic:<chatId>
//   group_ai:vibe:<chatId>
//
// D1:
//   group_memories
//
// IMPORTANT
// ------------------------------------------------------------
// This module intentionally makes ONE AI request for a qualifying
// event. The model returns:
//   action + response + memory candidate + confidence
//
// That is much cheaper than:
//   decision AI call + response AI call
// ============================================================

import { queryAI } from './ai';
import { tg } from '../telegram';

// ============================================================
// DEFAULT CONFIG
// ============================================================

const DEFAULT_COOLDOWN_MS =
  10 * 60 * 1000;

const DEFAULT_HISTORY_LIMIT =
  24;

const DEFAULT_HISTORY_TTL =
  6 * 60 * 60;

const DEFAULT_AI_TIMEOUT_MS =
  20_000;

const DEFAULT_ACTIVE_WINDOW_MS =
  2 * 60 * 1000;

const DEFAULT_MIN_MESSAGES =
  3;

const DEFAULT_ACTIVITY_THRESHOLD =
  42;

const DEFAULT_PENDING_MIN_WAIT_MS =
  15_000;

const DEFAULT_PENDING_MAX_WAIT_MS =
  120_000;

const DEFAULT_REPLY_PRIORITY_BONUS =
  18;

const MAX_MESSAGE_LENGTH =
  1200;

const MAX_REPLY_LENGTH =
  900;

const MAX_LORE_LENGTH =
  500;

const MAX_HISTORY_CHARS =
  12_000;

const MAX_LORE_ITEMS =
  8;

const MEMORY_SCHEMA_VERSION =
  '2';

// ============================================================
// LANGUAGE / CONVERSATION SIGNALS
// ============================================================

const DEBATE_MARKERS = [
  'wrong',
  'you are wrong',
  "you're wrong",
  'nah',
  'no bro',
  'cap',
  'that is cap',
  'thats cap',
  'disagree',
  'disagreed',
  'agree',
  'actually',
  'because',
  'prove it',
  'prove that',
  'how is',
  'how can',
  'why would',
  'why is',
  'better than',
  'worse than',
  'versus',
  'vs',
  'compared to',
  'not true',
  'false',
  'fact',
  'facts',
  'truth',
  'you said',
  'but you',
  'but that',
  'i think',
  'i dont think',
  "i don't think",
  'no way',
  'yes it is',
  'yes it does',
  'never',
  'always',
  'exactly',
  'you mean',
  'what do you mean',
  'makes no sense',
  'that makes no sense'
];

const INTEREST_MARKERS = [
  'religion',
  'religious',
  'christian',
  'christianity',
  'muslim',
  'islam',
  'quran',
  'bible',
  'god',
  'faith',
  'belief',
  'believe',
  'politics',
  'political',
  'football',
  'soccer',
  'arsenal',
  'chelsea',
  'man united',
  'man utd',
  'liverpool',
  'iphone',
  'android',
  'samsung',
  'pixel',
  'gaming',
  'playstation',
  'ps5',
  'xbox',
  'pc',
  'money',
  'crypto',
  'school',
  'exam',
  'relationship',
  'relationships',
  'love',
  'dating',
  'marriage',
  'streamer',
  'kick',
  'phone',
  'laptop',
  'gpu',
  'cpu',
  'ai',
  'artificial intelligence',
  'scam',
  'controversial',
  'controversy'
];

const QUESTION_MARKERS = [
  '?',
  'why ',
  'how ',
  'what ',
  'which ',
  'who ',
  'would you ',
  'do you ',
  'can you ',
  'is it ',
  'is this ',
  'should we ',
  'does anyone ',
  'anyone know '
];

const HUMOR_MARKERS = [
  '😂',
  '🤣',
  '😭',
  '💀',
  'lmao',
  'lol',
  'haha',
  'hahaha',
  'brooo',
  'broooo',
  'wild',
  'crazy',
  'nahhh'
];

const SENSITIVE_TOPICS = [
  'religion',
  'religious',
  'christian',
  'christianity',
  'muslim',
  'islam',
  'quran',
  'bible',
  'god',
  'faith',
  'politics',
  'political',
  'race',
  'ethnicity'
];

// ============================================================
// ENV HELPERS
// ============================================================

function numberEnv(
  env,
  key,
  fallback,
  min,
  max
) {
  const value =
    Number(
      env?.[key]
    );

  if (
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return Math.min(
    Math.max(
      value,
      min
    ),
    max
  );
}

function isEnabled(env) {
  const value =
    String(
      env?.GROUP_AI_ENABLED ??
      'true'
    )
      .trim()
      .toLowerCase();

  return ![
    '0',
    'false',
    'off',
    'no',
    'disabled'
  ].includes(value);
}

// ============================================================
// BASIC HELPERS
// ============================================================

function cleanMessage(text) {
  return String(
    text ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(
      0,
      MAX_MESSAGE_LENGTH
    );
}

function cleanReply(text) {
  let reply =
    String(
      text ?? ''
    )
      .trim();

  reply =
    reply
      .replace(
        /^```(?:text|txt|markdown)?\s*/i,
        ''
      )
      .replace(
        /```$/i,
        ''
      )
      .trim();

  reply =
    reply.replace(
      /^(assistant|stakick|bot)\s*:\s*/i,
      ''
    );

  if (!reply) {
    return '';
  }

  return reply.slice(
    0,
    MAX_REPLY_LENGTH
  );
}

function getUserLabel(message) {
  const from =
    message?.from;

  if (!from) {
    return 'Unknown';
  }

  if (from.username) {
    return `@${from.username}`;
  }

  const name = [
    from.first_name,
    from.last_name
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    name ||
    String(
      from.id ||
      'User'
    )
  );
}

function getChatId(update) {
  return (
    update?.message?.chat?.id ??
    null
  );
}

function getUserId(update) {
  return (
    update?.message?.from?.id ??
    null
  );
}

function getMessageId(update) {
  return (
    update?.message?.message_id ??
    null
  );
}

function isGroupMessage(update) {
  const type =
    update?.message?.chat?.type;

  return (
    type === 'group' ||
    type === 'supergroup'
  );
}

function looksLikeCommand(text) {
  return /^\/[A-Za-z0-9_]+/.test(
    String(
      text ?? ''
    ).trim()
  );
}

function getHistoryKey(chatId) {
  return `group_ai:history:${String(
    chatId
  )}`;
}

function getCooldownKey(chatId) {
  return `group_ai:cooldown:${String(
    chatId
  )}`;
}

function getPendingKey(chatId) {
  return `group_ai:pending:${String(
    chatId
  )}`;
}

function getTopicKey(chatId) {
  return `group_ai:last_topic:${String(
    chatId
  )}`;
}

function getVibeKey(chatId) {
  return `group_ai:vibe:${String(
    chatId
  )}`;
}

function getSchemaKey() {
  return `group_ai:schema:v${MEMORY_SCHEMA_VERSION}`;
}

function escapeRegex(text) {
  return String(
    text ?? ''
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );
}

function botMentioned(
  text,
  botUsername
) {
  if (!botUsername) {
    return false;
  }

  return new RegExp(
    `@${escapeRegex(
      botUsername
    )}\\b`,
    'i'
  ).test(text);
}

function containsSensitiveTopic(
  text
) {
  const lower =
    String(
      text ?? ''
    ).toLowerCase();

  return SENSITIVE_TOPICS.some(
    (topic) =>
      lower.includes(topic)
  );
}

// ============================================================
// REPLY / FOLLOW-UP AWARENESS
// ============================================================

function getReplyContext(
  message
) {
  const replied =
    message?.reply_to_message;

  if (!replied) {
    return null;
  }

  const repliedText =
    cleanMessage(
      replied?.text ||
      replied?.caption ||
      ''
    );

  return {
    messageId:
      replied?.message_id ??
      null,

    userId:
      replied?.from?.id ??
      null,

    username:
      replied?.from?.username
        ? `@${replied.from.username}`
        : [
            replied?.from?.first_name,
            replied?.from?.last_name
          ]
            .filter(Boolean)
            .join(' ')
            .trim() ||
          'User',

    isBot:
      Boolean(
        replied?.from?.is_bot
      ),

    text:
      repliedText
  };
}

function isReplyToStakick(
  replyContext,
  botUsername
) {
  if (!replyContext) {
    return false;
  }

  if (
    replyContext.isBot
  ) {
    return true;
  }

  if (
    botUsername &&
    String(
      replyContext.username ||
      ''
    )
      .toLowerCase() ===
      `@${String(
        botUsername
      ).toLowerCase()}`
  ) {
    return true;
  }

  return false;
}

// ============================================================
// HISTORY
// ============================================================

function trimHistory(
  history,
  limit
) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.slice(
    -limit
  );
}

async function loadHistory(
  env,
  chatId,
  limit,
  ttlSeconds
) {
  if (!env?.KV) {
    return [];
  }

  const raw =
    await env.KV.get(
      getHistoryKey(chatId)
    );

  if (!raw) {
    return [];
  }

  let history = [];

  try {
    history =
      JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(history)) {
    return [];
  }

  const cutoff =
    Date.now() -
    Math.min(
      Number(ttlSeconds) * 1000,
      24 * 60 * 60 * 1000
    );

  return trimHistory(
    history.filter(
      (item) =>
        Number(
          item?.timestamp || 0
        ) >= cutoff
    ),
    limit
  );
}

async function saveHistory(
  env,
  chatId,
  history,
  limit,
  ttlSeconds
) {
  if (!env?.KV) {
    return;
  }

  const safe =
    trimHistory(
      history,
      limit
    );

  await env.KV.put(
    getHistoryKey(chatId),
    JSON.stringify(safe),
    {
      expirationTtl:
        Math.max(
          60,
          Math.floor(
            ttlSeconds
          )
        )
    }
  );
}

function formatHistory(
  history
) {
  const lines =
    history.map(
      (item) => {
        const speaker =
          String(
            item?.username ||
            item?.firstName ||
            'User'
          ).trim();

        const label =
          item?.isBot
            ? `Stakick (${speaker})`
            : speaker;

        const text =
          cleanMessage(
            item?.text
          );

        if (!text) {
          return '';
        }

        return `${label}: ${text}`;
      }
    );

  return lines
    .filter(Boolean)
    .join('\n')
    .slice(
      -MAX_HISTORY_CHARS
    );
}

// ============================================================
// ACTIVITY / MOMENTUM
// ============================================================

function recentMessages(
  history,
  activeWindowMs
) {
  const cutoff =
    Date.now() -
    activeWindowMs;

  return history.filter(
    (item) =>
      Number(
        item?.timestamp || 0
      ) >= cutoff
  );
}

function countDistinctUsers(
  history
) {
  return new Set(
    history
      .map(
        (item) =>
          String(
            item?.userId ?? ''
          )
      )
      .filter(Boolean)
  ).size;
}

function countMatches(
  text,
  markers
) {
  const lower =
    String(
      text ?? ''
    ).toLowerCase();

  let count = 0;

  for (
    const marker of markers
  ) {
    if (
      lower.includes(marker)
    ) {
      count++;
    }
  }

  return count;
}

function calculateMomentum(
  recent
) {
  if (
    recent.length < 2
  ) {
    return 0;
  }

  const timestamps =
    recent
      .map(
        (item) =>
          Number(
            item?.timestamp || 0
          )
      )
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) => a - b
      );

  if (
    timestamps.length < 2
  ) {
    return 0;
  }

  const gaps = [];

  for (
    let i = 1;
    i < timestamps.length;
    i++
  ) {
    gaps.push(
      timestamps[i] -
        timestamps[i - 1]
    );
  }

  const avgGap =
    gaps.reduce(
      (sum, gap) =>
        sum + gap,
      0
    ) /
    gaps.length;

  if (
    avgGap <= 5_000
  ) {
    return 30;
  }

  if (
    avgGap <= 10_000
  ) {
    return 24;
  }

  if (
    avgGap <= 20_000
  ) {
    return 18;
  }

  if (
    avgGap <= 40_000
  ) {
    return 10;
  }

  return 4;
}

function scoreConversation(
  history,
  currentText,
  activeWindowMs,
  minMessages,
  replyPriority
) {
  const recent =
    recentMessages(
      history,
      activeWindowMs
    );

  const distinct =
    countDistinctUsers(
      recent
    );

  if (
    recent.length <
      minMessages ||
    distinct < 2
  ) {
    if (replyPriority) {
      return Math.min(
        100,
        30 +
          DEFAULT_REPLY_PRIORITY_BONUS
      );
    }

    return 0;
  }

  let score = 0;

  score += Math.min(
    28,
    recent.length * 7
  );

  score += Math.min(
    24,
    distinct * 12
  );

  const corpus = [
    ...recent.map(
      (item) =>
        item?.text || ''
    ),
    currentText
  ]
    .join(' ')
    .toLowerCase();

  score += Math.min(
    20,
    countMatches(
      corpus,
      DEBATE_MARKERS
    ) * 4
  );

  score += Math.min(
    16,
    countMatches(
      corpus,
      INTEREST_MARKERS
    ) * 4
  );

  score += Math.min(
    10,
    countMatches(
      corpus,
      QUESTION_MARKERS
    ) * 2
  );

  score += Math.min(
    30,
    calculateMomentum(
      recent
    )
  );

  score += Math.min(
    12,
    countMatches(
      corpus,
      HUMOR_MARKERS
    ) * 3
  );

  if (
    replyPriority
  ) {
    score +=
      DEFAULT_REPLY_PRIORITY_BONUS;
  }

  return Math.min(
    100,
    score
  );
}

// ============================================================
// COOLDOWN
// ============================================================

async function loadLastBotTime(
  env,
  chatId
) {
  if (!env?.KV) {
    return null;
  }

  const raw =
    await env.KV.get(
      getCooldownKey(chatId)
    );

  if (!raw) {
    return null;
  }

  const timestamp =
    Number(raw);

  return Number.isFinite(
    timestamp
  )
    ? timestamp
    : null;
}

async function cooldownActive(
  env,
  chatId,
  cooldownMs
) {
  const last =
    await loadLastBotTime(
      env,
      chatId
    );

  if (!last) {
    return false;
  }

  return (
    Date.now() -
      last <
    cooldownMs
  );
}

async function setCooldown(
  env,
  chatId,
  cooldownMs
) {
  if (!env?.KV) {
    return;
  }

  await env.KV.put(
    getCooldownKey(chatId),
    String(Date.now()),
    {
      expirationTtl:
        Math.max(
          60,
          Math.ceil(
            cooldownMs / 1000
          )
        )
    }
  );
}

// ============================================================
// PENDING WAIT STATE
// ============================================================

async function loadPending(
  env,
  chatId
) {
  if (!env?.KV) {
    return null;
  }

  const raw =
    await env.KV.get(
      getPendingKey(chatId)
    );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(
      raw
    );
  } catch {
    return null;
  }
}

async function savePending(
  env,
  chatId,
  pending,
  maxWaitMs
) {
  if (!env?.KV) {
    return;
  }

  await env.KV.put(
    getPendingKey(chatId),
    JSON.stringify(
      pending
    ),
    {
      expirationTtl:
        Math.max(
          60,
          Math.ceil(
            maxWaitMs / 1000
          )
        )
    }
  );
}

async function clearPending(
  env,
  chatId
) {
  if (!env?.KV) {
    return;
  }

  try {
    await env.KV.delete(
      getPendingKey(chatId)
    );
  } catch {
    // Non-critical.
  }
}

// ============================================================
// TOPIC STATE
// ============================================================

async function loadLastTopic(
  env,
  chatId
) {
  if (!env?.KV) {
    return null;
  }

  return (
    await env.KV.get(
      getTopicKey(chatId)
    )
  ) || null;
}

async function saveLastTopic(
  env,
  chatId,
  topic
) {
  if (
    !env?.KV ||
    !topic
  ) {
    return;
  }

  await env.KV.put(
    getTopicKey(chatId),
    String(topic).slice(
      0,
      150
    ),
    {
      expirationTtl:
        6 * 60 * 60
    }
  );
}

// ============================================================
// GROUP VIBE
// ============================================================

async function loadVibe(
  env,
  chatId
) {
  if (!env?.KV) {
    return null;
  }

  const raw =
    await env.KV.get(
      getVibeKey(chatId)
    );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(
      raw
    );
  } catch {
    return null;
  }
}

async function saveVibe(
  env,
  chatId,
  vibe
) {
  if (
    !env?.KV ||
    !vibe
  ) {
    return;
  }

  await env.KV.put(
    getVibeKey(chatId),
    JSON.stringify(
      vibe
    ),
    {
      expirationTtl:
        7 * 24 * 60 * 60
    }
  );
}

// ============================================================
// GROUP LORE / D1
// ============================================================

async function ensureLoreSchema(
  env
) {
  if (!env?.DB) {
    return false;
  }

  if (env?.KV) {
    const ready =
      await env.KV.get(
        getSchemaKey()
      );

    if (
      ready === '1'
    ) {
      return true;
    }
  }

  try {
    await env.DB
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS group_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          memory TEXT NOT NULL,
          category TEXT DEFAULT 'group_fact',
          importance REAL DEFAULT 0.60,
          source_user_id INTEGER,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          use_count INTEGER DEFAULT 0
        )
        `
      )
      .run();

    await env.DB
      .prepare(
        `
        CREATE INDEX IF NOT EXISTS
        idx_group_memories_chat
        ON group_memories(chat_id)
        `
      )
      .run();

    if (env?.KV) {
      await env.KV.put(
        getSchemaKey(),
        '1',
        {
          expirationTtl:
            7 * 24 * 60 * 60
        }
      );
    }

    return true;
  } catch (error) {
    console.error(
      'Group lore schema setup failed:',
      error?.message ||
        error
    );

    return false;
  }
}

async function loadGroupLore(
  env,
  chatId,
  limit = MAX_LORE_ITEMS
) {
  if (!env?.DB) {
    return [];
  }

  try {
    const result =
      await env.DB
        .prepare(
          `
          SELECT
            id,
            memory,
            category,
            importance,
            source_user_id,
            created_at,
            last_used_at,
            use_count
          FROM group_memories
          WHERE chat_id = ?
          ORDER BY
            importance DESC,
            COALESCE(last_used_at, 0) DESC,
            created_at DESC
          LIMIT ?
          `
        )
        .bind(
          chatId,
          limit
        )
        .all();

    return (
      result?.results ||
      []
    );
  } catch (error) {
    console.error(
      'Group lore load failed:',
      error?.message ||
        error
    );

    return [];
  }
}

async function saveGroupMemory(
  env,
  {
    chatId,
    userId,
    memory,
    category,
    importance
  }
) {
  if (
    !env?.DB ||
    !memory
  ) {
    return null;
  }

  const cleaned =
    String(memory)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(
        0,
        MAX_LORE_LENGTH
      );

  if (
    cleaned.length < 8
  ) {
    return null;
  }

  const safeImportance =
    Math.min(
      1,
      Math.max(
        0.10,
        Number(
          importance ??
          0.60
        )
      )
    );

  const safeCategory =
    String(
      category ||
      'group_fact'
    )
      .trim()
      .slice(
        0,
        40
      ) ||
    'group_fact';

  try {
    const duplicate =
      await env.DB
        .prepare(
          `
          SELECT
            id,
            memory,
            importance
          FROM group_memories
          WHERE chat_id = ?
            AND LOWER(memory) =
                LOWER(?)
          LIMIT 1
          `
        )
        .bind(
          chatId,
          cleaned
        )
        .first();

    if (
      duplicate?.id
    ) {
      await env.DB
        .prepare(
          `
          UPDATE group_memories
          SET
            importance = MAX(
              importance,
              ?
            ),
            last_used_at = ?,
            use_count =
              COALESCE(use_count, 0) + 1
          WHERE id = ?
          `
        )
        .bind(
          safeImportance,
          Date.now(),
          duplicate.id
        )
        .run();

      return Number(
        duplicate.id
      );
    }

    const result =
      await env.DB
        .prepare(
          `
          INSERT INTO group_memories
          (
            chat_id,
            memory,
            category,
            importance,
            source_user_id,
            created_at,
            last_used_at,
            use_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          `
        )
        .bind(
          chatId,
          cleaned,
          safeCategory,
          safeImportance,
          userId ??
            null,
          Date.now(),
          Date.now()
        )
        .run();

    return Number(
      result?.meta
        ?.last_row_id || 0
    );
  } catch (error) {
    console.error(
      'Group lore save failed:',
      error?.message ||
        error
    );

    return null;
  }
}

async function markLoreUsed(
  env,
  ids
) {
  if (
    !env?.DB ||
    !Array.isArray(ids) ||
    ids.length === 0
  ) {
    return;
  }

  for (
    const id of ids
  ) {
    try {
      await env.DB
        .prepare(
          `
          UPDATE group_memories
          SET
            last_used_at = ?,
            use_count =
              COALESCE(use_count, 0) + 1
          WHERE id = ?
          `
        )
        .bind(
          Date.now(),
          id
        )
        .run();
    } catch {
      // Non-critical.
    }
  }
}

// ============================================================
// AI OUTPUT PARSER
// ============================================================

function stripCodeFence(
  text
) {
  return String(
    text ?? ''
  )
    .trim()
    .replace(
      /^```json\s*/i,
      ''
    )
    .replace(
      /^```\s*/i,
      ''
    )
    .replace(
      /```$/i,
      ''
    )
    .trim();
}

function normalizeDecision(
  parsed
) {
  let action =
    String(
      parsed?.action ||
      ''
    )
      .trim()
      .toUpperCase();

  if (
    ![
      'REPLY',
      'WAIT',
      'IGNORE'
    ].includes(action)
  ) {
    action =
      parsed?.shouldSpeak
        ? 'REPLY'
        : 'IGNORE';
  }

  const confidence =
    Math.min(
      1,
      Math.max(
        0,
        Number(
          parsed?.confidence ??
          0
        )
      )
    );

  const reply =
    cleanReply(
      parsed?.reply ||
      ''
    );

  const memory =
    parsed?.memory &&
    typeof parsed.memory ===
      'object'
      ? {
          remember:
            Boolean(
              parsed.memory
                ?.remember
            ),

          text:
            String(
              parsed.memory
                ?.text ||
              ''
            )
              .trim()
              .slice(
                0,
                MAX_LORE_LENGTH
              ),

          category:
            String(
              parsed.memory
                ?.category ||
              'group_fact'
            )
              .trim()
              .slice(
                0,
                40
              ),

          importance:
            Math.min(
              1,
              Math.max(
                0.10,
                Number(
                  parsed.memory
                    ?.importance ??
                  0.60
                )
              )
            )
        }
      : null;

  const waitSeconds =
    Math.min(
      120,
      Math.max(
        15,
        Number(
          parsed?.waitSeconds ??
          30
        )
      )
    );

  const vibe =
    parsed?.vibe &&
    typeof parsed.vibe ===
      'object'
      ? {
          humor:
            clampNumber(
              parsed.vibe
                ?.humor,
              0.5
            ),

          seriousness:
            clampNumber(
              parsed.vibe
                ?.seriousness,
              0.5
            ),

          banter:
            clampNumber(
              parsed.vibe
                ?.banter,
              0.5
            ),

          energy:
            clampNumber(
              parsed.vibe
                ?.energy,
              0.5
            )
        }
      : null;

  const topic =
    String(
      parsed?.topic ||
      ''
    )
      .trim()
      .slice(
        0,
        150
      );

  return {
    action,
    confidence,

    reason:
      String(
        parsed?.reason ||
        ''
      )
        .trim()
        .slice(
          0,
          300
        ),

    reply,

    memory,

    waitSeconds,

    topic,

    vibe,

    loreIds:
      Array.isArray(
        parsed?.loreIds
      )
        ? parsed.loreIds
            .map(
              Number
            )
            .filter(
              Number.isFinite
            )
        : []
  };
}

function clampNumber(
  value,
  fallback
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return fallback;
  }

  return Math.min(
    1,
    Math.max(
      0,
      n
    )
  );
}

function parseDecision(
  text
) {
  const raw =
    stripCodeFence(
      text
    );

  try {
    return normalizeDecision(
      JSON.parse(raw)
    );
  } catch {
    // Continue.
  }

  const start =
    raw.indexOf('{');

  const end =
    raw.lastIndexOf('}');

  if (
    start >= 0 &&
    end > start
  ) {
    try {
      return normalizeDecision(
        JSON.parse(
          raw.slice(
            start,
            end + 1
          )
        )
      );
    } catch {
      // Continue.
    }
  }

  return {
    action:
      'IGNORE',

    confidence:
      0,

    reason:
      'Invalid AI response',

    reply:
      '',

    memory:
      null,

    waitSeconds:
      30,

    topic:
      '',

    vibe:
      null,

    loreIds:
      []
  };
}

// ============================================================
// AI PROMPT
// ============================================================

function buildAutonomousPrompt({
  history,
  currentText,
  currentUsername,
  replyContext,
  replyToStakick,
  lore,
  previousTopic,
  vibe,
  activityScore,
  sensitive
}) {
  const loreText =
    lore.length > 0
      ? lore
          .map(
            (item) =>
              `- [id=${item.id}] [${item.category || 'group_fact'}] ${item.memory}`
          )
          .join('\n')
      : '- No persistent group lore yet.';

  const replyText =
    replyContext
      ? `
TELEGRAM REPLY CONTEXT:
The current message is replying to:
${replyContext.isBot ? 'Stakick' : replyContext.username}: ${replyContext.text}

Directly replying to Stakick:
${replyToStakick ? 'YES' : 'NO'}
`
      : `
TELEGRAM REPLY CONTEXT:
No direct reply-to-message was provided.
`;

  const vibeText =
    vibe
      ? `
CURRENT GROUP VIBE ESTIMATE:
- humor: ${vibe.humor}
- seriousness: ${vibe.seriousness}
- banter: ${vibe.banter}
- energy: ${vibe.energy}
`
      : `
CURRENT GROUP VIBE:
Unknown. Infer it from the conversation.
`;

  return `
You are Stakick, an actual-feeling member of a Telegram group.

You are participating naturally in an ongoing group conversation.

You are NOT required to speak.

Your three possible actions are:

REPLY
WAIT
IGNORE

============================================================
CORE BEHAVIOR
============================================================

Choose REPLY when Stakick can genuinely improve the conversation.

Choose WAIT when the conversation is developing and another
message or two may provide better context.

Choose IGNORE when participating would feel forced, unnecessary,
repetitive, annoying, or out of place.

Do not insert yourself into every discussion.

Do not act like an assistant waiting for instructions.

Do not say:
- "As an AI"
- "As a bot"
- "I am an AI"
- "I understand your request"
- "How can I assist?"
- "Certainly"

Speak like a normal member of the group.

============================================================
FOLLOW-UP AWARENESS
============================================================

If somebody is replying directly to Stakick, pay special attention.

If the current message answers, challenges, jokes about, questions,
or continues something Stakick previously said, Stakick can choose
REPLY even when the general group activity is moderate.

Do not treat a direct reply as a brand-new unrelated conversation.

Continue the thread naturally.

Do not repeat Stakick's previous point.

============================================================
CONVERSATION MOMENTUM
============================================================

Pay attention to:
- message frequency
- multiple participants
- disagreement
- questions
- jokes
- emotional energy
- whether the conversation is escalating
- whether the current message opens a new topic
- whether people are already answering each other naturally

If the group is still developing a topic, WAIT can be better than
an immediate interruption.

============================================================
GROUP LORE
============================================================

The group may have recurring jokes, nicknames, traditions,
preferences, memorable events, and personality patterns.

Existing lore:
${loreText}

Use lore only when genuinely relevant.

Do NOT force an inside joke into unrelated conversation.

You may propose ONE new memory only when it is genuinely useful
in future conversations.

Good memories:
- recurring inside jokes
- stable nicknames
- recurring group traditions
- long-running group preferences
- meaningful recurring member dynamics
- memorable group events

Do NOT store:
- random one-off statements
- temporary emotions
- passwords
- secrets
- private financial information
- sensitive personal data
- sensitive traits
- medical information
- political or religious identity as a personal profile
- anything that would be creepy to remember

============================================================
GROUP VIBE
============================================================

Use the current group's style.

If people are joking, be playful.

If people are debating seriously, be thoughtful.

If people are excited, match the energy.

If people are angry, do not deliberately inflame them.

Light teasing is allowed when it is clearly playful.

============================================================
SENSITIVE TOPICS
============================================================

Sensitive topic detected:
${sensitive ? 'YES' : 'NO'}

For religion, politics, identity, or other sensitive discussions:
- discuss ideas rather than attacking people
- do not mock someone's beliefs
- do not deliberately provoke
- do not present unsupported claims as facts
- do not encourage hostility
- staying silent is better than making things worse

============================================================
RESPONSE STYLE
============================================================

Keep autonomous responses concise.

Normally:
1-4 sentences.

Sometimes one sentence is perfect.

Do not write essays.

Avoid generic filler.

Good:
"😂 You two are actually arguing about completely different things."

Good:
"Wait, that's a different question entirely."

Good:
"Okay but what would actually change your mind?"

Bad:
"Both sides have valid perspectives and it is important to
understand that every situation is nuanced."

============================================================
TOKEN ECONOMY
============================================================

Only provide a response when it is worth sending.

Do not repeat recent points.

Do not restate the whole conversation.

Do not manufacture disagreement just to participate.

============================================================
CURRENT CONTEXT
============================================================

Activity score:
${activityScore}

Previous topic:
${previousTopic || 'Unknown'}

${vibeText}

RECENT GROUP CONVERSATION:
<context>
${history}
</context>

${replyText}

CURRENT SPEAKER:
${currentUsername}

CURRENT MESSAGE:
<current>
${currentText}
</current>

============================================================
RETURN JSON ONLY
============================================================

{
  "action": "REPLY|WAIT|IGNORE",
  "confidence": 0.00,
  "reason": "brief reason",
  "reply": "message to send if action is REPLY",
  "waitSeconds": 30,
  "topic": "short current topic",
  "vibe": {
    "humor": 0.0,
    "seriousness": 0.0,
    "banter": 0.0,
    "energy": 0.0
  },
  "memory": {
    "remember": false,
    "text": "",
    "category": "group_fact",
    "importance": 0.60
  },
  "loreIds": []
}

Rules:
- If action is IGNORE, reply should be empty.
- If action is WAIT, reply should be empty.
- If action is REPLY, reply must be the exact message Stakick should send.
- Keep memory.remember false unless memory is genuinely useful.
- loreIds should contain IDs of existing lore actually used.
`.trim();
}

// ============================================================
// NATURAL DELAY
// ============================================================

function randomReplyDelayMs(
  priority
) {
  if (
    priority >= 85
  ) {
    return (
      800 +
      Math.floor(
        Math.random() *
        1800
      )
    );
  }

  return (
    1200 +
    Math.floor(
      Math.random() *
      2800
    )
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// MAIN
// ============================================================

export async function handleGroupParticipation(
  env,
  update,
  {
    botUsername = ''
  } = {}
) {
  try {
    // ----------------------------------------------------------
    // ENABLE CHECK
    // ----------------------------------------------------------

    if (!isEnabled(env)) {
      return {
        spoke: false,
        reason:
          'disabled'
      };
    }

    if (!env?.KV) {
      return {
        spoke: false,
        reason:
          'KV unavailable'
      };
    }

    // ----------------------------------------------------------
    // GROUP ONLY
    // ----------------------------------------------------------

    if (
      !isGroupMessage(update)
    ) {
      return {
        spoke: false,
        reason:
          'not a group message'
      };
    }

    const message =
      update?.message;

    if (
      !message ||
      message?.from?.is_bot
    ) {
      return {
        spoke: false,
        reason:
          'bot/service message'
      };
    }

    // ----------------------------------------------------------
    // MESSAGE TEXT
    // ----------------------------------------------------------

    const text =
      cleanMessage(
        message?.text ||
        message?.caption ||
        ''
      );

    if (!text) {
      return {
        spoke: false,
        reason:
          'no text'
      };
    }

    if (
      looksLikeCommand(text)
    ) {
      return {
        spoke: false,
        reason:
          'command'
      };
    }

    /*
     * Direct @Stakick mentions already use the normal AI path.
     */
    if (
      botMentioned(
        text,
        botUsername
      )
    ) {
      return {
        spoke: false,
        reason:
          'direct bot mention'
      };
    }

    // ----------------------------------------------------------
    // IDS
    // ----------------------------------------------------------

    const chatId =
      getChatId(update);

    const userId =
      getUserId(update);

    const messageId =
      getMessageId(update);

    if (
      chatId === null ||
      chatId === undefined ||
      userId === null ||
      userId === undefined
    ) {
      return {
        spoke: false,
        reason:
          'missing identity'
      };
    }

    // ----------------------------------------------------------
    // CONFIG
    // ----------------------------------------------------------

    const cooldownMs =
      numberEnv(
        env,
        'GROUP_AI_COOLDOWN_MS',
        DEFAULT_COOLDOWN_MS,
        60_000,
        24 * 60 * 60 * 1000
      );

    const historyLimit =
      numberEnv(
        env,
        'GROUP_AI_HISTORY_LIMIT',
        DEFAULT_HISTORY_LIMIT,
        8,
        50
      );

    const historyTtl =
      numberEnv(
        env,
        'GROUP_AI_HISTORY_TTL',
        DEFAULT_HISTORY_TTL,
        300,
        24 * 60 * 60
      );

    const activeWindowMs =
      numberEnv(
        env,
        'GROUP_AI_ACTIVE_WINDOW_MS',
        DEFAULT_ACTIVE_WINDOW_MS,
        30_000,
        10 * 60 * 1000
      );

    const minMessages =
      numberEnv(
        env,
        'GROUP_AI_MIN_MESSAGES',
        DEFAULT_MIN_MESSAGES,
        2,
        20
      );

    const activityThreshold =
      numberEnv(
        env,
        'GROUP_AI_ACTIVITY_THRESHOLD',
        DEFAULT_ACTIVITY_THRESHOLD,
        20,
        100
      );

    const aiTimeoutMs =
      numberEnv(
        env,
        'GROUP_AI_TIMEOUT_MS',
        DEFAULT_AI_TIMEOUT_MS,
        5_000,
        60_000
      );

    // ----------------------------------------------------------
    // SCHEMA
    // ----------------------------------------------------------

    await ensureLoreSchema(
      env
    );

    // ----------------------------------------------------------
    // LOAD HISTORY
    // ----------------------------------------------------------

    let history =
      await loadHistory(
        env,
        chatId,
        historyLimit,
        historyTtl
      );

    const replyContext =
      getReplyContext(
        message
      );

    const replyToStakick =
      isReplyToStakick(
        replyContext,
        botUsername
      );

    const currentItem = {
      messageId,

      userId:
        String(userId),

      username:
        getUserLabel(message),

      firstName:
        message?.from?.first_name ||
        '',

      text,

      timestamp:
        Date.now(),

      isBot:
        false
    };

    history = [
      ...history,
      currentItem
    ].slice(
      -historyLimit
    );

    await saveHistory(
      env,
      chatId,
      history,
      historyLimit,
      historyTtl
    );

    // ----------------------------------------------------------
    // PRIORITY
    // ----------------------------------------------------------

    const replyPriority =
      replyToStakick;

    // ----------------------------------------------------------
    // WAIT STATE
    // ----------------------------------------------------------

    const pending =
      await loadPending(
        env,
        chatId
      );

    if (
      pending
    ) {
      const createdAt =
        Number(
          pending?.createdAt ||
          0
        );

      const waitMs =
        Math.min(
          DEFAULT_PENDING_MAX_WAIT_MS,
          Math.max(
            DEFAULT_PENDING_MIN_WAIT_MS,
            Number(
              pending?.waitMs ||
              30_000
            )
          )
        );

      /*
       * A direct reply to Stakick overrides a previous WAIT.
       * Otherwise allow the conversation to develop for at least
       * the requested waiting period.
       */
      if (
        !replyPriority &&
        createdAt &&
        Date.now() -
          createdAt <
          waitMs
      ) {
        return {
          spoke: false,
          reason:
            'pending wait window'
        };
      }

      await clearPending(
        env,
        chatId
      );
    }

    // ----------------------------------------------------------
    // ACTIVITY SCORE
    // ----------------------------------------------------------

    const activityScore =
      scoreConversation(
        history,
        text,
        activeWindowMs,
        minMessages,
        replyPriority
      );

    /*
     * A direct reply to Stakick gets a lower local barrier.
     */
    const effectiveThreshold =
      replyPriority
        ? Math.max(
            22,
            activityThreshold -
              15
          )
        : activityThreshold;

    if (
      activityScore <
      effectiveThreshold
    ) {
      return {
        spoke: false,
        reason:
          `low activity score (${activityScore})`
      };
    }

    // ----------------------------------------------------------
    // COOLDOWN
    // ----------------------------------------------------------

    /*
     * Direct replies can bypass the normal cooldown, but only
     * if enough time has passed to avoid bot-to-human spam loops.
     */
    const lastBotTime =
      await loadLastBotTime(
        env,
        chatId
      );

    const minimumFollowupGap =
      25_000;

    if (
      lastBotTime &&
      Date.now() -
        lastBotTime <
        (replyPriority
          ? minimumFollowupGap
          : cooldownMs)
    ) {
      return {
        spoke: false,
        reason:
          'cooldown'
      };
    }

    // ----------------------------------------------------------
    // GROUP MEMORY
    // ----------------------------------------------------------

    const lore =
      await loadGroupLore(
        env,
        chatId,
        MAX_LORE_ITEMS
      );

    // ----------------------------------------------------------
    // GROUP VIBE
    // ----------------------------------------------------------

    const existingVibe =
      await loadVibe(
        env,
        chatId
      );

    // ----------------------------------------------------------
    // TOPIC
    // ----------------------------------------------------------

    const previousTopic =
      await loadLastTopic(
        env,
        chatId
      );

    // ----------------------------------------------------------
    // SENSITIVE TOPIC
    // ----------------------------------------------------------

    const sensitive =
      containsSensitiveTopic(
        [
          text,
          ...history
            .slice(-6)
            .map(
              (item) =>
                item?.text || ''
            )
        ].join(' ')
      );

    // ----------------------------------------------------------
    // AI PROMPT
    // ----------------------------------------------------------

    const prompt =
      buildAutonomousPrompt({
        history:
          formatHistory(
            history
          ),

        currentText:
          text,

        currentUsername:
          currentItem.username,

        replyContext,

        replyToStakick,

        lore,

        previousTopic,

        vibe:
          existingVibe,

        activityScore,

        sensitive
      });

    const host =
      env.BOT_HOST ||
      'stakick-bot.workers.dev';

    // ----------------------------------------------------------
    // ONE AI CALL
    // ----------------------------------------------------------

    let aiRaw = '';

    try {
      aiRaw =
        await queryAI(
          env,
          prompt,
          {
            host,

            useMemory:
              false,

            saveMemory:
              false,

            webSearch:
              false,

            maxTokens:
              650,

            temperature:
              0.78,

            timeoutMs:
              aiTimeoutMs
          }
        );
    } catch (error) {
      console.error(
        'Autonomous group AI failed:',
        error?.message ||
          error
      );

      return {
        spoke: false,
        reason:
          'AI request failed'
      };
    }

    const decision =
      parseDecision(
        aiRaw
      );

    // ----------------------------------------------------------
    // VIBE UPDATE
    // ----------------------------------------------------------

    if (
      decision.vibe
    ) {
      await saveVibe(
        env,
        chatId,
        decision.vibe
      );
    }

    // ----------------------------------------------------------
    // TOPIC UPDATE
    // ----------------------------------------------------------

    if (
      decision.topic
    ) {
      await saveLastTopic(
        env,
        chatId,
        decision.topic
      );
    }

    // ----------------------------------------------------------
    // MEMORY UPDATE
    // ----------------------------------------------------------

    if (
      decision.memory
        ?.remember &&
      decision.memory
        ?.text &&
      decision.memory
        ?.importance >=
        0.65
    ) {
      await saveGroupMemory(
        env,
        {
          chatId,

          userId,

          memory:
            decision.memory
              .text,

          category:
            decision.memory
              .category,

          importance:
            decision.memory
              .importance
        }
      );
    }

    // ----------------------------------------------------------
    // MARK EXISTING LORE USED
    // ----------------------------------------------------------

    if (
      decision.loreIds?.length
    ) {
      await markLoreUsed(
        env,
        decision.loreIds
      );
    }

    // ----------------------------------------------------------
    // CONFIDENCE GATE
    // ----------------------------------------------------------

    const minimumConfidence =
      replyPriority
        ? 0.55
        : 0.62;

    if (
      decision.confidence <
      minimumConfidence
    ) {
      if (
        decision.action ===
        'WAIT'
      ) {
        const waitMs =
          Math.min(
            DEFAULT_PENDING_MAX_WAIT_MS,
            Math.max(
              DEFAULT_PENDING_MIN_WAIT_MS,
              decision.waitSeconds *
                1000
            )
          );

        await savePending(
          env,
          chatId,
          {
            createdAt:
              Date.now(),

            waitMs,

            reason:
              decision.reason ||
              'low-confidence waiting'
          },
          DEFAULT_PENDING_MAX_WAIT_MS
        );
      }

      return {
        spoke: false,
        reason:
          'low AI confidence'
      };
    }

    // ----------------------------------------------------------
    // IGNORE
    // ----------------------------------------------------------

    if (
      decision.action ===
      'IGNORE'
    ) {
      return {
        spoke: false,
        reason:
          decision.reason ||
          'AI chose silence'
      };
    }

    // ----------------------------------------------------------
    // WAIT
    // ----------------------------------------------------------

    if (
      decision.action ===
      'WAIT'
    ) {
      const waitMs =
        Math.min(
          DEFAULT_PENDING_MAX_WAIT_MS,
          Math.max(
            DEFAULT_PENDING_MIN_WAIT_MS,
            decision.waitSeconds *
              1000
          )
        );

      await savePending(
        env,
        chatId,
        {
          createdAt:
            Date.now(),

          waitMs,

          reason:
            decision.reason ||
            'conversation still developing'
        },
        DEFAULT_PENDING_MAX_WAIT_MS
      );

      return {
        spoke: false,
        reason:
          decision.reason ||
          'waiting'
      };
    }

    // ----------------------------------------------------------
    // REPLY VALIDATION
    // ----------------------------------------------------------

    const reply =
      cleanReply(
        decision.reply
      );

    if (!reply) {
      return {
        spoke: false,
        reason:
          'REPLY selected without a message'
      };
    }

    // ----------------------------------------------------------
    // ANTI-REPETITION
    // ----------------------------------------------------------

    const recentBotMessages =
      history
        .filter(
          (item) =>
            item?.isBot
        )
        .slice(-3);

    const normalizedReply =
      reply
        .toLowerCase()
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

    const repeated =
      recentBotMessages.some(
        (item) => {
          const previous =
            cleanMessage(
              item?.text
            )
              .toLowerCase()
              .replace(
                /\s+/g,
                ' '
              )
              .trim();

          return (
            previous ===
              normalizedReply ||
            (
              previous.length >
                30 &&
              normalizedReply.length >
                30 &&
              (
                previous.includes(
                  normalizedReply
                ) ||
                normalizedReply.includes(
                  previous
                )
              )
            )
          );
        }
      );

    if (
      repeated
    ) {
      return {
        spoke: false,
        reason:
          'duplicate response prevented'
      };
    }

    // ----------------------------------------------------------
    // CLEAR WAIT
    // ----------------------------------------------------------

    await clearPending(
      env,
      chatId
    );

    // ----------------------------------------------------------
    // NATURAL DELAY
    // ----------------------------------------------------------

    /*
     * Direct replies feel faster.
     * General participation gets a slightly longer delay.
     */
    try {
      await sleep(
        randomReplyDelayMs(
          replyPriority
            ? 90
            : activityScore
        )
      );
    } catch {
      // Cosmetic.
    }

    // ----------------------------------------------------------
    // COOLDOWN RESERVATION
    // ----------------------------------------------------------

    await setCooldown(
      env,
      chatId,
      cooldownMs
    );

    // ----------------------------------------------------------
    // TYPING
    // ----------------------------------------------------------

    try {
      if (
        typeof tg.sendTyping ===
        'function'
      ) {
        await tg.sendTyping(
          env.BOT_TOKEN,
          chatId
        );
      }
    } catch {
      // Cosmetic.
    }

    // ----------------------------------------------------------
    // TELEGRAM SEND
    // ----------------------------------------------------------

    const sendOptions = {
      disable_web_page_preview:
        true,

      reply_parameters:
        messageId
          ? {
              message_id:
                messageId,

              allow_sending_without_reply:
                true
            }
          : undefined
    };

    let sentMessage = null;

    try {
      sentMessage =
        await tg.sendMessage(
          env.BOT_TOKEN,
          chatId,
          reply,
          sendOptions
        );
    } catch (error) {
      console.error(
        'Autonomous group reply send failed:',
        error?.message ||
          error
      );

      /*
       * Do not leave a long cooldown behind when Telegram
       * rejected the actual message.
       */
      try {
        await env.KV.delete(
          getCooldownKey(
            chatId
          )
        );
      } catch {
        // Ignore cleanup failure.
      }

      return {
        spoke: false,
        reason:
          'Telegram send failed'
      };
    }

    // ----------------------------------------------------------
    // SAVE STAKICK MESSAGE TO CONTEXT
    // ----------------------------------------------------------

    const botMessageId =
      sentMessage?.result
        ?.message_id ??
      sentMessage?.message_id ??
      null;

    const updatedHistory = [
      ...history,
      {
        messageId:
          botMessageId,

        userId:
          'stakick-bot',

        username:
          botUsername
            ? `@${botUsername}`
            : 'Stakick',

        firstName:
          'Stakick',

        text:
          reply,

        timestamp:
          Date.now(),

        isBot:
          true
      }
    ].slice(
      -historyLimit
    );

    await saveHistory(
      env,
      chatId,
      updatedHistory,
      historyLimit,
      historyTtl
    );

    // ----------------------------------------------------------
    // LOG
    // ----------------------------------------------------------

    console.log(
      JSON.stringify({
        event:
          'group_ai_participation',

        chatId:
          String(chatId),

        messageId,

        botMessageId,

        action:
          decision.action,

        confidence:
          decision.confidence,

        activityScore,

        replyPriority,

        replyToStakick,

        sensitive,

        topic:
          decision.topic ||
          previousTopic ||
          null,

        memorySaved:
          Boolean(
            decision.memory
              ?.remember
          )
      })
    );

    return {
      spoke:
        true,

      reason:
        decision.reason ||
        'AI chose participation',

      activityScore,

      confidence:
        decision.confidence,

      replyToStakick,

      botMessageId
    };
  } catch (error) {
    console.error(
      'Group participation failed:',
      error
    );

    return {
      spoke: false,
      reason:
        error?.message ||
        'unexpected error'
    };
  }
}
