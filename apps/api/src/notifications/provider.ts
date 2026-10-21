/**
 * Push-notification provider abstraction (doc 02 §3). Mirrors the `SmsProvider` pattern: a dev/mock
 * adapter now, the real Expo Push (→ FCM/APNs) adapter swapped in at Phase 8 (D-push). SMS reuses
 * the existing `SmsProvider` (auth/sms). Providers never hold business state.
 */
export interface PushMessage {
  /** The device push token to deliver to. */
  token: string;
  title: string;
  body: string;
}

export interface PushProvider {
  send(message: PushMessage): Promise<void>;
}
