import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';

import { tg } from './telegram';
import { parseInput } from './parser';
import { commandRegistry } from './config';
import {
  requireAdmin,
  requireGroup
} from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { logCommand } from './middleware/logger';
import { handleNewMembers } from './commands/group/welcome';
import { checkReminders } from './commands/external/remind';
import { runMonitor } from './kick/monitor';
import { handleKickEventSub } from './kick/eventsub';

import { queryAI } from './services/ai';
import { handleGroupParticipation } from './services/groupIntelligence';
import { ensureSchema } from './db';

const app = new Hono();

// ============================================================
// CONFIG
// ============================================================

const MONITOR_INTERVAL_MS = 15_000;
const MONITOR_ALARM_NAME = 'main';

// ============================================================
// HELPERS
// ============================================================

function getOwnerId(env) {
  return String(
    env.OWNER_ID || '6816397800'
  );
}

function isAuthorizedSecret(
  env,
  provided
) {
  const configured =
    env.SETUP_SECRET;

  if (!configured) {
    return true;
  }

  return provided === configured;
}

/*
 * Extract Telegram identity safely.
 */
function getTelegramContext(update) {
  const message =
    update?.message;

  const callback =
    update?.callback_query;

  const chat =
    message?.chat ||
    callback?.message?.chat ||
    null;

  const user =
    message?.from ||
    callback?.from ||
    null;

  return {
    chatId:
      chat?.id ?? null,

    userId:
      user?.id ?? null,

    chatType:
      chat?.type || null,

    username:
      user?.username || null,

    firstName:
      user?.first_name || null,

    lastName:
      user?.last_name || null
  };
}

async function whitelistCheck(
  c,
  update
) {
  const OWNER_ID =
    getOwnerId(c.env);

  const {
    chatId,
    userId,
    chatType
  } =
    getTelegramContext(
      update
    );

  const text =
    update.message?.text ||
    '';

  /*
   * Owner's private chat is always allowed.
   */
  if (
    chatType === 'private' &&
    String(userId) === OWNER_ID
  ) {
    return true;
  }

  /*
   * Owner can use /approve even before
   * a group has been whitelisted.
   */
  if (
    String(userId) === OWNER_ID &&
    text
      .trim()
      .toLowerCase()
      .startsWith('/approve')
  ) {
    return true;
  }

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
    whitelist.includes(
      String(chatId)
    )
  ) {
    return true;
  }

  if (
    update.message &&
    chatId !== null &&
    chatId !== undefined
  ) {
    await tg.sendMessage(
      c.env.BOT_TOKEN,
      chatId,
      '❌ This bot is private. Contact the owner to authorize this group.'
    );
  }

  return false;
}

// ============================================================
// AI
// ============================================================

async function handleOpenRouterAI(
  c,
  prompt,
  {
    chatId = null,
    userId = null
  } = {}
) {
  try {
    const host =
      c.req.header(
        'host'
      ) ||
      'stakick-bot.workers.dev';

    if (
      chatId === null ||
      chatId === undefined
    ) {
      throw new Error(
        'Unable to determine Telegram chat ID.'
      );
    }

    if (
      userId === null ||
      userId === undefined
    ) {
      throw new Error(
        'Unable to determine Telegram user ID.'
      );
    }

    const reply =
      await queryAI(
        c.env,
        prompt,
        {
          host,

          /*
           * These two values are what make persistent
           * conversation memory actually work.
           */
          chatId,
          userId,

          useMemory:
            true,

          saveMemory:
            true
        }
      );

    return (
      reply ||
      '❌ Empty AI response.'
    );
  } catch (error) {
    console.error(
      'AI request failed:',
      error
    );

    return (
      `❌ AI error: ${
        error?.message ||
        'Unknown AI error'
      }`
    );
  }
}

// ============================================================
// DURABLE OBJECT ACCESS
// ============================================================

function getMonitorStub(
  env
) {
  if (!env.MONITOR_ALARM) {
    throw new Error(
      'MONITOR_ALARM Durable Object binding is missing.'
    );
  }

  const id =
    env.MONITOR_ALARM.idFromName(
      MONITOR_ALARM_NAME
    );

  return env.MONITOR_ALARM.get(
    id
  );
}

