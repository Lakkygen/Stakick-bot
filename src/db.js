// src/db.js
// ============================================================
// STAKICKBOT — CLOUDFLARE D1 + KV DATABASE LAYER
// ============================================================

const SCHEMA_VERSION =
  '2026-08-17-ai-memory-v1';

const SCHEMA_KEY =
  'schema_version';

const SCHEMA_STATEMENTS = [
  /*
   * Existing moderation tables
   */
  `CREATE TABLE IF NOT EXISTS mod_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    admin_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    sent INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS group_settings (
    chat_id INTEGER PRIMARY KEY,
    anti_spam INTEGER DEFAULT 1,
    welcome_msg TEXT,
    rules TEXT,
    updated_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS user_stats (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    message_count INTEGER DEFAULT 0,
    command_count INTEGER DEFAULT 0,
    last_seen INTEGER,
    PRIMARY KEY (user_id, chat_id)
  )`,

  /*
   * Kick channel/drop tables
   */
  `CREATE TABLE IF NOT EXISTS kick_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    broadcaster_user_id TEXT,
    name TEXT,
    notify_chat_id INTEGER NOT NULL,
    active INTEGER DEFAULT 1,
    added_by INTEGER,
    added_at INTEGER,
    last_is_live INTEGER DEFAULT 0,
    last_title TEXT,
    last_viewer_count INTEGER DEFAULT 0,
    last_category TEXT,
    last_checked INTEGER,
    fail_count INTEGER DEFAULT 0,
    last_error TEXT,
    UNIQUE(slug, notify_chat_id)
  )`,

  `CREATE TABLE IF NOT EXISTS kick_stream_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_slug TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    peak_viewers INTEGER DEFAULT 0,
    title TEXT,
    category TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS kick_alert_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_slug TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    sent_at INTEGER,
    chat_id INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS kick_drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_slug TEXT NOT NULL,
    stream_id TEXT,
    title TEXT,
    detected_at INTEGER,
    chat_id INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS bot_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS bot_health_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_type TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS channel_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_slug TEXT NOT NULL,
    error_type TEXT NOT NULL,
    error_message TEXT,
    fail_count INTEGER DEFAULT 1,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,

  /*
   * ==========================================================
   * AI MEMORY
   * ==========================================================
   */

  /*
   * Individual AI messages.
   *
   * chat_id:
   *   Telegram chat where the conversation occurred.
   *
   * user_id:
   *   Telegram user who sent the message.
   *
   * role:
   *   user / assistant / system
   *
   * content:
   *   Actual message text.
   */
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  /*
   * Long-term facts/memories.
   *
   * These are separate from ordinary conversation history.
   */
  `CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    memory TEXT NOT NULL,
    importance INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, memory)
  )`,

  /*
   * Useful indexes for fast retrieval.
   */
  `CREATE INDEX IF NOT EXISTS idx_ai_messages_chat_user_time
   ON ai_messages(chat_id, user_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_ai_messages_chat_time
   ON ai_messages(chat_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_ai_memories_user_time
   ON ai_memories(user_id, updated_at DESC)`,
];

const MIGRATIONS = [
  /*
   * Keep your existing migration information.
   *
   * CREATE TABLE IF NOT EXISTS above makes the database
   * safe for fresh installations and existing databases.
   */
  {
    version:
      '2026-08-10-v3',
    statements: [
      `ALTER TABLE kick_channels
       ADD COLUMN broadcaster_user_id TEXT`,

      `ALTER TABLE kick_channels
       ADD COLUMN fail_count INTEGER DEFAULT 0`,

      `ALTER TABLE kick_channels
       ADD COLUMN last_error TEXT`,
    ],
  },
];

let bootstrapPromise =
  null;

/*
 * ==========================================================
 * SCHEMA INITIALIZATION
 * ==========================================================
 */

export async function ensureSchema(env) {
  if (!env?.DB || !env?.KV) {
    return;
  }

  const currentVersion =
    await env.KV.get(
      SCHEMA_KEY
    );

  if (
    currentVersion ===
    SCHEMA_VERSION
  ) {
    return;
  }

  if (!bootstrapPromise) {
    bootstrapPromise =
      (async () => {
        const versionCheck =
          await env.KV.get(
            SCHEMA_KEY
          );

        if (
          versionCheck ===
          SCHEMA_VERSION
        ) {
          return;
        }

        /*
         * Run base schema.
         */
        for (
          const statement
            of SCHEMA_STATEMENTS
        ) {
          try {
            await env.DB
              .prepare(
                statement
              )
              .run();
          } catch (error) {
            const message =
              String(
                error?.message ||
                error
              );

            /*
             * CREATE IF NOT EXISTS should make most
             * cases safe. We still log unexpected errors.
             */
            if (
              !message
                .toLowerCase()
                .includes(
                  'duplicate column'
                )
            ) {
              console.error(
                'Schema statement failed:',
                message
              );
            }
          }
        }

        /*
         * Run legacy migrations.
         */
        for (
          const migration
            of MIGRATIONS
        ) {
          for (
            const statement
              of migration.statements
          ) {
            try {
              await env.DB
                .prepare(
                  statement
                )
                .run();
            } catch (error) {
              const message =
                String(
                  error?.message ||
                  error
                );

              if (
                !message
                  .toLowerCase()
                  .includes(
                    'duplicate column'
                  )
              ) {
                console.error(
                  'Migration failed:',
                  message
                );
              }
            }
          }
        }

        /*
         * Store current schema version.
         */
        await env.KV.put(
          SCHEMA_KEY,
          SCHEMA_VERSION,
          {
            expirationTtl:
              31536000,
          }
        );
      })().finally(
        () => {
          bootstrapPromise =
            null;
        }
      );
  }

  return bootstrapPromise;
}

/*
 * ==========================================================
 * AI CONVERSATION HISTORY
 * ==========================================================
 */

/**
 * Save an AI message.
 */
export async function saveAIMessage(
  env,
  {
    chatId,
    userId,
    role,
    content,
  }
) {
  if (!env?.DB) {
    throw new Error(
      'D1 database binding is missing.'
    );
  }

  if (
    chatId === undefined ||
    chatId === null
  ) {
    throw new Error(
      'chatId is required.'
    );
  }

  if (
    userId === undefined ||
    userId === null
  ) {
    throw new Error(
      'userId is required.'
    );
  }

  if (
    !['user', 'assistant', 'system']
      .includes(role)
  ) {
    throw new Error(
      `Invalid AI message role: ${role}`
    );
  }

  const text =
    String(
      content ?? ''
    ).trim();

  if (!text) {
    return;
  }

  await env.DB
    .prepare(
      `INSERT INTO ai_messages
       (
         chat_id,
         user_id,
         role,
         content,
         created_at
       )
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      Number(chatId),
      Number(userId),
      role,
      text,
      Date.now()
    )
    .run();
}

