import { tg } from '../../telegram';

export async function remind(c, update, parsed) {
  const chatId = update.message.chat.id;
  const userId = update.message.from.id;
  const args = parsed.args;

  const match = args.match(/^(\d+)\s*(m|min|h|hour|d|day)s?\s+(.+)$/i);
  if (!match) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId,
      '⏰ Usage: <code>/remind 30m Check the oven</code>
Formats: 10m, 2h, 1d', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const [, amount, unitRaw, text] = match;
  const unit = unitRaw.toLowerCase().startsWith('h') ? 'h' : unitRaw.toLowerCase().startsWith('d') ? 'd' : 'm';
  const ms = { m: 60000, h: 3600000, d: 86400000 }[unit];
  const remindAt = Date.now() + (parseInt(amount) * ms);

  await c.env.DB.prepare(
    'INSERT INTO reminders (chat_id, user_id, text, remind_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(chatId, userId, text, remindAt, Date.now()).run();

  await tg.sendMessage(c.env.BOT_TOKEN, chatId,
    `⏰ Got it! I'll remind you in <b>${amount}${unit}</b>:
<i>${text}</i>`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function checkReminders(c) {
  const now = Date.now();
  const due = await c.env.DB.prepare(
    'SELECT * FROM reminders WHERE remind_at <= ? AND sent = 0'
  ).bind(now).all();

  for (const row of due.results || []) {
    await tg.sendMessage(c.env.BOT_TOKEN, row.chat_id,
      `⏰ <a href="tg://user?id=${row.user_id}">Reminder</a>:
<b>${row.text}</b>`, { parse_mode: 'HTML' });

    await c.env.DB.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').bind(row.id).run();
  }
}
