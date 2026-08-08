import { tg } from '../../telegram';

export async function crypto(c, update, parsed) {
  const chatId = update.message.chat.id;
  const symbol = (parsed.args || 'BTC').toUpperCase();

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  const cacheKey = `crypto:${symbol}`;
  let data = await c.env.KV.get(cacheKey, 'json');

  if (!data) {
    const res = await fetch(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbol}&convert=USD`,
      { headers: { 'X-CMC_PRO_API_KEY': c.env.CMC_KEY || '' } }
    );
    if (!res.ok) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ Coin not found: ${symbol}`);
      return c.text('OK');
    }
    const json = await res.json();
    data = json.data?.[symbol];
    if (!data) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ No data for ${symbol}`);
      return c.text('OK');
    }
    await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  }

  const q = data.quote.USD;
  const changeEmoji = q.percent_change_24h >= 0 ? '🟢' : '🔴';

  const text = `💰 <b>${data.name} (${data.symbol})</b>
├ 💵 Price: <code>$${q.price.toFixed(2)}</code>
├ 📊 24h: ${changeEmoji} <code>${q.percent_change_24h.toFixed(2)}%</code>
├ 💎 Market Cap: <code>$${(q.market_cap / 1e9).toFixed(2)}B</code>
└ 🔄 Volume 24h: <code>$${(q.volume_24h / 1e9).toFixed(2)}B</code>`;

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, text, { parse_mode: 'HTML' });
  return c.text('OK');
}
