/**
 * Output-truncation signal.
 *
 * Kept separate from `llm.ts` so route modules (and their test doubles) can
 * import the predicate without pulling in — or having to mock — the whole LLM
 * call layer.
 */

/**
 * The provider stopped at the output limit. Unlike a content filter or a
 * provider error, another attempt at the SAME budget reproduces the cut, and a
 * fallback model inherits the same `maxOutputTokens`. So this error is
 * deliberately non-retryable and never arms the fallback model: retrying it
 * would pay for the same truncated work twice.
 */
export class LlmOutputTruncatedError extends Error {
  readonly code = 'LLM_OUTPUT_TRUNCATED';
  readonly isRetryable = false;

  constructor(
    readonly source: string,
    readonly maxOutputTokens?: number,
    /** The partial text the provider produced before the cut. */
    readonly text = '',
  ) {
    super(
      `${source} output was truncated by the output limit${
        maxOutputTokens ? ` (maxOutputTokens=${maxOutputTokens})` : ''
      }; raise the stage cap or reduce the requested output`,
    );
    this.name = 'LlmOutputTruncatedError';
  }
}

export function isLlmOutputTruncatedError(error: unknown): error is LlmOutputTruncatedError {
  return (
    error instanceof LlmOutputTruncatedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'LLM_OUTPUT_TRUNCATED')
  );
}
