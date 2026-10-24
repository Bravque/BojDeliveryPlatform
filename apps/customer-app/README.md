# @boj/customer-app (Expo / React Native)

Customer mobile app — the first of the two native clients deferred from the Phase 6 MVP.

**MVP critical journey:** phone-OTP sign-in → browse merchants (optionally by town) → open a
merchant menu → track an order live (joins the `order:{ulid}` socket room and re-fetches on each
status nudge).

## ⚠️ Verification scope in this repo

This is a React Native / Expo app. **The CI pipeline and dev sandbox have no Metro bundler,
emulator, or EAS build**, so the **UI is typecheck-verified only** — it is *not* rendered or
journey-tested here (CLAUDE.md: never claim untested).

What **is** verified in CI:

- **`src/api.ts`** — typed REST client (pure `fetch`) — unit-tested (`src/api.test.ts`).
- **`src/customerFlow.ts`** — the headless journey controller holding **all** state transitions
  and API orchestration (business logic out of UI) — unit-tested end-to-end
  (`src/customerFlow.test.ts`: phone→OTP→browse→merchant→track, realtime refresh, error paths).
- `tsc --noEmit` typechecks the whole app including `App.tsx` and the screens.

`App.tsx` is a thin view that renders `createCustomerModel(...)` state and binds inputs; it takes
injectable `api`/`connectSocket` props so the same logic is testable headlessly.

## Run locally (requires the native toolchain, not available in CI)

```bash
EXPO_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @boj/customer-app dev   # expo start
```

Then open in Expo Go / a simulator. `EXPO_PUBLIC_API_URL` must point at the API origin.

## Scripts

| Script | What it does |
|--------|--------------|
| `dev` | `expo start` (local only) |
| `typecheck` | `tsc --noEmit` — verifies the whole app compiles (runs in CI) |
| `test` | `vitest run` — pure logic unit tests (runs in CI) |

There is no `build` script: the native bundle is produced via **EAS** (`eas build`), not in CI, so
`turbo run build` simply skips this workspace.
