# Decision layer (System 1)

A typed decision model answers bounded questions — a choice, a score, or a
yes/no probability — in one forward pass and reports confidence. That is a
different contract from a chat completion, so this layer is separate from
`callLLM` and `MODEL_ROUTES`.

It is **optional per site**. No `DECISION_ROUTES` entry means no extra calls
and no behavior change.

## Why

Generation happens once per course. Grading and verification happen once per
learner, per attempt, so they dominate the repeated LLM spend. They are also
bounded: a rubric is a set of yes/no questions, and a blind quiz solve is a
choice among existing options.

The layer does not try to replace the expensive writing model. It triages the
repeated judgments:

- a confident decision can skip the LLM call;
- a low-confidence decision, an abstain, a timeout, or an over-long input goes
  to the existing LLM path unchanged;
- `shadow` mode proves agreement before anything is switched on.

## Config

`DECISION_ROUTES` is one JSON object keyed by site.

```json
{
  "quiz-verify": {
    "provider": "laya",
    "endpoint": "http://127.0.0.1:8090",
    "mode": "replace"
  },
  "exam-grading": {
    "provider": "laya",
    "endpoint": "http://127.0.0.1:8090",
    "mode": "shadow"
  },
  "quiz-grade": {
    "provider": "chat",
    "model": "ollama:qwen3:4b",
    "mode": "replace",
    "maxInputChars": 6000
  }
}
```

Fields:

| Field | Meaning | Default |
|---|---|---|
| `provider` | `laya`, `jev`, or `chat` | required |
| `mode` | `shadow`, `triage`, `replace`, or `off` | `triage` typed, `replace` chat |
| `endpoint` | Base URL for `laya` / `jev`; the adapter POSTs `/predict` | required for typed |
| `apiKey` / `apiKeyEnv` | Hosted auth; prefer `apiKeyEnv` so the JSON stays shareable | none |
| `model` | `provider:model` for `chat` | required for chat |
| `timeoutMs` | Per-call deadline | `4000` typed, `15000` chat |
| `minConfidence` | `triage` threshold | `0.9` |
| `maxInputChars` | Longer inputs skip the decision | `12000` |
| `fallback` | `llm` or `none` | `llm` |

`DECISION_MODELS_ENABLED=false` disables every site without editing the routes.

### Modes

- `shadow` — run both, log agreement (`shadow-agree` / `shadow-disagree`),
  return the LLM result. It maps the permissive `replace` policy, so agreement
  measures what switching the site on would actually do.
- `triage` — use the decision only when every answer it used is at or above
  `minConfidence`; otherwise fall back. Partial results never get a guessed
  score.
- `replace` — use any usable decision; abstain/error/timeout falls back.
- `off` — the site is treated as unconfigured.

`fallback: "none"` disables the LLM fallback. On a grading site that means a
502 rather than an invented score; on `quiz-verify` it means no signal and the
quiz keeps its generated key.

## Providers

### Typed (`laya`, `jev`)

The adapter posts:

```json
{
  "state": "...",
  "questions": [
    { "id": "r1", "type": "noul", "prompt": "..." },
    { "id": "__score", "type": "score", "prompt": "...", "min": 0, "max": 10 },
    { "id": "q1", "type": "choice", "prompt": "...", "options": [{ "value": "A", "label": "..." }] }
  ]
}
```

and reads:

```json
{
  "answers": {
    "r1": { "noul": 0.91, "confidence": 0.95 },
    "__score": { "score": 8, "confidence": 0.8 },
    "q1": { "choice": "A", "confidence": 0.97 }
  }
}
```

`abstain: true` or `route: "review"` marks an answer unusable. Missing
confidence is treated as `0`, so a server that does not report calibration
cannot drive `triage`. `prompt` is also sent as `question` for older servers.

A typed adapter retries **once** on a transient failure (transport error,
timeout, `408`/`425`/`429`, `5xx`, or malformed JSON) and only while the
configured `timeoutMs` still has at least 250ms left. Both attempts share that
one budget, so a server that already spent the whole deadline is not retried.
A deterministic failure — `4xx`, an HTML/non-JSON content type, or a body over
the 512 KiB cap — fails immediately. Response bodies are read with a streaming
byte cap; the error never includes the body because it can echo learner text.