/**
 * Load recent conversation messages.
 *
 * The result is returned in chronological order.
 */
export async function getAIHistory(
  env,
  {
    chatId,
    userId,
    limit = 16,
  }
) {
  if (!env?.DB) {
    return [];
  }

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 16,
        1
      ),
      50
    );

  const result =
    await env.DB
      .prepare(
        `SELECT
           role,
           content,
           created_at
         FROM ai_messages
         WHERE chat_id = ?
           AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .bind(
        Number(chatId),
        Number(userId),
        safeLimit
      )
      .all();

  const rows =
    result?.results || [];

  return rows
    .reverse()
    .map(
      (row) => ({
        role:
          row.role,
        content:
          row.content,
      })
    );
}

/**
 * Delete a user's conversation.
 */
export async function clearAIHistory(
  env,
  {
    chatId,
    userId,
  }
) {
  if (!env?.DB) {
    return;
  }

  await env.DB
    .prepare(
      `DELETE FROM ai_messages
       WHERE chat_id = ?
         AND user_id = ?`
    )
    .bind(
      Number(chatId),
      Number(userId)
    )
    .run();
}

/*
 * ==========================================================
 * AI LONG-TERM MEMORY
 * ==========================================================
 */

/**
 * Save a durable memory.
 */
export async function saveAIMemory(
  env,
  {
    userId,
    memory,
    importance = 1,
  }
) {
  if (!env?.DB) {
    throw new Error(
      'D1 database binding is missing.'
    );
  }

  const text =
    String(
      memory ?? ''
    ).trim();

  if (!text) {
    return;
  }

  const safeImportance =
    Math.min(
      Math.max(
        Number(importance) || 1,
        1
      ),
      5
    );

  const now =
    Date.now();

  await env.DB
    .prepare(
      `INSERT INTO ai_memories
       (
         user_id,
         memory,
         importance,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, memory)
       DO UPDATE SET
         importance = excluded.importance,
         updated_at = excluded.updated_at`
    )
    .bind(
      Number(userId),
      text,
      safeImportance,
      now,
      now
    )
    .run();
}

/**
 * Retrieve durable memories for a user.
 */
export async function getAIMemories(
  env,
  {
    userId,
    limit = 20,
  }
) {
  if (!env?.DB) {
    return [];
  }

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 20,
        1
      ),
      50
    );

  const result =
    await env.DB
      .prepare(
        `SELECT
           id,
           memory,
           importance,
           created_at,
           updated_at
         FROM ai_memories
         WHERE user_id = ?
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`
      )
      .bind(
        Number(userId),
        safeLimit
      )
      .all();

  return (
    result?.results ||
    []
  );
}

/**
 * Delete all durable memories for a user.
 */
export async function clearAIMemories(
  env,
  {
    userId,
  }
) {
  if (!env?.DB) {
    return;
  }

  await env.DB
    .prepare(
      `DELETE FROM ai_memories
       WHERE user_id = ?`
    )
    .bind(
      Number(userId)
    )
    .run();
}

/**
 * Delete one exact memory.
 */
export async function deleteAIMemory(
  env,
  {
    userId,
    memory,
  }
) {
  if (!env?.DB) {
    return;
  }

  await env.DB
    .prepare(
      `DELETE FROM ai_memories
       WHERE user_id = ?
         AND memory = ?`
    )
    .bind(
      Number(userId),
      String(memory ?? '').trim()
    )
    .run();
}
