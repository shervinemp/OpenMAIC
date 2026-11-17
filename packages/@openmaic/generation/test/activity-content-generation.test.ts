import { describe, expect, it, vi } from 'vitest';
import { validateActivityContent } from '@openmaic/dsl';
import type { AICallFn, SceneOutline } from '@openmaic/generation';
import {
  generateSceneActions,
  generateSceneContent,
  takeSceneDepthReport,
  validateOutlineShape,
} from '@openmaic/generation';
import { CONTENT_ATTEMPTS, activityOutline, validActivityResponse } from './scene-fixtures.js';

function reply(payload: unknown): string {
  return JSON.stringify(payload);
}

function lab(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...validActivityResponse(), ...overrides };
}

describe('activity outline contract', () => {
  it('requires activityConfig on an activity outline', () => {
    const outline: SceneOutline = { ...activityOutline(), activityConfig: undefined };
    expect(validateOutlineShape(outline)).toEqual([
      expect.stringContaining('missing activityConfig'),
    ]);
    expect(validateOutlineShape(activityOutline())).toEqual([]);
  });
});

describe('generateSceneContent — code labs', () => {
  it('normalizes a model reply into validated activity content', async () => {
    let system = '';
    const aiCall: AICallFn = async (systemPrompt) => {
      system = systemPrompt;
      return reply(validActivityResponse());
    };

    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(system).toContain('Code Lab Generator');
    expect(content).toMatchObject({
      type: 'activity',
      kind: 'code',
      language: 'python',
      entryFile: 'main.py',
      hints: ['Look the key up in the mapping.', 'Missing keys should raise KeyError.'],
      debrief: 'A registry lookup returns the registered instance or fails loudly.',
    });
    if (!content || !('type' in content)) {
      throw new Error('expected code activity content');
    }
    expect(content.kind).toBe('code');
    expect(content.tests.map((test) => test.id)).toEqual(['finds', 'rejects']);
    expect(content.checks).toEqual([{ id: 'tests', type: 'expectTests', label: 'All tests pass' }]);
    expect(content.referenceFiles?.[0]?.content).toContain('registry[key]');
    expect(validateActivityContent(content)).toEqual({ valid: true });
  });

  it('accepts a single-object wrapper around the lab payload', async () => {
    const aiCall: AICallFn = async () => reply({ activity: validActivityResponse() });
    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(content).toMatchObject({ type: 'activity', kind: 'code', entryFile: 'main.py' });
  });

  it('clamps the time limit and drops empty hints', async () => {
    const aiCall: AICallFn = async () =>
      reply(lab({ timeLimitSec: 900, hints: ['  ', 'Try the registry.'] }));
    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(content).toMatchObject({ timeLimitSec: 120, hints: ['Try the registry.'] });
  });

  it('re-prompts when the entry file is missing from the workspace', async () => {
    let calls = 0;
    let secondPrompt = '';
    const aiCall: AICallFn = async (_system, user) => {
      calls += 1;
      if (calls === 1) return reply(lab({ entryFile: 'solution.py' }));
      secondPrompt = user;
      return reply(validActivityResponse());
    };

    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(calls).toBe(2);
    expect(secondPrompt).toContain('broke the lab contract');
    expect(secondPrompt).toContain('entryFile');
    expect(content).toMatchObject({ type: 'activity' });
  });

  it('re-prompts when the reply is not JSON, then accepts a valid object', async () => {
    let calls = 0;
    let secondPrompt = '';
    const aiCall: AICallFn = async (_system, user) => {
      calls += 1;
      if (calls === 1) return 'Sure! Here is the lab you asked for.';
      secondPrompt = user;
      return reply(validActivityResponse());
    };

    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(calls).toBe(2);
    expect(secondPrompt).toContain('could not be parsed as one JSON object');
    expect(content).toMatchObject({ type: 'activity' });
  });

  it('re-prompts when the starter already equals the reference', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return reply(
        lab({
          files: [
            { path: 'main.py', content: 'def resolve(registry, key):\n    return registry[key]\n' },
          ],
        }),
      );
    };

    const content = await generateSceneContent(activityOutline(), aiCall);
    expect(calls).toBe(CONTENT_ATTEMPTS);
    expect(content).toBeNull();
    expect(takeSceneDepthReport('activity-1')?.findings.join(' ')).toContain(
      'asks the learner to do nothing',
    );
  });

  it('rejects an activity that asks for an unsupported runtime without calling the model', async () => {
    const aiCall = vi.fn<AICallFn>(async () => reply(validActivityResponse()));
    const onFailure = vi.fn();
    const content = await generateSceneContent(
      {
        ...activityOutline(),
        activityConfig: { kind: 'code', language: 'javascript' },
      },
      aiCall,
      { onFailure },
    );

    expect(content).toBeNull();
    expect(aiCall).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith({ code: 'invalid-model-output' });
  });

  it('never ships a lab that stays structurally invalid', async () => {
    const aiCall: AICallFn = async () => reply(lab({ tests: [] }));
    const onFailure = vi.fn();
    const content = await generateSceneContent(activityOutline(), aiCall, { onFailure });
    expect(content).toBeNull();
    expect(onFailure).toHaveBeenCalledWith({ code: 'invalid-model-output' });
  });
});

describe('generateSceneActions — code labs', () => {
  it('returns no narration actions for a lab', async () => {
    const content = await generateSceneContent(activityOutline(), async () =>
      reply(validActivityResponse()),
    );
    if (!content) throw new Error('expected content');

    const actions = await generateSceneActions(
      activityOutline(),
      content,
      vi.fn<AICallFn>(async () => '[]'),
    );
    expect(actions).toEqual([]);
  });
});
