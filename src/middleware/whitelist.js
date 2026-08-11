import { tg } from '../telegram';

export async function whitelistCheck(c, update) {
  const OWNER_ID = String(c.env.OWNER_ID || '6816397800');
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  const chatType = update.message?.chat?.type || update.callback_query?.message?.chat?.type;

  if (chatType === 'private' && String(userId) === OWNER_ID) return true;

  const whitelistRaw = await c.env.KV.get('bot_whitelist');
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];
  if (whitelist.includes(String(chatId))) return true;

  if (update.message) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ This bot is private. Contact the owner to authorize this group.');
  }
  return false;
}
