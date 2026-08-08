export async function logCommand(c, next) {
  const { parsed, update } = c.var;
  const user = update.message?.from;
  const chat = update.message?.chat;

  if (user && chat && parsed?.command) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO user_stats (user_id, chat_id, command_count, last_seen)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET
         command_count = command_count + 1,
         last_seen = excluded.last_seen`
      ).bind(user.id, chat.id, Date.now()).run()
    );
  }

  return next();
}
