/**
 * Runtime config. Expo injects public env vars prefixed `EXPO_PUBLIC_` into `process.env` at build
 * time. The local `declare` keeps this typechecking without pulling Node types into the RN app;
 * the `typeof` guard keeps it safe if `process` is absent.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined;

export const API_BASE_URL: string =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_API_URL) || '';
