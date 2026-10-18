/**
 * SMS delivery behind a provider interface (decision D12) so Africa's Talking / TalkSasa can be
 * introduced later without touching call sites. The only implementation in Phase 1 is the
 * development/test `MockSmsProvider`; production OTP delivery must never depend on a mock.
 */
export interface SmsMessage {
  /** Recipient in E.164 (see `normalizeKenyanPhone`). */
  to: string;
  body: string;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<void>;
}
