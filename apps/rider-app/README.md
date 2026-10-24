# @boj/rider-app (Expo / React Native)

Rider mobile app — the second native client deferred from the Phase 6 MVP.

**MVP critical journey:** phone-OTP sign-in → **go online** → see live **offers** → **accept** one
(first-wins; a lost race surfaces "Offer already taken" and refreshes) → **pickup** → **start** →
**complete** with the customer's proof-of-delivery **PIN**.

## ⚠️ Verification scope in this repo

React Native / Expo app. **CI + the dev sandbox have no Metro bundler, emulator, or EAS build**,
so the **UI is typecheck-verified only** — not rendered or journey-tested here (CLAUDE.md: never
claim untested).

Verified in CI:

- **`src/api.ts`** — typed `fetch` client (OTP, online/offline, offers, accept, delivery
  pickup/start/complete) — unit-tested (`src/api.test.ts`).
- **`src/riderFlow.ts`** — headless `createRiderModel` controller holding **all** state
  transitions + orchestration — unit-tested end-to-end (`src/riderFlow.test.ts`: full journey,
  the 409 lost-race path, a rejected PIN, offline/clear, token guards).
- `tsc --noEmit` typechecks the whole app including `App.tsx`.

`App.tsx` is a thin view that renders `createRiderModel(...)` state; `RiderApp(props)` is
injectable for a future RN render test.

## Run locally (requires the native toolchain, not available in CI)

```bash
EXPO_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @boj/rider-app dev   # expo start
```

Open in Expo Go / a simulator. Sign in as an **approved** rider (riders are onboarded + approved
via the admin flow). `EXPO_PUBLIC_API_URL` must point at the API origin.

## Scripts

| Script | What it does |
|--------|--------------|
| `dev` | `expo start` (local only) |
| `typecheck` | `tsc --noEmit` — verifies the whole app compiles (runs in CI) |
| `test` | `vitest run` — pure logic unit tests (runs in CI) |

No `build` script: the native bundle is produced via **EAS**, not in CI, so `turbo run build`
skips this workspace.

## Follow-ups (not in this MVP)

- Realtime new-offer push (join the `rider:{ulid}` socket room and refresh on a nudge) — currently
  offers are loaded on go-online and via **Refresh**.
- Rider earnings / delivery history screens.
