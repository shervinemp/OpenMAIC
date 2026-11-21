import { describe, expect, it, vi } from 'vitest';

import { buildOutlineAgreementDirective, withOutlineAgreement } from '../src/outline-contract.js';
import type { SceneOutline } from '../src/outline-types.js';

const outline = {
  id: 'scene_1',
  type: 'slide',
  title: 'Fresh water',
  description: 'Where fresh water is stored',
  keyPoints: ['Most water is saline', 'Liquid fresh water is under 1%'],
} as unknown as SceneOutline;

describe('outline agreement contract', () => {
  it('includes the outline claims in an authoritative system directive', () => {
    const directive = buildOutlineAgreementDirective(outline);
    expect(directive).toContain('Outline agreement (authoritative)');
    expect(directive).toContain('Where fresh water is stored');
    expect(directive).toContain('Liquid fresh water is under 1%');
    expect(directive).toContain('under 1%');
    expect(directive).toContain('about 1%');
  });

  it('wraps only the system prompt, leaving the user prompt and images untouched', async () => {
    const aiCall = vi.fn(
      async (_system: string, _user: string, _images?: unknown): Promise<string> => 'ok',
    );
    const wrapped = withOutlineAgreement(aiCall, outline);
    const images = [{ id: 'img_1', src: 'data:image/png;base64,AAAA' }];

    await wrapped('SYSTEM', 'USER', images);

    expect(aiCall).toHaveBeenCalledTimes(1);
    const [system, user, passedImages] = aiCall.mock.calls[0];
    expect(system).toContain('SYSTEM');
    expect(system).toContain('Outline agreement (authoritative)');
    expect(user).toBe('USER');
    expect(passedImages).toBe(images);
  });
});
