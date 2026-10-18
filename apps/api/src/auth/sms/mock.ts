import type { Logger } from '../../platform/logger';
import type { SmsMessage, SmsProvider } from './provider';

export interface MockSmsOptions {
  logger?: Logger;
  /**
   * Log the message body so a developer can read the OTP locally. Dev-only — must never be
   * enabled in production (D12: never log real production OTPs).
   */
  logBody?: boolean;
}

/**
 * In-memory SMS provider for development and tests. Records every message so tests can assert
 * what was "sent"; optionally logs the body in development. Not for production use.
 */
export class MockSmsProvider implements SmsProvider {
  readonly sent: SmsMessage[] = [];

  constructor(private readonly opts: MockSmsOptions = {}) {}

  send(message: SmsMessage): Promise<void> {
    this.sent.push(message);
    if (this.opts.logBody) {
      this.opts.logger?.info({ to: message.to, body: message.body }, 'MockSmsProvider: sent SMS');
    } else {
      this.opts.logger?.info({ to: message.to }, 'MockSmsProvider: sent SMS');
    }
    return Promise.resolve();
  }

  /** Most recent message sent to `to`, if any (test helper). */
  lastTo(to: string): SmsMessage | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]?.to === to) {
        return this.sent[i];
      }
    }
    return undefined;
  }
}
