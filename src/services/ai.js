export async function queryAI(env, prompt, opts = {}) {
  const apiKey = env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.OPENAI_KEY;
  const baseUrl = env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = env.OPENROUTER_MODEL || env.OPENAI_MODEL || 'google/gemini-2.5-flash-preview:free';
  const maxTokens = opts.maxTokens || 600;
  const temperature = opts.temperature ?? 0.7;
  const systemPrompt = opts.systemPrompt || 'You are StakickBot, a helpful assistant. Keep answers concise and useful, preferably under 400 words.';
  const host = opts.host || 'stakick-bot.workers.dev';

  if (!apiKey) throw new Error('No AI API key configured.');
  if (!model) throw new Error('No AI model configured.');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': `https://${host}`,
      'X-Title': 'StakickBot',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      temperature,
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI error (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}
