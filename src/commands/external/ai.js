import { tg } from '../../telegram';
import { queryAI } from '../../services/ai';

export async function ask(c, update, parsed) {
  const chatId = update.message.chat.id;
  const prompt = parsed.args?.trim();

  if (!prompt) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, 'Usage: <code>/ask How do I center a div?</code>', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  const apiKey = c.env.OPENROUTER_API_KEY || c.env.OPENAI_API_KEY || c.env.OPENAI_KEY;
  if (!apiKey) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ AI API key not configured.', { parse_mode: 'HTML' });
    return c.text('OK');
  }

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  try {
    const host = c.req.header('host') || 'stakick-bot.workers.dev';
    const reply = await queryAI(c.env, prompt, { host });

    const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
    for (const chunk of chunks) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, chunk, {
        parse_mode: 'HTML',
        reply_to_message_id: update.message.message_id,
      });
    }
    return c.text('OK');
  } catch (error) {
    console.error('AI request failed:', error);
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ AI error: ${error.message.slice(0, 200)}`, { parse_mode: 'HTML' });
    return c.text('OK');
  }
}
