import { describe, expect, it } from 'vitest';
import { validateScene } from '@openmaic/dsl';
import type { AICallFn, SceneOutline } from '@openmaic/generation';
import { buildSceneFromOutline } from '@/lib/server/scene-generation';
import { validateAppScene } from '@/lib/document-store/validators';

const OUTLINE: SceneOutline = {
  id: 'activity-1',
  type: 'activity',
  title: 'Build the resolver',
  description: 'Return a registered instance or raise for an unknown key.',
  keyPoints: ['Return the instance', 'Reject unknown keys'],
  order: 1,
  activityConfig: { kind: 'code', language: 'python' },
};

const LAB = {
  instructions:
    'Implement `resolve(registry, key)`. Return the instance stored under `key`. When the key is missing, raise `KeyError`. Do not mutate the registry. For example, resolving an unknown key raises an error.',
  entryFile: 'main.py',
  files: [{ path: 'main.py', content: 'def resolve(registry, key):\n    return None\n' }],
  tests: [
    {
      id: 'finds',
      name: 'returns a registered instance',
      code: 'from main import resolve\nassert resolve({"db": 1}, "db") == 1',
    },
    {
      id: 'rejects',
      name: 'raises for an unknown key',
      code: 'from main import resolve\ntry:\n    resolve({}, "db")\nexcept KeyError:\n    pass\nelse:\n    raise AssertionError',
    },
  ],
  checks: [{ id: 'tests', type: 'expectTests' }],
  referenceFiles: [
    { path: 'main.py', content: 'def resolve(registry, key):\n    return registry[key]\n' },
  ],
};

describe('buildSceneFromOutline — activity', () => {
  it('builds a validated activity scene with no narration actions', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return JSON.stringify(LAB);
    };

    const scene = await buildSceneFromOutline(OUTLINE, aiCall, 'stage-1');
    expect(scene).not.toBeNull();
    expect(scene?.type).toBe('activity');
    expect(scene?.actions).toEqual([]);
    expect(scene?.content).toMatchObject({ type: 'activity', kind: 'code' });
    // Content only: the action stage is deterministic for a lab.
    expect(calls).toBe(1);
    expect(validateScene(scene)).toEqual({ valid: true });
    // The same scene passes the app's write-boundary validator.
    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  it('defaults a legacy outline without activityConfig to a Python code lab', async () => {
    const { activityConfig: _dropped, ...legacy } = OUTLINE;
    const scene = await buildSceneFromOutline(legacy, async () => JSON.stringify(LAB), 'stage-1');
    expect(scene?.content).toMatchObject({
      type: 'activity',
      kind: 'code',
      language: 'python',
    });
  });
});
