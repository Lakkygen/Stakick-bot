import { tg } from '../../telegram';

export async function ask(c, update, parsed) {
  const chatId = update.message.chat.id;
  const prompt = parsed.args?.trim();

  // Check for a prompt
  if (!prompt) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      'Usage: <code>/ask How do I center a div?</code>',
      { parse_mode: 'HTML' }
    );

    return c.text('OK');
  }

  // Check required environment variables
  const apiKey = c.env.OPENROUTER_API_KEY;
  const model = c.env.OPENROUTER_MODEL;

  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not configured');

    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ AI service is not configured. Please contact the bot administrator.',
      { parse_mode: 'HTML' }
    );

    return c.text('OK');
  }

  if (!model) {
    console.error('OPENROUTER_MODEL is not configured');

    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ AI model is not configured. Please contact the bot administrator.',
      { parse_mode: 'HTML' }
    );

    return c.text('OK');
  }

  // Show typing indicator
  await tg.sendChatAction(
    c.env.BOT_TOKEN,
    chatId,
    'typing'
  );

  try {
    const res = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',

          // Optional OpenRouter attribution headers
          'HTTP-Referer': 'https://stakick.com',
          'X-Title': 'Stakick Bot',
        },

        body: JSON.stringify({
          model: model,

          messages: [
            {
              role: 'system',
              content:
                'You are a helpful assistant. Keep answers concise and useful, preferably under 400 words.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],

          max_tokens: 600,
          temperature: 0.7
        })
      }
    );

    const data = await res.json();

    // Log the actual OpenRouter error for Cloudflare debugging
    if (!res.ok) {
      console.error(
        'OpenRouter API error:',
        res.status,
        JSON.stringify(data)
      );

      const errorMessage =
        data?.error?.message ||
        data?.error?.metadata?.raw ||
        `OpenRouter returned HTTP ${res.status}`;

      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        `❌ AI service error.\n\n<code>${escapeHtml(errorMessage)}</code>`,
        { parse_mode: 'HTML' }
      );

      return c.text('OK');
    }

    // Extract the AI response
    const reply =
      data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error(
        'OpenRouter returned no message:',
        JSON.stringify(data)
      );

      await tg.sendMessage(
        c.env.BOT_TOKEN,
        chatId,
        '❌ The AI returned an empty response. Please try again.'
      );

      return c.text('OK');
    }

    // Telegram messages have a 4096-character limit.
    // Keep a little room below the limit.
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

// Escape HTML so API error messages cannot break Telegram HTML parsing.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
