import 'dotenv/config';

import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PORT =
  Number(process.env.PORT || 3000);

const PROFILE_PATH =
  path.resolve(
    process.env.KICK_PROFILE ||
      './kick-profile'
  );

const WATCHER_SECRET =
  String(
    process.env.WATCHER_SECRET || ''
  ).trim();

const MAX_PAGES = Math.min(
  Math.max(
    Number(process.env.MAX_PAGES || 3),
    1
  ),
  5
);

const NAVIGATION_TIMEOUT_MS =
  Math.min(
    Math.max(
      Number(
        process.env.NAVIGATION_TIMEOUT_MS ||
          30000
      ),
      5000
    ),
    120000
  );

const pages = new Map();

let context = null;
let startupPromise = null;
let shuttingDown = false;
let browserError = null;

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

function validSlug(value) {
  if (!value) return null;

  let slug = String(value).trim();

  try {
    if (
      slug.startsWith('http://') ||
      slug.startsWith('https://')
    ) {
      const url =
        new URL(slug);

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

  slug =
    slug
      .replace(/^@/, '')
      .trim();

  if (
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(
      slug
    )
  ) {
    return null;
  }

  return slug;
}

function authorized(req) {
  if (!WATCHER_SECRET) {
    return false;
  }

  return (
    req.get('x-watcher-secret') ===
    WATCHER_SECRET
  );
}

async function ensureBrowser() {
  if (shuttingDown) {
    throw new Error(
      'Watcher is shutting down'
    );
  }

  if (context) {
    return context;
  }

  if (startupPromise) {
    return startupPromise;
  }

  startupPromise =
    (async () => {
      fs.mkdirSync(
        PROFILE_PATH,
        {
          recursive: true
        }
      );

      log(
        `Launching Chromium profile: ${PROFILE_PATH}`
      );

      const browser =
        await chromium.launchPersistentContext(
          PROFILE_PATH,
          {
            headless: false,
            viewport: {
              width: 1280,
              height: 720
            },
            locale: 'en-US'
          }
        );

      browser.setDefaultTimeout(
        15000
      );

      browser.setDefaultNavigationTimeout(
        NAVIGATION_TIMEOUT_MS
      );

      browser.on(
        'close',
        () => {
          context = null;
        }
      );

      context = browser;

      log(
        'Chromium ready.'
      );

      return browser;
    })();

  try {
    return await startupPromise;
  } finally {
    startupPromise = null;
  }
}

function activePages() {
  return [
    ...pages.values()
  ].filter(
    entry =>
      entry.page &&
      !entry.page.isClosed()
  );
}

function findExisting(slug) {
  return activePages().find(
    entry =>
      entry.slug.toLowerCase() ===
      slug.toLowerCase()
  );
}

async function openStream(slug) {
  const existing =
    findExisting(slug);

  if (existing) {
    try {
      await existing.page.bringToFront();
    } catch {}

    return {
      ok: true,
      reused: true,
      pageId: existing.id,
      slug
    };
  }

  if (
    activePages().length >=
    MAX_PAGES
  ) {
    throw new Error(
      `Maximum active pages reached (${MAX_PAGES})`
    );
  }

  const browser =
    await ensureBrowser();

  const page =
    await browser.newPage();

  const pageId =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  pages.set(
    pageId,
    {
      id: pageId,
      slug,
      page,
      openedAt: Date.now()
    }
  );

  page.on(
    'close',
    () => {
      pages.delete(pageId);
    }
  );

  try {
    const url =
      `https://kick.com/${encodeURIComponent(
        slug
      )}`;

    log(
      `Opening ${url}`
    );

    await page.goto(
      url,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          NAVIGATION_TIMEOUT_MS
      }
    );

    await page.bringToFront();

    return {
      ok: true,
      reused: false,
      pageId,
      slug,
      url
    };
  } catch (error) {
    pages.delete(
      pageId
    );

    try {
      await page.close();
    } catch {}

    throw error;
  }
}

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      browserReady:
        Boolean(context),
      browserError,
      activeStreams:
        activePages().length,
      maxStreams:
        MAX_PAGES,
      uptime:
        Math.floor(
          process.uptime()
        )
    });
  }
);

app.get(
  '/streams',
  (req, res) => {
    if (!authorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    return res.json({
      ok: true,
      streams:
        activePages().map(
          entry => ({
            pageId:
              entry.id,
            slug:
              entry.slug,
            openedAt:
              entry.openedAt,
            url:
              `https://kick.com/${entry.slug}`
          })
        )
    });
  }
);

app.post(
  '/watch',
  async (req, res) => {
    if (!authorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const slug =
      validSlug(
        req.body?.slug
      );

    if (!slug) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid Kick channel slug'
      });
    }

    try {
      const result =
        await openStream(
          slug
        );

      log(
        `[WATCH] ${slug} opened`
      );

      return res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      errorLog(
        `[WATCH] ${slug} failed:`,
        error?.message ||
          error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          'Failed to open stream'
      });
    }
  }
);

app.post(
  '/close',
  async (req, res) => {
    if (!authorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const pageId =
      String(
        req.body?.pageId || ''
      ).trim();

    const entry =
      pages.get(pageId);

    if (!entry) {
      return res.status(404).json({
        ok: false,
        error:
          'Page not found'
      });
    }

    pages.delete(pageId);

    try {
      await entry.page.close();
    } catch {}

    return res.json({
      ok: true,
      closed: true,
      pageId
    });
  }
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        'Route not found'
    });
  }
);

const server =
  app.listen(
    PORT,
    async () => {
      log(
        `Stakick watcher listening on port ${PORT}`
      );

      try {
        await ensureBrowser();

        log(
          'Watcher ready. Log into Kick in the opened Chromium profile.'
        );
} catch (error) {
  browserError =
    error?.stack ||
    error?.message ||
    String(error);

  errorLog(
    'Browser startup failed:',
    browserError
  );
      }
    }
  );

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  log(
    'Shutting down watcher...'
  );

  for (
    const entry of activePages()
  ) {
    try {
      await entry.page.close();
    } catch {}
  }

  pages.clear();

  if (context) {
    try {
      await context.close();
    } catch {}

    context = null;
  }

  server.close(
    () => process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);
