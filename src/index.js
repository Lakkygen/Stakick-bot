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

// Prevent external/database operations from hanging forever.
async function withTimeout(promise, ms, label = 'operation') {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

app.get('/', (c) =>
  c.json({
    status: 'Stakick is alive',
    owner: c.env.OWNER_KICK_SLUG,
  })
);

app.post('/webhook', async (c) => {
  let update;

  try {
    update = await c.req.json();
  } catch (error) {
    console.error('Invalid Telegram webhook JSON:', error);
    return c.text('Bad Request', 400);
  }

  c.set('update', update);

  /*
   * IMPORTANT:
   * Schema creation should never be allowed to freeze a Telegram update.
   * If it fails/times out, the bot can still process normal commands.
   */
  try {
    await withTimeout(
      ensureSchema(c.env),
      5000,
      'D1 schema initialization'
    );
  } catch (error) {
    console.error('ensureSchema failed:', error);
  }

  // Cache bot username without allowing KV to freeze the update.
  let cachedUsername = null;

  try {
    cachedUsername = await withTimeout(
      c.env.KV.get('bot_username'),
      3000,
      'KV bot username lookup'
    );
  } catch (error) {
    console.error('KV bot username lookup failed:', error);
  }

  if (
    !cachedUsername &&
    update.message?.from?.is_bot &&
    update.message.from.username
  ) {
    try {
      await withTimeout(
        c.env.KV.put('bot_username', update.message.from.username),
        3000,
        'KV bot username write'
      );

      cachedUsername = update.message.from.username;
    } catch (error) {
      console.error('KV bot username write failed:', error);
    }
  }

  // Handle bot added to group
  if (update.my_chat_member) {
    try {
      const chat = update.my_chat_member.chat;
      const newStatus = update.my_chat_member.new_chat_member.status;

      if (newStatus === 'member' || newStatus === 'administrator') {
        await withTimeout(
          c.env.DB.prepare(
            `INSERT INTO group_settings (chat_id, welcome_msg, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(chat_id) DO NOTHING`
          )
            .bind(chat.id, null, Date.now())
            .run(),
          5000,
          'D1 group initialization'
        );

        try {
          const existingDefault = await withTimeout(
            c.env.KV.get('default_notify_group'),
            3000,
            'KV default group lookup'
          );

          if (!existingDefault && chat.type !== 'private') {
            await withTimeout(
              c.env.KV.put(
                'default_notify_group',
                chat.id.toString()
              ),
              3000,
              'KV default group write'
            );
          }
        } catch (error) {
          console.error('Default group KV operation failed:', error);
        }
      }
    } catch (error) {
      console.error('my_chat_member handling failed:', error);
    }

    return c.text('OK');
  }

  // Handle new members
  if (update.message?.new_chat_members) {
    try {
      return await withTimeout(
        handleNewMembers(c, update),
        8000,
        'new member handler'
      );
    } catch (error) {
      console.error('New member handler failed:', error);
      return c.text('OK');
    }
  }

  // Handle callback queries
  if (update.callback_query) {
    try {
      await withTimeout(
        tg.answerCallbackQuery(
          c.env.BOT_TOKEN,
          update.callback_query.id
        ),
        5000,
        'Telegram callback acknowledgement'
      );
    } catch (error) {
      console.error('Callback acknowledgement failed:', error);
    }

    try {
      const data = update.callback_query.data;
      const chatId = update.callback_query.message.chat.id;

      if (data === 'cmd_help') {
        const help = commandRegistry.help;

        if (help) {
          await withTimeout(
            help[0](
              c,
              {
                message: update.callback_query.message,
              },
              {
                args: '',
              }
            ),
            8000,
            'help command'
          );
        }
      }
    } catch (error) {
      console.error('Callback command failed:', error);
    }

    return c.text('OK');
  }

  // Parse input
  let parsed;

  try {
    const botUsername =
      cachedUsername || c.env.BOT_USERNAME;

    parsed = parseInput(update, botUsername);
  } catch (error) {
    console.error('Input parser failed:', error);
    return c.text('OK');
  }

  if (!parsed) {
    return c.text('OK');
  }

  c.set('parsed', parsed);

  // Route commands
  if (parsed.type === 'command' && parsed.command) {
    const cmdName = parsed.command.replace('/', '');
    const entry = commandRegistry[cmdName];

    if (!entry) {
      return c.text('OK');
    }

    try {
      const [handler, middlewares, scope] = entry;
      const chatType = update.message?.chat?.type;

      if (
        scope === 'group' &&
        chatType === 'private'
      ) {
        await withTimeout(
          tg.sendMessage(
            c.env.BOT_TOKEN,
            update.message.chat.id,
            'Use this in a group!'
          ),
          5000,
          'private command warning'
        );

        return c.text('OK');
      }

      // Run middleware safely.
      for (const mwName of middlewares || []) {
        const mw = middlewareMap[mwName];

        if (!mw) continue;

        let nextCalled = false;

        const result = await withTimeout(
          mw(c, () => {
            nextCalled = true;
          }),
          8000,
          `${mwName} middleware`
        );

        if (!nextCalled) {
          return result || c.text('OK');
        }
      }

      /*
       * Run the command with a safety timeout.
       *
       * This does NOT cancel the underlying promise, but prevents
       * the webhook request from waiting forever.
       */
      try {
        const result = await withTimeout(
          handler(c, update, parsed),
          25000,
          `${cmdName} command`
        );

        return result || c.text('OK');
      } catch (error) {
        console.error(
          `Command /${cmdName} failed:`,
          error
        );

        try {
          await withTimeout(
            tg.sendMessage(
              c.env.BOT_TOKEN,
              update.message.chat.id,
              '❌ Something went wrong while processing that command. Please try again.'
            ),
            5000,
            'command error message'
          );
        } catch (telegramError) {
          console.error(
            'Failed to send command error:',
            telegramError
          );
        }

        return c.text('OK');
      }
    } catch (error) {
      console.error(
        `Command routing failed for /${cmdName}:`,
        error
      );

      return c.text('OK');
    }
  }

  // Natural language when tagged
  if (
    parsed.type === 'natural' &&
    parsed.isMention
  ) {
    const aiEntry = commandRegistry.ask;

    if (aiEntry) {
      try {
        const fakeParsed = {
          ...parsed,
          args: parsed.args,
        };

        await withTimeout(
          aiEntry[0](c, update, fakeParsed),
          30000,
          'AI request'
        );
      } catch (error) {
        console.error(
          'Natural language AI handler failed:',
          error
        );

        try {
          await withTimeout(
            tg.sendMessage(
              c.env.BOT_TOKEN,
              update.message.chat.id,
              '❌ The AI request timed out. Please try again.'
            ),
            5000,
            'AI timeout message'
          );
        } catch (telegramError) {
          console.error(
            'Failed to send AI timeout message:',
            telegramError
          );
        }
      }
    }
  }

  return c.text('OK');
});

app.post('/kick/eventsub', async (c) => {
  try {
    return await withTimeout(
      handleKickEventSub(c),
      10000,
      'Kick EventSub handler'
    );
  } catch (error) {
    console.error(
      'Kick EventSub handler failed:',
      error
    );

    return c.text('OK');
  }
});

app.get('/kick/oauth/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');

    if (!code || !state) {
      return c.text('Missing params', 400);
    }

    const chatId = await withTimeout(
      c.env.KV.get(`oauth_state:${state}`),
      5000,
      'OAuth state lookup'
    );

    if (!chatId) {
      return c.text('Invalid or expired state', 400);
    }

    const res = await withTimeout(
      fetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: c.env.KICK_CLIENT_ID,
          client_secret: c.env.KICK_CLIENT_SECRET,
          code,
          redirect_uri: `https://${c.req.headers.get(
            'host'
          )}/kick/oauth/callback`,
        }),
      }),
      10000,
      'Kick OAuth token request'
    );

    const data = await res.json();

    if (data.access_token) {
      await withTimeout(
        c.env.KV.put(
          'kick_user_token',
          data.access_token,
          {
            expirationTtl: 3500,
          }
        ),
        5000,
        'Kick token storage'
      );

      if (data.refresh_token) {
        await withTimeout(
          c.env.KV.put(
            'kick_refresh_token_backup',
            data.refresh_token
          ),
          5000,
          'Kick refresh token storage'
        );
      }

      await withTimeout(
        tg.sendMessage(
          c.env.BOT_TOKEN,
          parseInt(chatId),
          '✅ Kick account linked successfully!'
        ),
        5000,
        'Kick OAuth Telegram message'
      );
    } else {
      await withTimeout(
        tg.sendMessage(
          c.env.BOT_TOKEN,
          parseInt(chatId),
          `❌ OAuth failed: ${
            data.error_description || 'Unknown'
          }`
        ),
        5000,
        'Kick OAuth error message'
      );
    }

    return c.text(
      'OAuth complete. You can close this tab.'
    );
  } catch (error) {
    console.error('Kick OAuth callback failed:', error);

    return c.text(
      'OAuth failed. Please try again.',
      500
    );
  }
});

