import { Hono } from 'hono';
import { tg } from './telegram';
import { parseInput } from './parser';
import { commandRegistry } from './config';
import { requireAdmin, requireGroup } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { logCommand } from './middleware/logger';
import { handleNewMembers } from './commands/group/welcome';
import { checkReminders } from './commands/external/remind';
import { runMonitor } from './kick/monitor';
import { handleKickEventSub } from './kick/eventsub';
import { ensureSchema } from './db';

const app = new Hono();

const middlewareMap = {
  requireAdmin,
  requireGroup,
  rateLimit,
  logCommand,
};

app.get('/', (c) => c.json({ status: 'Stakick is alive', owner: c.env.OWNER_KICK_SLUG }));

app.post('/webhook', async (c) => {
  await ensureSchema(c.env);
  const update = await c.req.json();
  c.set('update', update);

  // Cache bot username
  const cachedUsername = await c.env.KV.get('bot_username');
  if (!cachedUsername && update.message?.from?.is_bot && update.message.from.username) {
    await c.env.KV.put('bot_username', update.message.from.username);
  }

  // Handle bot added to group
  if (update.my_chat_member) {
    const chat = update.my_chat_member.chat;
    const newStatus = update.my_chat_member.new_chat_member.status;
    if (newStatus === 'member' || newStatus === 'administrator') {
      await c.env.DB.prepare(
        `INSERT INTO group_settings (chat_id, welcome_msg, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO NOTHING`
      ).bind(chat.id, null, Date.now()).run();

      const existingDefault = await c.env.KV.get('default_notify_group');
      if (!existingDefault && chat.type !== 'private') {
        await c.env.KV.put('default_notify_group', chat.id.toString());
      }
    }
    return c.text('OK');
  }

  // Handle new members
  if (update.message?.new_chat_members) {
    return handleNewMembers(c, update);
  }

  // Handle callback queries
  if (update.callback_query) {
    await tg.answerCallbackQuery(c.env.BOT_TOKEN, update.callback_query.id);
    const data = update.callback_query.data;
    const chatId = update.callback_query.message.chat.id;

    if (data === 'cmd_help') {
      const help = commandRegistry.help;
      if (help) await help[0](c, { message: update.callback_query.message }, { args: '' });
    }
    return c.text('OK');
  }

  // Parse input
  const botUsername = cachedUsername || c.env.BOT_USERNAME;
  const parsed = parseInput(update, botUsername);
  if (!parsed) return c.text('OK');
  c.set('parsed', parsed);

  // Route commands
  if (parsed.type === 'command' && parsed.command) {
    const cmdName = parsed.command.replace('/', '');
    const entry = commandRegistry[cmdName];
    if (entry) {
      const [handler, middlewares, scope] = entry;
      const chatType = update.message.chat.type;

      if (scope === 'group' && chatType === 'private') {
        await tg.sendMessage(c.env.BOT_TOKEN, update.message.chat.id, 'Use this in a group!');
        return c.text('OK');
      }

      for (const mwName of middlewares) {
        const mw = middlewareMap[mwName];
        if (mw) {
          let nextCalled = false;
          const result = await mw(c, () => { nextCalled = true; });
          if (!nextCalled) return result || c.text('OK');
        }
      }

      return handler(c, update, parsed);
    }
  }

  // Natural language when tagged
  if (parsed.type === 'natural' && parsed.isMention) {
    const aiEntry = commandRegistry.ask;
    if (aiEntry) {
      const fakeParsed = { ...parsed, args: parsed.args };
      return aiEntry[0](c, update, fakeParsed);
    }
  }

  return c.text('OK');
});

app.post('/kick/eventsub', async (c) => {
  return handleKickEventSub(c);
});

app.get('/kick/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) return c.text('Missing params', 400);

  const chatId = await c.env.KV.get(`oauth_state:${state}`);
  if (!chatId) return c.text('Invalid or expired state', 400);

  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: c.env.KICK_CLIENT_ID,
      client_secret: c.env.KICK_CLIENT_SECRET,
      code,
      redirect_uri: `https://${c.req.headers.get('host')}/kick/oauth/callback`,
    }),
  });

  const data = await res.json();
  if (data.access_token) {
    await c.env.KV.put('kick_user_token', data.access_token, { expirationTtl: 3500 });
    if (data.refresh_token) {
      await c.env.KV.put('kick_refresh_token_backup', data.refresh_token);
    }
    await tg.sendMessage(c.env.BOT_TOKEN, parseInt(chatId), '✅ Kick account linked successfully!');
  } else {
    await tg.sendMessage(c.env.BOT_TOKEN, parseInt(chatId), `❌ OAuth failed: ${data.error_description || 'Unknown'}`);
  }

  return c.text('OAuth complete. You can close this tab.');
});

app.get('/setup', async (c) => {
  await ensureSchema(c.env);
  const setupSecret = c.env.SETUP_SECRET;
  if (setupSecret && c.req.query('key') !== setupSecret) {
    return c.json({ error: 'Unauthorized. Provide the setup key.' }, 401);
  }

  const host = c.req.headers.get('host');
  const webhookUrl = `https://${host}/webhook`;

  const res = await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
      drop_pending_updates: true,
    }),
  });

  const meRes = await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/getMe`);
  const meData = await meRes.json();
  if (meData.ok) {
    await c.env.KV.put('bot_username', meData.result.username);
  }

  const info = await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/getWebhookInfo`);
  return c.json({
    setup: await res.json(),
    bot: meData.result,
    webhook: await info.json(),
  });
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSchema(env));
    ctx.waitUntil(runMonitor({ env, executionCtx: ctx }));
    ctx.waitUntil(checkReminders({ env, executionCtx: ctx }));
  }
};
