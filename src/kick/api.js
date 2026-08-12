// ============================================================
// STAKICK API CLIENT
// ============================================================
//
// KICK data sources:
//
// 1. KICK Drops API
//    https://web.kick.com/api/v1/drops/campaigns
//
// 2. KICK public web API
//    https://kick.com/api/v2
//
// 3. KICK official API
//    https://api.kick.com/public/v1
//
// IMPORTANT:
// - Drop detection should use fetchDropCampaigns()
// - Stream monitoring should use fetchChannelInfo()
// - Requests are deliberately uncached for monitoring
// - Every network request has a timeout
// - Transient failures are retried
//
// ============================================================

// ------------------------------------------------------------
// ENDPOINTS
// ------------------------------------------------------------

const KICK_V2 =
  'https://kick.com/api/v2';

const KICK_CHANNELS =
  `${KICK_V2}/channels`;

const OFFICIAL_API =
  'https://api.kick.com/public/v1';

const DROPS_API =
  'https://web.kick.com/api/v1/drops/campaigns';

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

const CHANNEL_TIMEOUT_MS = 3500;

const DROPS_TIMEOUT_MS = 4500;

const MAX_RETRIES = 2;

// ------------------------------------------------------------
// HEADERS
// ------------------------------------------------------------

const REALISTIC_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language':
    'en-US,en;q=0.9',
  Referer:
    'https://kick.com/',
  Origin:
    'https://kick.com/',
  'Cache-Control':
    'no-cache, no-store, max-age=0',
  Pragma:
    'no-cache',
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function safeErrorMessage(error) {
  return (
    error?.message ||
    String(error)
  );
}

function createTimeoutSignal(
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

// ------------------------------------------------------------
// REQUEST CLASSIFICATION
// ------------------------------------------------------------

function isRetryableStatus(
  status
) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

// ------------------------------------------------------------
// GENERIC FETCH WITH RETRY
// ------------------------------------------------------------

export async function fetchWithRetry(
  url,
  options = {},
  retries = MAX_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    const timeout =
      createTimeoutSignal(
        timeoutMs
      );

    try {
      const mergedHeaders = {
        ...REALISTIC_HEADERS,
        ...(options.headers || {}),
      };

      const response =
        await fetch(url, {
          ...options,
          headers: mergedHeaders,
          signal:
            options.signal ||
            timeout.signal,

          /*
           * Cloudflare Workers:
           *
           * Explicitly disable edge caching for monitoring.
           */
          cf: {
            ...(options.cf || {}),
            cacheTtl: 0,
            cacheEverything: false,
          },
        });

      timeout.clear();

      /*
       * Successful response.
       */
      if (
        response.ok
      ) {
        return response;
      }

      /*
       * Retry transient HTTP failures.
       */
      if (
        isRetryableStatus(
          response.status
        ) &&
        attempt < retries
      ) {
        let delay =
          500 *
          Math.pow(
            2,
            attempt
          );

        /*
         * Respect Retry-After when supplied.
         */
        const retryAfter =
          response.headers.get(
            'Retry-After'
          );

        if (retryAfter) {
          const seconds =
            Number(
              retryAfter
            );

          if (
            Number.isFinite(
              seconds
            )
          ) {
            delay =
              Math.min(
                seconds * 1000,
                5000
              );
          }
        }

        console.warn(
          `[KICK API] ${response.status} retry ${attempt + 1}/${retries} in ${delay}ms`
        );

        await sleep(delay);
        continue;
      }

      /*
       * Permanent HTTP error.
       */
      return response;

    } catch (error) {
      timeout.clear();

      lastError =
        error;

      if (
        attempt >= retries
      ) {
        break;
      }

      const delay =
        Math.min(
          500 *
            (attempt + 1),
          2500
        );

      console.warn(
        `[KICK API] network error; retry ${attempt + 1}/${retries} in ${delay}ms: ${safeErrorMessage(error)}`
      );

      await sleep(delay);
    }
  }

  throw (
    lastError ||
    new Error(
      `Request failed after ${retries + 1} attempts: ${url}`
    )
  );
}

// ============================================================
// DROPS API
// ============================================================
//
// THIS IS THE IMPORTANT NEW FUNCTION.
//
// monitor.js should call this instead of implementing its own
// Drops API fetcher if you want api.js to be the central API
// layer.
//
// ============================================================

