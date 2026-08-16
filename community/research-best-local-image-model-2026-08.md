# Best Local (Self-Hosted, Consumer-GPU) Text-to-Image Model — August 2026

**Date:** 2026-08-07 (verdict revised after a follow-up sweep of the 2026 release landscape)
**Scope:** Read-only research from primary sources (Hugging Face model cards, BFL/Stability/Qwen/Tongyi-MAI/Krea/Ideogram announcements, HF model API). For OpenMAIC: commercial product, slide/teaching images, 8–16 GB VRAM (ideally ≤12 GB), ComfyUI (localhost:8188) and Lemonade/sd-cpp GGUF (localhost:13305), Apache-2.0 preferred.

---

## Verdict (one paragraph, revised 2026-08-07)

**Best pick: Z-Image-Turbo** (Tongyi-MAI / Alibaba, 2025-11-25) — Apache-2.0, 6B params, 8-step distilled, sub-second-to-seconds generation, strong bilingual (EN/ZH) text rendering, fits ~16 GB unquantized and well under 12 GB as GGUF. It is the only candidate that combines a clean commercial license, genuinely good text-in-image rendering, practical speed on consumer GPUs, and a ready-made local-stack ecosystem (ComfyUI single-file repo with 5.1M downloads, 67 quantizations incl. sd-cpp/GGUF). **Quality tier for text-heavy deliverables: Qwen-Image-2512** (Apache-2.0, 20B, best-in-class complex text/layout — its card showcases full PPT-slide generation — but minutes per image on 12 GB at Q4/Q5 GGUF). **2026's two headline open releases do NOT fit OpenMAIC:** Ideogram 4 (9.3B, the best open-weight text rendering per third-party ContraLabs/Design Arena evals, beating Qwen-Image, FLUX.2-dev and Nano Banana 2) is **non-commercial licensed**; Krea 2 Turbo (13B, 8-step, top-trending as of Aug 2026) uses the Krea 2 Community License (commercial with content-filter deployment obligations, gated) and has no ComfyUI support yet. **Fastest Apache-2.0 fallback: FLUX.2-klein-4B** (~6–8 GB FP8/GGUF, sub-second, but explicitly weak text rendering).

---

## 2026 release sweep (added 2026-08-07 — supersedes parts of the original report)

The original report under-sampled 2026 releases. A live sweep of the HF model API (trending + downloads, text-to-image) found the following:

- **Z-Image-Turbo** (Tongyi-MAI, 2025-11-25) — the missing candidate that reshapes the verdict. Apache-2.0, 6B, 8 NFE, guidance 0. Card: "sub-second inference latency on enterprise-grade H800 GPUs and fits comfortably within 16G VRAM consumer devices"; showcase category is "Accurate Bilingual Text Rendering" (EN + ZH). 1.06M downloads/month, 803 adapters, 67 quantizations. ComfyUI: `Comfy-Org/z_image_turbo` single-file (5.1M downloads). GGUF: `unsloth/Z-Image-Turbo-GGUF`, `jayn7/Z-Image-Turbo-GGUF`, `BlackStone-Yu/Z-Image-Turbo-GGUF`. Base Z-Image (50-step, CFG) and Z-Image-Edit (editing) are also Apache-2.0.
- **Ideogram 4** (ideogram-ai, released 2026-06-03) — Ideogram's first open-weight model. 9.3B params, nf4/fp8 quants, native up to 2048px, structured-JSON prompting. **License: Ideogram 4 Non-Commercial** (HF tag `ideogram-4-non-commercial`, gated) → **disqualified for OpenMAIC**. Quality evidence is unusually strong and third-party: ContraLabs blind typography eval (10 pro designers) — Ideogram 4 first-place win rate 47.9% vs Nano Banana 2 (30.0%), FLUX.2 max (15.5%), Grok Imagine 1.0 (15.0%); Design Arena top-ranked open-weight model. No ComfyUI support yet; custom `ideogram4` codebase + diffusers.
- **Krea 2 / Krea 2 Turbo** (krea, released 2026-06-22) — 12–13B DiT, Turbo = 8-step distilled; top-2 trending T2I model on HF in Aug 2026. **License: Krea 2 Community License** (gated; commercial use allowed but deployers *must* implement content filtering per the card) → usable but with obligations, and not Apache. 26 quantizations exist; no ComfyUI support mentioned; custom `Krea2Pipeline` + SGLang. Watch-list: verify license PDF and integration before adopting.
- **nvidia/Qwen-Image-Flash** (2026-07-01) — few-step (DMD2) distillation of Qwen-Image; license tag `other` (unverified terms) → watch only.
- **FLUX.2-klein-9B** ecosystem matured (GGUF/abliterated finetunes trending), but the 9B stays under the FLUX Non-Commercial License → still disqualified.

