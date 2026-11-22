# Decision layer (System 1)

A typed decision model answers bounded questions — a choice, a score, or a
yes/no probability — in one forward pass and reports confidence. That is a
different contract from a chat completion, so this layer is separate from
`callLLM` and `MODEL_ROUTES`.

It is **opt-in** and configured in one place: **Settings → Model Services →
Decision Model**. There is no server-side env config, no per-site config, and
no separate decision API key. The single choice is sent with each request via
`x-decision-*` headers; with no header, no decision call is made and the site
keeps its normal LLM baseline.

## Why

Generation happens once per course. Grading and verification happen once per
learner, per attempt, so they dominate the repeated LLM spend. They are also
bounded: a rubric is a set of yes/no questions, and a blind quiz solve is a
choice among existing options.

The layer does not try to replace the expensive writing model. It triages the
repeated judgments:

- a confident decision can answer directly;
- an abstain, a low-confidence answer, a timeout, or an over-long input goes to
  the existing LLM path unchanged;
- `shadow` mode proves agreement before anything is switched on.

## Config

The Decision Model tab exposes one choice for every decision site:

| Setting | Meaning | Default |
|---|---|---|
| Enable decision model | Off means no decision calls at all | off |
| Provider | `chat` (dedicated model) or `laya` / `jev` (typed) | `chat` |
| Mode | `shadow` or `replace` | `shadow` |
| Model | one qualified `provider:model` id from the dedicated System 1 catalog | none |
| Endpoint | base URL for `laya` / `jev`; the adapter POSTs `/predict` | none |

The provider/model catalog is **independent of the main LLM's**
`providersConfig` and picker. Add qualified `provider:model` ids (for example
an OpenAI or Gemini model) in the tab, then choose one. The selected id is
stored as `decisionModel`; the catalog as `decisionModels`. The provider still
needs to be reachable on the server (credentials/base URL configured);
otherwise the decision call fails open to the LLM baseline.

Internal limits are fixed in `lib/decision/request-config.ts`: 15s timeout,
`0.9` minimum confidence, 12,000 input characters, and LLM fallback. They are
not exposed as per-site settings.

### Modes

- `shadow` — run both, log agreement (`shadow-agree` / `shadow-disagree`),
  return the LLM result. It maps the permissive `replace` policy, so agreement
  measures what switching the site on would actually do.
- `replace` — use any usable decision; abstain/error/timeout falls back to the
  LLM. Quiz and exam feedback text is empty in this mode.
- `triage` (internal only, not exposed in Settings) — use the decision only
  when every answer it used is at or above `minConfidence`. A chat model never
  drives `triage`: its self-reported confidence is not calibrated.

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

### Dedicated model (`chat` adapter)

Any qualified `provider:model` id from the dedicated System 1 catalog, with a
JSON-only prompt. The wire result is the same shape, normalized by the same
parser. This path is generative: its self-reported confidence is not
calibrated, so the adapter records every answer with confidence `0`, which
keeps it out of `triage` and leaves `shadow`/`replace` as the usable modes.

The chat timeout defaults to 15s because a cold local model may spend several
seconds loading before it answers. Local providers still need an explicit base
URL; a localhost endpoint needs `ALLOW_LOCAL_NETWORKS=true`.

`jsonMode` is available on the internal config for stricter output: the shared
transport adds `response_format: {"type":"json_object"}` for OpenAI-compatible
endpoints. It stays opt-in because a server that does not know the field would
reject the request and follow the normal fallback path.

## Sites

One Settings choice applies to all four sites:

- **`quiz-verify`** — blind multiple-choice solve. Returns only valid option
  values; an abstained item is simply no signal. The existing LLM verifier is
  the baseline/fallback.
- **`exam-grading`** — per-criterion `noul` questions plus one bounded score.
  `replace` can use a partial result plus the reported score. Feedback text is
  empty: a decision head cannot write the rationale, and the route must not
  invent it.
- **`quiz-grade`** — one bounded score. `replace` accepts any bounded score.
  Comment is empty.
- **`claim-check`** — typed shadow review of the deterministic claim ledger.
  The code ledger is the baseline in every mode; `replace` is possible but not
  recommended because the typed verdict is only yes/no, not the specific
  contradiction a rewrite needs.

## Telemetry and diagnostics

The router keeps process-local counters per site/provider/mode/outcome plus a
shadow-agreement aggregate. Shadow rows expose `agree`, `disagree`, `skipped`,
`decided`, and `agreementRate`; the rate is `null` until at least one
comparable pair exists, never a fabricated `0%`.

Counters are written to a snapshot after events settle (debounced, atomic) and
merged once at boot, so a restart does not erase the shadow evidence that makes
the mode useful. The file is `<DECISION_TELEMETRY_FILE>` when set, otherwise
`<PERSISTENCE_DIR>/decision-telemetry.json`, otherwise
`data/decision-telemetry.json`. This is best-effort diagnostics: a write
failure only warns, and multiple processes sharing one file are
last-writer-wins.

`GET /api/decision/status` reports `source: "settings"` plus the counters and
agreement report. It requires the `PERSISTENCE_DEV_TOKEN` bearer credential
used by the course-maintenance routes; with no token configured it refuses
every request. Telemetry carries no learner text.

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
- Telemetry logs only site/provider/mode/outcome/confidence/latency/attempts —
  never learner text.
- The System 1 catalog never reads from or writes to the main LLM's
  `providersConfig`.

## Tests

`tests/decision/` covers the request-derived config, provider normalization,
the typed HTTP adapter's retry and response guards, telemetry and shadow
reporting, router modes and fallbacks, and each site's mapping.
`tests/api/decision-grading.test.ts` exercises the real routes with a stubbed
decision server; `tests/api/decision-status.test.ts` covers the operator
diagnostics route and its token gate;
`tests/store/settings-decision-models.test.ts` covers the dedicated model
catalog.
