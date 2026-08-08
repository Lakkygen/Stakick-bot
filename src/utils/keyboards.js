export const mainMenu = {
  inline_keyboard: [
    [
      { text: '🌤 Weather', callback_data: 'cmd_weather' },
      { text: '💰 Crypto', callback_data: 'cmd_crypto' },
    ],
    [
      { text: '🤖 Ask AI', callback_data: 'cmd_ai' },
      { text: '⏰ Remind Me', callback_data: 'cmd_remind' },
    ],
    [
      { text: '📺 Kick Watch', callback_data: 'cmd_kick' },
      { text: '❓ Help', callback_data: 'cmd_help' },
    ],
  ],
};

export const kickMenu = {
  inline_keyboard: [
    [
      { text: '➕ Watch Channel', callback_data: 'kick_watch' },
      { text: '📊 Status', callback_data: 'kick_status' },
    ],
    [
      { text: '🎁 Drops', callback_data: 'kick_drops' },
      { text: '📋 My List', callback_data: 'kick_list' },
    ],
    [{ text: '⬅️ Back', callback_data: 'menu_main' }],
  ],
};
