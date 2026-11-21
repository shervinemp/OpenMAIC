import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The FastH3 workflow is data, but it is data the video adapter patches by
 * node title and that ComfyUI executes with a strict node contract. A typo in
 * a title or a stale model name silently breaks generation (or, with the old
 * Q4_0 model, crashes ComfyUI), so pin the contract here.
 */
const workflowPath = resolve(process.cwd(), 'public/comfyui-minimax-h3.json');
const workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;

function nodesByTitle(title: string) {
  return Object.values(workflow).filter((node) => node._meta?.title === title);
}

describe('comfyui-minimax-h3 workflow', () => {
  it('uses the lean 8-step FastH3 GGUF, never the crashing Q4_0 build', () => {
    const unet = Object.values(workflow).find((node) => node.class_type === 'UnetLoaderGGUF');
    expect(unet).toBeDefined();
    const model = unet!.inputs.unet_name;
    expect(model).toBe('fasth3_omniref_8step_pruned-Q3_K_M.gguf');
    expect(String(model)).not.toMatch(/Q4_0/);

    const sampler = nodesByTitle('KSampler')[0];
    expect(sampler?.class_type).toBe('KSampler');
    expect(sampler?.inputs.steps).toBe(8);
    expect(sampler?.inputs.cfg).toBe(1);
  });

  it('routes the model through the MiniMax H3 sigma-shift node', () => {
    const shift = Object.values(workflow).find((node) => node.class_type === 'MiniMaxH3SigmaShift');
    expect(shift).toBeDefined();
    expect(shift!.inputs.shift_video).toBe(12);
    expect(shift!.inputs.shift_audio).toBe(3);

    const sampler = nodesByTitle('KSampler')[0];
    // MODEL must come from the shift node, not straight from the UNET loader.
    expect(sampler!.inputs.model).toEqual([
      Object.keys(workflow).find((id) => workflow[id] === shift),
      0,
    ]);
  });

  it('exposes every node title the video adapter patches', () => {
    for (const title of ['Input Prompt', 'Width', 'Height', 'Duration', 'KSampler']) {
      expect(nodesByTitle(title).length, `missing node titled "${title}"`).toBe(1);
    }
  });

  it('stays a text-to-video workflow (no Load Image node)', () => {
    // The adapter throws if a Load Image node is present without an inputImage,
    // and course generation never supplies one.
    expect(Object.values(workflow).some((node) => node.class_type === 'LoadImage')).toBe(false);
  });

  it('loads the matching H3 text encoder and VAEs', () => {
    const clip = Object.values(workflow).find((node) => node.class_type === 'CLIPLoaderGGUF');
    expect(clip?.inputs.clip_name).toBe('Qwen3-VL-32B-Ultra-Heretic-H3-L0-49-IQ4_XS.gguf');
    expect(clip?.inputs.type).toBe('minimax');

    const vaes = Object.values(workflow)
      .filter((node) => node.class_type === 'VAELoader')
      .map((node) => node.inputs.vae_name);
    expect(vaes).toEqual(
      expect.arrayContaining([
        'minimax_h3_video_vae_fp16.safetensors',
        'minimax_h3_audio_vae_fp32.safetensors',
      ]),
    );
  });
});