async function callMonitorDO(
  env,
  path,
  options = {}
) {
  const stub =
    getMonitorStub(env);

  const response =
    await stub.fetch(
      `https://monitor.internal${path}`,
      {
        method:
          options.method ||
          'GET',

        headers: {
          'content-type':
            'application/json'
        },

        body:
          options.body ||
          undefined
      }
    );

  let payload = null;

  try {
    payload =
      await response.json();
  } catch {
    payload = {
      ok:
        response.ok
    };
  }

  return {
    response,
    payload
  };
}

// ============================================================
// MIDDLEWARE REGISTRY
// ============================================================

const middlewareMap = {
  requireAdmin,
  requireGroup,
  rateLimit,
  logCommand
};

// ============================================================
// BASIC ROUTES
// ============================================================

app.get(
  '/',
  (c) => {
    return c.json({
      status:
        'Stakick is alive',

      owner:
        c.env.OWNER_KICK_SLUG ||
        'unknown',

      service:
        'stakick-bot',

      version:
        '3.1.0',

      monitor:
        'durable-object-alarm',

      monitor_interval_ms:
        MONITOR_INTERVAL_MS,

      ai_memory:
        'd1-persistent',

      timestamp:
        new Date().toISOString()
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  async (c) => {
    let dbOk = false;
    let kvOk = false;

    const start =
      Date.now();

    try {
      await ensureSchema(
        c.env
      );

      await c.env.DB
        .prepare(
          'SELECT 1'
        )
        .run();

      dbOk = true;
    } catch (error) {
      console.error(
        'Health DB check failed:',
        error?.message ||
          error
      );
    }

    try {
      await c.env.KV.put(
        'health_check',
        Date.now().toString(),
        {
          expirationTtl:
            60
        }
      );

      await c.env.KV.get(
        'health_check'
      );

      kvOk = true;
    } catch (error) {
      console.error(
        'Health KV check failed:',
        error?.message ||
          error
      );
    }

    let monitor = {
      ok: false,
      error: null
    };

    try {
      const result =
        await callMonitorDO(
          c.env,
          '/status'
        );

      monitor =
        result.payload;
    } catch (error) {
      monitor = {
        ok: false,
        error:
          error?.message ||
          String(error)
      };
    }

    const latencyMs =
      Date.now() -
      start;

    if (
      c.executionCtx?.waitUntil &&
      c.env.DB
    ) {
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
            monitor.ok
              ? 'ok'
              : 'degraded',

            `db=${dbOk}, kv=${kvOk}, monitor=${Boolean(
              monitor.ok
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
        Boolean(
          monitor.ok
        ),

      db:
        dbOk,

      kv:
        kvOk,

      monitor,

      latency_ms:
        latencyMs,

      service:
        'stakick-bot',

      version:
        '3.1.0',

      ai_memory:
        dbOk
          ? 'available'
          : 'unavailable',

      timestamp:
        new Date().toISOString()
    });
  }
);

// ============================================================
// MANUAL MONITOR EXECUTION
// ============================================================

app.get(
  '/run',
  async (c) => {
    const setupSecret =
      c.env.SETUP_SECRET;

    if (
      setupSecret &&
      c.req.query('key') !==
        setupSecret
    ) {
      return c.json(
        {
          ok: false,
          error:
            'Unauthorized. Provide setup key.'
        },
        401
      );
    }

    console.log(
      '🔥 Manual monitor run requested'
    );

    const start =
      Date.now();

    try {
      const result =
        await callMonitorDO(
          c.env,
          '/run',
          {
            method:
              'POST'
          }
        );

      return c.json({
        ...result.payload,

        duration_ms:
          Date.now() -
          start
      });
    } catch (error) {
      console.error(
        '❌ /run error:',
        error
      );

      return c.json(
        {
          ok: false,

          error:
            error?.message ||
            String(error),

          duration_ms:
            Date.now() -
            start
        },
        500
      );
    }
  }
);

// ============================================================
// MONITOR START
// ============================================================

app.get(
  '/monitor/start',
  async (c) => {
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
            'Unauthorized. Provide setup key.'
        },
        401
      );
    }

    try {
      const result =
        await callMonitorDO(
          c.env,
          '/start',
          {
            method:
              'POST'
          }
        );

      return c.json(
        result.payload
      );
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
            String(error)
        },
        500
      );
    }
  }
);

// ============================================================
// MONITOR STOP
// ============================================================

app.get(
  '/monitor/stop',
  async (c) => {
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
            'Unauthorized. Provide setup key.'
        },
        401
      );
    }

    try {
      const result =
        await callMonitorDO(
          c.env,
          '/stop',
          {
            method:
              'POST'
          }
        );

      return c.json(
        result.payload
      );
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
            String(error)
        },
        500
      );
    }
  }
);

// ============================================================
// MONITOR STATUS
// ============================================================

app.get(
  '/monitor/status',
  async (c) => {
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
            'Unauthorized. Provide setup key.'
        },
        401
      );
    }

    try {
      const result =
        await callMonitorDO(
          c.env,
          '/status'
        );

      return c.json(
        result.payload
      );
    } catch (error) {
      return c.json(
        {
          ok: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
);

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post(
  '/webhook',
  async (c) => {
    const requestId =
      crypto.randomUUID();

    try {
      /*
       * Make sure D1 contains the AI memory tables.
       */
      await ensureSchema(
        c.env
      );

      const update =
        await c.req.json();

      c.set(
        'update',
        update
      );

      // --------------------------------------------------------
      // IDENTITY
      // --------------------------------------------------------

      const telegram =
        getTelegramContext(
          update
        );

      /*
       * Store identity in Hono context so future handlers
       * can access it if needed.
       */
      c.set(
        'telegram',
        telegram
      );

      // --------------------------------------------------------
      // WHITELIST
      // --------------------------------------------------------

      const allowed =
        await whitelistCheck(
          c,
          update
        );

      if (!allowed) {
        return c.text(
          'OK'
        );
      }

      // --------------------------------------------------------
      // BOT USERNAME
      // --------------------------------------------------------

      let cachedUsername =
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
          update.message
            .from
            .username
        );

        cachedUsername =
          update.message
            .from
            .username;
      }

      // --------------------------------------------------------
      // BOT ADDED / REMOVED
      // --------------------------------------------------------

      if (
        update.my_chat_member
      ) {
        const chat =
          update.my_chat_member
            .chat;

        const newStatus =
          update.my_chat_member
            .new_chat_member
            ?.status;

        if (
          newStatus ===
            'member' ||
          newStatus ===
            'administrator'
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
            chat.type !==
              'private'
          ) {
            await c.env.KV.put(
              'default_notify_group',
              String(chat.id)
            );
          }

          try {
            await callMonitorDO(
              c.env,
              '/start',
              {
                method:
                  'POST'
              }
            );
          } catch (error) {
            console.error(
              'Failed to start monitor:',
              error
            );
          }
        }

        return c.text(
          'OK'
        );
      }

      // --------------------------------------------------------
      // NEW MEMBERS
      // --------------------------------------------------------

      if (
        update.message
          ?.new_chat_members
      ) {
        return await handleNewMembers(
          c,
          update
        );
      }

      // --------------------------------------------------------
      // CALLBACKS
      // --------------------------------------------------------

      if (
        update.callback_query
      ) {
        await tg.answerCallbackQuery(
          c.env.BOT_TOKEN,
          update.callback_query.id
        );

        const data =
          update.callback_query
            .data;

        const callbackMessage =
          update.callback_query
            .message;

        if (
          !callbackMessage
        ) {
          return c.text(
            'OK'
          );
        }

        /*
         * AI callback gets its own context-aware path.
         *
         * This means a future AI menu button can also use
         * persistent memory.
         */
        if (
          data ===
          'cmd_ai'
        ) {
          const prompt =
            update.callback_query
              ?.message
              ?.text
              ?.trim();

          /*
           * We don't send the whole Telegram message as the
           * actual question. Tell the user to use /ask or
           * mention the bot if no prompt exists.
           */
          const text =
            prompt
              ? await handleOpenRouterAI(
                  c,
                  prompt,
                  {
                    chatId:
                      telegram.chatId,
                    userId:
                      telegram.userId
                  }
                )
              : '🧠 Ask me something with /ask or mention @StakickBot.';

          await tg.sendMessage(
            c.env.BOT_TOKEN,
            telegram.chatId,
            text
          );

          return c.text(
            'OK'
          );
        }

        const callbackMap = {
          cmd_help:
            'help',

          cmd_weather:
            'weather',

          cmd_crypto:
            'crypto',

          cmd_ai:
            'ask',

          cmd_remind:
            'remind',

          cmd_kick:
            'kickstatus'
        };

        const cmdName =
          callbackMap[data];

        if (
          cmdName &&
          commandRegistry[
            cmdName
          ]
        ) {
          const [
            handler
          ] =
            commandRegistry[
              cmdName
            ];

          await handler(
            c,
            {
              message:
                callbackMessage
            },
            {
              args:
                ''
            }
          );

          return c.text(
            'OK'
          );
        }

        if (
          data ===
          'menu_main'
        ) {
          const startCmd =
            commandRegistry
              .start;

          if (
            startCmd
          ) {
            await startCmd[0](
              c,
              {
                message:
                  callbackMessage
              },
              {
                args:
                  ''
              }
            );
          }

          return c.text(
            'OK'
          );
        }

        return c.text(
          'OK'
        );
      }

      // --------------------------------------------------------
      // PARSER
      // --------------------------------------------------------

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
        return c.text(
          'OK'
        );
      }

      c.set(
        'parsed',
        parsed
      );

      // --------------------------------------------------------
      // COMMANDS
      // --------------------------------------------------------

      if (
        parsed.type ===
          'command' &&
        parsed.command
      ) {
        const cmdName =
          parsed.command
            .replace(
              /^\//,
              ''
            )
            .split('@')[0]
            .toLowerCase();

        // ------------------------------------------------------
        // /approve
        // ------------------------------------------------------

        if (
          cmdName ===
          'approve'
        ) {
          const userId =
            String(
              update.message
                ?.from?.id
            );

          const chatId =
            update.message
              ?.chat
              ?.id;

          const OWNER_ID =
            getOwnerId(
              c.env
            );

          if (
            userId !==
            OWNER_ID
          ) {
            await tg.sendMessage(
              c.env.BOT_TOKEN,
              chatId,
              '❌ Owner only.'
            );

            return c.text(
              'OK'
            );
          }

          const targetId =
            parsed.args
              ?.trim() ||
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

          return c.text(
            'OK'
          );
        }

        /*
         * ======================================================
         * /ask — MEMORY-AWARE AI
         * ======================================================
         *
         * We handle /ask here rather than relying on a separate
         * command handler that might call queryAI() without
         * chatId/userId.
         */

        if (
          cmdName ===
          'ask'
        ) {
          const chatId =
            update.message
              ?.chat
              ?.id;

          const userId =
            update.message
              ?.from
              ?.id;

          const prompt =
            String(
              parsed.args ||
              ''
            ).trim();

          if (!prompt) {
            await tg.sendMessage(
              c.env.BOT_TOKEN,
              chatId,
              '🧠 Usage: /ask your question'
            );

            return c.text(
              'OK'
            );
          }

          /*
           * Give /ask the same middleware protections that the
           * registered command would normally have, if present.
           *
           * We only run middleware here; the actual handler is
           * our memory-aware AI function.
           */
          const entry =
            commandRegistry
              .ask;

          if (
            entry
          ) {
            const [
              ,
              middlewares = [],
              scope
            ] = entry;

            const chatType =
              update.message
                ?.chat
                ?.type;

            if (
              scope ===
                'group' &&
              chatType ===
                'private'
            ) {
              await tg.sendMessage(
                c.env.BOT_TOKEN,
                chatId,
                'Use this command in a group!'
              );

              return c.text(
                'OK'
              );
            }

            for (
              const mwName
                of middlewares
            ) {
              const middleware =
                middlewareMap[
                  mwName
                ];

              if (
                !middleware
              ) {
                continue;
              }

              let nextCalled =
                false;

              const result =
                await middleware(
                  c,
                  () => {
                    nextCalled =
                      true;
                  }
                );

              if (
                !nextCalled
              ) {
                return (
                  result ||
                  c.text(
                    'OK'
                  )
                );
              }
            }
          }

          const reply =
            await handleOpenRouterAI(
              c,
              prompt,
              {
                chatId,
                userId
              }
            );

          await tg.sendMessage(
            c.env.BOT_TOKEN,
            chatId,
            reply,
            {
              parse_mode:
                'HTML'
            }
          );

          return c.text(
            'OK'
          );
        }

        // ------------------------------------------------------
        // NORMAL COMMAND REGISTRY
        // ------------------------------------------------------

        const entry =
          commandRegistry[
            cmdName
          ];

        if (entry) {
          const [
            handler,
            middlewares = [],
            scope
          ] = entry;

          const chatType =
            update.message
              ?.chat
              ?.type;

          if (
            scope ===
              'group' &&
            chatType ===
              'private'
          ) {
            await tg.sendMessage(
              c.env.BOT_TOKEN,
              update.message
                .chat
                .id,
              'Use this command in a group!'
            );

            return c.text(
              'OK'
            );
          }

          for (
            const mwName
              of middlewares
          ) {
            const middleware =
              middlewareMap[
                mwName
              ];

            if (
              !middleware
            ) {
              continue;
            }

            let nextCalled =
              false;

            const result =
              await middleware(
                c,
                () => {
                  nextCalled =
                    true;
                }
              );

            if (
              !nextCalled
            ) {
              return (
                result ||
                c.text(
                  'OK'
                )
              );
            }
          }
          
                // --------------------------------------------------------
      // AUTONOMOUS GROUP PARTICIPATION
      // --------------------------------------------------------

      if (
        update.message?.chat?.type ===
          'group' ||
        update.message?.chat?.type ===
          'supergroup'
      ) {
        const participation =
          handleGroupParticipation(
            c.env,
            update,
            {
              botUsername:
                cachedUsername ||
                c.env.BOT_USERNAME ||
                ''
            }
          );

        if (
          c.executionCtx?.waitUntil
        ) {
          c.executionCtx.waitUntil(
            participation
          );
        } else {
          await participation;
        }
      }

          return await handler(
            c,
            update,
            parsed
          );
        }
      }

      // --------------------------------------------------------
      // NATURAL AI
      // --------------------------------------------------------

      if (
        parsed.type ===
          'natural' &&
        parsed.isMention
      ) {
        const chatId =
          update.message
            ?.chat
            ?.id;

        const userId =
          update.message
            ?.from
            ?.id;

        const prompt =
          parsed.args ||
          parsed.text ||
          '';

        const reply =
          await handleOpenRouterAI(
            c,
            prompt,
            {
              chatId,
              userId
            }
          );

        if (
          chatId !==
            undefined &&
          chatId !==
            null
        ) {
          await tg.sendMessage(
            c.env.BOT_TOKEN,
            chatId,
            reply,
            {
              parse_mode:
                'HTML'
            }
          );
        }

        return c.text(
          'OK'
        );
      }

      return c.text(
        'OK'
      );
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
            requestId
        },
        500
      );
    }
  }
);

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
            'Kick EventSub processing failed'
        },
        500
      );
    }
  }
);

// ============================================================
// KICK OAUTH
// ============================================================

app.get(
  '/kick/oauth/callback',
  async (c) => {
    try {
      const code =
        c.req.query(
          'code'
        );

      const state =
        c.req.query(
          'state'
        );

      if (
        !code ||
        !state
      ) {
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
        c.req.header(
          'host'
        );

      const redirectUri =
        `https://${host}/kick/oauth/callback`;

      const response =
        await fetch(
          'https://id.kick.com/oauth/token',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                grant_type:
                  'authorization_code',

                client_id:
                  c.env.KICK_CLIENT_ID,

                client_secret:
                  c.env.KICK_CLIENT_SECRET,

                code,

                redirect_uri:
                  redirectUri
              })
          }
        );

      const data =
        await response.json();

      if (
        data.access_token
      ) {
        await c.env.KV.put(
          'kick_user_token',
          data.access_token,
          {
            expirationTtl:
              3500
          }
        );

        if (
          data.refresh_token
        ) {
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
      if (!c.env.BOT_TOKEN) {
        return c.json(
          {
            ok: false,
            error:
              'BOT_TOKEN is not configured as a Worker secret.'
          },
          500
        );
      }

      if (!c.env.KV) {
        return c.json(
          {
            ok: false,
            error:
              'KV binding is missing from the Worker.'
          },
          500
        );
      }

      const setupSecret =
        c.env.SETUP_SECRET;

      if (
        setupSecret &&
        c.req.query('key') !==
          setupSecret
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Unauthorized. Provide the setup key.'
          },
          401
        );
      }

      const host =
        c.req.header(
          'host'
        );

      if (!host) {
        return c.json(
          {
            ok: false,
            error:
              'Unable to determine Worker hostname.'
          },
          500
        );
      }

      const webhookUrl =
        `https://${host}/webhook`;

      const setWebhookResponse =
        await fetch(
          `https://api.telegram.org/bot${c.env.BOT_TOKEN}/setWebhook`,
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                url:
                  webhookUrl,

                allowed_updates: [
                  'message',
                  'callback_query',
                  'chat_member',
                  'my_chat_member'
                ],

                drop_pending_updates:
                  true
              })
          }
        );

      const setWebhookData =
        await setWebhookResponse.json();

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

      const webhookResponse =
        await fetch(
          `https://api.telegram.org/bot${c.env.BOT_TOKEN}/getWebhookInfo`
        );

      const webhookData =
        await webhookResponse.json();

      // Start the monitor alarm.
      let monitorStart =
        null;

      try {
        const result =
          await callMonitorDO(
            c.env,
            '/start',
            {
              method:
                'POST'
            }
          );

        monitorStart =
          result.payload;
      } catch (error) {
        monitorStart = {
          ok: false,
          error:
            error?.message ||
            String(error)
        };
      }

      return c.json({
        ok:
          Boolean(
            setWebhookData?.ok
          ) &&
          Boolean(
            meData?.ok
          ),

        service:
          'stakick-bot',

        version:
          '3.1.0',

        ai_memory:
          'd1-persistent',

        webhook: {
          url:
            webhookUrl,

          registration:
            setWebhookData,

          status:
            webhookData
        },

        bot:
          meData?.ok
            ? {
                id:
                  meData.result.id,

                username:
                  meData.result.username,

                first_name:
                  meData.result.first_name,

                is_bot:
                  meData.result.is_bot
              }
            : {
                error:
                  meData?.description ||
                  'Unable to retrieve bot information.'
              },

        monitor:
          monitorStart,

        timestamp:
          new Date().toISOString()
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
              : 'Unknown error'
        },
        500
      );
    }
  }
);

