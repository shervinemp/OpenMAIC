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

  it('builds a validated SQL lab scene', async () => {
    const outline: SceneOutline = {
      ...OUTLINE,
      id: 'activity-sql',
      title: 'Build the adults view',
      activityConfig: { kind: 'sql' },
    };
    const lab = {
      instructions:
        'Create a view named `adults` that returns the name of every learner aged 21 or older. The `learners` table is seeded before your script runs. Your script may create a view or a table. The probe reads `adults` ordered by name. For example, Ada (24) and Linus (31) appear; Grace (19) does not.',
      setupSql:
        "create table learners (id int primary key, name text, age int);\ninsert into learners values (1, 'Ada', 24), (2, 'Grace', 19), (3, 'Linus', 31);",
      starterSql: 'select * from learners;',
      checks: [
        {
          id: 'rows',
          type: 'expectSqlRows',
          sql: 'select name from adults order by name;',
          expected: [['Ada'], ['Linus']],
          ordered: true,
        },
      ],
      referenceSql:
        'create view adults as select name from learners where age >= 21 order by name;',
    };

    const scene = await buildSceneFromOutline(outline, async () => JSON.stringify(lab), 'stage-1');
    expect(scene).not.toBeNull();
    expect(scene?.type).toBe('activity');
    expect(scene?.content).toMatchObject({ type: 'activity', kind: 'sql' });
    expect(scene?.actions).toEqual([]);
    expect(validateScene(scene)).toEqual({ valid: true });
    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  it('builds a validated simulated terminal lab scene', async () => {
    const outline: SceneOutline = {
      ...OUTLINE,
      id: 'activity-terminal',
      title: 'Write a note in the shell',
      activityConfig: { kind: 'terminal' },
    };
    const lab = {
      instructions:
        'Create a file named `notes.txt` in your home directory whose content contains the word `done`. Then print the current working directory. The session starts in `/home/learner`. You can use output redirection with `echo`, and `pwd` prints the current directory. For example, `echo done > notes.txt` writes the file.',
      files: [{ path: 'README.txt', content: 'Workspace notes.\n', editable: false }],
      checks: [
        { id: 'file', type: 'expectFile', path: 'notes.txt', expected: 'done', mode: 'contains' },
        { id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' },
      ],
      referenceCommands: ['echo done > notes.txt', 'pwd'],
    };

    const scene = await buildSceneFromOutline(outline, async () => JSON.stringify(lab), 'stage-1');
    expect(scene).not.toBeNull();
    expect(scene?.type).toBe('activity');
    expect(scene?.content).toMatchObject({
      type: 'activity',
      kind: 'terminal',
      runtime: 'simulation',
    });
    expect(scene?.actions).toEqual([]);
    expect(validateScene(scene)).toEqual({ valid: true });
    expect(validateAppScene(scene)).toEqual({ valid: true });
  });
});
