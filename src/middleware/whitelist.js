// src/middleware/whitelist.js
import { tg } from '../telegram';

// REPLACE THIS with your actual Telegram numeric ID
// Get it from @userinfobot on Telegram
const OWNER_ID = '6816397800';

export async function whitelistCheck(c, update) {
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  const chatType = update.message?.chat?.type || update.callback_query?.message?.chat?.type;

  // Always allow owner in private chat
  if (chatType === 'private' && userId === Number(OWNER_ID)) {
    return true;
  }

  // Always allow approved groups
  const whitelistRaw = await c.env.KV.get('bot_whitelist');
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];

  if (whitelist.includes(String(chatId))) {
    return true;
  }

  // Not allowed — send warning and block
  if (update.message) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ This bot is private. Contact the owner to authorize this group.'
    );
  }

  return false;
}
