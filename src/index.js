import { Hono } from 'hono';

import { tg } from './telegram';
import { parseInput } from './parser';
import { commandRegistry } from './config';
import {
  requireAdmin,
  requireGroup,
} from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { logCommand } from './middleware/logger';
import { handleNewMembers } from './commands/group/welcome';
import { checkReminders } from './commands/external/remind';
import { handleKickEventSub } from './kick/eventsub';
import { queryAI } from './services/ai';
import { ensureSchema } from './db';

// IMPORTANT:
// This must match src/kick/dropAlarm.js exactly.
import { DropAlarm } from './kick/dropAlarm';

const app = new Hono();

// ============================================================
// CONFIG
// ============================================================

const MONITOR_ALARM_NAME = 'main-monitor';

// ============================================================
// HELPERS
// ============================================================

function getOwnerId(env) {
  return String(env.OWNER_ID || '6816397800');
}

function isAuthorizedSecret(env, provided) {
  const configured = env.SETUP_SECRET;

  if (!configured) {
    return true;
  }

  return provided === configured;
}

async function whitelistCheck(c, update) {
  const OWNER_ID = getOwnerId(c.env);

  const chatId =
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id;

  const userId =
    update.message?.from?.id ||
    update.callback_query?.from?.id;

  const chatType =
    update.message?.chat?.type ||
    update.callback_query?.message?.chat?.type;

  const text =
    update.message?.text || '';

  // Owner private chat is always allowed.
  if (
    chatType === 'private' &&
    String(userId) === OWNER_ID
  ) {
    return true;
  }

  // Owner can approve chats before they are whitelisted.
  if (
    String(userId) === OWNER_ID &&
    text.trim().toLowerCase().startsWith('/approve')
  ) {
    return true;
  }

  const whitelistRaw =
    await c.env.KV.get('bot_whitelist');

  let whitelist = [];

  try {
    whitelist = whitelistRaw
      ? JSON.parse(whitelistRaw)
      : [];
  } catch {
    whitelist = [];
  }

  if (whitelist.includes(String(chatId))) {
    return true;
  }

  if (update.message && chatId != null) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ This bot is private. Contact the owner to authorize this group.'
    );
  }

  return false;
}

