import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateVideo,
  normalizeVideoOptions,
  testVideoConnectivity,
  VIDEO_PROVIDERS,
} from '@/lib/media/video-providers';
import { generateWithComfyuiVideo } from '@/lib/media/adapters/comfyui-video-adapter';

const BASE = 'http://comfyui.test:8188';
const VIDEO_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);

/** Minimal API-format workflow with the node titles the adapter patches. */
function makeWorkflow() {
  return {
    '1': { inputs: { value: '' }, _meta: { title: 'Input Prompt' } },
    '2': { inputs: { noise_seed: 0 }, _meta: { title: 'KSampler' } },
    '3': { inputs: {}, _meta: { title: 'Save Video' } },
  };
}

/** Fake ComfyUI REST server: /system_stats, /prompt, /history/<id>, /view. */
function stubComfy(history: () => unknown, viewBytes: Uint8Array = VIDEO_BYTES) {
  const jsonResponse = (value: unknown) =>
    ({ ok: true, json: async () => value }) as unknown as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return jsonResponse({});
      if (url.endsWith('/prompt')) {
        return jsonResponse({ prompt_id: 'prompt-1', number: 1, node_errors: {} });
      }
      if (url.includes('/history/')) {
        return jsonResponse({ 'prompt-1': history() });
      }
      if (url.includes('/view?')) {
        return { ok: true, arrayBuffer: async () => viewBytes.buffer } as unknown as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ComfyUI video provider registry', () => {
  it('registers a keyless local provider', () => {
    const comfy = VIDEO_PROVIDERS['comfyui-video'];
    expect(comfy).toBeDefined();
    expect(comfy.requiresApiKey).toBe(false);
    expect(comfy.defaultBaseUrl).toBe('http://localhost:8188');
    expect(comfy.supportedResolutions).toEqual(['480p', '720p']);
    // Workflow files act as models; the list stays empty until public/ is scanned.
    expect(comfy.models).toEqual([]);
  });

  it('clamps options to the provider capabilities', () => {
    const unset = normalizeVideoOptions('comfyui-video', {
      prompt: 'x',
      aspectRatio: '16:9',
    });
    expect(unset.resolution).toBe('480p');
    expect(unset.duration).toBe(5);

    const over = normalizeVideoOptions('comfyui-video', {
      prompt: 'x',
      resolution: '1080p',
      duration: 30,
    });
    expect(over.resolution).toBe('480p');
    expect(over.duration).toBe(5);
  });

  it('routes connectivity through the ComfyUI probe', async () => {
    stubComfy(() => ({}));
    const result = await testVideoConnectivity({
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
    });
    expect(result.success).toBe(true);
  });
});

describe('ComfyUI video adapter generation', () => {
  it('submits, polls, and returns a base64 data URL plus poster', async () => {
    stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { gifs: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
        '2': { images: [{ filename: 'poster.jpg', subfolder: '', type: 'output' }] },
      },
    }));

    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'a wave rolls onto the beach',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
    });

    expect(result.url).toMatch(/^data:video\/mp4;base64,/);
    expect(result.poster).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.duration).toBe(5);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('fails loudly when the workflow has no prompt node', async () => {
    stubComfy(() => ({}));
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: { '3': { inputs: {}, _meta: { title: 'Save Video' } } },
    };
    await expect(generateWithComfyuiVideo(config as never, { prompt: 'x' })).rejects.toThrow(
      /prompt input node/i,
    );
  });

  it('rejects an unsafe workflow identifier before contacting ComfyUI', async () => {
    stubComfy(() => ({}));
    await expect(
      generateVideo(
        { providerId: 'comfyui-video', apiKey: '', baseUrl: BASE, model: '../../etc/x.json' },
        { prompt: 'x' },
      ),
    ).rejects.toThrow(/not a valid workflow filename/i);
  });
});
