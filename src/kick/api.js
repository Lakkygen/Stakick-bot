const KICK_V2 = 'https://kick.com/api/v2/channels';

export async function fetchChannelInfo(slug) {
  try {
    const res = await fetch(`${KICK_V2}/${slug}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://kick.com/${slug}`,
        'Origin': 'https://kick.com',
      },
      cf: { cacheTtl: 30 }
    });

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
    const res = await fetch(`https://kick.com/api/v2/channels/${slug}/clips?limit=${limit}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.clips || [];
  } catch (e) {
    return [];
  }
}