async function handleOpenRouterAI(c, prompt) {
  try {
    const host =
      c.req.header('host') ||
      'stakick-bot.workers.dev';

    const reply = await queryAI(
      c.env,
      prompt,
      { host }
    );

    return reply || '❌ Empty AI response.';
  } catch (err) {
    console.error('AI error:', err);

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
// DURABLE OBJECT ACCESS
// ============================================================

function getDropAlarmStub(env) {
  if (!env.DROP_ALARM) {
    throw new Error(
      'DROP_ALARM Durable Object binding is missing.'
    );
  }

  const id = env.DROP_ALARM.idFromName(
    MONITOR_ALARM_NAME
  );

  return env.DROP_ALARM.get(id);
}

async function callDropAlarm(
  env,
  path,
  method = 'GET'
) {
  const stub = getDropAlarmStub(env);

  const response = await stub.fetch(
    `https://drop-alarm.internal${path}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
      },
    }
  );

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = {
      ok: response.ok,
    };
  }

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        `DropAlarm returned HTTP ${response.status}`
    );
  }

  return payload;
}

// ============================================================
// HOME
// ============================================================

app.get('/', (c) => {
  return c.json({
    status: 'Stakick is alive',
    owner: c.env.OWNER_KICK_SLUG || 'unknown',
    service: 'stakick-bot',
    version: '3.1.0',
    monitor: 'durable-object-alarm',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', async (c) => {
  let dbOk = false;
  let kvOk = false;

  const started = Date.now();

  // ----------------------------
  // D1
  // ----------------------------

  try {
    await ensureSchema(c.env);

    await c.env.DB
      .prepare('SELECT 1')
      .run();

    dbOk = true;
  } catch (error) {
    console.error(
      'Health DB check failed:',
      error?.message || error
    );
  }

  // ----------------------------
  // KV
  // ----------------------------

  try {
    const key = `health_check:${Date.now()}`;

    await c.env.KV.put(
      key,
      'ok',
      {
        expirationTtl: 60,
      }
    );

    const value =
      await c.env.KV.get(key);

    kvOk = value === 'ok';
  } catch (error) {
    console.error(
      'Health KV check failed:',
      error?.message || error
    );
  }

  // ----------------------------
  // Durable Object
  // ----------------------------

  let monitor = {
    ok: false,
    error: null,
  };

  try {
    monitor = await callDropAlarm(
      c.env,
      '/status'
    );
  } catch (error) {
    monitor = {
      ok: false,
      error:
        error?.message ||
        'DropAlarm unavailable',
    };
  }

  const latencyMs =
    Date.now() - started;

  // ----------------------------
  // Persistent health log
  // ----------------------------

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(
      c.env.DB
        .prepare(
          `INSERT INTO bot_health_log
           (
             check_type,
             status,
             details,
             latency_ms,
             created_at
           )
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          'http_health',
          dbOk &&
          kvOk &&
          Boolean(monitor?.ok)
            ? 'ok'
            : 'degraded',
          `db=${dbOk},kv=${kvOk},monitor=${Boolean(
            monitor?.ok
          )}`,
          latencyMs,
          Date.now()
        )
        .run()
        .catch(() => {})
    );
  }

  return c.json({
    ok:
      dbOk &&
      kvOk &&
      Boolean(monitor?.ok),

    db: dbOk,
    kv: kvOk,
    monitor,

    latency_ms: latencyMs,

    service: 'stakick-bot',
    version: '3.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// MANUAL MONITOR RUN
// ============================================================
//
// Goes through the same Durable Object as the recurring alarm.
// This prevents separate monitor execution paths.
// ============================================================

app.get('/run', async (c) => {
  if (
    !isAuthorizedSecret(
      c.env,
      c.req.query('key')
    )
  ) {
    return c.json(
      {
        ok: false,
        error:
          'Unauthorized. Provide setup key.',
      },
      401
    );
  }

  const started = Date.now();

  try {
    const result = await callDropAlarm(
      c.env,
      '/run',
      'POST'
    );

    return c.json({
      ...result,
      duration_ms:
        Date.now() - started,
    });
  } catch (error) {
    console.error(
      'Manual /run failed:',
      error
    );

    return c.json(
      {
        ok: false,
        error:
          error?.message ||
          'Monitor execution failed',
        duration_ms:
          Date.now() - started,
      },
      500
    );
  }
});

// ============================================================
// MONITOR START
// ============================================================

app.get('/monitor/start', async (c) => {
  if (
    !isAuthorizedSecret(
      c.env,
      c.req.query('key')
    )
  ) {
    return c.json(
      {
        ok: false,
        error:
          'Unauthorized. Provide setup key.',
      },
      401
    );
  }

  try {
    const result = await callDropAlarm(
      c.env,
      '/start',
      'POST'
    );

    return c.json(result);
  } catch (error) {
    console.error(
      'Monitor start failed:',
      error
    );

    return c.json(
      {
        ok: false,
        error:
          error?.message ||
          'Unable to start monitor',
      },
      500
    );
  }
});

// ============================================================
// MONITOR STOP
// ============================================================

app.get('/monitor/stop', async (c) => {
  if (
    !isAuthorizedSecret(
      c.env,
      c.req.query('key')
    )
  ) {
    return c.json(
      {
        ok: false,
        error:
          'Unauthorized. Provide setup key.',
      },
      401
    );
  }

  try {
    const result = await callDropAlarm(
      c.env,
      '/stop',
      'POST'
    );

    return c.json(result);
  } catch (error) {
    console.error(
      'Monitor stop failed:',
      error
    );

    return c.json(
      {
        ok: false,
        error:
          error?.message ||
          'Unable to stop monitor',
      },
      500
    );
  }
});

// ============================================================
// MONITOR STATUS
// ============================================================

app.get('/monitor/status', async (c) => {
  if (
    !isAuthorizedSecret(
      c.env,
      c.req.query('key')
    )
  ) {
    return c.json(
      {
        ok: false,
        error:
          'Unauthorized. Provide setup key.',
      },
      401
    );
  }

  try {
    const result =
      await callDropAlarm(
        c.env,
        '/status'
      );

    return c.json(result);
  } catch (error) {
    return c.json(
      {
        ok: false,
        error:
          error?.message ||
          'Unable to read monitor status',
      },
      500
    );
  }
});

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post('/webhook', async (c) => {
  const requestId =
    crypto.randomUUID();

  try {
    await ensureSchema(c.env);

    const update =
      await c.req.json();

    c.set(
      'update',
      update
    );

    // ----------------------------
    // Whitelist
    // ----------------------------

    const allowed =
      await whitelistCheck(
        c,
        update
      );

    if (!allowed) {
      return c.text('OK');
    }

    // ----------------------------
    // Cache bot username
    // ----------------------------

    const cachedUsername =
      await c.env.KV.get(
        'bot_username'
      );

    if (
      !cachedUsername &&
      update.message?.from?.is_bot &&
      update.message?.from?.username
    ) {
      await c.env.KV.put(
        'bot_username',
        update.message.from.username
      );
    }

    // ----------------------------
    // Bot membership events
    // ----------------------------

    if (update.my_chat_member) {
      const chat =
        update.my_chat_member.chat;

      const newStatus =
        update.my_chat_member
          .new_chat_member
          ?.status;

      if (
        newStatus === 'member' ||
        newStatus === 'administrator'
      ) {
        await c.env.DB
          .prepare(
            `INSERT INTO group_settings
             (
               chat_id,
               welcome_msg,
               updated_at
             )
             VALUES (?, ?, ?)
             ON CONFLICT(chat_id)
             DO NOTHING`
          )
          .bind(
            chat.id,
            null,
            Date.now()
          )
          .run();

        const existingDefault =
          await c.env.KV.get(
            'default_notify_group'
          );

        if (
          !existingDefault &&
          chat.type !== 'private'
        ) {
          await c.env.KV.put(
            'default_notify_group',
            String(chat.id)
          );
        }

        // Ensure the high-frequency alarm is alive.
        try {
          await callDropAlarm(
            c.env,
            '/start',
            'POST'
          );
        } catch (error) {
          console.error(
            'Unable to start DropAlarm after bot joined chat:',
            error?.message ||
              error
          );
        }
      }

      return c.text('OK');
    }

    // ----------------------------
    // New members
    // ----------------------------

    if (
      update.message?.new_chat_members
    ) {
      return await handleNewMembers(
        c,
        update
      );
    }

    // ----------------------------
    // Callback queries
    // ----------------------------

    if (update.callback_query) {
      await tg.answerCallbackQuery(
        c.env.BOT_TOKEN,
        update.callback_query.id
      );

      const data =
        update.callback_query.data;

      const callbackMessage =
        update.callback_query.message;

      if (!callbackMessage) {
        return c.text('OK');
      }

      const callbackMap = {
        cmd_help: 'help',
        cmd_weather: 'weather',
        cmd_crypto: 'crypto',
        cmd_ai: 'ask',
        cmd_remind: 'remind',
        cmd_kick: 'kickstatus',
      };

      const cmdName =
        callbackMap[data];

      if (
        cmdName &&
        commandRegistry[cmdName]
      ) {
        const [
          handler,
        ] =
          commandRegistry[
            cmdName
          ];

        await handler(
          c,
          {
            message:
              callbackMessage,
          },
          {
            args: '',
          }
        );

        return c.text('OK');
      }

      if (data === 'menu_main') {
        const startCmd =
          commandRegistry.start;

        if (startCmd) {
          await startCmd[0](
            c,
            {
              message:
                callbackMessage,
            },
            {
              args: '',
            }
          );
        }

        return c.text('OK');
      }

      return c.text('OK');
    }

    // ----------------------------
    // Parse message
    // ----------------------------

    const botUsername =
      cachedUsername ||
      c.env.BOT_USERNAME ||
      '';

    const parsed =
      parseInput(
        update,
        botUsername
      );

    if (!parsed) {
      return c.text('OK');
    }

    c.set(
      'parsed',
      parsed
    );

    // ========================================================
    // COMMANDS
    // ========================================================

    if (
      parsed.type === 'command' &&
      parsed.command
    ) {
      const cmdName =
        parsed.command
          .replace(/^\//, '')
          .split('@')[0]
          .toLowerCase();

      // ------------------------------------------------------
      // /approve
      // ------------------------------------------------------

      if (cmdName === 'approve') {
        const userId =
          String(
            update.message?.from?.id
          );

        const chatId =
          update.message?.chat?.id;

        const OWNER_ID =
          getOwnerId(
            c.env
          );

        if (
          userId !== OWNER_ID
        ) {
          await tg.sendMessage(
            c.env.BOT_TOKEN,
            chatId,
            '❌ Owner only.'
          );

          return c.text('OK');
        }

        const targetId =
          parsed.args?.trim() ||
          String(chatId);

        const whitelistRaw =
          await c.env.KV.get(
            'bot_whitelist'
          );

        let whitelist = [];

        try {
          whitelist =
            whitelistRaw
              ? JSON.parse(
                  whitelistRaw
                )
              : [];
        } catch {
          whitelist = [];
        }

        if (
          !whitelist.includes(
            targetId
          )
        ) {
          whitelist.push(
            targetId
          );

          await c.env.KV.put(
            'bot_whitelist',
            JSON.stringify(
              whitelist
            )
          );
        }

        await tg.sendMessage(
          c.env.BOT_TOKEN,
          chatId,
          `✅ Group ${targetId} approved.`
        );

        // Ensure monitoring is running.
        try {
          await callDropAlarm(
            c.env,
            '/start',
            'POST'
          );
        } catch (error) {
          console.error(
            'Unable to start DropAlarm after approval:',
            error?.message ||
              error
          );
        }

        return c.text('OK');
      }

      // ------------------------------------------------------
      // Registered commands
      // ------------------------------------------------------

      const entry =
        commandRegistry[
          cmdName
        ];

      if (entry) {
        const [
          handler,
          middlewares = [],
          scope,
        ] = entry;

        const chatType =
          update.message
            ?.chat?.type;

        if (
          scope === 'group' &&
          chatType === 'private'
        ) {
          await tg.sendMessage(
            c.env.BOT_TOKEN,
            update.message.chat.id,
            'Use this command in a group!'
          );

          return c.text('OK');
        }

        for (
          const mwName
          of middlewares
        ) {
          const middleware =
            middlewareMap[
              mwName
            ];

          if (!middleware) {
            continue;
          }

          let nextCalled =
            false;

          const result =
            await middleware(
              c,
              () => {
                nextCalled = true;
              }
            );

          if (!nextCalled) {
            return (
              result ||
              c.text('OK')
            );
          }
        }

        return await handler(
          c,
          update,
          parsed
        );
      }
    }

    // ========================================================
    // NATURAL LANGUAGE AI
    // ========================================================

    if (
      parsed.type === 'natural' &&
      parsed.isMention
    ) {
      const reply =
        await handleOpenRouterAI(
          c,
          parsed.args ||
            parsed.text ||
            ''
        );

      if (
        update.message?.chat?.id
      ) {
        await tg.sendMessage(
          c.env.BOT_TOKEN,
          update.message.chat.id,
          reply,
          {
            parse_mode: 'HTML',
          }
        );
      }

      return c.text('OK');
    }

    return c.text('OK');
  } catch (error) {
    console.error(
      `[${requestId}] Webhook error:`,
      error
    );

    return c.json(
      {
        ok: false,
        error:
          'Webhook processing failed',
        request_id:
          requestId,
      },
      500
    );
  }
});

// ============================================================
// KICK EVENTSUB
// ============================================================

app.post(
  '/kick/eventsub',
  async (c) => {
    try {
      return await handleKickEventSub(
        c
      );
    } catch (error) {
      console.error(
        'Kick EventSub error:',
        error
      );

      return c.json(
        {
          ok: false,
          error:
            'Kick EventSub processing failed',
        },
        500
      );
    }
  }
);

// ============================================================
// KICK OAUTH CALLBACK
// ============================================================

app.get(
  '/kick/oauth/callback',
  async (c) => {
    try {
      const code =
        c.req.query('code');

      const state =
        c.req.query('state');

      if (!code || !state) {
        return c.text(
          'Missing OAuth parameters.',
          400
        );
      }

      const chatId =
        await c.env.KV.get(
          `oauth_state:${state}`
        );

      if (!chatId) {
        return c.text(
          'Invalid or expired OAuth state.',
          400
        );
      }

      const host =
        c.req.header('host');

      if (!host) {
        return c.text(
          'Unable to determine Worker hostname.',
          500
        );
      }

      const redirectUri =
        `https://${host}/kick/oauth/callback`;

      const response =
        await fetch(
          'https://id.kick.com/oauth/token',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              grant_type:
                'authorization_code',
              client_id:
                c.env.KICK_CLIENT_ID,
              client_secret:
                c.env.KICK_CLIENT_SECRET,
              code,
              redirect_uri:
                redirectUri,
            }),
          }
        );

      const data =
        await response.json();

      if (data.access_token) {
        await c.env.KV.put(
          'kick_user_token',
          data.access_token,
          {
            expirationTtl: 3500,
          }
        );

        if (data.refresh_token) {
          await c.env.KV.put(
            'kick_refresh_token_backup',
            data.refresh_token
          );
        }

        await tg.sendMessage(
          c.env.BOT_TOKEN,
          Number(chatId),
          '✅ Kick account linked successfully!'
        );
      } else {
        await tg.sendMessage(
          c.env.BOT_TOKEN,
          Number(chatId),
          `❌ OAuth failed: ${
            data.error_description ||
            data.error ||
            'Unknown error'
          }`
        );
      }

      return c.text(
        'OAuth complete. You can close this tab.'
      );
    } catch (error) {
      console.error(
        'Kick OAuth callback error:',
        error
      );

      return c.text(
        'OAuth processing failed.',
        500
      );
    }
  }
);

// ============================================================
// SETUP
// ============================================================

app.get(
  '/setup',
  async (c) => {
    try {
      // ----------------------
      // Basic bindings
      // ----------------------

      if (!c.env.BOT_TOKEN) {
        return c.json(
          {
            ok: false,
            error:
              'BOT_TOKEN is not configured as a Worker secret.',
          },
          500
        );
      }

      if (!c.env.KV) {
        return c.json(
          {
            ok: false,
            error:
              'KV binding is missing from the Worker.',
          },
          500
        );
      }

      if (!c.env.DB) {
        return c.json(
          {
            ok: false,
            error:
              'DB binding is missing from the Worker.',
          },
          500
        );
      }

      if (!c.env.DROP_ALARM) {
        return c.json(
          {
            ok: false,
            error:
              'DROP_ALARM Durable Object binding is missing from the Worker.',
          },
          500
        );
      }

      // ----------------------
      // Setup authorization
      // ----------------------

      if (
        !isAuthorizedSecret(
          c.env,
          c.req.query('key')
        )
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Unauthorized. Provide the setup key.',
          },
          401
        );
      }

      const host =
        c.req.header('host');

      if (!host) {
        return c.json(
          {
            ok: false,
            error:
              'Unable to determine Worker hostname.',
          },
          500
        );
      }

      // ----------------------
      // Database schema
      // ----------------------

      await ensureSchema(
        c.env
      );

      // ----------------------
      // Telegram webhook
      // ----------------------

      const webhookUrl =
        `https://${host}/webhook`;

      const setWebhookResponse =
        await fetch(
          `https://api.telegram.org/bot${c.env.BOT_TOKEN}/setWebhook`,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              url: webhookUrl,
              allowed_updates: [
                'message',
                'callback_query',
                'chat_member',
                'my_chat_member',
              ],
              drop_pending_updates:
                true,
            }),
          }
        );

      const setWebhookData =
        await setWebhookResponse.json();

      // ----------------------
      // Telegram bot identity
      // ----------------------

      const meResponse =
        await fetch(
          `https://api.telegram.org/bot${c.env.BOT_TOKEN}/getMe`
        );

      const meData =
        await meResponse.json();

      if (
        meData?.ok &&
        meData?.result?.username
      ) {
        await c.env.KV.put(
          'bot_username',
          meData.result.username
        );
      }

      // ----------------------
      // Telegram webhook status
      // ----------------------

      const webhookResponse =
        await fetch(
          `https://api.telegram.org/bot${c.env.BOT_TOKEN}/getWebhookInfo`
        );

      const webhookData =
        await webhookResponse.json();

      // ----------------------
      // Start DropAlarm
      // ----------------------

      let monitorStart = null;

      try {
        monitorStart =
          await callDropAlarm(
            c.env,
            '/start',
            'POST'
          );
      } catch (error) {
        console.error(
          'DropAlarm start during setup failed:',
          error
        );

        monitorStart = {
          ok: false,
          error:
            error?.message ||
            'Unable to start DropAlarm',
        };
      }

      return c.json({
        ok:
          Boolean(
            setWebhookData?.ok
          ) &&
          Boolean(
            meData?.ok
          ) &&
          Boolean(
            c.env.DROP_ALARM
          ),

        service:
          'stakick-bot',

        version:
          '3.1.0',

        webhook: {
          url: webhookUrl,
          registration:
            setWebhookData,
          status:
            webhookData,
        },

        bot: meData?.ok
          ? {
              id:
                meData.result.id,
              username:
                meData.result.username,
              first_name:
                meData.result.first_name,
              is_bot:
                meData.result.is_bot,
            }
          : {
              error:
                meData?.description ||
                'Unable to retrieve bot information.',
            },

        monitor:
          monitorStart,

        timestamp:
          new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        'Setup endpoint error:',
        error
      );

      return c.json(
        {
          ok: false,
          error:
            'Setup failed.',
          message:
            error instanceof Error
              ? error.message
              : 'Unknown error',
        },
        500
      );
    }
  }
);