// ============================================================
// FALLBACKS
// ============================================================

app.notFound(
  (c) => {
    return c.json(
      {
        ok: false,

        error:
          'Route not found',

        path:
          new URL(
            c.req.url
          ).pathname,

        method:
          c.req.method,

        service:
          'stakick-bot'
      },
      404
    );
  }
);

app.onError(
  (error, c) => {
    console.error(
      'Unhandled Worker error:',
      error
    );

    return c.json(
      {
        ok: false,
        error:
          'Internal server error'
      },
      500
    );
  }
);

// ============================================================
// DURABLE OBJECT
// ============================================================

export class MonitorAlarm extends DurableObject {
  constructor(
    ctx,
    env
  ) {
    super(
      ctx,
      env
    );

    this.env =
      env;
  }

  async scheduleNextAlarm() {
    const existing =
      await this.ctx.storage.getAlarm();

    if (
      existing != null
    ) {
      return existing;
    }

    const next =
      Date.now() +
      MONITOR_INTERVAL_MS;

    await this.ctx.storage.setAlarm(
      next
    );

    return next;
  }

  async alarm(
    alarmInfo
  ) {
    const started =
      Date.now();

    let result =
      null;

    try {
      console.log(
        `[MONITOR ALARM] fired ` +
        `retry=${
          alarmInfo?.retryCount ||
          0
        }`
      );

      result =
        await runMonitor({
          env:
            this.env,

          executionCtx:
            null
        });

      console.log(
        `[MONITOR ALARM] completed ` +
        `${Date.now() - started}ms`
      );
    } catch (error) {
      console.error(
        '[MONITOR ALARM] monitor failed:',
        error
      );
    } finally {
      try {
        await this.ctx.storage.setAlarm(
          Date.now() +
            MONITOR_INTERVAL_MS
        );
      } catch (scheduleError) {
        console.error(
          '[MONITOR ALARM] failed to reschedule:',
          scheduleError
        );
      }
    }

    return result;
  }

