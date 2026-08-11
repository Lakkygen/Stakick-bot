export function formatAlert(slug, type, livestream, milestone = null, displayName = null) {
  const name = displayName || slug;

  switch (type) {
    case 'live':
      return `🔴 <b>${name}</b> is LIVE on Kick!\n\n📺 ${livestream.session_title}\n🎮 ${livestream.categories?.[0]?.name || 'Just Chatting'}\n👁 ${livestream.viewer_count?.toLocaleString()} viewers\n🔗 Watch now → https://kick.com/${slug}`;
    case 'offline':
      return `⚫ <b>${name}</b> has gone offline.`;
    case 'title_change':
      return `📝 <b>${name}</b> updated title:\n<i>${livestream.session_title}</i>\n🔗 Watch https://kick.com/${slug}`;
    case 'milestone':
      return `🎉 <b>${name}</b> hit <b>${milestone.toLocaleString()}</b> viewers!\n📺 ${livestream.session_title}\n🔗 Watch now → https://kick.com/${slug}`;
    case 'category_change':
      return `🏷 <b>${name}</b> switched to <b>${livestream.categories?.[0]?.name}</b>\n👁 ${livestream.viewer_count?.toLocaleString()} viewers\n🔗 Watch https://kick.com/${slug}`;
    default:
      return `Kick update: ${name}`;
  }
}
