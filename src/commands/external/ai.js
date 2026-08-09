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

  // FIXED: Support both naming conventions + default free model
  const apiKey = c.env.OPENROUTER_API_KEY || c.env.OPENAI_KEY;
  const model = c.env.OPENROUTER_MODEL || c.env.OPENAI_MODEL || 'google/gemini-2.5-flash-preview:free';

  if (!apiKey) {
    console.error('OPENROUTER_API_KEY / OPENAI_KEY is not configured');
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ AI service is not configured. Please contact the bot administrator.',
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
      console.error('OpenRouter API error:', res.status, JSON.stringify(data));
      const errorMessage = data?.error?.message || data?.error?.metadata?.raw || `OpenRouter returned HTTP ${res.status}`;
      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        `❌ AI service error.\n\n<code>${escapeHtml(errorMessage)}</code>`,
        { parse_mode: 'HTML' }
      );
      return c.text('OK');
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error('OpenRouter returned no message:', JSON.stringify(data));
      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        '❌ The AI returned an empty response. Please try again.'
      );
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
    console.error('OpenRouter request failed:', error);
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ Could not connect to the AI service. Please try again shortly.'
    );
    return c.text('OK');
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
