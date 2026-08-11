import { DurableObject } from 'cloudflare:workers';
import { runMonitor } from './monitor';

const INTERVAL_MS = 15_000;

export class DropAlarm extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async getStatus() {
    const alarmAt = await this.ctx.storage.getAlarm();

    return {
      running: alarmAt != null,
      alarm_at: alarmAt,
      alarm_in_ms:
        alarmAt != null
          ? Math.max(0, alarmAt - Date.now())
          : null,
      interval_ms: INTERVAL_MS,
      interval_seconds: INTERVAL_MS / 1000,
    };
  }

  async start() {
    const existing = await this.ctx.storage.getAlarm();

    if (existing != null) {
      return {
        ok: true,
        started: false,
        already_running: true,
        alarm_at: existing,
        alarm_in_ms: Math.max(
          0,
          existing - Date.now()
        ),
        interval_ms: INTERVAL_MS,
      };
    }

    const firstAlarm = Date.now() + 1000;

    await this.ctx.storage.setAlarm(firstAlarm);

    return {
      ok: true,
      started: true,
      first_alarm_at: firstAlarm,
      interval_ms: INTERVAL_MS,
    };
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();

    return {
      ok: true,
      stopped: true,
    };
  }

  async runNow() {
    const started = Date.now();

    try {
      const stats = await runMonitor({
        env: this.env,
        executionCtx: null,
      });

      return {
        ok: true,
        stats,
        duration_ms: Date.now() - started,
      };
    } finally {
      // Keep the recurring alarm alive.
      await this.ctx.storage.setAlarm(
        Date.now() + INTERVAL_MS
      );
    }
  }

  async alarm(alarmInfo) {
    const started = Date.now();

    try {
      console.log(
        `[DROP ALARM] fired retry=${
          alarmInfo?.retryCount ?? 0
        }`
      );

      const stats = await runMonitor({
        env: this.env,
        executionCtx: null,
      });

      console.log(
        `[DROP ALARM] completed ${Date.now() - started}ms`,
        JSON.stringify(stats)
      );
    } catch (error) {
      console.error(
        '[DROP ALARM] monitor execution failed:',
        error?.message || error
      );
    } finally {
      /*
       * Important:
       * Always schedule the next alarm after this execution.
       *
       * This gives us approximately a 15-second monitor cycle
       * without requiring a 15-second Cron Trigger.
       */
      try {
        await this.ctx.storage.setAlarm(
          Date.now() + INTERVAL_MS
        );
      } catch (error) {
        console.error(
          '[DROP ALARM] failed to schedule next alarm:',
          error?.message || error
        );
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return Response.json(
        await this.getStatus()
      );
    }

    if (url.pathname === '/start') {
      return Response.json(
        await this.start()
      );
    }

    if (url.pathname === '/stop') {
      return Response.json(
        await this.stop()
      );
    }

    if (url.pathname === '/run') {
      return Response.json(
        await this.runNow()
      );
    }

    return Response.json(
      {
        ok: false,
        error: 'Unknown DropAlarm route',
      },
      { status: 404 }
    );
  }
}
