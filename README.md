# Stakick Bot — Ready-to-Deploy Cloudflare Worker

A feature-rich Telegram bot with deep Kick.com integration, group management, AI, weather, crypto, reminders, and real-time stream monitoring.

## 🔐 Security

Secrets are intentionally **not** stored in this repository. Set them with Wrangler:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SETUP_SECRET
```

If the bot token that was included in an older copy of this project is still active, revoke it in Telegram's **@BotFather** and issue a new token before deploying this cleaned package.
## Prerequisites

1. Node.js installed
2. A Cloudflare account
3. Wrangler CLI: `npm install -g wrangler`
4. Logged in: `npx wrangler login`

## Step 1: Authenticate with Cloudflare

```bash
npm install
npx wrangler login
```

This project uses Wrangler's automatic resource provisioning for **KV and D1**. On the first deploy, Cloudflare can create the missing resources and bind them to the Worker. The bot also bootstraps its own database tables the first time it runs, so you do not need a separate manual schema step.

## Step 2: Set Your Bot Username

After creating your bot with @BotFather, change `BOT_USERNAME` in `wrangler.jsonc` to your actual bot username. The `/setup` endpoint also refreshes the username from Telegram.

## Step 3: Set required secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SETUP_SECRET
```

Optional integrations:

```bash
npx wrangler secret put OPENAI_KEY
npx wrangler secret put OPENWEATHER_KEY
npx wrangler secret put CMC_KEY
npx wrangler secret put KICK_CLIENT_ID
npx wrangler secret put KICK_CLIENT_SECRET
npx wrangler secret put KICK_REFRESH_TOKEN
```

## Step 4: Deploy + initialize D1

```bash
npm run deploy:full
```

The first deploy provisions the KV/D1 resources. The bot creates its tables automatically on first run through `/setup`, webhook traffic, or the scheduled monitor.

## Step 5: Setup Telegram Webhook

After deployment, open:

`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/setup?key=YOUR_SETUP_SECRET`

This registers the Telegram webhook and caches the bot username.

## Step 6: Add Bot to Your Group

1. Add `@YourBotUsername` to your Telegram group
2. Make it an admin (required for ban/mute/purge)
3. Run: `/kicksetnotify` in the group to set it as the default notification channel

## Step 7: Start Watching Kick Streams

In your group, tag the bot:
```
@YourBotUsername /kickwatch xqc
@YourBotUsername /kickwatch lakkygen
```

Or use direct commands:
```
/kickwatch xqc
/kickstatus lakkygen
/kickdrops
```

## Optional: Link Your Kick Account (OAuth)

To let Stakick send chat or manage your stream as you:

1. Go to `https://kick.com/settings/developer` and create an app
2. Set redirect URI to: `https://your-worker.workers.dev/kick/oauth/callback`
3. Set secrets:
```bash
npx wrangler secret put KICK_CLIENT_ID
npx wrangler secret put KICK_CLIENT_SECRET
```
4. In Telegram, run `/kicklink` and authorize

## Commands Reference

### Group Management
- `/ban` — Reply to user (admin only)
- `/mute 30` — Mute for 30 minutes (admin only)
- `/warn spam` — Warn user (admin only)
- `/purge 10` — Delete last 10 messages (admin only)
- `/setwelcome Hello {name}!` — Set welcome message
- `/setrules No spam` — Set group rules
- `/rules` — Show rules

### Kick Integration
- `/kickwatch <slug>` — Watch a Kick channel
- `/kickunwatch <slug>` — Stop watching
- `/kicklist` — List watched channels
- `/kickstatus <slug>` — Check live status now
- `/kickdrops` — Show recent drop alerts
- `/kickclips <slug>` — Show recent clips
- `/kicksetnotify` — Set this group as default (admin)
- `/kicklink` — Link your Kick account via OAuth

### External Tools
- `/weather London` — Weather info
- `/crypto BTC` — Crypto prices
- `/ask <question>` — Ask AI
- `/translate en es Hello` — Translate text
- `/remind 30m Check oven` — Set reminder

### Natural Language
Tag the bot in a group and ask anything:
```
@StakickBot what's the weather in Tokyo?
@StakickBot remind me to call mom in 2 hours
```

## How Monitoring Works

- Cron runs every **1 minute**
- Checks up to **40 channels** per run (prioritizes owner channel)
- Staggered checking means you can watch **unlimited channels** — less active ones are checked slightly less frequently
- Alerts sent for: go-live, offline, title changes, category changes, viewer milestones, drop/bonus detection

## Architecture Notes

- **Ban-safe**: Stakick does NOT view-bot. It uses public APIs for monitoring and official OAuth for account actions.
- **Drop alerts**: Scans stream title, category, channel metadata, and other Kick fields for stronger drop/reward signals such as "drops enabled", "watch to earn", "bonus", "campaign", and related phrases. You must watch via Kick's website/app to actually earn drops.
- **Scalable**: Add new commands by dropping a file in `src/commands/` and registering it in `src/config.js`.

## Troubleshooting

**Bot not responding?**
- Check `/setup` returned OK
- Ensure bot is admin in the group
- Check Wrangler logs: `npx wrangler tail`

**Kick API returning 403?**
- Kick's unofficial API is protected by Cloudflare. The bot uses realistic headers, but occasional blocks are normal.
- For production reliability, complete the OAuth setup to use the official API.

**Want to watch more than 40 channels?**
- The bot automatically staggers checks. Channels are ordered by `last_checked`, so all get checked over time.
- To check more per minute, upgrade to Cloudflare Workers Paid (50ms CPU, longer cron duration).

---
Built for lakkygen | Stakick Bot v1.0
