import { getUserToken } from './auth';

export async function sendChatAsUser(env, chatroomId, message) {
  const token = await getUserToken(env).catch(() => null);
  if (!token) return false;

  const res = await fetch(`https://api.kick.com/public/v1/chat/${chatroomId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: message }),
  });

  return res.ok;
}

export async function getChannelDetails(env, slug) {
  const token = await getUserToken(env).catch(() => null);
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

  const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${slug}`, { headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data?.[0];
}
