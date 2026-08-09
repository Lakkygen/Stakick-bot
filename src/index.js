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

const app = new Hono();

// ============================================================
// OWNER & WHITELIST CONFIG
// ============================================================

const OWNER_ID = '6816397800';

/**
 * Check if this chat/user is allowed to use the bot.
 * - Owner can use in private chat
 * - Owner can run /approve in ANY group (even unapproved)
 * - Only approved groups are allowed for everyone else
 */
async function whitelistCheck(c, update) {
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  const userId = update.message?.from?.id || update.callback_query?.from?.id;
  const chatType = update.message?.chat?.type || update.callback_query?.message?.chat?.type;
  const text = update.message?.text || '';

  // Owner always allowed in private chat
  if (chatType === 'private' && String(userId) === OWNER_ID) {
    return true;
  }

  // FIX: Owner can always run /approve to authorize a group
  if (String(userId) === OWNER_ID && text.trim().toLowerCase().startsWith('/approve')) {
    return true;
  }

  // Check approved groups list
  const whitelistRaw = await c.env.KV.get('bot_whitelist');
  const whitelist = whitelistRaw ? JSON.parse(whitelistRaw) : [];

  if (whitelist.includes(String(chatId))) {
    return true;
  }

  // Not allowed — warn and block
  if (update.message) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ This bot is private. Contact the owner to authorize this group.'
    );
  }

  return false;
}

// ============================================================
// INLINE AI HANDLER
// ============================================================

async function handleOpenRouterAI(c, prompt) {
  const apiKey = c.env.OPENROUTER_API_KEY || c.env.OPENAI_KEY;
  const baseUrl = c.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = c.env.OPENROUTER_MODEL || c.env.OPENAI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

  if (!apiKey) return '❌ No AI API key configured.';
  if (!model) return '❌ No AI model configured.';

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': `https://${c.req.header('host') || 'stakick-bot.michaeladedeji366.workers.dev'}`,
        'X-Title': 'StakickBot',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are StakickBot, a helpful assistant. Keep answers concise.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.7,
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return `❌ AI error (${res.status}): ${err.slice(0, 200)}`;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '❌ Empty AI response.';

  } catch (err) {
    return `❌ AI error: ${err.message}`;
  }
}

// ============================================================
// MIDDLEWARE REGISTRY
// ============================================================

const middlewareMap = {
  requireAdmin,
  requireGroup,
  rateLimit,
  logCommand,
};

// ============================================================
// HEALTH / STATUS ROUTES
// ============================================================

