import 'dotenv/config';

import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ============================================================
// CONFIG
// ============================================================

const PORT = getPositiveInteger(
  process.env.PORT,
  3000
);

const PROFILE_PATH = path.resolve(
  process.env.KICK_PROFILE || './kick-profile'
);

const WATCHER_SECRET =
  process.env.WATCHER_SECRET || '';

const MAX_PAGES = Math.min(
  getPositiveInteger(
    process.env.MAX_PAGES,
    3
  ),
  10
);

const NAVIGATION_TIMEOUT_MS = Math.min(
  getPositiveInteger(
    process.env.NAVIGATION_TIMEOUT_MS,
    30000
  ),
  120000
);

const KICK_BASE_URL =
  'https://kick.com';

// ============================================================
// STATE
// ============================================================

let browserContext = null;
let browserStarting = null;
let shuttingDown = false;

const pages = new Map();

let requestCount = 0;

// ============================================================
// HELPERS
// ============================================================

function getPositiveInteger(value, fallback) {
  const number = Number(value);

  if (
    Number.isInteger(number) &&
    number > 0
  ) {
    return number;
  }

  return fallback;
}

function log(...args) {
  console.log(
    `[${new Date().toISOString()}]`,
    ...args
  );
}

function errorLog(...args) {
  console.error(
    `[${new Date().toISOString()}]`,
    ...args
  );
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, {
    recursive: true
  });
}

function normalizeSlug(value) {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  let slug = value.trim();

  if (!slug) {
    return null;
  }

  // Accept either:
  // xQc
  // https://kick.com/xQc
  // https://www.kick.com/xQc
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

      slug =
        url.pathname
          .replace(/^\/+/, '')
          .split('/')[0];
    }
  } catch {
    return null;
  }

  slug = slug
    .replace(/^@/, '')
    .trim();

  /*
   * Kick channel slugs should not contain
   * whitespace or URL path separators.
   */
  if (
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(
      slug
    )
  ) {
    return null;
  }

  return slug;
}

function streamUrl(slug) {
  return `${KICK_BASE_URL}/${encodeURIComponent(
    slug
  )}`;
}

function authorized(req) {
  if (!WATCHER_SECRET) {
    return true;
  }

  const supplied =
    req.get('x-watcher-secret') ||
    req.body?.secret ||
    '';

  return supplied === WATCHER_SECRET;
}

function activePages() {
  return [...pages.values()]
    .filter(
      entry =>
        entry.page &&
        !entry.page.isClosed()
    );
}

function pageAlreadyOpen(slug) {
  for (const entry of activePages()) {
    if (
      entry.slug.toLowerCase() ===
      slug.toLowerCase()
    ) {
      return entry;
    }
  }

  return null;
}

// ============================================================
// BROWSER
// ============================================================

async function launchBrowser() {
  if (shuttingDown) {
    throw new Error(
      'Watcher is shutting down.'
    );
  }

  if (browserContext) {
    return browserContext;
  }

  if (browserStarting) {
    return browserStarting;
  }

  browserStarting =
    (async () => {
      ensureDirectory(
        PROFILE_PATH
      );

      log(
        `Starting Chromium with profile: ${PROFILE_PATH}`
      );

      const context =
        await chromium.launchPersistentContext(
          PROFILE_PATH,
          {
            headless: false,

            viewport: {
              width: 1280,
              height: 720
            },

            locale: 'en-US',

            ignoreHTTPSErrors: false,

            timeout:
              NAVIGATION_TIMEOUT_MS
          }
        );

      context.setDefaultTimeout(
        15000
      );

      context.setDefaultNavigationTimeout(
        NAVIGATION_TIMEOUT_MS
      );

      context.on(
        'page',
        page => {
          log(
            'Browser opened a new page.'
          );

          attachPageListeners(
            page
          );
        }
      );

      context.on(
        'close',
        () => {
          log(
            'Browser context closed.'
          );

          browserContext = null;
        }
      );

      browserContext = context;

      for (
        const page of context.pages()
      ) {
        attachPageListeners(
          page
        );
      }

      log(
        'Chromium is ready.'
      );

      return context;
    })();

  try {
    return await browserStarting;
  } finally {
    browserStarting = null;
  }
}

function attachPageListeners(page) {
  if (
    page.__stakickListenersAttached
  ) {
    return;
  }

  page.__stakickListenersAttached =
    true;

  page.on(
    'crash',
    () => {
      errorLog(
        'A browser page crashed.'
      );
    }
  );

  page.on(
    'close',
    () => {
      for (
        const [id, entry]
        of pages.entries()
      ) {
        if (
          entry.page === page
        ) {
          pages.delete(id);

          log(
            `Removed closed page ${id}.`
          );
        }
      }
    }
  );

  page.on(
    'pageerror',
    error => {
      errorLog(
        'Kick page error:',
        error.message
      );
    }
  );
}

// ============================================================
// OPEN STREAM
// ============================================================