  async fetch(
    request
  ) {
    const url =
      new URL(
        request.url
      );

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    if (
      url.pathname ===
      '/status'
    ) {
      const alarm =
        await this.ctx.storage.getAlarm();

      return Response.json({
        ok: true,

        running:
          alarm != null,

        alarm_at:
          alarm,

        alarm_in_ms:
          alarm != null
            ? Math.max(
                0,
                alarm -
                  Date.now()
              )
            : null,

        interval_ms:
          MONITOR_INTERVAL_MS,

        interval_seconds:
          MONITOR_INTERVAL_MS /
          1000
      });
    }

    // --------------------------------------------------------
    // START
    // --------------------------------------------------------

    if (
      url.pathname ===
      '/start'
    ) {
      const existing =
        await this.ctx.storage.getAlarm();

      if (
        existing == null
      ) {
        const next =
          Date.now() +
          1000;

        await this.ctx.storage.setAlarm(
          next
        );

        return Response.json({
          ok: true,

          started:
            true,

          first_alarm_at:
            next,

          interval_ms:
            MONITOR_INTERVAL_MS
        });
      }

      return Response.json({
        ok: true,

        started:
          false,

        already_running:
          true,

        alarm_at:
          existing,

        alarm_in_ms:
          Math.max(
            0,
            existing -
              Date.now()
          ),

        interval_ms:
          MONITOR_INTERVAL_MS
      });
    }

    // --------------------------------------------------------
    // STOP
    // --------------------------------------------------------

    if (
      url.pathname ===
      '/stop'
    ) {
      await this.ctx.storage.deleteAlarm();

      return Response.json({
        ok: true,
        stopped:
          true
      });
    }

    // --------------------------------------------------------
    // MANUAL RUN
    // --------------------------------------------------------

    if (
      url.pathname ===
      '/run'
    ) {
      const started =
        Date.now();

      let stats =
        null;

      try {
        stats =
          await runMonitor({
            env:
              this.env,

            executionCtx:
              null
          });
      } finally {
        await this.ctx.storage.setAlarm(
          Date.now() +
            MONITOR_INTERVAL_MS
        );
      }

      return Response.json({
        ok: true,

        manual:
          true,

        duration_ms:
          Date.now() -
          started,

        stats
      });
    }

    return Response.json(
      {
        ok: false,

        error:
          'Unknown monitor operation'
      },
      {
        status:
          404
      }
    );
  }
}

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

  async scheduled(
    controller,
    env,
    ctx
  ) {
    /*
     * Cron acts as a watchdog for the Durable Object alarm.
     */
    ctx.waitUntil(
      (async () => {
        try {
          await callMonitorDO(
            env,
            '/start',
            {
              method:
                'POST'
            }
          );
        } catch (error) {
          console.error(
            'Monitor watchdog failed:',
            error
          );
        }
      })()
    );

    /*
     * Existing reminder processing.
     */
    ctx.waitUntil(
      checkReminders({
        env,

        executionCtx:
          ctx
      })
    );
  }
};
