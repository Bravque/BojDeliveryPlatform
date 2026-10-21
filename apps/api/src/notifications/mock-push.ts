import type { Logger } from '../platform/logger';
import type { PushMessage, PushProvider } from './provider';

export interface MockPushOptions {
  logger?: Logger;
  logBody?: boolean;
}

/**
 * Dev/test push provider: captures every message in `sent` (for assertions) and optionally logs it.
 * Stands in for Expo Push until Phase 8 — no network, deterministic.
 */
export class MockPushProvider implements PushProvider {
  readonly sent: PushMessage[] = [];

  constructor(private readonly opts: MockPushOptions = {}) {}

  send(message: PushMessage): Promise<void> {
    this.sent.push(message);
    if (this.opts.logBody) {
      this.opts.logger?.info(
        { token: message.token, body: message.body },
        'MockPushProvider: sent',
      );
    } else {
      this.opts.logger?.info({ token: message.token }, 'MockPushProvider: sent');
    }
    return Promise.resolve();
  }
}
