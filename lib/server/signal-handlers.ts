/**
 * Node-only signal registration.
 *
 * Lives in its own module so `instrumentation.ts` can load it via dynamic
 * import: Next compiles instrumentation for the Edge runtime too, and the
 * Edge bundle statically rejects `process.once`. Dynamic imports stay opaque
 * to that check, exactly like the other Node-only imports there.
 */
export function registerSignalHandlers(onShutdown: () => void): void {
  process.once('SIGTERM', () => void onShutdown());
  process.once('SIGINT', () => void onShutdown());
}
