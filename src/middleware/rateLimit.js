import { tg } from '../telegram';

export async function rateLimit(c, next) {
  const userId = c.var.update.message?.from?.id || c.var.update.callback_query?.from?.id;
  if (!userId) return next();

  const key = `ratelimit:${userId}`;
  const current = parseInt(await c.env.KV.get(key) || '0');

  if (current >= 10) {
    await tg.sendMessage(c.env.BOT_TOKEN, c.var.update.message?.chat?.id || c.var.update.callback_query?.message?.chat?.id,
      '⏳ Rate limit hit. Slow down!');
    return c.text('OK');
  }

  await c.env.KV.put(key, (current + 1).toString(), { expirationTtl: 60 });
  return next();
}
