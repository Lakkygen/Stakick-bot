import { tg } from '../../telegram';
import { mainMenu } from '../../utils/keyboards';

export async function start(c, update, parsed) {
  const chatId = update.message.chat.id;
  const name = update.message.from.first_name;

  const text = `👋 Hey <b>${name}</b>!

I'm <b>Stakick</b> — your multi-function bot powered by Cloudflare.

<b>In Groups:</b>
• Tag me: <code>@StakickBot /weather London</code>
• Or just tag me naturally: <code>@StakickBot what's the weather?</code>
• Admin tools: /ban, /mute, /warn, /purge

<b>Kick Integration:</b>
• <code>/kickwatch xqc</code> — watch any Kick channel
• <code>/kickstatus</code> — check live status
• <code>/kickdrops</code> — drop alerts
• Auto-alerts: go-live, milestones, title changes, drops

<b>In Private:</b>
• Direct commands: /weather, /crypto, /ask, /translate
• Or just chat naturally!

Use the buttons below or type /help.`;

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, text, {
    reply_markup: mainMenu,
  });
  return c.text('OK');
}
