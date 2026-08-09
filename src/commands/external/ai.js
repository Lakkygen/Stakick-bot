import { tg } from '../../telegram';

export async function ask(c, update, parsed) {
  const chatId = update.message.chat.id;
  const prompt = parsed.args?.trim();

  if (!prompt) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/ask How do I center a div?</code>',
      { parse_mode: 'HTML' }
    );
    return c.text('OK');
  }

  // FIXED: Support both naming conventions
  const apiKey = c.env.OPENROUTER_API_KEY || c.env.OPENAI_API_KEY || c.env.OPENAI_KEY;
  const model = c.env.OPENROUTER_MODEL || c.env.OPENAI_MODEL || 'google/gemini-2.5-flash-preview:free';

  if (!apiKey) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ AI API key not configured.',
      { parse_mode: 'HTML' }
    );
    return c.text('OK');
  }

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `https://${c.req?.header?.('host') || 'stakick-bot.michaeladedeji366.workers.dev'}`,
        'X-Title': 'Stakick Bot',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Keep answers concise and useful, preferably under 400 words.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 600,
        temperature: 0.7
      })
    });

    const data = await res.json();

    if (!res.ok) {
      const errorMessage = data?.error?.message || `HTTP ${res.status}`;
      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        `❌ AI error: <code>${errorMessage.slice(0, 200)}</code>`,
        { parse_mode: 'HTML' }
      );
      return c.text('OK');
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ AI returned empty response.');
      return c.text('OK');
    }

    const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];

    for (const chunk of chunks) {
      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        chunk,
        {
          parse_mode: 'HTML',
          reply_to_message_id: update.message.message_id,
        }
      );
    }

    return c.text('OK');

  } catch (error) {
    console.error('AI request failed:', error);
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ Could not connect to AI service.'
    );
    return c.text('OK');
  }
}
