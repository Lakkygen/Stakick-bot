// src/commands/external/ai.js
// OpenRouter integration for Stakick Bot

export async function handleAIQuery(c, userMessage) {
  const apiKey = c.env.OPENROUTER_API_KEY || c.env.OPENAI_KEY;
  const baseUrl = c.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
  const model = c.env.OPENAI_MODEL || c.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-preview:free";

  if (!apiKey) {
    return "❌ No AI API key configured. Add OPENROUTER_API_KEY to Cloudflare environment variables.";
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": `https://${c.req.headers.get("host") || "stakick-bot.michaeladedeji366.workers.dev"}`,
        "X-Title": "StakickBot"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are StakickBot, a helpful Telegram assistant. Keep answers short and useful."
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        max_tokens: 800,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("OpenRouter error:", res.status, errText);
      return `❌ AI service error (${res.status}): ${errText.slice(0, 200)}`;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      return "❌ AI returned empty response.";
    }

    return reply;

  } catch (err) {
    console.error("AI fetch error:", err);
    return `❌ AI service error: ${err.message}`;
  }
}
