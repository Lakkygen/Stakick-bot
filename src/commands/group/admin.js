import { tg } from '../../telegram';

async function getTargetUser(message) {
  if (message.reply_to_message) {
    return message.reply_to_message.from;
  }
  for (const entity of message.entities || []) {
    if (entity.type === 'text_mention') {
      return entity.user;
    }
  }
  return null;
}

export async function ban(c, update, parsed) {
  const { message } = update;
  const target = await getTargetUser(message);

  if (!target) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
      '🚫 Reply to a user or mention them: <code>/ban @user</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  if (target.id.toString() === (c.env.BOT_ID || '')) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, 'Nice try 😏');
    return c.text('OK');
  }

  await tg.banChatMember(c.env.BOT_TOKEN, message.chat.id, target.id);
  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
    `🚫 <a href="tg://user?id=${target.id}">${target.first_name}</a> has been banned.`,
    { parse_mode: 'HTML' });

  await c.env.DB.prepare(
    'INSERT INTO mod_logs (chat_id, admin_id, target_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(message.chat.id, message.from.id, target.id, 'ban', parsed.args || 'No reason', Date.now()).run();

  return c.text('OK');
}

export async function unban(c, update, parsed) {
  const { message } = update;
  const target = await getTargetUser(message);
  if (!target) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, 'Reply to a banned user to unban.');
    return c.text('OK');
  }
  await tg.unbanChatMember(c.env.BOT_TOKEN, message.chat.id, target.id);
  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
    `✅ <a href="tg://user?id=${target.id}">${target.first_name}</a> unbanned.`, { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function mute(c, update, parsed) {
  const { message } = update;
  const target = await getTargetUser(message);
  const minutes = parseInt(parsed.args) || 60;

  if (!target) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, 'Reply to a user with <code>/mute [minutes]</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const until = Math.floor(Date.now() / 1000) + (minutes * 60);

  await tg.restrictChatMember(c.env.BOT_TOKEN, message.chat.id, target.id, {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
  }, until);

  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
    `🔇 <a href="tg://user?id=${target.id}">${target.first_name}</a> muted for ${minutes}m.`,
    { parse_mode: 'HTML' });
  return c.text('OK');
}

export async function warn(c, update, parsed) {
  const { message } = update;
  const target = await getTargetUser(message);
  const reason = parsed.args || 'No reason';

  if (!target) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, 'Reply to a user with <code>/warn [reason]</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const key = `warns:${message.chat.id}:${target.id}`;
  const warns = JSON.parse(await c.env.KV.get(key) || '[]');
  warns.push({ by: message.from.id, reason, time: Date.now() });

  if (warns.length >= 3) {
    await tg.banChatMember(c.env.BOT_TOKEN, message.chat.id, target.id);
    await c.env.KV.delete(key);
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
      `🚫 <a href="tg://user?id=${target.id}">${target.first_name}</a> hit 3/3 warnings and was banned.`,
      { parse_mode: 'HTML' });
  } else {
    await c.env.KV.put(key, JSON.stringify(warns));
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
      `⚠️ <a href="tg://user?id=${target.id}">${target.first_name}</a> — Warning ${warns.length}/3
<i>${reason}</i>`,
      { parse_mode: 'HTML' });
  }
  return c.text('OK');
}

export async function purge(c, update, parsed) {
  const { message } = update;
  const count = Math.min(parseInt(parsed.args) || 10, 100);
  const msgId = message.message_id;
  let deleted = 0;

  for (let i = 1; i <= count && (msgId - i) > 0; i++) {
    const res = await tg.deleteMessage(c.env.BOT_TOKEN, message.chat.id, msgId - i);
    if (res.ok) deleted++;
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }

  const confirm = await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id, `🧹 Deleted ${deleted} messages.`);
  c.executionCtx.waitUntil(
    new Promise(r => setTimeout(r, 5000)).then(async () => {
      const cid = (await confirm.json()).result?.message_id;
      if (cid) await tg.deleteMessage(c.env.BOT_TOKEN, message.chat.id, cid);
    })
  );

  return c.text('OK');
}

export async function listWarns(c, update, parsed) {
  const { message } = update;
  const target = await getTargetUser(message) || message.from;
  const key = `warns:${message.chat.id}:${target.id}`;
  const warns = JSON.parse(await c.env.KV.get(key) || '[]');

  if (!warns.length) {
    await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
      `<a href="tg://user?id=${target.id}">${target.first_name}</a> has no warnings.`, { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const list = warns.map((w, i) => `${i + 1}. ${w.reason} (by ${w.by})`).join('
');
  await tg.sendMessage(c.env.BOT_TOKEN, message.chat.id,
    `⚠️ Warnings for <a href="tg://user?id=${target.id}">${target.first_name}</a>:
${list}`, { parse_mode: 'HTML' });
  return c.text('OK');
}
