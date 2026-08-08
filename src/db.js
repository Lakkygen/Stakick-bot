const SCHEMA_VERSION = '2026-08-08-v2';
const SCHEMA_KEY = 'schema_version';

const SCHEMA_STATEMENTS = [
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
  `CREATE TABLE IF NOT EXISTS kick_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
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
];

let bootstrapPromise = null;

export async function ensureSchema(env) {
  if (!env?.DB || !env?.KV) return;

  const currentVersion = await env.KV.get(SCHEMA_KEY);
  if (currentVersion === SCHEMA_VERSION) return;

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const versionCheck = await env.KV.get(SCHEMA_KEY);
      if (versionCheck === SCHEMA_VERSION) return;

      for (const statement of SCHEMA_STATEMENTS) {
        await env.DB.prepare(statement).run();
      }

      await env.KV.put(SCHEMA_KEY, SCHEMA_VERSION, { expirationTtl: 31536000 });
    })().finally(() => {
      bootstrapPromise = null;
    });
  }

  return bootstrapPromise;
}
