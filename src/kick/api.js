const KICK_V2 = 'https://kick.com/api/v2/channels';
const OFFICIAL_API = 'https://api.kick.com/public/v1';

const REALISTIC_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://kick.com/',
  'Origin': 'https://kick.com',
};

async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && i < retries) {
        const delay = Math.min(1000 * Math.pow(2, i), 5000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
  }
  throw lastError || new Error(`Fetch failed after ${retries} retries: ${url}`);
}

export async function fetchChannelInfo(slug, env = null) {
  if (env?.KICK_CLIENT_ID) {
    try {
      const token = await env.KV.get('kick_user_token');
      if (token) {
        const res = await fetchWithRetry(`${OFFICIAL_API}/channels?slug[]=${slug}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        }, 1);
        if (res.ok) {
          const json = await res.json();
          const ch = json.data?.[0];
          if (ch) {
            return {
              id: ch.id,
              user_id: ch.user_id,
              slug: ch.slug,
              user: { username: ch.slug },
              followers_count: ch.followers_count,
              livestream: ch.stream
                ? {
                    id: ch.stream.id,
                    session_title: ch.stream.title,
                    viewer_count: ch.stream.viewer_count,
                    categories: ch.stream.category ? [{ name: ch.stream.category.name }] : [],
                  }
                : null,
            };
          }
        }
      }
    } catch (e) {
      console.error(`Official API fallback failed for ${slug}:`, e.message);
    }
  }

  try {
    const res = await fetchWithRetry(`${KICK_V2}/${slug}`, {
      headers: REALISTIC_HEADERS,
      cf: { cacheTtl: 30 },
    }, 2);

    if (res.status === 404) return null;
    if (res.status === 403) {
      console.error(`Kick blocked request for ${slug} (403)`);
      return null;
    }
    if (!res.ok) {
      console.error(`Kick API error ${res.status} for ${slug}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`Fetch error for ${slug}:`, e);
    return null;
  }
}

export async function fetchChannelClips(slug, limit = 5) {
  try {
    const res = await fetchWithRetry(
      `https://kick.com/api/v2/channels/${slug}/clips?limit=${limit}`,
      { headers: REALISTIC_HEADERS },
      1
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.clips || [];
  } catch (e) {
    return [];
  }
}

export async function fetchLivestreamInfo(slug) {
  try {
    const res = await fetchWithRetry(
      `https://kick.com/api/v2/channels/${slug}/livestream`,
      { headers: REALISTIC_HEADERS },
      1
    );
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}
