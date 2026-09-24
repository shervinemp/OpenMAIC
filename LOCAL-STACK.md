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
| Image | ComfyUI Image | `http://localhost:8188` | Workflow: `comfyui-qwen-image-21-uc.json` (UC Q8_0 — the only 2.1 variant; benchmarked winner over unsloth/z-image/2512) |
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

- `unet/`: `qwen-image-2.1-UC-Q8_0.gguf` (uncensored — benchmarked winner;
  the unsloth Q8_0 twin was deleted), `minimax_h3_fl2va_pruned_fp8_Q4_0.gguf`
- `text_encoders/`: `qwen3vl_8b_int8_convrot.safetensors` (Qwen-Image-2.1 —
  Qwen3-VL-8B int8, the official-template TE; Q4 GGUF caused bad text and was
  deleted), H3 Qwen3-VL-32B files
- `vae/`: `qwen_image_2.1_vae_bf16.safetensors` (2.1), `ae.safetensors`, H3 VAEs

**Removed (2026-09-22, ~51 GB reclaimed total):** `qwen-image-2512-Q5_K_S.gguf`,
`z-image-turbo-Q8_0.gguf`, `Z-Image-AbliteratedV1.Q8_0.gguf`,
`Qwen2.5-VL-7B-Instruct-Q5_K_M.gguf`, `qwen_image_vae.safetensors`,
`Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf`, all three 2.1 denoisers except the
UC Q8_0 (both Q5_K_M + unsloth Q8_0), and the 2512/z-image/unsloth workflow
JSONs — replaced by the single UC Q8_0 workflow above.
Benchmark verdict: UC > unsloth (quality, incl. text); int8 TE + 40 steps
fixed the text-rendering failures the Q4 TE caused (exact spelling on signs,
menus, prices, CJK; only unprompted filler copy still fails at 1024²).

**ComfyUI fork note:** `custom_nodes/ComfyUI-GGUF` (Nif00 lineage) needs
`qwen_image21` + `minimax_h3` in `IMG_ARCH_LIST` (`loader.py`) and the
`QwenImage21` template in `tools/convert.py:detect_arch` (ported from
leejet's f912d5e/cee9bb1) — the runtime loader calls `detect_arch` for
sd.cpp-format GGUFs. ComfyUI core ≥ 2026-09-22 master required for
`TextEncodeQwenImage21` (`pip install comfy-kitchen==0.2.35 comfy-aimdo==0.5.5 av>=17`
after updating).

## Out of scope (deliberately)

- **ASR / STT** — left for later; nothing here depends on it and it would
  compete with ComfyUI for VRAM
- **SearXNG** — not needed; web search already runs on Brave (keyless)

## Gotchas

- In `NODE_ENV=production` the SSRF guard blocks client-supplied localhost base
  URLs; local dev (`next dev`) skips the check, so run the app via `pnpm serve`
  (dev mode) or set `ALLOW_LOCAL_NETWORKS=true`.
- Qwen-Image-2.1 at Q8_0 + int8 TE + 40 steps on a 12 GB card: ~56-61 s per
  image (1024², cfg 1, euler/simple — official template settings; Q5/25-step
  tier was ~40-45 s). Still ~6× faster than the old 2512 setup (~5-6 min).
  Benchmark harness: `node scripts/censorship-bench.mjs --prompts FILE --out DIR
  --variants a.json,b.json` (content-blind: logs line numbers only).