async function openStream(slug) {
  const existing =
    pageAlreadyOpen(slug);

  if (existing) {
    try {
      await existing.page.bringToFront();
    } catch {}

    return {
      reused: true,
      pageId: existing.id,
      slug,
      url: streamUrl(slug)
    };
  }

  const current =
    activePages();

  if (
    current.length >=
    MAX_PAGES
  ) {
    throw new Error(
      `Maximum active stream pages reached (${MAX_PAGES}).`
    );
  }

  const context =
    await launchBrowser();

  const page =
    await context.newPage();

  attachPageListeners(page);

  const id =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  pages.set(id, {
    id,
    slug,
    page,
    openedAt: Date.now()
  });

  const url =
    streamUrl(slug);

  log(
    `Opening Kick stream: ${url}`
  );

  try {
    await page.goto(
      url,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          NAVIGATION_TIMEOUT_MS
      }
    );

    /*
     * Give the page a small amount of time
     * to finish rendering.
     *
     * This does NOT attempt to fake viewing
     * or manipulate Kick's playback system.
     */
    await page
      .waitForTimeout(1000);

    try {
      await page.bringToFront();
    } catch {}

    log(
      `Stream opened successfully: ${slug}`
    );

    return {
      reused: false,
      pageId: id,
      slug,
      url,
      title:
        await page.title().catch(
          () => null
        )
    };
  } catch (error) {
    pages.delete(id);

    try {
      await page.close();
    } catch {}

    throw new Error(
      `Failed to open Kick stream "${slug}": ${error.message}`
    );
  }
}

// ============================================================
// CLOSE STREAM
// ============================================================

async function closeStream(pageId) {
  const entry =
    pages.get(pageId);

  if (!entry) {
    return false;
  }

  pages.delete(pageId);

  try {
    if (
      !entry.page.isClosed()
    ) {
      await entry.page.close();
    }
  } catch (error) {
    errorLog(
      `Failed closing page ${pageId}:`,
      error.message
    );
  }

  return true;
}

// ============================================================
// ROUTES
// ============================================================

app.get(
  '/health',
  async (req, res) => {
    const active =
      activePages();

    res.json({
      ok: true,
      service:
        'stakick-browser-watcher',
      browserReady:
        Boolean(browserContext),
      shuttingDown,
      activeStreams:
        active.length,
      maxStreams:
        MAX_PAGES,
      uptimeSeconds:
        Math.floor(
          process.uptime()
        ),
      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  '/streams',
  (req, res) => {
    res.json({
      ok: true,
      streams:
        activePages().map(
          entry => ({
            pageId:
              entry.id,
            slug:
              entry.slug,
            openedAt:
              new Date(
                entry.openedAt
              ).toISOString(),
            url:
              streamUrl(
                entry.slug
              )
          })
        )
    });
  }
);

app.post(
  '/watch',
  async (req, res) => {
    const requestId =
      ++requestCount;

    try {
      if (!authorized(req)) {
        return res.status(401).json({
          ok: false,
          error:
            'Unauthorized.',
          requestId
        });
      }

      const slug =
        normalizeSlug(
          req.body?.slug
        );

      if (!slug) {
        return res.status(400).json({
          ok: false,
          error:
            'Invalid Kick channel slug.',
          requestId
        });
      }

      const result =
        await openStream(
          slug
        );

      return res.json({
        ok: true,
        requestId,
        ...result
      });
    } catch (error) {
      errorLog(
        `[${requestId}] /watch failed:`,
        error.message
      );

      return res.status(500).json({
        ok: false,
        requestId,
        error:
          error.message
      });
    }
  }
);

app.post(
  '/close',
  async (req, res) => {
    try {
      if (!authorized(req)) {
        return res.status(401).json({
          ok: false,
          error:
            'Unauthorized.'
        });
      }

      const pageId =
        String(
          req.body?.pageId || ''
        ).trim();

      if (!pageId) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing pageId.'
        });
      }

      const closed =
        await closeStream(
          pageId
        );

      if (!closed) {
        return res.status(404).json({
          ok: false,
          error:
            'Stream page not found.'
        });
      }

      return res.json({
        ok: true,
        closed: true,
        pageId
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        'Route not found.',
      path:
        req.path
    });
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    errorLog(
      'Express error:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    return res.status(500).json({
      ok: false,
      error:
        'Internal watcher error.'
    });
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  log(
    `${signal} received. Shutting down...`
  );

  for (
    const entry of activePages()
  ) {
    try {
      await entry.page.close();
    } catch {}
  }

  pages.clear();

  if (browserContext) {
    try {
      await browserContext.close();
    } catch {}

    browserContext = null;
  }

  server.close(() => {
    log(
      'Watcher stopped cleanly.'
    );

    process.exit(0);
  });

  setTimeout(
    () => {
      process.exit(1);
    },
    5000
  ).unref();
}

// ============================================================
// START
// ============================================================

ensureDirectory(
  PROFILE_PATH
);

const server =
  app.listen(
    PORT,
    async () => {
      log(
        `Stakick watcher listening on port ${PORT}`
      );

      log(
        `Profile: ${PROFILE_PATH}`
      );

      log(
        `Maximum streams: ${MAX_PAGES}`
      );

      if (
        WATCHER_SECRET
      ) {
        log(
          'Request authentication: enabled'
        );
      } else {
        log(
          'WARNING: WATCHER_SECRET is not configured.'
        );
      }

      try {
        await launchBrowser();

        log(
          'Watcher is ready.'
        );
        log(
          'Open Kick and log into your account manually.'
        );
      } catch (error) {
        errorLog(
          'Browser startup failed:',
          error.message
        );

        /*
         * The HTTP server stays alive so a temporary
         * Chromium problem does not kill the service.
         * A later /watch request will retry browser startup.
         */
      }
    }
  );

server.on(
  'error',
  error => {
    errorLog(
      'HTTP server error:',
      error.message
    );

    if (
      error.code ===
      'EADDRINUSE'
    ) {
      errorLog(
        `Port ${PORT} is already in use.`
      );

      process.exit(1);
    }
  }
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'uncaughtException',
  error => {
    errorLog(
      'Uncaught exception:',
      error
    );
  }
);

process.on(
  'unhandledRejection',
  reason => {
    errorLog(
      'Unhandled rejection:',
      reason
    );
  }
);