app.get('/setup', async (c) => {
  try {
    await withTimeout(
      ensureSchema(c.env),
      5000,
      'setup schema initialization'
    );

    const setupSecret = c.env.SETUP_SECRET;

    if (
      setupSecret &&
      c.req.query('key') !== setupSecret
    ) {
      return c.json(
        {
          error:
            'Unauthorized. Provide the setup key.',
        },
        401
      );
    }

    const host = c.req.headers.get('host');
    const webhookUrl = `https://${host}/webhook`;

    const res = await withTimeout(
      fetch(
        `https://api.telegram.org/bot${c.env.BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: [
              'message',
              'callback_query',
              'chat_member',
              'my_chat_member',
            ],
            drop_pending_updates: true,
          }),
        }
      ),
      10000,
      'Telegram setWebhook'
    );

    const meRes = await withTimeout(
      fetch(
        `https://api.telegram.org/bot${c.env.BOT_TOKEN}/getMe`
      ),
      10000,
      'Telegram getMe'
    );

    const meData = await meRes.json();

    if (meData.ok) {
      await withTimeout(
        c.env.KV.put(
          'bot_username',
          meData.result.username
        ),
        5000,
        'bot username setup'
      );
    }

    const info = await withTimeout(
      fetch(
        `https://api.telegram.org/bot${c.env.BOT_TOKEN}/getWebhookInfo`
      ),
      10000,
      'Telegram getWebhookInfo'
    );

    return c.json({
      setup: await res.json(),
      bot: meData.result,
      webhook: await info.json(),
    });
  } catch (error) {
    console.error('Setup failed:', error);

    return c.json(
      {
        error: 'Setup failed',
        message: error.message,
      },
      500
    );
  }
});

export default {
  async fetch(request, env, ctx) {
    try {
      return await app.fetch(request, env, ctx);
    } catch (error) {
      console.error('Unhandled Worker error:', error);

      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      ensureSchema(env).catch((error) => {
        console.error(
          'Scheduled schema check failed:',
          error
        );
      })
    );

    ctx.waitUntil(
      runMonitor({
        env,
        executionCtx: ctx,
      }).catch((error) => {
        console.error(
          'Scheduled Kick monitor failed:',
          error
        );
      })
    );

    ctx.waitUntil(
      checkReminders({
        env,
        executionCtx: ctx,
      }).catch((error) => {
        console.error(
          'Scheduled reminders failed:',
          error
        );
      })
    );
  },
};
