import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';
import { createScheduler, type ScheduledJob } from './scheduler';

function fakeTimers() {
  const registered: Array<{ cb: () => void; ms: number }> = [];
  const cleared: number[] = [];
  let next = 1;
  const setIntervalImpl = ((cb: () => void, ms: number) => {
    registered.push({ cb, ms });
    return next++ as unknown as ReturnType<typeof setInterval>;
  }) as SchedulerTimer;
  const clearIntervalImpl = (h: ReturnType<typeof setInterval>) => {
    cleared.push(h as unknown as number);
  };
  return { registered, cleared, setIntervalImpl, clearIntervalImpl };
}
type SchedulerTimer = (cb: () => void, ms: number) => ReturnType<typeof setInterval>;

function fakeLogger() {
  const errors: Array<Record<string, unknown>> = [];
  const logger = {
    info: vi.fn(),
    error: (obj: Record<string, unknown>) => errors.push(obj),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, errors };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('createScheduler', () => {
  it('registers one interval per job at its configured cadence', () => {
    const t = fakeTimers();
    const { logger } = fakeLogger();
    const jobs: ScheduledJob[] = [
      { name: 'a', intervalMs: 1000, run: () => Promise.resolve() },
      { name: 'b', intervalMs: 5000, run: () => Promise.resolve() },
    ];
    createScheduler({ jobs, logger, ...t }).start();
    expect(t.registered.map((r) => r.ms)).toEqual([1000, 5000]);
  });

  it('runs a job when its interval fires', async () => {
    const t = fakeTimers();
    const { logger } = fakeLogger();
    const run = vi.fn(() => Promise.resolve());
    createScheduler({ jobs: [{ name: 'a', intervalMs: 1000, run }], logger, ...t }).start();
    t.registered[0]!.cb();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing run (logs it) so the loop and other jobs survive', async () => {
    const t = fakeTimers();
    const { logger, errors } = fakeLogger();
    const good = vi.fn(() => Promise.resolve());
    const jobs: ScheduledJob[] = [
      { name: 'boom', intervalMs: 1000, run: () => Promise.reject(new Error('kaboom')) },
      { name: 'good', intervalMs: 1000, run: good },
    ];
    createScheduler({ jobs, logger, ...t }).start();
    expect(() => t.registered[0]!.cb()).not.toThrow(); // failing job
    t.registered[1]!.cb(); // healthy job still fires independently
    await flush();
    expect(errors[0]).toMatchObject({ job: 'boom' });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent; stop clears all intervals', () => {
    const t = fakeTimers();
    const { logger } = fakeLogger();
    const s = createScheduler({
      jobs: [{ name: 'a', intervalMs: 1000, run: () => Promise.resolve() }],
      logger,
      ...t,
    });
    s.start();
    s.start(); // no second registration
    expect(t.registered).toHaveLength(1);
    s.stop();
    expect(t.cleared).toEqual([1]);
    // After stop, start registers again.
    s.start();
    expect(t.registered).toHaveLength(2);
  });
});
