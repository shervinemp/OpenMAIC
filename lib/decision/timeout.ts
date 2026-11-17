/** Combine a caller signal with a per-call timeout, and clean both up. */
export function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Decision call timed out', 'TimeoutError'));
  }, timeoutMs);

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
