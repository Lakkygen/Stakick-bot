import { tg } from '../../telegram';

export async function handleNewMembers(c, update) {
  const { message } = update;
  if (!message.new_chat_members) return c.text('OK');

  for (const member of message.new_chat_members) {
    if (member.is_bot && member.username !== c.env.BOT_USERNAME) {
      await tg.banChatMember(c.env.BOT_TOKEN, message.chat.id, member.id);
      continue;
    }

    const welcomeText = await c.env.KV.get(`welcome:${message.chat.id}`) ||
      `👋 Welcome, <a href="tg://user?id=${member.id}">${member.first_name}</a>! Enjoy your stay.`;

    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, welcomeText, { parse_mode: 'HTML' });
  }
  return c.text('OK');
}

export async function setWelcome(c, update, parsed) {
  const { message } = update;
  const text = parsed.args;

  if (!text) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
      'Usage: <code>/setwelcome Welcome {name}! Read the rules.</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  await c.env.KV.put(`welcome:${message.chat.id}`, text);
  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, '✅ Welcome message updated!');
  return c.text('OK');
}

export async function setRules(c, update, parsed) {
  const { message } = update;
  if (!parsed.args) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, 'Usage: /setrules No spam, be nice.');
    return c.text('OK');
  }
  await c.env.DB.prepare(
    `INSERT INTO group_settings (chat_id, rules, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`
  ).bind(message.chat.id, parsed.args, Date.now()).run();

  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, '✅ Rules updated!');
  return c.text('OK');
}

export async function rules(c, update, parsed) {
  const { message } = update;
  const row = await c.env.DB.prepare('SELECT rules FROM group_settings WHERE chat_id = ?')
    .bind(message.chat.id).first();

  const text = row?.rules ? `📜 <b>Group Rules:</b>
${row.rules}` : 'No rules set yet. Use /setrules';
  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, text, { parse_mode: 'HTML' });
  return c.text('OK');
}
