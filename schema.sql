-- Telegram bot core tables
CREATE TABLE IF NOT EXISTS mod_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS group_settings (
  chat_id INTEGER PRIMARY KEY,
  anti_spam INTEGER DEFAULT 1,
  welcome_msg TEXT,
  rules TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  command_count INTEGER DEFAULT 0,
  last_seen INTEGER,
  PRIMARY KEY (user_id, chat_id)
);

-- Kick integration tables
CREATE TABLE IF NOT EXISTS kick_channels (
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
);

CREATE TABLE IF NOT EXISTS kick_stream_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  peak_viewers INTEGER DEFAULT 0,
  title TEXT,
  category TEXT
);

CREATE TABLE IF NOT EXISTS kick_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  sent_at INTEGER,
  chat_id INTEGER
);

CREATE TABLE IF NOT EXISTS kick_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  stream_id TEXT,
  title TEXT,
  detected_at INTEGER,
  chat_id INTEGER
);

CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

-- Monitoring & health tables
CREATE TABLE IF NOT EXISTS bot_health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT,
  fail_count INTEGER DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