// ============================================================
// NOT FOUND
// ============================================================

app.notFound((c) => {
  return c.json(
    {
      ok: false,
      error: 'Route not found',
      path:
        new URL(
          c.req.url
        ).pathname,
      method: c.req.method,
      service:
        'stakick-bot',
    },
    404
  );
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.onError((error, c) => {
  console.error(
    'Unhandled Worker error:',
    error
  );

  return c.json(
    {
      ok: false,
      error:
        'Internal server error',
    },
    500
  );
});

// ============================================================
// DURABLE OBJECT EXPORT
// ============================================================
//
// CRITICAL FOR WRANGLER:
//
// Cloudflare already has a provisioned DropAlarm namespace.
// Therefore the Worker MUST export the DropAlarm class.
// This fixes the exact reconciliation error from deployment #78.
// ============================================================

export { DropAlarm };

// ============================================================
// WORKER ENTRYPOINT
// ============================================================

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    return app.fetch(
      request,
      env,
      ctx
    );
  },

  // ==========================================================
  // CRON WATCHDOG
  // ==========================================================
  //
  // Native Cloudflare Cron runs once per minute.
  //
  // It does NOT execute runMonitor directly.
  //
  // It simply ensures the persistent Durable Object alarm
  // is alive.
  //
  // The DropAlarm object is responsible for the recurring
  // high-frequency monitor loop.
  // ==========================================================

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          await callDropAlarm(
            env,
            '/start',
            'POST'
          );

          console.log(
            '[CRON] DropAlarm watchdog OK'
          );
        } catch (error) {
          console.error(
            '[CRON] DropAlarm watchdog failed:',
            error?.message ||
              error
          );
        }
      })()
    );

    // Reminders remain on the regular Cron schedule.
    ctx.waitUntil(
      checkReminders({
        env,
        executionCtx:
          ctx,
      })
    );
  },
};
