import { getUserToken } from './auth';

export async function sendChatAsUser(env, chatroomId, message) {
  const token = await getUserToken(env).catch(() => null);
  if (!token) return false;

  const res = await fetch(`https://api.kick.com/public/v1/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: message,
      type: 'user',
      broadcaster_user_id: chatroomId,
    }),
  });

  return res.ok;
}

export async function getChannelDetails(env, slug) {
  const token = await getUserToken(env).catch(() => null);
  const headers = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' };

  const res = await fetch(`https://api.kick.com/public/v1/channels?slug[]=${slug}`, { headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data?.[0];
}

export async function getLivestreams(env, opts = {}) {
  const token = await getUserToken(env).catch(() => null);
  if (!token) return null;

  const params = new URLSearchParams();
  if (opts.categoryId) params.append('category_id[]', opts.categoryId);
  if (opts.language) params.append('language_code[]', opts.language);
  if (opts.limit) params.append('limit', String(opts.limit));

  const res = await fetch(`https://api.kick.com/public/v2/livestreams?${params}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.data || [];
}

export async function updateChannel(env, opts) {
  const token = await getUserToken(env).catch(() => null);
  if (!token) return false;

  const res = await fetch(`https://api.kick.com/public/v1/channels`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(opts),
  });

  return res.ok;
}

export async function banUser(env, broadcasterUserId, userId, duration = null, reason = '') {
  const token = await getUserToken(env).catch(() => null);
  if (!token) return false;

  const res = await fetch(`https://api.kick.com/public/v1/moderation/bans`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcaster_user_id: broadcasterUserId,
      user_id: userId,
      duration,
      reason,
    }),
  });

  return res.ok;
}