app.get('/', (c) => {
  return c.json({
    status: 'Stakick is alive',
    owner: c.env.OWNER_KICK_SLUG || 'unknown',
    service: 'stakick-bot',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'stakick-bot',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();
    c.set('update', update);

    // WHITELIST CHECK — block unauthorized groups
    const allowed = await whitelistCheck(c, update);
    if (!allowed) return c.text('OK');

    const cachedUsername = await c.env.KV.get('bot_username');

    if (
      !cachedUsername &&
      update.message?.from?.is_bot &&
      update.message?.from?.username
    ) {
      await c.env.KV.put('bot_username', update.message.from.username);
    }

    // BOT ADDED / REMOVED FROM GROUP
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const newStatus = update.my_chat_member.new_chat_member?.status;

      if (newStatus === 'member' || newStatus === 'administrator') {
        await c.env.DB.prepare(
          `INSERT INTO group_settings (chat_id, welcome_msg, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO NOTHING`
        )
          .bind(chat.id, null, Date.now())
          .run();

        const existingDefault = await c.env.KV.get('default_notify_group');
        if (!existingDefault && chat.type !== 'private') {
          await c.env.KV.put('default_notify_group', String(chat.id));
        }
      }

      return c.text('OK');
    }

    // NEW MEMBERS
    if (update.message?.new_chat_members) {
      return await handleNewMembers(c, update);
    }

    // CALLBACK QUERIES
    if (update.callback_query) {
      await tg.answerCallbackQuery(c.env.BOT_TOKEN, update.callback_query.id);

      const data = update.callback_query.data;
      const callbackMessage = update.callback_query.message;

      if (!callbackMessage) return c.text('OK');

      if (data === 'cmd_help') {
        const help = commandRegistry.help;
        if (help) await help[0](c, { message: callbackMessage }, { args: '' });
      }

      return c.text('OK');
    }

    // INPUT PARSING
    const botUsername = cachedUsername || c.env.BOT_USERNAME || '';
    const parsed = parseInput(update, botUsername);

    if (!parsed) return c.text('OK');

    c.set('parsed', parsed);

    // COMMAND ROUTING
    if (parsed.type === 'command' && parsed.command) {
      const cmdName = parsed.command
        .replace(/^\//, '')
        .split('@')[0]
        .toLowerCase();

      // OWNER-ONLY APPROVE COMMAND
      if (cmdName === 'approve') {
        const userId = String(update.message?.from?.id);
        const chatId = update.message.chat.id;

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

    // NATURAL LANGUAGE / AI
    if (parsed.type === 'natural' && parsed.isMention) {
      const reply = await handleOpenRouterAI(c, parsed.args || parsed.text || '');

      if (update.message?.chat?.id) {
        await tg.sendMessage(c.env.BOT_TOKEN, update.message.chat.id, reply, { parse_mode: 'HTML' });
      }

      return c.text('OK');
    }

    return c.text('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({ ok: false, error: 'Webhook processing failed' }, 500);
  }
});

// ============================================================
// KICK EVENTSUB
// ============================================================

app.post('/kick/eventsub', async (c) => {
  try {
    return await handleKickEventSub(c);
  } catch (error) {
    console.error('Kick EventSub error:', error);
    return c.json({ ok: false, error: 'Kick EventSub processing failed' }, 500);
  }
});

// ============================================================
// KICK OAUTH CALLBACK
// ============================================================

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

// ============================================================
// TELEGRAM SETUP
// ============================================================

app.get('/setup', async (c) => {
  try {
    if (!c.env.BOT_TOKEN) {
      return c.json({ ok: false, error: 'BOT_TOKEN is not configured as a Worker secret.' }, 500);
    }

    if (!c.env.KV) {
      return c.json({ ok: false, error: 'KV binding is missing from the Worker.' }, 500);
    }

    const setupSecret = c.env.SETUP_SECRET;
    if (setupSecret && c.req.query('key') !== setupSecret) {
      return c.json({ ok: false, error: 'Unauthorized. Provide the setup key.' }, 401);
    }

    const host = c.req.header('host');
    if (!host) {
      return c.json({ ok: false, error: 'Unable to determine Worker hostname.' }, 500);
    }

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
      webhook: {
        url: webhookUrl,
        registration: setWebhookData,
        status: webhookData,
      },
      bot: meData?.ok
        ? {
            id: meData.result.id,
            username: meData.result.username,
            first_name: meData.result.first_name,
            is_bot: meData.result.is_bot,
          }
        : { error: meData?.description || 'Unable to retrieve bot information.' },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Setup endpoint error:', error);
    return c.json({ ok: false, error: 'Setup failed.', message: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// ============================================================
// 404 & ERROR HANDLERS
// ============================================================

app.notFound((c) => {
  return c.json({ ok: false, error: 'Route not found', path: new URL(c.req.url).pathname, method: c.req.method, service: 'stakick-bot' }, 404);
});

app.onError((error, c) => {
  console.error('Unhandled Worker error:', error);
  return c.json({ ok: false, error: 'Internal server error' }, 500);
});

// ============================================================
// CLOUDFLARE WORKER EXPORT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitor({ env, executionCtx: ctx }));
    ctx.waitUntil(checkReminders({ env, executionCtx: ctx }));
  },
};
