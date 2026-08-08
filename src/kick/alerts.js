export function formatAlert(slug, type, livestream, milestone = null, displayName = null) {
  const name = displayName || slug;

  switch (type) {
    case 'live':
      return `🔴 <b>${name}</b> is LIVE on Kick!

` +
        `📺 ${livestream.session_title}
` +
        `🎮 ${livestream.categories?.[0]?.name || 'Just Chatting'}
` +
        `👁 ${livestream.viewer_count?.toLocaleString()} viewers
` +
        `🔗 <a href="https://kick.com/${slug}">Watch now →</a>`;

    case 'offline':
      return `⚫ <b>${name}</b> has gone offline.`;

    case 'title_change':
      return `📝 <b>${name}</b> updated title:
<i>${livestream.session_title}</i>
🔗 <a href="https://kick.com/${slug}">Watch</a>`;

    case 'milestone':
      return `🎉 <b>${name}</b> hit <b>${milestone.toLocaleString()}</b> viewers!
` +
        `📺 ${livestream.session_title}
` +
        `🔗 <a href="https://kick.com/${slug}">Watch now →</a>`;

    case 'category_change':
      return `🏷 <b>${name}</b> switched to <b>${livestream.categories?.[0]?.name}</b>
` +
        `👁 ${livestream.viewer_count?.toLocaleString()} viewers
` +
        `🔗 <a href="https://kick.com/${slug}">Watch</a>`;

    default:
      return `Kick update: ${name}`;
  }
}
