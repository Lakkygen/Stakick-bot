export function parseInput(update, botUsername) {
  const message = update.message || update.edited_message || update.callback_query?.message;
  if (!message || !message.text) return null;

  const text = message.text;
  const chatType = message.chat?.type || 'private';
  const isPrivate = chatType === 'private';
  const entities = message.entities || [];

  // In private chat, no mention required
  if (isPrivate) {
    return {
      type: text.startsWith('/') ? 'command' : 'natural',
      raw: text,
      command: text.startsWith('/') ? text.split(' ')[0].split('@')[0].toLowerCase() : null,
      args: text.startsWith('/') ? text.split(' ').slice(1).join(' ') : text,
      isMention: false,
    };
  }

  // In groups: must be mentioned or replied to bot
  const mentionPattern = new RegExp(`@${botUsername}\\b`, 'i');
  const hasTextMention = mentionPattern.test(text);

  let hasEntityMention = false;
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mentionText = text.substring(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        hasEntityMention = true;
      }
    }
  }

  const isReplyToBot = message.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase();

  if (!hasTextMention && !hasEntityMention && !isReplyToBot) {
    return null;
  }

  let cleanText = text.replace(mentionPattern, '').trim();
  if (!cleanText && isReplyToBot) {
    cleanText = text.trim();
  }

  const isCommand = cleanText.startsWith('/');
  const command = isCommand ? cleanText.split(' ')[0].split('@')[0].toLowerCase() : null;
  const args = isCommand ? cleanText.split(' ').slice(1).join(' ') : cleanText;

  return {
    type: isCommand ? 'command' : 'natural',
    raw: cleanText,
    command,
    args,
    isMention: true,
    isReplyToBot,
  };
}
