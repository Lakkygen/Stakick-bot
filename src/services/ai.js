// src/services/ai.js
// ============================================================
// STAKICKBOT — OPENROUTER CHAT COMPLETIONS
// ============================================================

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-2.5-flash-preview:free';

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  // Some providers can return structured content.
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        return part?.text || '';
      })
      .join('')
      .trim();
  }

  return '';
}

export async function queryAI(env, prompt, opts = {}) {
  const apiKey =
    env.OPENROUTER_API_KEY ||
    env.OPENAI_API_KEY ||
    env.OPENAI_KEY;

  // Preferred:
  // OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
  //
  // Your old OPENAI_BASE_URL is still supported for compatibility.
  const baseUrl = normalizeBaseUrl(
    env.OPENROUTER_BASE_URL ||
    env.OPENAI_BASE_URL ||
    DEFAULT_BASE_URL
  );

  const model =
    env.OPENROUTER_MODEL ||
    env.OPENAI_MODEL ||
    DEFAULT_MODEL;

  const maxTokens = Number.isFinite(Number(opts.maxTokens))
    ? Number(opts.maxTokens)
    : 600;

  const temperature =
    opts.temperature !== undefined
      ? Number(opts.temperature)
      : 0.7;

  const systemPrompt =
    opts.systemPrompt ||
    'You are StakickBot, a helpful assistant. Keep answers concise, useful, and preferably under 400 words.';

  const host =
    opts.host ||
    env.BOT_HOST ||
    'stakick-bot.workers.dev';

  if (!apiKey) {
    throw new Error('No OpenRouter API key configured.');
  }

  if (!model) {
    throw new Error('No AI model configured.');
  }

  if (!prompt || !String(prompt).trim()) {
    throw new Error('No prompt provided.');
  }

  const endpoint = `${baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,

        // OpenRouter recommends these optional attribution headers.
        'HTTP-Referer': `https://${host}`,
        'X-Title': 'StakickBot',
      },

      body: JSON.stringify({
        model,

        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: String(prompt),
          },
        ],

        max_tokens: maxTokens,
        temperature,
      }),

      signal: controller.signal,
    });

    const raw = await response.text();

    let data = null;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const providerMessage =
        data?.error?.message ||
        data?.error?.metadata?.raw ||
        raw ||
        'Unknown provider error';

      throw new Error(
        `OpenRouter error (${response.status}): ${String(providerMessage).slice(0, 500)}`
      );
    }

    const text = extractText(data);

    if (!text) {
      throw new Error('OpenRouter returned an empty AI response.');
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('AI request timed out after 25 seconds.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
