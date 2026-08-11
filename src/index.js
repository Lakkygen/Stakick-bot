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
import { queryAI } from './services/ai';
import { ensureSchema } from './db';

const app = new Hono();

function getOwnerId(env) {
  return String(env.OWNER_ID || '6816397800');
}

async function whitelistCheck(c, update) {
  const OWNER_ID = getOwnerId(c.env);
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  const chatType = update.message?.chat?.type || update.callback_query?.message?.chat?.type;
  const text = update.message?.text || '';

  if (chatType === 'private' && String(userId) === OWNER_ID) return true;
  if (String(userId) === OWNER_ID && text.trim().toLowerCase().startsWith('/approve')) return true;

  const whitelistRaw = await c.env.KV.get('bot_whitelist');
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];

  if (whitelist.includes(String(chatId))) return true;

  if (update.message) {
    await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ This bot is private. Contact the owner to authorize this group.');
  }
  return false;
}

async function handleOpenRouterAI(c, prompt) {
  try {
    const host = c.req.header('host') || 'stakick-bot.workers.dev';
    const reply = await queryAI(c.env, prompt, { host });
    return reply || '❌ Empty AI response.';
  } catch (err) {
    return `❌ AI error: ${err.message}`;
  }
}

const middlewareMap = {
  requireAdmin,
  requireGroup,
  rateLimit,
  logCommand,
};

app.get('/', (c) => {
  return c.json({
    status: 'Stakick is alive',
    owner: c.env.OWNER_KICK_SLUG || 'unknown',
    service: 'stakick-bot',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (c) => {
  let dbOk = false, kvOk = false;
  const start = Date.now();
  try {
    await ensureSchema(c.env);
    await c.env.DB.prepare('SELECT 1').run();
    dbOk = true;
  } catch (e) { console.error('Health DB check failed:', e.message); }
  try {
    await c.env.KV.put('health_check', Date.now().toString(), { expirationTtl: 60 });
    await c.env.KV.get('health_check');
    kvOk = true;
  } catch (e) { console.error('Health KV check failed:', e.message); }
  const latencyMs = Date.now() - start;

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        'INSERT INTO bot_health_log (check_type, status, details, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind('http_health', dbOk && kvOk ? 'ok' : 'degraded', `db=${dbOk}, kv=${kvOk}`, latencyMs, Date.now()).run().catch(() => {})
    );
  }

  return c.json({ ok: dbOk && kvOk, db: dbOk, kv: kvOk, latency_ms: latencyMs, service: 'stakick-bot', version: '2.0.0', timestamp: new Date().toISOString() });
});

app.get('/run', async (c) => {
  const setupSecret = c.env.SETUP_SECRET;
  if (setupSecret && c.req.query('key') !== setupSecret) {
    return c.json({ ok: false, error: 'Unauthorized. Provide setup key.' }, 401);
  }
  console.log('🔥 Manual /run triggered');
  const start = Date.now();
  try {
    await runMonitor({ env: c.env, executionCtx: c.executionCtx });
    return c.json({ ok: true, message: 'Monitor executed.', duration_ms: Date.now() - start });
  } catch (err) {
    console.error('❌ /run error:', err);
    return c.json({ ok: false, error: err.message, duration_ms: Date.now() - start }, 500);
  }
});

app.post('/webhook', async (c) => {
  const requestId = crypto.randomUUID();
  try {
    await ensureSchema(c.env);
    const update = await c.req.json();
    c.set('update', update);

    const allowed = await whitelistCheck(c, update);
    if (!allowed) return c.text('OK');

    const cachedUsername = await c.env.KV.get('bot_username');
    if (!cachedUsername && update.message?.from?.is_bot && update.message?.from?.username) {
      await c.env.KV.put('bot_username', update.message.from.username);
    }

    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const newStatus = update.my_chat_member.new_chat_member?.status;
      if (newStatus === 'member' || newStatus === 'administrator') {
        await c.env.DB.prepare(
          `INSERT INTO group_settings (chat_id, welcome_msg, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO NOTHING`
        ).bind(chat.id, null, Date.now()).run();
        const existingDefault = await c.env.KV.get('default_notify_group');
        if (!existingDefault && chat.type !== 'private') {
          await c.env.KV.put('default_notify_group', String(chat.id));
        }
      }
      return c.text('OK');
    }

    if (update.message?.new_chat_members) {
      return await handleNewMembers(c, update);
    }

    if (update.callback_query) {
      await tg.answerCallbackQuery(c.env.BOT_TOKEN, update.callback_query.id);
      const data = update.callback_query.data;
      const callbackMessage = update.callback_query.message;
      if (!callbackMessage) return c.text('OK');

      const callbackMap = {
        cmd_help: 'help',
        cmd_weather: 'weather',
        cmd_crypto: 'crypto',
        cmd_ai: 'ask',
        cmd_remind: 'remind',
        cmd_kick: 'kickstatus',
      };

      const cmdName = callbackMap[data];
      if (cmdName && commandRegistry[cmdName]) {
        const [handler] = commandRegistry[cmdName];
        await handler(c, { message: callbackMessage }, { args: '' });
        return c.text('OK');
      }
      if (data === 'menu_main') {
        const startCmd = commandRegistry.start;
        if (startCmd) await startCmd[0](c, { message: callbackMessage }, { args: '' });
        return c.text('OK');
      }
      return c.text('OK');
    }

    const botUsername = cachedUsername || c.env.BOT_USERNAME || '';
    const parsed = parseInput(update, botUsername);
    if (!parsed) return c.text('OK');
    c.set('parsed', parsed);

    if (parsed.type === 'command' && parsed.command) {
      const cmdName = parsed.command.replace(/^\//, '').split('@')[0].toLowerCase();

      if (cmdName === 'approve') {
        const userId = String(update.message?.from?.id);
        const chatId = update.message.chat.id;
        const OWNER_ID = getOwnerId(c.env);
        if (userId !== OWNER_ID) {
          await tg.sendMessage(c.env.BOT_TOKEN, chatId, '❌ Owner only.');
          return c.text('OK');
        }
        const targetId = parsed.args?.trim() || String(chatId);
        const whitelistRaw = await c.env.KV.get('bot_whitelist');
        const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];
        if (!whitelist.includes(targetId)) {
          whitelist.push(targetId);
          await c.env.KV.put('bot_whitelist', JSON.stringify(whitelist));
        }
        await tg.sendMessage(c.env.BOT_TOKEN, chatId, `✅ Group ${targetId} approved.`);
        return c.text('OK');
      }

      const entry = commandRegistry[cmdName];
      if (entry) {
        const [handler, middlewares = [], scope] = entry;
        const chatType = update.message?.chat?.type;
        if (scope === 'group' && chatType === 'private') {
          await tg.sendMessage(c.env.BOT_TOKEN, update.message.chat.id, 'Use this command in a group!');
          return c.text('OK');
        }
        for (const mwName of middlewares) {
          const middleware = middlewareMap[mwName];
          if (!middleware) continue;
          let nextCalled = false;
          const result = await middleware(c, () => { nextCalled = true; });
          if (!nextCalled) return result || c.text('OK');
        }
        return await handler(c, update, parsed);
      }
    }

    if (parsed.type === 'natural' && parsed.isMention) {
      const reply = await handleOpenRouterAI(c, parsed.args || parsed.text || '');
      if (update.message?.chat?.id) {
        await tg.sendMessage(c.env.BOT_TOKEN, update.message.chat.id, reply, { parse_mode: 'HTML' });
      }
      return c.text('OK');
    }

    return c.text('OK');
  } catch (error) {
    console.error(`[${requestId}] Webhook error:`, error);
    return c.json({ ok: false, error: 'Webhook processing failed', request_id: requestId }, 500);
  }
});