### Chat (`chat`)

Any model already in the registry — OpenAI, Gemini, Ollama, Lemonade, vLLM —
with a JSON-only prompt. The wire result is the same shape, normalized by the
same parser. This path is generative: its self-reported confidence is not
calibrated, so the adapter records every answer with confidence `0`. Use
`replace` or `shadow`; an explicit `triage` skips the decision call and warns
at boot instead of paying for a result it cannot use. Omitting `mode` defaults
chat sites to `replace`.

The chat timeout defaults to 15s because a cold local model may spend several
seconds loading before it answers.

Local providers still need an explicit base URL. A localhost endpoint needs
`ALLOW_LOCAL_NETWORKS=true`, exactly like a local Ollama endpoint.

For stricter output, a provider that supports schema-constrained decoding
(Ollama `format`, vLLM guided JSON, llama.cpp grammars) can enforce the
`answers` shape at the decoder. Wiring that through the chat adapter is a
future extension; the normalizer already accepts the resulting JSON.

## Sites

- **`quiz-verify`** — blind multiple-choice solve. Returns only valid option
  values; an abstained item is simply no signal. The existing LLM verifier is
  the baseline/fallback.
- **`exam-grading`** — per-criterion `noul` questions plus one bounded score.
  `triage` only awards full marks or zero (all criteria met/unmet at high
  confidence); `replace` can use a partial result plus the reported score.
  Feedback text is empty: a decision head cannot write the rationale, and the
  route must not invent it.
- **`quiz-grade`** — one bounded score. `triage` accepts only a clear zero or a
  clear full score; `replace` accepts any bounded score. Comment is empty.

## Telemetry and diagnostics

The router keeps process-local counters per site/provider/mode/outcome plus a
shadow-agreement aggregate. Shadow rows expose `agree`, `disagree`, `skipped`,
`decided`, and `agreementRate`; the rate is `null` until at least one
comparable pair exists, never a fabricated `0%`. A probe request is kept out of
these counters, so a health check cannot flatter the statistics.

Counters are written to a snapshot after events settle (debounced, atomic) and
merged once at boot, so a restart does not erase the shadow evidence that makes
the mode useful. The file is `<DECISION_TELEMETRY_FILE>` when set, otherwise
`<PERSISTENCE_DIR>/decision-telemetry.json`, otherwise
`data/decision-telemetry.json`. This is best-effort diagnostics: a write
failure only warns, and multiple processes sharing one file are
last-writer-wins.

`GET /api/decision/status` returns the enabled flag, configured sites (never
the API key), the counters, and the agreement report.
`POST /api/decision/status` probes each configured typed site with a fixed,
learner-free `noul` question; chat sites are reported as `configured` because
probing one would spend a model call. Both methods require the
`PERSISTENCE_DEV_TOKEN` bearer credential used by the course-maintenance
routes; with no token configured they refuse every request.

### Deliberately not wired

The PBL evaluator streams a narrative reflection plus a JSON tail. Its value is
the feedback that drives the next step, so replacing it with a typed score
would remove the product. It stays on the LLM until there is a real hybrid
design, not a triage flag.

## Invariants

- A decision failure never fails the request; it falls back.
- A decision-only site does not need a chat model: the LLM is resolved lazily,
  only when the fallback actually runs.
- `abstain` is not zero. It is an absent observation.
- A chat model never drives `triage`: its confidence is not calibrated.
- Long inputs go to the LLM: encoders have a bounded window.
- Decision scores are clamped to the question's declared range.
- The LLM remains the default and the permanent fallback.
- `quiz-verify` remains operator-only; a station model selection cannot turn it
  on.
- Telemetry logs only site/provider/mode/outcome/confidence/latency/attempts —
  never learner text. A probe request never enters the agreement counters.

## Tests

`tests/decision/` covers config parsing, provider normalization, the typed HTTP
adapter's retry and response guards, telemetry and shadow reporting, the
connectivity probe, router modes and fallbacks, and each site's mapping.
`tests/api/decision-grading.test.ts` exercises the real routes with a stubbed
decision server; `tests/api/decision-status.test.ts` covers the operator
diagnostics route and its token gate.
