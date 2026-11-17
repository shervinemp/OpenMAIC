import { describe, expect, it } from 'vitest';
import {
  groupIdenticalMediaRequests,
  mediaPromptKey,
  normalizeMediaPrompt,
} from '@/lib/media/prompt-dedupe';
import type { MediaGenerationRequest } from '@/lib/media/types';

function request(overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest {
  return {
    type: 'image',
    prompt: 'A labelled diagram of the water cycle',
    elementId: 'gen_img_1',
    aspectRatio: '16:9',
    ...overrides,
  };
}

describe('media prompt deduplication', () => {
  it('normalizes case and whitespace but not different wording', () => {
    expect(normalizeMediaPrompt('  A   Water\nCycle ')).toBe('a water cycle');
    expect(normalizeMediaPrompt('A water cycle')).not.toBe(normalizeMediaPrompt('A water cycle.'));
  });

  it('groups requests that ask for the same bytes across different slots', () => {
    const groups = groupIdenticalMediaRequests([
      request({ elementId: 'gen_img_1' }),
      request({ elementId: 'gen_img_2', prompt: '  a LABELLED   diagram of the water cycle ' }),
      request({ elementId: 'gen_img_3', prompt: 'An unrelated photo' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.leader.elementId).toBe('gen_img_1');
    expect(groups[0]?.duplicates.map((entry) => entry.elementId)).toEqual(['gen_img_2']);
    expect(groups[1]?.leader.elementId).toBe('gen_img_3');
    expect(groups[1]?.duplicates).toEqual([]);
  });

  it('keeps requests whose output differs apart', () => {
    const groups = groupIdenticalMediaRequests([
      request(),
      request({ elementId: 'gen_img_wide', aspectRatio: '9:16' }),
      request({ elementId: 'gen_img_style', style: 'watercolor' }),
      request({ elementId: 'gen_vid_1', type: 'video' }),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.duplicates.length === 0)).toBe(true);
  });

  it('never merges requests with no prompt to compare', () => {
    const groups = groupIdenticalMediaRequests([
      request({ elementId: 'gen_img_blank_1', prompt: '   ' }),
      request({ elementId: 'gen_img_blank_2', prompt: '   ' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(mediaPromptKey(request({ prompt: '   ' }))).toBeNull();
  });

  it('is order-preserving: the first request of a group leads', () => {
    const groups = groupIdenticalMediaRequests([
      request({ elementId: 'gen_img_b', prompt: 'same' }),
      request({ elementId: 'gen_img_a', prompt: 'other' }),
      request({ elementId: 'gen_img_c', prompt: 'same' }),
    ]);
    expect(groups.map((group) => group.leader.elementId)).toEqual(['gen_img_b', 'gen_img_a']);
    expect(groups[0]?.duplicates.map((entry) => entry.elementId)).toEqual(['gen_img_c']);
  });

  it('distinguishes a prompt from the same prompt with a different style', () => {
    expect(mediaPromptKey(request())).not.toBe(mediaPromptKey(request({ style: 'sketch' })));
    expect(mediaPromptKey(request({ style: 'Sketch' }))).toBe(
      mediaPromptKey(request({ style: '  sketch ' })),
    );
  });
});