export async function fetchDropCampaigns(
  env = null
) {
  const headers = {
    ...REALISTIC_HEADERS,
    Accept:
      'application/json',
  };

  /*
   * Optional session token.
   *
   * If KICK_SESSION_TOKEN exists, send it.
   */
  if (
    env?.KICK_SESSION_TOKEN
  ) {
    headers.Authorization =
      `Bearer ${env.KICK_SESSION_TOKEN}`;
  }

  try {
    const response =
      await fetchWithRetry(
        DROPS_API,
        {
          method: 'GET',
          headers,

          /*
           * Absolutely no caching.
           *
           * Drop discovery needs the freshest possible response.
           */
          cf: {
            cacheTtl: 0,
            cacheEverything: false,
          },
        },
        2,
        DROPS_TIMEOUT_MS
      );

    if (
      !response.ok
    ) {
      console.error(
        `[KICK DROPS] HTTP ${response.status}`
      );

      return null;
    }

    const payload =
      await response.json();

    /*
     * Known response:
     *
     * {
     *   data: [...],
     *   message: "Success"
     * }
     */

    if (
      Array.isArray(
        payload?.data
      )
    ) {
      return payload.data
        .filter(Boolean);
    }

    /*
     * Alternate response.
     */
    if (
      Array.isArray(
        payload?.campaigns
      )
    ) {
      return payload.campaigns
        .filter(Boolean);
    }

    /*
     * Some endpoints may return the array directly.
     */
    if (
      Array.isArray(
        payload
      )
    ) {
      return payload
        .filter(Boolean);
    }

    console.warn(
      '[KICK DROPS] Unexpected response structure'
    );

    return [];

  } catch (error) {
    console.error(
      '[KICK DROPS] fetch failed:',
      safeErrorMessage(error)
    );

    /*
     * IMPORTANT:
     *
     * null means API FAILURE.
     *
     * [] means API successfully responded with zero campaigns.
     *
     * The monitor can therefore distinguish:
     *
     * API DOWN
     * vs
     * NO DROPS
     */
    return null;
  }
}

// ============================================================
// OFFICIAL KICK CHANNEL API
// ============================================================

async function fetchOfficialChannel(
  slug,
  env
) {
  if (
    !env?.KICK_CLIENT_ID
  ) {
    return null;
  }

  if (
    !env?.KV
  ) {
    return null;
  }

  try {
    const token =
      await env.KV.get(
        'kick_user_token'
      );

    if (!token) {
      return null;
    }

    const url =
      `${OFFICIAL_API}/channels?slug[]=${encodeURIComponent(slug)}`;

    const response =
      await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept:
              'application/json',
          },
        },
        1,
        CHANNEL_TIMEOUT_MS
      );

    /*
     * Token may be invalid/expired.
     *
     * Don't repeatedly hammer the official API.
     */
    if (
      response.status ===
        401 ||
      response.status ===
        403
    ) {
      console.warn(
        `[KICK OFFICIAL] authorization failed for ${slug}`
      );

      return null;
    }

    if (
      !response.ok
    ) {
      return null;
    }

    const json =
      await response.json();

    const channel =
      json?.data?.[0];

    if (!channel) {
      return null;
    }

    return normalizeOfficialChannel(
      channel
    );

  } catch (error) {
    console.error(
      `[KICK OFFICIAL] ${slug}:`,
      safeErrorMessage(error)
    );

    return null;
  }
}

// ============================================================
// OFFICIAL API NORMALIZER
// ============================================================

function normalizeOfficialChannel(
  channel
) {
  const stream =
    channel?.stream ||
    null;

  return {
    id:
      channel?.id ??
      null,

    user_id:
      channel?.user_id ??
      null,

    slug:
      channel?.slug ??
      null,

    user: {
      id:
        channel?.user_id ??
        null,

      username:
        channel?.slug ??
        null,
    },

    followers_count:
      channel?.followers_count ??
      0,

    livestream:
      stream
        ? {
            id:
              stream.id ??
              null,

            session_title:
              stream.title ||
              '',

            viewer_count:
              Number(
                stream.viewer_count ||
                0
              ),

            categories:
              stream.category
                ? [
                    {
                      name:
                        stream.category.name ||
                        'Unknown',
                    },
                  ]
                : [],
          }
        : null,
  };
}

// ============================================================
// KICK V2 CHANNEL
// ============================================================

