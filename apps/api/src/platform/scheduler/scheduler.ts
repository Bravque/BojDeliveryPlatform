import type { Logger } from '../logger';

/**
 * Minimal in-process interval scheduler (Phase 8, doc 10). Runs the jobs that were on-demand until
 * now — the stale-payment reconcile sweep and the assignment-offer expiry tick — on a fixed cadence.
 * A failing run is logged and swallowed so one bad tick never kills the loop, and every operation it
 * drives is itself idempotent, so a missed/duplicated run can't double-pay or double-capture.
 *
 * **Single instance only** (gated by `SCHEDULER_ENABLED`): running two schedulers would double-sweep.
 * Durable, multi-instance scheduling (BullMQ/Redis) is deferred to an actual multi-instance deploy.
 * Timer functions are injectable so the cadence is unit-testable without real time.
 */
export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface SchedulerDeps {
  jobs: ScheduledJob[];
  logger: Logger;
  setIntervalImpl?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const setIv = deps.setIntervalImpl ?? setInterval;
  const clearIv = deps.clearIntervalImpl ?? clearInterval;
  const handles: Array<ReturnType<typeof setInterval>> = [];
  let running = false;

  async function runJob(job: ScheduledJob): Promise<void> {
    try {
      await job.run();
    } catch (err) {
      deps.logger.error({ err, job: job.name }, 'scheduled job failed');
    }
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      for (const job of deps.jobs) {
        handles.push(
          setIv(() => {
            void runJob(job);
          }, job.intervalMs),
        );
      }
      deps.logger.info({ jobs: deps.jobs.map((j) => j.name) }, 'scheduler started');
    },
    stop(): void {
      for (const handle of handles) {
        clearIv(handle);
      }
      handles.length = 0;
      running = false;
    },
  };
}
