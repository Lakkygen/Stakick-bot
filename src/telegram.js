const BASE = (token) => `https://api.telegram.org/bot${token}`;

async function api(token, method, body) {
  const res = await fetch(`${BASE(token)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export const tg = {
  sendMessage: (token, chatId, text, opts = {}) =>
    api(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts }),
  sendPhoto: (token, chatId, photo, caption, opts = {}) =>
    api(token, 'sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...opts }),
  deleteMessage: (token, chatId, messageId) =>
    api(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }),
  banChatMember: (token, chatId, userId, revoke = true) =>
    api(token, 'banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: revoke }),
  unbanChatMember: (token, chatId, userId) =>
    api(token, 'unbanChatMember', { chat_id: chatId, user_id: userId }),
  restrictChatMember: (token, chatId, userId, permissions, untilDate = 0) =>
    api(token, 'restrictChatMember', { chat_id: chatId, user_id: userId, permissions, until_date: untilDate }),
  getChatMember: (token, chatId, userId) =>
    api(token, 'getChatMember', { chat_id: chatId, user_id: userId }),
  getChat: (token, chatId) =>
    api(token, 'getChat', { chat_id: chatId }),
  sendChatAction: (token, chatId, action) =>
    api(token, 'sendChatAction', { chat_id: chatId, action }),
  answerCallbackQuery: (token, queryId, text, showAlert = false) =>
    api(token, 'answerCallbackQuery', { callback_query_id: queryId, text, show_alert: showAlert }),
  editMessageText: (token, chatId, messageId, text, opts = {}) =>
    api(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...opts }),
};