### Revised candidate ranking for OpenMAIC (commercial, 12 GB, ComfyUI + sd-cpp)

| Rank | Model | License | Size | Steps | Text rendering | Fit |
|---|---|---|---|---|---|---|
| 1 | **Z-Image-Turbo** | Apache-2.0 | 6B | 8 | Strong (EN/ZH) | Default pick: fast, ComfyUI + GGUF ready, 12 GB friendly |
| 2 | **Qwen-Image-2512** | Apache-2.0 | 20B | 50 | Best-in-class complex text/layout | Text-heavy slides, slower |
| 3 | **FLUX.2-klein-4B** | Apache-2.0 | 4B | 4 | Weak (card warns of distortion) | Fastest, text-free illustrations |
| — | Ideogram 4 | Non-commercial | 9.3B | — | Best overall (3rd-party evals) | **Excluded** (license) |
| — | Krea 2 Turbo | Community (gated) | 13B | 8 | Likely strong (unverified) | Watch: license PDF + no ComfyUI yet |

---

## How the landscape looked in August 2026 (verified)

Everything below was verified against primary sources on 2026-08-07:

- **FLUX.2 family (BFL)** — announced 2025-11-25 ([bfl.ai/blog/flux-2](https://bfl.ai/blog/flux-2)). Open-weight members: FLUX.2-dev (32B, non-commercial), FLUX.2-klein-9B (non-commercial), FLUX.2-klein-4B (Apache-2.0). **There is no FLUX.2-schnell** — the klein family replaced that role.
- **FLUX 3 (BFL, 2026)** — a multimodal video/audio/image/action model, **API-only**. Per the official FAQ: "FLUX 3 Image, FLUX 3 Action, and the FLUX 3 Dev open-weight backbone are separate parts of the rollout… open-weight access to the FLUX 3 Dev multimodal backbone is coming soon." Not a local option yet. FLUX.2 Max is likewise an API tier.
- **FLUX.1.1** — FLUX.1.1 [pro] was API-only at launch and never received open weights; a Hugging Face API search for `black-forest-labs flux.1.1` returns no repos. Superseded by FLUX.2.
- **Stable Diffusion 4.x — does not exist.** Stability AI's image-models page ([stability.ai/stable-image](https://stability.ai/stable-image)) still markets **SD 3.5 Large / Turbo / Medium** as "our most powerful image model yet," and their news feed (through May 2026) shows only SD 3.5 NIM (Aug 2025), TensorRT optimization (Jun 2025), and audio/video models. No SD4 or SD 3.5 successor was announced.
- **Qwen-Image updates** — base T2I releases are Qwen-Image (2025-08-04) and **Qwen-Image-2512 (2025-12-31)**. There is **no Qwen-Image-2509 base model**; "2509" was the *edit* model Qwen-Image-Edit-2509 (2025-09-22). Also in the family: Qwen-Image-Edit-2511 (editing), Qwen-Image-Layered (layer decomposition, 2025-12-19).
- **Others:** Tencent HunyuanImage-2.1/3.0 exist (Sept 2025) under Tencent's own license (not Apache). ByteDance Seedream 4.0 (2025) is distributed under the non-commercial BytePlus license and is gated. Google's "Nano Banana" (Gemini 2.5 Flash Image) has weights under Google's license, not Apache, and is not a standard local-diffusion model. None beat the two picks above for this use case.

---

## Candidate 1: Qwen-Image-2512 — BEST PICK

**Source:** [huggingface.co/Qwen/Qwen-Image-2512](https://huggingface.co/Qwen/Qwen-Image-2512) (model card, verified 2026-08-07)

| Attribute | Value (as stated by the source) |
|---|---|
| Developer | Alibaba Qwen |
| Released | 2025-12-31 |
| License | **Apache-2.0** (card: "Qwen-Image is licensed under Apache 2.0"; HF license tag `apache-2.0`) |
| Size | 20B params, bf16 |
| Text rendering | Headline feature; card demos full **PPT slides, infographics, educational posters** with legible Chinese + English text and layouts |
| Aspect ratios | 7 documented: 1:1 (1328²), **16:9 (1664×928)**, 9:16, 4:3, 3:4, 3:2, 2:3 |
| Sampling | 50 steps, true_cfg_scale 4.0, negative prompt supported |
| First-party benchmark | "10,000+ rounds of blind evaluations on AI Arena… Qwen-Image-2512 is currently the strongest open-source model—while remaining highly competitive even among closed-source models" (Qwen's own claim) |
| GGUF / sd-cpp | Yes — `unsloth/Qwen-Image-2512-GGUF` (76k downloads), `Civitai/Qwen-Image-2512-GGUF` (tagged `stable-diffusion.cpp`), `byteshape/Qwen-Image-2512-GGUF` |
| ComfyUI | Native (same architecture as Qwen-Image; Comfy-Org single-file repo `Comfy-Org/Qwen-Image_ComfyUI`, 1.49M downloads, Apache-2.0) |
| VRAM at usable res | 20B bf16 ≈ 40 GB+; **Q4/Q5 GGUF ≈ 11–14 GB**; with sd-cpp text-encoder offload it runs on 12 GB (same profile as the Qwen-Image GGUF OpenMAIC already runs) |

**Strengths:** best-in-class text-in-image rendering of any local model — this is the one thing that matters most for slides; Apache-2.0 with no revenue caps; proven GGUF path already in OpenMAIC's Lemonade/sd-cpp pipeline; strong prompt adherence and image understanding per Qwen's AI Arena eval.
**Weaknesses:** 20B is heavy — at Q4/Q5 on a 12 GB GPU generation is slow (minutes, not seconds); text rendering degrades noticeably at low quant levels; Qwen's arena claim is first-party (not independently audited).

**Predecessor:** Qwen-Image (2025-08-04) — same license, same size, slightly weaker realism/text; 191k downloads/month. Use 2512.

---

## Candidate 2: FLUX.2-klein-4B — RUNNER-UP & CHEAPEST-VRAM PICK

**Sources:** [huggingface.co/black-forest-labs/FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) (model card) + [bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence) (2026-01-15)

| Attribute | Value (as stated by the source) |
|---|---|
| Developer | Black Forest Labs |
| Released | 2026-01-15 |
| License | **Apache-2.0** ("Open weights available for commercial use under the Apache 2.0 license"; HF tag `apache-2.0`) |
| Size | 4B params (rectified flow transformer + Qwen3 text embedder), step-distilled to 4 steps |
| Text rendering | **Explicitly weak** — card limitations: "While the model can output text, text rendered may be inaccurate or subject to distortion" |
| Aspect ratios | Flexible I/O ratios; ~1MP default (FLUX.2 family edits up to 4MP per BFL's FLUX.2 post) |
| Speed | "End-to-end inference as low as under a second" (BFL) |
| First-party benchmark | BFL: "FLUX.2 [klein] matches or exceeds Qwen's quality at a fraction of the latency and VRAM, and outperforms Z-Image" (Elo vs latency/VRAM charts, measured on GB200) |
| GGUF / sd-cpp | Yes — `unsloth/FLUX.2-klein-4B-GGUF` (157k downloads), `leejet/FLUX.2-klein-4B-GGUF` (tagged `stable-diffusion.cpp`) |
| ComfyUI | Yes — card: "available in both ComfyUI and Diffusers" |
| VRAM at usable res | **~13 GB in bf16** (card: "fits in ~13GB VRAM… RTX 3090/4070 and above"); official FP8 (−40% VRAM, ~8 GB) and NVFP4 (−55%, ~6 GB) quants from BFL/NVIDIA; GGUF Q4 lower still |

**Strengths:** fully commercial license at 4B; fits the OpenMAIC 12 GB target even in bf16 territory and comfortably in FP8/GGUF; sub-second generation (great for iterating slide illustrations); unified T2I + image-editing + multi-reference in one model; official NVIDIA FP8/NVFP4 quants; ComfyUI-native and sd-cpp GGUF.
**Weaknesses:** text rendering is the weakest of the serious candidates — do not use it when the image itself must contain legible words, captions, or diagrams with labels; 4B quality below Qwen-Image-2512 for complex layouts; BFL's "matches Qwen" chart is first-party on a GB200.

**Same-family, disqualified:** FLUX.2-klein-9B — same speed, higher quality, but **FLUX Non-Commercial License** (~29 GB VRAM in bf16). FLUX.2-klein-base-4B — undistilled, Apache-2.0, for fine-tuning.

---

## Candidate 3: FLUX.1-schnell — Apache-2.0, fast, but weak text (legacy-but-viable)

**Source:** [huggingface.co/black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)

- 12B rectified flow transformer, **Apache-2.0** ("the model can be used for personal, scientific, and commercial purposes"), 1–4 steps, guidance 0, 256-token max sequence.
- 210k downloads/month — still the de-facto open-weights fast model; huge GGUF ecosystem (38 quantizations listed); ComfyUI-supported.
- Known weak point is text rendering; 12B in GGUF Q4 ≈ 8–10 GB, so it fits 12 GB comfortably.
- Today it is largely superseded by FLUX.2-klein-4B (same license, better quality/latency). Keep as a low-VRAM speed fallback.

---

## Candidate 4: Stable Diffusion 3.5 Large / Medium — viable but license-capped

**Sources:** [huggingface.co/stabilityai/stable-diffusion-3.5-large](https://huggingface.co/stabilityai/stable-diffusion-3.5-large), [huggingface.co/stabilityai/stable-diffusion-3.5-medium](https://huggingface.co/stabilityai/stable-diffusion-3.5-medium), [stability.ai/stable-image](https://stability.ai/stable-image)

- License: **Stability Community License** — free for research, non-commercial, and *commercial use for organizations/individuals with < $1M total annual revenue*; above that you must buy an Enterprise license. **Not Apache-2.0.**
- Large: 8B, 1MP target, strong prompt adherence and typography for its class; Medium: 2.5B MMDiT-X, explicitly "designed to run on consumer hardware" (roughly 4–6 GB with FP8 T5 / NF4 — the true lowest-VRAM text-to-image model with decent typography).
- ComfyUI is Stability's own recommended runtime; GGUF/diffusers quant paths exist.
- **No successor as of Aug 2026** (SD4 unannounced; SD 3.5 still marketed as flagship; TensorRT/NIM optimizations landed in 2025).
- Verdict: acceptable only while OpenMAIC's revenue stays under $1M, and its text rendering trails Qwen-Image-2512. The Medium variant is the cheapest-VRAM fallback if the 4B klein's ~6–8 GB is still too much.

---

## Candidates verified but disqualified for commercial use

| Model | Status | Why not for OpenMAIC |
|---|---|---|
| **FLUX.2-dev** (32B) | Real; 941k downloads/mo; "state of the art in open text-to-image… infographics with complex typography" (BFL) | **FLUX Non-Commercial License** (card: "release of the open-weight FLUX.2 [dev] model under a non-commercial license"); ~29 GB+ VRAM even in 4-bit with remote text encoder |
| **FLUX.2-klein-9B** | Real; ~29 GB bf16 | **FLUX Non-Commercial License** |
| **FLUX.1-dev** (12B) | Real; 512k downloads/mo | **FLUX.1-dev Non-Commercial License** (card: license tag `flux-1-dev-non-commercial-license`) |
| **FLUX 3** | Real, 2026; image+video+audio+action | **API-only**; open-weight backbone "coming soon" — not local |
| **FLUX.1.1 [pro]** | API-only, no weights ever (HF API returns no BFL repos) | Not local |
| **Tencent HunyuanImage 2.1 / 3.0** | Real (Sept 2025); 3.0 is MoE; GGUF + ComfyUI exist | HF license tag `other` (Tencent Hunyuan Community License); model card gated so exact commercial terms could not be verified — Apache-2.0 preference rules it out |
| **Seedream 4.0 (ByteDance)** | Real (2025) | Non-commercial BytePlus license |
| **SD 3.5 Large/Turbo** | Real | Community license caps commercial use at < $1M revenue |
| **SD 4.x / SD 3.5 successor** | **Does not exist** | Unannounced as of Aug 2026 |

---

## Implications for OpenMAIC

1. **Make Z-Image-Turbo the default local model.** Apache-2.0, 6B, 8-step — seconds per image on a 12 GB card, strong bilingual text rendering, and both target runtimes are covered today: ComfyUI single-file (`Comfy-Org/z_image_turbo`) for ComfyUI workflows and GGUF (`unsloth/Z-Image-Turbo-GGUF` or `jayn7/Z-Image-Turbo-GGUF`) for the Lemonade/sd-cpp path. This supersedes the original FLUX.2-klein-4B speed-tier pick: same license family, better text, bigger ecosystem.
2. **Keep Qwen-Image-2512 (GGUF) as the quality tier for text-heavy slides** — complex layouts, labeled diagrams, title cards. Same sd-cpp path as the Qwen-Image GGUF OpenMAIC already runs; accept minutes-per-image on 12 GB.
3. **Do not adopt Ideogram 4** — it is the best open text-rendering model by third-party evals, but the license is non-commercial.
4. **Watch list:** Krea 2 Turbo (verify the Community License PDF's commercial terms and content-filter obligations; needs ComfyUI/sd-cpp support before it's usable here); FLUX 3 Dev open-weight backbone ("coming soon"); any Qwen 2026 T2I update (the 2512 roadmap shows monthly releases; as of the Aug 7 sweep the latest base is still 2512); `nvidia/Qwen-Image-Flash` license clarification.
5. **VRAM budget on the 12 GB card:** Z-Image-Turbo Q4/Q5 GGUF ≈ 6–8 GB (comfortable); Qwen-Image-2512 Q4_K_M/Q5_K_M + text-encoder offload ≈ 11–13 GB (tight); klein-4B FP8 ≈ 6–8 GB.

---

## Source list (all fetched 2026-08-07)

- https://huggingface.co/Tongyi-MAI/Z-Image-Turbo — model card, Apache-2.0, 6B, 8-step, bilingual text rendering, 16 GB VRAM
- https://huggingface.co/api/models?author=Qwen&search=image — Qwen org inventory (latest T2I base is still 2512)
- https://huggingface.co/api/models?pipeline_tag=text-to-image&sort=downloads — top-downloaded T2I (Z-Image-Turbo at 1.06M/mo)
- https://huggingface.co/api/models?pipeline_tag=text-to-image&sort=trendingScore — Aug 2026 trending (Krea-2, Ideogram 4, Z-Image)
- https://huggingface.co/api/models?search=Z-Image — Z-Image ecosystem (Comfy-Org single-file 5.1M dl, unsloth/jayn7 GGUF, 67 quants)
- https://huggingface.co/ideogram-ai/ideogram-4-nf4 — Ideogram 4 card: 9.3B, nf4/fp8, non-commercial license, ContraLabs/Design Arena third-party evals
- https://huggingface.co/krea/Krea-2-Turbo — Krea 2 card: 13B, 8-step, Krea 2 Community License (gated, content-filter obligations)
- https://huggingface.co/Qwen/Qwen-Image-2512 — model card, license, aspect ratios, AI Arena claim, PPT-slide showcases
- https://huggingface.co/Qwen/Qwen-Image — base model, Apache-2.0, news (2025-08-04)
- https://huggingface.co/black-forest-labs/FLUX.2-klein-4B — model card, Apache-2.0, 13 GB VRAM, text-rendering limitation
- https://huggingface.co/black-forest-labs/FLUX.2-dev — model card, FLUX NCL, 32B, gated
- https://bfl.ai/blog/flux-2 — FLUX.2 announcement, family + licensing (2025-11-25)
- https://huggingface.co/black-forest-labs/FLUX.1-dev / FLUX.1-schnell — model cards and licenses
- https://stability.ai/stable-image — SD 3.5 still flagship; no SD4
- https://huggingface.co/stabilityai/stable-diffusion-3.5-large / -medium — licenses, VRAM guidance

*Note: AI Arena / ContraLabs / Design Arena / BFL benchmark claims are vendor- or arena-reported; the ContraLabs typography eval (blind, pro-designer panel) is the strongest independent signal. Treat all as directional.*
