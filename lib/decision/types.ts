/**
 * Typed decision calls: the System 1 seam.
 *
 * A decision model answers bounded questions — a choice, a score, or a
 * yes/no probability — in one pass and reports calibrated confidence. That is
 * a different contract from a chat completion, so it cannot ride `callLLM` or
 * `MODEL_ROUTES`. This module defines the provider-neutral request/result
 * shape every adapter and site agrees on.
 *
 * The layer is opt-in per site. No configuration = no calls = current behavior.
 */

/** Sites wired to the decision layer today. */
export const DECISION_SITES = ['quiz-verify', 'exam-grading', 'quiz-grade'] as const;

export type DecisionSiteId = (typeof DECISION_SITES)[number];

/**
 * `off` is accepted in config as an explicit kill switch for one site.
 * `shadow` never changes behavior; `triage` only acts on confident results;
 * `replace` acts on any usable result and falls back on abstain.
 */
export type DecisionMode = 'off' | 'shadow' | 'triage' | 'replace';

/**
 * `laya` and `jev` speak the typed decision protocol directly. `chat` routes a
 * normal chat model (OpenAI, Gemini, Ollama, Lemonade, …) through a JSON-only
 * prompt; it is generative, so it has no calibrated confidence of its own.
 */
export type DecisionProviderId = 'laya' | 'jev' | 'chat';

/** What to do when the decision model cannot answer. */
export type DecisionFallback = 'llm' | 'none';

export interface DecisionSiteConfig {
  site: DecisionSiteId;
  provider: DecisionProviderId;
  mode: DecisionMode;
  /** Required for `chat`; a `provider:model` string from the normal registry. */
  model?: string;
  /** Required for `laya` / `jev`; base URL of the decision server. */
  endpoint?: string;
  /** Literal key, or resolved from `apiKeyEnv` at parse time. */
  apiKey?: string;
  timeoutMs: number;
  /** Minimum confidence for `triage`. `replace` ignores it. */
  minConfidence: number;
  /** Longer inputs go to the fallback: encoders have a bounded window. */
  maxInputChars: number;
  fallback: DecisionFallback;
}

export type DecisionQuestion =
  | {
      id: string;
      kind: 'choice';
      prompt: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      multiple?: boolean;
    }
  | { id: string; kind: 'score'; prompt: string; min: number; max: number }
  | { id: string; kind: 'noul'; prompt: string };

export interface DecisionRequest {
  /** Shared context for every question in the request. */
  state: string;
  questions: readonly DecisionQuestion[];
}

export type DecisionAnswer =
  | { kind: 'choice'; values: string[]; confidence: number }
  | { kind: 'score'; value: number; confidence: number }
  | { kind: 'noul'; probability: number; confidence: number };

export interface DecisionResult {
  /** Stable adapter label for telemetry, e.g. `laya` or `chat:ollama:qwen3:4b`. */
  provider: string;
  answers: ReadonlyMap<string, DecisionAnswer>;
  /** Question ids the provider explicitly refused or could not answer. */
  abstained: ReadonlySet<string>;
  latencyMs: number;
  /**
   * Wire attempts a network adapter made before answering. Absent for
   * in-process adapters (or when the provider does not report it), where the
   * notion does not apply.
   */
  attempts?: number;
}

export interface DecisionProvider {
  readonly id: string;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
}

/** Confidence an adapter did not report is 0: it can never drive `triage`. */
export const UNREPORTED_CONFIDENCE = 0;
