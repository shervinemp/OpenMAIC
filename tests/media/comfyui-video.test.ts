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

/** I2V workflow: a Load Image node (by title) plus a prompt/sampler. */
function makeI2VWorkflow() {
  return {
    ...makeWorkflow(),
    '4': { inputs: { image: 'placeholder.png' }, _meta: { title: 'Load Image' } },
  };
}

/** I2V workflow whose LoadImage node is discovered by class_type, not title. */
function makeUntitledI2VWorkflow() {
  return {
    ...makeWorkflow(),
    '4': { inputs: { image: 'placeholder.png' }, class_type: 'LoadImage' },
  };
}

/**
 * Fake ComfyUI REST server: /system_stats, /upload/image, /prompt,
 * /history/<id>, /view. Records the last queued workflow and the uploaded
 * image name so tests can assert what was patched.
 */
function stubComfy(history: () => unknown, viewBytes: Uint8Array = VIDEO_BYTES) {
  const calls: { promptBody?: unknown; uploadedImageName?: string; uploadCount: number } = {
    uploadCount: 0,
  };
  const jsonResponse = (value: unknown) =>
    ({ ok: true, json: async () => value }) as unknown as Response;
  const bytesResponse = (bytes: Uint8Array) =>
    ({ ok: true, arrayBuffer: async () => bytes.buffer }) as unknown as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return jsonResponse({});
      if (url.endsWith('/upload/image')) {
        calls.uploadCount += 1;
        const form = init?.body as FormData | undefined;
        const image = form?.get('image');
        if (image instanceof Blob) {
          calls.uploadedImageName = 'uploaded-' + image.size + '.png';
        }
        return jsonResponse({ name: calls.uploadedImageName ?? 'uploaded.png', subfolder: '', type: 'input' });
      }
      if (url.endsWith('/prompt')) {
        calls.promptBody = JSON.parse(String(init?.body));
        return jsonResponse({ prompt_id: 'prompt-1', number: 1, node_errors: {} });
      }
      if (url.includes('/history/')) {
        return jsonResponse({ 'prompt-1': history() });
      }
      if (url.includes('/view?')) {
        return bytesResponse(viewBytes);
      }
      if (url.startsWith('http://images.test/')) {
        return bytesResponse(viewBytes);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
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

  it('returns the native SaveVideo output (single video history key)', async () => {
    stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': {
          video: [{ filename: 'clip.mp4', subfolder: 'video/MiniMax_H3', type: 'output' }],
        },
      },
    }));

    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'a red fox leaping over a log',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
    });

    expect(result.url).toMatch(/^data:video\/mp4;base64,/);
    expect(result.poster).toBeUndefined();
  });

  it('returns the native SaveVideo output (recorded under history "images")', async () => {
    stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': {
          images: [{ filename: 'MiniMax_H3_00001_.mp4', subfolder: 'video', type: 'output' }],
        },
      },
    }));

    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'a red fox leaping over a log',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
    });

    expect(result.url).toMatch(/^data:video\/mp4;base64,/);
    expect(result.poster).toBeUndefined();
  });

  it('labels a GIF output with its own mime type rather than video/mp4', async () => {
    stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { gifs: [{ filename: 'clip.gif', subfolder: '', type: 'output' }] },
      },
    }));

    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'a galloping horse',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
    });

    expect(result.url).toMatch(/^data:image\/gif;base64,/);
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

  it('image-to-video: uploads the input image and patches the Load Image node', async () => {
    const calls = stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
      },
    }));

    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeI2VWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'the camera slowly zooms in',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      inputImage: `data:image/png;base64,${pngBase64}`,
    });

    expect(calls.uploadCount).toBe(1);
    expect(result.url).toMatch(/^data:video\/mp4;base64,/);
    // The uploaded filename must be wired into the LoadImage node's image input.
    const promptBody = calls.promptBody as {
      prompt: Record<string, { inputs: { image?: string } }>;
    };
    expect(promptBody.prompt['4'].inputs.image).toBe('uploaded-7.png');
    // Prompt, seed, and dims are patched as before.
    expect(promptBody.prompt['1'].inputs).toMatchObject({ value: 'the camera slowly zooms in' });
  });

  it('image-to-video: finds an untitled LoadImage node by class_type', async () => {
    const calls = stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
      },
    }));

    const pngBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeUntitledI2VWorkflow(),
    };
    await generateWithComfyuiVideo(config as never, {
      prompt: 'pan right across the scene',
      duration: 5,
      resolution: '480p',
      inputImage: `data:image/png;base64,${pngBase64}`,
    });

    const promptBody = calls.promptBody as {
      prompt: Record<string, { inputs: { image?: string } }>;
    };
    expect(promptBody.prompt['4'].inputs.image).toBe('uploaded-4.png');
  });

  it('image-to-video: accepts an http(s) input image URL', async () => {
    const calls = stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
      },
    }));

    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeI2VWorkflow(),
    };
    await generateWithComfyuiVideo(config as never, {
      prompt: 'birds scatter from the tree',
      duration: 5,
      resolution: '480p',
      inputImage: 'http://images.test/ref.png',
    });

    expect(calls.uploadCount).toBe(1);
    const promptBody = calls.promptBody as {
      prompt: Record<string, { inputs: { image?: string } }>;
    };
    // The filename is derived from the URL basename.
    expect(promptBody.prompt['4'].inputs.image).toBe('uploaded-6.png');
  });

  it('image-to-video: fails fast when a Load Image workflow gets no input image', async () => {
    stubComfy(() => ({}));
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeI2VWorkflow(),
    };
    await expect(
      generateWithComfyuiVideo(config as never, { prompt: 'x', duration: 5, resolution: '480p' }),
    ).rejects.toThrow(/input image/i);
  });

  it('image-to-video: ignores a supplied input image on a text-to-video workflow', async () => {
    const calls = stubComfy(() => ({
      status: { status_str: 'success', completed: true },
      outputs: {
        '3': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
      },
    }));

    const pngBase64 = Buffer.from([9, 9, 9]).toString('base64');
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeWorkflow(),
    };
    const result = await generateWithComfyuiVideo(config as never, {
      prompt: 'a waterfall at sunset',
      duration: 5,
      resolution: '480p',
      inputImage: `data:image/png;base64,${pngBase64}`,
    });

    expect(result.url).toMatch(/^data:video\/mp4;base64,/);
    // No Load Image node → the image is never uploaded.
    expect(calls.uploadCount).toBe(0);
  });

  it('rejects a non-base64 data URL input image before uploading', async () => {
    const calls = stubComfy(() => ({}));
    const config = {
      providerId: 'comfyui-video',
      apiKey: '',
      baseUrl: BASE,
      workflowJson: makeI2VWorkflow(),
    };
    await expect(
      generateWithComfyuiVideo(config as never, {
        prompt: 'x',
        duration: 5,
        resolution: '480p',
        inputImage: 'data:image/png,not-base64',
      }),
    ).rejects.toThrow(/base64/i);
    expect(calls.uploadCount).toBe(0);
  });
});