export async function fetchChannelInfo(
  slug,
  env = null
) {
  if (!slug) {
    return null;
  }

  const cleanSlug =
    String(slug)
      .trim()
      .toLowerCase();

  /*
   * ----------------------------------------------------------
   * OFFICIAL API FIRST
   * ----------------------------------------------------------
   *
   * If a valid official API token is configured, use it.
   */
  const official =
    await fetchOfficialChannel(
      cleanSlug,
      env
    );

  if (official) {
    return official;
  }

  /*
   * ----------------------------------------------------------
   * KICK WEB API FALLBACK
   * ----------------------------------------------------------
   */

  const url =
    `${KICK_CHANNELS}/${encodeURIComponent(
      cleanSlug
    )}`;

  try {
    const response =
      await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers:
            REALISTIC_HEADERS,

          /*
           * IMPORTANT:
           *
           * Do NOT cache channel state.
           *
           * The monitor needs current live/offline state.
           */
          cf: {
            cacheTtl: 0,
            cacheEverything: false,
          },
        },
        2,
        CHANNEL_TIMEOUT_MS
      );

    if (
      response.status ===
      404
    ) {
      return null;
    }

    if (
      response.status ===
      403
    ) {
      console.error(
        `[KICK V2] blocked request for ${cleanSlug} (403)`
      );

      return null;
    }

    if (
      !response.ok
    ) {
      console.error(
        `[KICK V2] HTTP ${response.status} for ${cleanSlug}`
      );

      return null;
    }

    return await response.json();

  } catch (error) {
    console.error(
      `[KICK V2] ${cleanSlug}:`,
      safeErrorMessage(error)
    );

    return null;
  }
}

// ============================================================
// LIVESTREAM ENDPOINT
// ============================================================
//
// This remains available for other parts of the bot.
// It is NOT required by the new monitor if channelInfo already
// contains livestream data.
//
// ============================================================

export async function fetchLivestreamInfo(
  slug
) {
  if (!slug) {
    return null;
  }

  const cleanSlug =
    String(slug)
      .trim()
      .toLowerCase();

  const url =
    `${KICK_CHANNELS}/${encodeURIComponent(
      cleanSlug
    )}/livestream`;

  try {
    const response =
      await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers:
            REALISTIC_HEADERS,
          cf: {
            cacheTtl: 0,
            cacheEverything: false,
          },
        },
        1,
        CHANNEL_TIMEOUT_MS
      );

    if (
      response.status ===
      404
    ) {
      return null;
    }

    if (
      !response.ok
    ) {
      return null;
    }

    return await response.json();

  } catch (error) {
    console.error(
      `[KICK LIVESTREAM] ${cleanSlug}:`,
      safeErrorMessage(error)
    );

    return null;
  }
}

// ============================================================
// CHANNEL CLIPS
// ============================================================

export async function fetchChannelClips(
  slug,
  limit = 5
) {
  if (!slug) {
    return [];
  }

  const cleanSlug =
    String(slug)
      .trim()
      .toLowerCase();

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 5,
        1
      ),
      50
    );

  const url =
    `${KICK_CHANNELS}/${encodeURIComponent(
      cleanSlug
    )}/clips?limit=${safeLimit}`;

  try {
    const response =
      await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers:
            REALISTIC_HEADERS,

          /*
           * Clips don't need stale caching either.
           */
          cf: {
            cacheTtl: 0,
            cacheEverything: false,
          },
        },
        1,
        DEFAULT_TIMEOUT_MS
      );

    if (
      !response.ok
    ) {
      return [];
    }

    const data =
      await response.json();

    return Array.isArray(
      data?.clips
    )
      ? data.clips
      : Array.isArray(data)
      ? data
      : [];

  } catch (error) {
    console.error(
      `[KICK CLIPS] ${cleanSlug}:`,
      safeErrorMessage(error)
    );

    return [];
  }
}

// ============================================================
// OPTIONAL: CHECK WHETHER CHANNEL IS LIVE
// ============================================================
//
// Useful helper for other modules.
//
// ============================================================

export async function isChannelLive(
  slug,
  env = null
) {
  const info =
    await fetchChannelInfo(
      slug,
      env
    );

  return Boolean(
    info?.livestream
  );
}

// ============================================================
// OPTIONAL: EXTRACT LIVESTREAM
// ============================================================
//
// Handles both the KICK V2 and official API structures.
//
// ============================================================

export function getLivestreamFromChannel(
  info
) {
  return (
    info?.livestream ||
    info?.stream ||
    null
  );
}

// ============================================================
// OPTIONAL: GET VIEWER COUNT
// ============================================================

export function getViewerCount(
  info
) {
  const livestream =
    getLivestreamFromChannel(
      info
    );

  const viewers =
    Number(
      livestream?.viewer_count
    );

  return Number.isFinite(
    viewers
  )
    ? viewers
    : 0;
}

// ============================================================
// OPTIONAL: GET STREAM TITLE
// ============================================================

export function getStreamTitle(
  info
) {
  const livestream =
    getLivestreamFromChannel(
      info
    );

  return (
    livestream?.session_title ||
    livestream?.title ||
    ''
  );
}

// ============================================================
// OPTIONAL: GET STREAM ID
// ============================================================

export function getStreamId(
  info
) {
  const livestream =
    getLivestreamFromChannel(
      info
    );

  return (
    livestream?.id ??
    null
  );
}
