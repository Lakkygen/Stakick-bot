import { tg } from '../../telegram';

export async function help(c, update, parsed) {
  const chatId = update.message.chat.id;

  const text = `📚 <b>Stakick Command Reference</b>

<b>Group Commands (tag me + command):</b>
<code>@StakickBot /ban</code> — Reply to user to ban
<code>@StakickBot /mute 30</code> — Mute for 30 min
<code>@StakickBot /warn spam</code> — Warn user
<code>@StakickBot /purge 10</code> — Delete last 10 msgs
<code>@StakickBot /setwelcome Hello!</code> — Set welcome
<code>@StakickBot /setrules Be nice</code> — Set rules
<code>@StakickBot /rules</code> — Show rules

<b>Kick Commands:</b>
<code>/kickwatch xqc</code> — Watch a channel
<code>/kickunwatch xqc</code> — Stop watching
<code>/kicklist</code> — List watched channels
<code>/kickstatus xqc</code> — Check status now
<code>/kickdrops</code> — Recent drop alerts
<code>/kicksetnotify</code> — Set default group (admin)
<code>/kickclips xqc</code> — Show recent clips

<b>External Tools:</b>
<code>/weather London</code>
<code>/crypto BTC</code>
<code>/ask Explain quantum</code>
<code>/translate en es Hello</code>
<code>/remind 30m Check oven</code>

<b>Natural Language:</b>
<code>@StakickBot what's 100 USD in EUR?</code>
<code>@StakickBot remind me to call mom in 2h</code>`;

  await tg.sendMessage(c.env.BOT_TOKEN, chatId, text, { parse_mode: 'HTML' });
  return c.text('OK');
}
