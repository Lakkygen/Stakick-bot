import { tg } from '../telegram';

export async function requireAdmin(c, next) {
  const { update } = c.var;
  const msg = update.message || update.callback_query?.message;
  if (!msg) return next();

  const chatType = msg.chat.type;
  if (chatType === 'private') {
    await tg.sendMessage(c.env.BOT_TOKEN, msg.chat.id, '⛔ Group command only.');
    return c.text('OK');
  }

  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  const res = await tg.getChatMember(c.env.BOT_TOKEN, msg.chat.id, userId);
  const data = await res.json();

  if (!['creator', 'administrator'].includes(data.result?.status)) {
    await tg.sendMessage(c.env.BOT_TOKEN, msg.chat.id, '⛔ Admins only, buddy.');
    return c.text('OK');
  }
  return next();
}

export async function requireGroup(c, next) {
  const { update } = c.var;
  const msg = update.message;
  if (msg && msg.chat.type === 'private') {
    await tg.sendMessage(c.env.BOT_TOKEN, msg.chat.id, 'Use this in a group!');
    return c.text('OK');
  }
  return next();
}
