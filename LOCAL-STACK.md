# Local Media Stack (personal branch)

Everything needed to run OpenMAIC media generation fully local. LLM stays on
DeepSeek (cloud) by design; every other provider slot can point at a local
server with **zero code changes** — flip the provider in the Settings UI and the
defaults/base URLs already match the local endpoints.

## One command

```bash
pnpm serve
```

Starts, idempotently (skips anything already up): Ollama (local LLM option),
Kokoro TTS, ComfyUI, and the OpenMAIC dev server. `Ctrl+C` stops what it
started.

- `pnpm serve ollama kokoro comfyui openmaic` — explicit set
- `pnpm serve funasr` — STT opt-in (needs the FunASR venv installed first;
  currently not installed — see "Not installed yet")

## What to select in Settings

| Category | Provider | Base URL | Notes |
|---|---|---|---|
| LLM / chat | **DeepSeek** (keep) or Ollama | `http://localhost:11434/v1` | Ollama is the local fallback; `ollama pull llama3.3` etc. |
| Image | ComfyUI Image | `http://localhost:8188` | Workflows: `comfyui-z-image-turbo.json` (fast) / `comfyui-qwen-image-2512.json` (text quality) |
| Video | ComfyUI (Local) | `http://localhost:8188` | Workflow: `comfyui-minimax-h3.json` (H3 T2V, 15 s max) |
| TTS | Lemonade TTS | `http://127.0.0.1:8080/v1` | Kokoro server; already wired via `.env.local` |
| Web search | Brave (already configured) | cloud | keyless in this app — no local server needed |
| ASR | — | — | left for later (VRAM pressure) |
| PDF | unpdf | — | In-process, always local |

**App port:** OpenMAIC runs on the first free port starting at **3000** (Next auto-increments: 3000, 3001, …) — so it never collides with other dev servers on this machine.

## Origin-independent persistence (server-backed store)

Lessons (documents), learner-runtime sessions, and **media assets** are
persisted **on disk by the OpenMAIC server** (`PERSISTENCE_DIR` in
`.env.local`), not in the browser. That means your lessons AND their images
follow the app across port changes, hostname changes, or browser profile
wipes — the browser origin only still holds small settings KV. Wired via
`lib/persistence/bootstrap.ts` (`NEXT_PUBLIC_PERSISTENCE=1`),
`app/api/persistence/[...path]/route.ts` (the JSON-file backend, no Postgres
required), and `lib/media/server-asset-store.ts` (the asset pool's server
backend, selected in `lib/media/asset-pool.ts`). Backend files live under
`.data/persistence/` (`documents/<stageId>.json`, `runtime/<sessionId>.json`,
`assets/<ref>`) — back them up with the rest of the repo folder.

- The dev token (`PERSISTENCE_DEV_TOKEN` == `NEXT_PUBLIC_PERSISTENCE_TOKEN`) is
  not a secret: it ships in the public bundle and only keeps scanners out of the
  trusted-localhost endpoint.
- Changing ports again later needs no migration: documents and assets are
  origin-independent; only settings would reset to defaults (covered by
  `DEFAULT_MODEL` in `.env.local`).

## Migrating data from a previous browser origin

If the app ran in another browser profile / port before, move the data once:

1. Fully close the source browser (profile lock). The source data may live in
   an MSIX-packaged browser's profile (e.g. DuckDuckGo keeps it under
   `%LOCALAPPDATA%\Packages\DuckDuckGo.DesktopBrowser_*\LocalState\DDGWebView\`).
2. Mirror the profile so a headless Chromium can read it (Chrome/CDP refuses
   the default profile path): `robocopy <profile-root> %TEMP%\opencode\ddg-mirror /E`.
3. Run `node scripts/run-migration.mjs` — it exports the old origin's
   IndexedDB (all maic/* DBs incl. legacy `MAIC-Database`, `maic-asset-pool`,
   `maic-backups`, `maic-runtime`) + localStorage into one JSON, imports it
   through the app's `/migrate` page (documents + assets → the local server
   store), and reports what landed on disk. The source browser is never
   modified; the export file stays at `%TEMP%\opencode\openmaic-migration.json`.
4. Reload the app — lessons are listed. The legacy per-file stores
   (`imageFiles`/`mediaFiles`/chat sessions from the old app era) are preserved
   in the export file but not restored (the modern app doesn't read them).

## Model files (ComfyUI `models/`)

- `unet/`: `qwen-image-2512-Q4_K_M.gguf` (or Q5_K_S), `z-image-turbo-Q8_0.gguf`,
  `minimax_h3_fl2va_pruned_fp8_Q4_0.gguf`
- `text_encoders/`: `qwen_2.5_vl_7b_fp8_scaled.safetensors` (Qwen-Image —
  GGUF of this exact encoder does not exist; the UD/abliterated Instruct GGUF
  produces broken output), `Z-Image-AbliteratedV1.Q8_0.gguf`, H3 Qwen3-VL files
- `vae/`: `qwen_image_vae.safetensors`, `ae.safetensors`, H3 VAEs

## Out of scope (deliberately)

- **ASR / STT** — left for later; nothing here depends on it and it would
  compete with ComfyUI for VRAM
- **SearXNG** — not needed; web search already runs on Brave (keyless)

## Gotchas

- In `NODE_ENV=production` the SSRF guard blocks client-supplied localhost base
  URLs; local dev (`next dev`) skips the check, so run the app via `pnpm serve`
  (dev mode) or set `ALLOW_LOCAL_NETWORKS=true`.
- Qwen-Image-2512 at Q4_K_M on a 12 GB card takes ~5-6 min per image
  (sequential loading); Z-Image-Turbo is the fast tier (~30 s).
