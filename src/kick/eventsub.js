import { tg } from '../telegram';

export async function handleKickEventSub(c) {
  const body = await c.req.json();

  const defaultGroup = await c.env.KV.get('default_notify_group');
  if (!defaultGroup) return c.text('OK');

  const { event, data } = body;

  switch (event) {
    case 'livestream.status.updated':
      if (data.is_live) {
        await tg.sendMessage(c.env.BOT_TOKEN, parseInt(defaultGroup),
          `🔴 <b>${data.channel_slug}</b> went LIVE!
📺 ${data.title}
🔗 https://kick.com/${data.channel_slug}`,
          { parse_mode: 'HTML' });
      } else {
        await tg.sendMessage(c.env.BOT_TOKEN, parseInt(defaultGroup),
          `⚫ <b>${data.channel_slug}</b> went offline.`, { parse_mode: 'HTML' });
      }
      break;
  }

  return c.text('OK');
}
