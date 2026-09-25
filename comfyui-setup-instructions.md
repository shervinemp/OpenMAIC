# ComfyUI Workflow Setup for OpenMAIC

## Where to store workflows

Place all workflow JSON files in your Next.js `public/` folder:

```
your-project/
  public/
    comfyui-workflow.json          → displays as "Workflow"
    comfyui-anime-style.json       → displays as "Anime Style"
    comfyui-line-art.json          → displays as "Line Art"
    comfyui-portrait.json          → displays as "Portrait"
```

### Naming convention
- Filenames **must** start with `comfyui-` or contain `workflow`
- Use hyphens to separate words — they become the display name in the UI
- The `comfyui-` prefix is stripped automatically
- Example: `comfyui-anime-style.json` → **"Anime Style"** in the dropdown

---

## Required nodes in your workflow

The adapter finds nodes **by their title** (the `_meta.title` field in the JSON).
To set a node's title in ComfyUI: right-click the node → **Title** → type the name.

### Required

| Node Title | Recommended Type | Purpose |
|------------|-----------------|---------|
| `Input Prompt` | `PrimitiveStringMultiline` | The image description from OpenMAIC is injected here |

### Recommended (automatically patched if present)

| Node Title | Recommended Type | Purpose |
|------------|-----------------|---------|
| `Width` | `PrimitiveInt` | Output width in pixels — set from the requested aspect ratio |
| `Height` | `PrimitiveInt` | Output height in pixels — set from the requested aspect ratio |
| `KSampler` | `KSampler` | Seed is randomised on every generation for varied outputs |
| `Enable prompt enhancement?` | `PrimitiveBoolean` | Set to `false` to skip LLM prompt enhancement (recommended for speed) |

### Fallback behaviour

If `Width` and `Height` nodes are **not found**, the adapter automatically falls
back to patching the `Empty Flux 2 Latent` node's `width` and `height` inputs
directly — so existing workflows without dedicated dimension nodes still work.

Both `Width` and `Height` must be present for the explicit node approach to
activate — if only one is found the adapter falls back to the latent node method
and logs a warning.

### Prompt node fallback

If `Input Prompt` is not found, the adapter falls back to a node titled
`String (Multiline - Prompt)` — so existing workflows still work without
renaming anything.

---

## Connecting the nodes

### Input Prompt
Connect the output of the `Input Prompt` node to wherever your prompt text
enters the pipeline — typically the `text` input of a `CLIPTextEncode` node,
or a `StringReplace` node if you use prompt templating.

### Width and Height
Connect the output of each node to the corresponding `width` and `height`
inputs of your `Empty Flux 2 Latent` (or equivalent empty latent) node.

Example wiring:
```
[Input Prompt] ──→ CLIPTextEncode (text)
[Width]        ──→ EmptyLatentImage (width)
[Height]       ──→ EmptyLatentImage (height)
```

---

## How to export in API format

The workflow JSON must be in **ComfyUI API format** (not the default save format).

1. In ComfyUI, go to **Settings** → enable **Dev Mode Options**
2. A new **Save (API Format)** button appears in the toolbar
3. Click **Save (API Format)** — this produces the correct JSON
4. Place the file in your `public/` folder

> ⚠️ The regular **Save** button produces a different format that will not work.

---

## Image-to-video (I2V) workflows

The **ComfyUI Video** provider also runs image-to-video workflows (e.g. Wan 2.2
I2V, CogVideoX I2V, HunyuanVideo I2V, LTX). There is no separate provider or
setting — I2V is triggered by two things working together:

1. The workflow includes a **`Load Image`** node (any `ComfyUI LoadImage` node;
   the title `Load Image` is preferred, but the adapter also finds it by
   `class_type` when untitled).
2. The caller passes an **input image** (base64 data URL or http(s) URL) to the
   video generation request.

### What happens at generation time

- The adapter uploads the source image to ComfyUI via `POST /upload/image`.
- The `Load Image` node's `image` input is set to the uploaded filename.
- The prompt, seed, and dimensions are patched exactly as for text-to-video.

### Fail-fast behaviour

- **Load Image node + no input image** → generation fails immediately with a
  clear error, so a stray I2V workflow can never run with a placeholder image.
- **Input image + no Load Image node** → the image is ignored (with a log
  warning) and the workflow runs as plain text-to-video.

### Constraints

- Input images must be **base64 data URLs** (`data:image/png;base64,...`) or
  **http(s) URLs**, and are capped at 20&nbsp;MB decoded.
- In production, remote (http) input image URLs are subject to the same SSRF
  guard as provider base URLs — `localhost`/private targets are refused unless
  `ALLOW_LOCAL_NETWORKS=true`.

---

## Settings in OpenMAIC

1. Go to **Settings → Image Generation**
2. Select **ComfyUI Image** as the provider
3. Set **Base URL** to your ComfyUI address (default `http://localhost:8188`)
4. Select your workflow from the **Workflows** list
5. Click **Test Connection** to verify ComfyUI is reachable

### Default workflow selection

If no workflow is explicitly selected — for example on the autonomous
classroom-media generation path, or before you've clicked a workflow in
Settings — the adapter falls back to the **first workflow file discovered in
`public/`** (alphabetically by display name). It does **not** rely on any
hard-coded filename, so you don't need a file called `comfyui-workflow.json`;
any single `comfyui-*.json` you ship will be used as the default. If `public/`
contains **no** workflow files at all, generation fails with a clear error
asking you to add one.

---

## Deployment topology (important for hosted/production)

The default Base URL `http://localhost:8188` assumes **OpenMAIC and ComfyUI run
on the same host** (the typical local / self-hosted setup).

When OpenMAIC runs with `NODE_ENV=production`, a **client-supplied** Base URL
(`x-base-url`) that points at `localhost`, `127.0.0.1`, or a private/internal IP
range is rejected with HTTP 403 by the SSRF guard (`validateUrlForSSRF`). This
is deliberate and matches the behaviour of the other local providers — it stops
a browser client from steering server-side requests at internal services.

Practical implications:

- **Same-host / self-hosted:** works out of the box. Server-resolved defaults
  are not subject to the client-URL SSRF check, so the `localhost:8188` default
  is fine when OpenMAIC and ComfyUI share a host.
- **ComfyUI on a different machine in production:** point OpenMAIC at ComfyUI
  over a **routable, non-private** address (or terminate it behind a reverse
  proxy on a public hostname). A `localhost`/private URL sent from the browser
  in production will be refused.
- **Local development** (`NODE_ENV` ≠ `production`): the SSRF check is skipped,
  so `localhost` works normally.

---

## Performance tips

- **Disable prompt enhancement** — if your workflow has an LLM-based prompt
  enhancer, set its enable node to `false`. Enhancement can add 3–5 minutes
  per image. The prompts generated by OpenMAIC are already descriptive enough.
- The adapter randomises the KSampler seed on every generation automatically.
- Output dimensions are calculated from the aspect ratio requested by OpenMAIC
  and capped at the `maxResolution` set in `image-providers.ts` (default `1920×1920`).
