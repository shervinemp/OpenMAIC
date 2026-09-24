#!/usr/bin/env node
/**
 * Content-blind batch image generation harness.
 *
 * Reads a prompts file (one prompt per line), pipes each line through one or
 * more ComfyUI workflow JSONs, and saves paired outputs to a directory.
 *
 * LOGGING CONTRACT: this script never prints prompt text or image content.
 * Progress lines carry only line numbers, variant labels, timings, and
 * filenames. Error messages are scrubbed of the prompt string before display.
 *
 * Usage:
 *   node scripts/censorship-bench.mjs \
 *     --prompts path/to/prompts.txt \
 *     --out     path/to/output-dir \
 *     --variants public/comfyui-qwen-image-21-uc.json,path/to/other-workflow.json \
 *     [--seed 424242] [--base http://127.0.0.1:8188] [--timeout 900]
 *     [--width W --height H] [--cfg N] [--negative TEXT]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const promptsPath = arg('prompts');
const outDir = arg('out');
const variantsArg = arg('variants');
const base = arg('base', 'http://127.0.0.1:8188');
const seedBase = Number(arg('seed', '424242'));
const timeoutMs = Number(arg('timeout', '900')) * 1000;
const width = arg('width') ? Number(arg('width')) : undefined;
const height = arg('height') ? Number(arg('height')) : undefined;
const cfg = arg('cfg') ? Number(arg('cfg')) : undefined;
const negative = arg('negative');

if (!promptsPath || !outDir || !variantsArg) {
  console.error(
    'usage: censorship-bench.mjs --prompts FILE --out DIR --variants a.json,b.json [--seed N] [--base URL] [--timeout S] [--width W --height H] [--cfg N] [--negative TEXT]',
  );
  process.exit(2);
}

const raw = readFileSync(resolve(promptsPath), 'utf8');
const prompts = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

const variantFiles = variantsArg
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const variants = variantFiles.map((file) => ({
  label: basename(file)
    .replace(/^comfyui[-_]?/i, '')
    .replace(/\.json$/i, ''),
  template: JSON.parse(readFileSync(resolve(file), 'utf8')),
}));

mkdirSync(resolve(outDir), { recursive: true });

const scrub = (msg, prompt) => (typeof msg === 'string' ? msg.split(prompt).join('[prompt]') : msg);

async function queueAndWait(workflow, timeoutMs) {
  const clientId = randomUUID();
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, stage: 'queue', detail: `HTTP ${res.status} ${body.slice(0, 300)}` };
  }
  const { prompt_id } = await res.json();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const hres = await fetch(`${base}/history/${prompt_id}`);
    if (!hres.ok) continue;
    const history = await hres.json();
    const entry = history[prompt_id];
    if (!entry) continue;
    const status = entry.status ?? {};
    if (status.status_str === 'error') {
      const detail = (status.messages ?? [])
        .filter((m) => Array.isArray(m) && m[1]?.exception_type)
        .map((m) => `${m[1].exception_type}: ${m[1].exception_message}`)
        .join(' | ');
      return {
        ok: false,
        stage: 'exec',
        detail: detail || 'execution error',
        outputs: entry.outputs ?? {},
      };
    }
    if (status.completed) return { ok: true, outputs: entry.outputs ?? {} };
  }
  return { ok: false, stage: 'timeout', detail: `no completion within ${timeoutMs / 1000}s` };
}

function patchWorkflow(template, prompt, seed) {
  const wf = structuredClone(template);
  let promptPatched = false;
  let seedPatched = false;
  for (const node of Object.values(wf)) {
    const title = node?._meta?.title;
    if (!node?.inputs) continue;
    if (title === 'Input Prompt' || title === 'String (Multiline - Prompt)') {
      node.inputs.value = prompt;
      promptPatched = true;
    }
    if (title === 'Width' && width !== undefined) node.inputs.value = width;
    if (title === 'Height' && height !== undefined) node.inputs.value = height;
    if (node.class_type === 'TextEncodeQwenImage21') {
      // Keep the encoder's resolution hint in sync with the latent size —
      // a stale 1024 hint at larger canvases conditions text wrong.
      if (width !== undefined && height !== undefined) {
        node.inputs.resolution = Math.min(width, height);
      }
      if (negative !== undefined) node.inputs.negative_prompt = negative;
    }
    if (node.class_type === 'KSampler') {
      if (typeof node.inputs.seed === 'number') {
        node.inputs.seed = seed;
        seedPatched = true;
      }
      if (cfg !== undefined) node.inputs.cfg = cfg;
    }
  }
  return { wf, promptPatched, seedPatched };
}

async function saveOutputs(outputs, outDir, lineNo, label) {
  const saved = [];
  for (const nodeOutput of Object.values(outputs)) {
    for (const img of nodeOutput.images ?? []) {
      const url =
        `${base}/view?filename=${encodeURIComponent(img.filename)}` +
        `&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${encodeURIComponent(img.type)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `line-${String(lineNo).padStart(3, '0')}--${label}.png`;
      writeFileSync(join(outDir, name), buf);
      saved.push(name);
    }
  }
  return saved;
}

const summary = { total: prompts.length * variants.length, ok: 0, failed: 0 };

for (let li = 0; li < prompts.length; li += 1) {
  const prompt = prompts[li];
  const lineNo = li + 1;
  for (const variant of variants) {
    const label = variant.label;
    const tag = `[${String(lineNo).padStart(2, '0')}/${prompts.length}] ${label}`;
    const started = Date.now();
    const { wf, promptPatched } = patchWorkflow(variant.template, prompt, seedBase + lineNo);
    if (!promptPatched) {
      console.log(`${tag} ERROR no-prompt-node`);
      summary.failed += 1;
      continue;
    }
    try {
      const result = await queueAndWait(wf, timeoutMs);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (result.ok) {
        const files = await saveOutputs(result.outputs, outDir, lineNo, label);
        summary.ok += 1;
        console.log(`${tag} ok ${secs}s -> ${files.join(',') || 'no-images'}`);
      } else {
        summary.failed += 1;
        console.log(`${tag} FAIL(${result.stage}) ${scrub(result.detail, prompt)}`);
      }
    } catch (err) {
      summary.failed += 1;
      console.log(`${tag} FAIL(net) ${scrub(err?.message ?? String(err), prompt)}`);
    }
  }
}

console.log(
  `done: ${summary.ok}/${summary.total} ok, ${summary.failed} failed -> ${resolve(outDir)}`,
);
process.exit(summary.failed > 0 ? 1 : 0);
