export async function getUserToken(env) {
  const cached = await env.KV.get('kick_user_token');
  if (cached) return cached;

  if (!env.KICK_REFRESH_TOKEN || !env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
    throw new Error('Kick OAuth not configured');
  }

  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
      refresh_token: env.KICK_REFRESH_TOKEN,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));

  await env.KV.put('kick_user_token', data.access_token, {
    expirationTtl: (data.expires_in || 3600) - 60,
  });

  return data.access_token;
}
