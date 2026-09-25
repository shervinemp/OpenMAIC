/**
 * Tests for the workflow default-picker: when no workflow is explicitly
 * selected, the image adapter must never auto-run a video workflow (and the
 * video adapter must never auto-run an image workflow).
 */
import { describe, it, expect } from 'vitest';
import { pickComfyuiWorkflowByOutput } from '@/lib/media/comfyui-workflows';

const IMAGE_WF = {
  filename: 'comfyui-z-image-turbo.json',
  workflow: {
    '1': { class_type: 'UnetLoaderGGUF' },
    '12': { class_type: 'SaveImage' },
  },
};

const VIDEO_WF = {
  filename: 'comfyui-minimax-h3.json',
  workflow: {
    '1': { class_type: 'MiniMaxH3ImageToVideo' },
    '16': { class_type: 'SaveVideo' },
  },
};

const IMAGE_WF_2 = {
  filename: 'comfyui-qwen-image-2512.json',
  workflow: {
    '1': { class_type: 'UnetLoaderGGUF' },
    '13': { class_type: 'SaveImage' },
  },
};

describe('pickComfyuiWorkflowByOutput', () => {
  it('prefers an image workflow over a video workflow for image generation', () => {
    // Video sorts first alphabetically — the OOM scenario: image generation
    // must NOT default into the video workflow.
    const picked = pickComfyuiWorkflowByOutput([VIDEO_WF, IMAGE_WF], 'image');
    expect(picked).toBe(IMAGE_WF.filename);
  });

  it('prefers a video workflow for video generation', () => {
    const picked = pickComfyuiWorkflowByOutput([IMAGE_WF, VIDEO_WF], 'video');
    expect(picked).toBe(VIDEO_WF.filename);
  });

  it('returns the first matching image workflow when several exist', () => {
    const picked = pickComfyuiWorkflowByOutput([VIDEO_WF, IMAGE_WF, IMAGE_WF_2], 'image');
    expect(picked).toBe(IMAGE_WF.filename);
  });

  it('returns undefined when nothing matches', () => {
    expect(pickComfyuiWorkflowByOutput([VIDEO_WF], 'image')).toBeUndefined();
    expect(pickComfyuiWorkflowByOutput([IMAGE_WF], 'video')).toBeUndefined();
  });

  it('ignores nodes without a class_type', () => {
    const malformed = {
      filename: 'comfyui-broken.json',
      workflow: { '1': { inputs: {} }, '2': { class_type: 'SaveImage' } },
    };
    const picked = pickComfyuiWorkflowByOutput([malformed], 'image');
    expect(picked).toBe(malformed.filename);
  });
});
