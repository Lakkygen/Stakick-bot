import { tg } from '../../telegram';

export async function weather(c, update, parsed) {
  const chatId = update.message.chat.id;
  const city = parsed.args || 'London';

  await tg.sendChatAction(c.env.BOT_TOKEN, chatId, 'typing');

  const cacheKey = `weather:${city.toLowerCase().replace(/\s/g, '_')}`;
  let data = await c.env.KV.get(cacheKey, 'json');

  if (!data) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${c.env.OPENWEATHER_KEY}&units=metric`;
    const res = await fetch(url);
    if (!res.ok) {
      await tg.sendMessage(c.env.BOT_TOKEN, chatId, `❌ City not found: ${city}`);
      return c.text('OK');
    }
    data = await res.json();
    await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 });
  }

  const emojiMap = {
    Clear: '☀️', Clouds: '☁️', Rain: '🌧', Drizzle: '🌦', Thunderstorm: '⛈',
    Snow: '❄️', Mist: '🌫', Fog: '🌫',
  };
  const emoji = emojiMap[data.weather[0].main] || '🌡';

  const text = `${emoji} <b>${data.name}, ${data.sys.country}</b>
├ 🌡 Temperature: <code>${data.main.temp}°C</code> (feels ${data.main.feels_like}°C)
├ 💧 Humidity: <code>${data.main.humidity}%</code>
├ 💨 Wind: <code>${data.wind.speed} m/s</code>
└ 🌤 Condition: <i>${data.weather[0].description}</i>`;

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, text, { parse_mode: 'HTML' });
  return c.text('OK');
}
