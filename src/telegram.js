// src/telegram.js
// ============================================================
// STAKICKBOT — TELEGRAM API HELPERS
// ============================================================

const BASE = (token) =>
  `https://api.telegram.org/bot${token}`;

/**
 * Generic Telegram Bot API request.
 */
async function api(
  token,
  method,
  body
) {
  if (!token) {
    throw new Error(
      'Telegram bot token is missing.'
    );
  }

  const response =
    await fetch(
      `${BASE(token)}/${method}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify(
          body ?? {}
        ),
      }
    );

  /*
   * Keep the raw Response object for compatibility
   * with the existing bot code.
   */
  return response;
}

function sendMessage(
  token,
  chatId,
  text,
  opts = {}
) {
  return api(
    token,
    'sendMessage',
    {
      chat_id:
        chatId,

      text:
        String(
          text ?? ''
        ),

      parse_mode:
        'HTML',

      disable_web_page_preview:
        true,

      ...opts,
    }
  );
}

function sendPhoto(
  token,
  chatId,
  photo,
  caption,
  opts = {}
) {
  return api(
    token,
    'sendPhoto',
    {
      chat_id:
        chatId,

      photo,

      caption:
        String(
          caption ?? ''
        ),

      parse_mode:
        'HTML',

      ...opts,
    }
  );
}

function deleteMessage(
  token,
  chatId,
  messageId
) {
  return api(
    token,
    'deleteMessage',
    {
      chat_id:
        chatId,

      message_id:
        messageId,
    }
  );
}

function banChatMember(
  token,
  chatId,
  userId,
  revoke = true
) {
  return api(
    token,
    'banChatMember',
    {
      chat_id:
        chatId,

      user_id:
        userId,

      revoke_messages:
        Boolean(revoke),
    }
  );
}

function unbanChatMember(
  token,
  chatId,
  userId
) {
  return api(
    token,
    'unbanChatMember',
    {
      chat_id:
        chatId,

      user_id:
        userId,
    }
  );
}

function restrictChatMember(
  token,
  chatId,
  userId,
  permissions,
  untilDate = 0
) {
  return api(
    token,
    'restrictChatMember',
    {
      chat_id:
        chatId,

      user_id:
        userId,

      permissions:
        permissions || {},

      until_date:
        Number(untilDate) || 0,
    }
  );
}

function getChatMember(
  token,
  chatId,
  userId
) {
  return api(
    token,
    'getChatMember',
    {
      chat_id:
        chatId,

      user_id:
        userId,
    }
  );
}

function getChat(
  token,
  chatId
) {
  return api(
    token,
    'getChat',
    {
      chat_id:
        chatId,
    }
  );
}

function sendChatAction(
  token,
  chatId,
  action
) {
  return api(
    token,
    'sendChatAction',
    {
      chat_id:
        chatId,

      action:
        action,
    }
  );
}

function answerCallbackQuery(
  token,
  queryId,
  text,
  showAlert = false
) {
  return api(
    token,
    'answerCallbackQuery',
    {
      callback_query_id:
        queryId,

      text:
        text
          ? String(text)
          : undefined,

      show_alert:
        Boolean(showAlert),
    }
  );
}

function editMessageText(
  token,
  chatId,
  messageId,
  text,
  opts = {}
) {
  return api(
    token,
    'editMessageText',
    {
      chat_id:
        chatId,

      message_id:
        messageId,

      text:
        String(
          text ?? ''
        ),

      parse_mode:
        'HTML',

      ...opts,
    }
  );
}

function getMe(token) {
  return api(
    token,
    'getMe',
    {}
  );
}

function setMyCommands(
  token,
  commands,
  scope
) {
  const body = {
    commands:
      Array.isArray(commands)
        ? commands
        : [],
  };

  if (scope) {
    body.scope =
      scope;
  }

  return api(
    token,
    'setMyCommands',
    body
  );
}

function sendTyping(
  token,
  chatId
) {
  return sendChatAction(
    token,
    chatId,
    'typing'
  );
}

export const tg = {
  sendMessage,
  sendPhoto,
  deleteMessage,
  banChatMember,
  unbanChatMember,
  restrictChatMember,
  getChatMember,
  getChat,
  sendChatAction,
  answerCallbackQuery,
  editMessageText,

  /*
   * Additional helpers.
   */
  getMe,
  setMyCommands,
  sendTyping,

  /*
   * Generic API escape hatch.
   */
  api,
};
