// src/commands/admin/approve.js
import { tg } from '../../telegram';

const OWNER_ID = 'LAKKYGEN'; // Same as whitelist.js

export async function approve(c, update, parsed) {
  const userId = update.message?.from?.id;
  const chatId = update.message.chat.id;

  if (userId !== Number(OWNER_ID)) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ Owner only.');
    return c.text('OK');
  }

  // Approve current group or a specific ID
  const targetId = parsed.args?.trim() || String(chatId);
  const whitelistRaw = await c.env.KV.get('bot_whitelist');
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];

  if (!whitelist.includes(targetId)) {
    whitelist.push(targetId);
    await c.env.KV.put('bot_whitelist', JSON.stringify(whitelist));
  }

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, `✅ Group ${targetId} approved.`);
  return c.text('OK');
}