app.post('/kick/eventsub', async (c) => {
  try {
    return await handleKickEventSub(c);
  } catch (error) {
    console.error('Kick EventSub error:', error);
    return c.json({ ok: false, error: 'Kick EventSub processing failed' }, 500);
  }
});

app.get('/kick/oauth/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.text('Missing OAuth parameters.', 400);
    const chatId = await c.env.KV.get(`oauth_state:${state}`);
    if (!chatId) return c.text('Invalid or expired OAuth state.', 400);

    const host = c.req.header('host');
    const redirectUri = `https://${host}/kick/oauth/callback`;
    const response = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: c.env.KICK_CLIENT_ID,
        client_secret: c.env.KICK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await response.json();
    if (data.access_token) {
      await c.env.KV.put('kick_user_token', data.access_token, { expirationTtl: 3500 });
      if (data.refresh_token) await c.env.KV.put('kick_refresh_token_backup', data.refresh_token);
      await tg.sendMessage(c.env.BOT_TOKEN, Number(chatId), '✅ Kick account linked successfully!');
    } else {
      await tg.sendMessage(c.env.BOT_TOKEN, Number(chatId), `❌ OAuth failed: ${data.error_description || data.error || 'Unknown error'}`);
    }
    return c.text('OAuth complete. You can close this tab.');
  } catch (error) {
    console.error('Kick OAuth callback error:', error);
    return c.text('OAuth processing failed.', 500);
  }
});

app.get('/setup', async (c) => {
  try {
    if (!c.env.BOT_TOKEN) return c.json({ ok: false, error: 'BOT_TOKEN is not configured as a Worker secret.' }, 500);
    if (!c.env.KV) return c.json({ ok: false, error: 'KV binding is missing from the Worker.' }, 500);

    const setupSecret = c.env.SETUP_SECRET;
    if (setupSecret && c.req.query('key') !== setupSecret) {
      return c.json({ ok: false, error: 'Unauthorized. Provide the setup key.' }, 401);
    }
    const host = c.req.header('host');
    if (!host) return c.json({ ok: false, error: 'Unable to determine Worker hostname.' }, 500);

    const webhookUrl = `https://${host}/webhook`;
    const setWebhookResponse = await fetch(
      `https://api.telegram.org/bot${c.env.BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
          drop_pending_updates: true,
        }),
      }
    );
    const setWebhookData = await setWebhookResponse.json();
    const meResponse = await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/getMe`);
    const meData = await meResponse.json();
    if (meData?.ok && meData?.result?.username) {
      await c.env.KV.put('bot_username', meData.result.username);
    }
    const webhookResponse = await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/getWebhookInfo`);
    const webhookData = await webhookResponse.json();

    return c.json({
      ok: Boolean(setWebhookData?.ok) && Boolean(meData?.ok),
      service: 'stakick-bot',
      version: '2.0.0',
      webhook: { url: webhookUrl, registration: setWebhookData, status: webhookData },
      bot: meData?.ok ? { id: meData.result.id, username: meData.result.username, first_name: meData.result.first_name, is_bot: meData.result.is_bot }
                      : { error: meData?.description || 'Unable to retrieve bot information.' },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Setup endpoint error:', error);
    return c.json({ ok: false, error: 'Setup failed.', message: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

app.notFound((c) => {
  return c.json({ ok: false, error: 'Route not found', path: new URL(c.req.url).pathname, method: c.req.method, service: 'stakick-bot' }, 404);
});

app.onError((error, c) => {
  console.error('Unhandled Worker error:', error);
  return c.json({ ok: false, error: 'Internal server error' }, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitor({ env, executionCtx: ctx }));
    ctx.waitUntil(checkReminders({ env, executionCtx: ctx }));
  },
};
