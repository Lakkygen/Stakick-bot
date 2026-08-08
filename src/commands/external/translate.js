import { tg } from '../../telegram';

export async function translate(c, update, parsed) {
  const chatId = update.message.chat.id;
  const parts = parsed.args.split(' ');

  if (parts.length < 3) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId,
      'Usage: <code>/translate en es Hello world</code>\nFormat: /translate [from] [to] [text]', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const [from, to, ...textParts] = parts;
  const text = textParts.join(' ');

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
  const res = await fetch(url);
  const data = await res.json();

  const translated = data.responseData?.translatedText || 'Translation failed.';

  await tg.sendMessage(c.env.BOT_TOKEN, chatId,
    `🔄 <b>Translation</b> (${from} → ${to}):\n<i>${translated}</i>`, { parse_mode: 'HTML' });
  return c.text('OK');
}
