import { tg } from '../../telegram';

export async function ask(c, update, parsed) {
  const chatId = update.message.chat.id;
  const prompt = parsed.args;

  if (!prompt) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'Usage: <code>/ask How do I center a div?</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.OPENAI_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Keep answers concise (under 400 words).' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || '❌ AI service error. Try again.';

  const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
  for (const chunk of chunks) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, chunk, {
      parse_mode: 'HTML',
      reply_to_message_id: update.message.message_id,
    });
  }
  return c.text('OK');
}
