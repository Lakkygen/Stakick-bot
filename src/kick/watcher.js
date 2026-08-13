const TIMEOUT_MS = 5000;

function normalizeSlug(value) {
  if (!value) return null;

  let slug = String(value).trim();

  try {
    if (
      slug.startsWith('http://') ||
      slug.startsWith('https://')
    ) {
      const url = new URL(slug);

      if (
        url.hostname !== 'kick.com' &&
        url.hostname !== 'www.kick.com'
      ) {
        return null;
      }

      slug = url.pathname
        .replace(/^\/+/, '')
        .split('/')[0];
    }
  } catch {
    return null;
  }

  slug = slug.replace(/^@/, '').trim();

  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(slug)) {
    return null;
  }

  return slug;
}

function getWatcherConfig(env) {
  const url = String(
    env.WATCHER_URL || ''
  ).trim().replace(/\/+$/, '');

  const secret = String(
    env.WATCHER_SECRET || ''
  ).trim();

  return { url, secret };
}

async function watcherRequest(
  env,
  pathname,
  body
) {
  const { url, secret } =
    getWatcherConfig(env);

  if (!url) {
    return {
      ok: false,
      skipped: true,
      reason: 'WATCHER_URL not configured'
    };
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${url}${pathname}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret
            ? {
                'x-watcher-secret': secret
              }
            : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    const text =
      await response.text();

    let data;

    try {
      data = text
        ? JSON.parse(text)
        : {};
    } catch {
      data = {
        ok: response.ok,
        raw: text.slice(0, 500)
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        ...data
      };
    }

    return {
      ok: true,
      status: response.status,
      ...data
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error?.name === 'AbortError'
          ? `Watcher timeout after ${TIMEOUT_MS}ms`
          : error?.message || String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function watcherHealth(env) {
  const { url, secret } =
    getWatcherConfig(env);

  if (!url) {
    return {
      ok: false,
      configured: false
    };
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${url}/health`,
      {
        method: 'GET',
        headers: secret
          ? {
              'x-watcher-secret': secret
            }
          : {},
        signal: controller.signal
      }
    );

    const text =
      await response.text();

    let data;

    try {
      data = text
        ? JSON.parse(text)
        : {};
    } catch {
      data = {
        ok: response.ok
      };
    }

    return {
      ok: response.ok,
      configured: true,
      ...data
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      error:
        error?.name === 'AbortError'
          ? `Watcher timeout after ${TIMEOUT_MS}ms`
          : error?.message || String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function startWatcher(
  env,
  {
    slug,
    campaignId = null,
    campaignName = null,
    watchSeconds = null,
    startAt = null
  } = {}
) {
  const cleanSlug =
    normalizeSlug(slug);

  if (!cleanSlug) {
    return {
      ok: false,
      error: 'Invalid channel slug'
    };
  }

  const seconds =
    Number(watchSeconds);

  return watcherRequest(
    env,
    '/watch',
    {
      slug: cleanSlug,
      campaignId,
      campaignName,
      watchSeconds:
        Number.isFinite(seconds) &&
        seconds > 0
          ? Math.floor(seconds)
          : null,
      startAt
    }
  );
}
