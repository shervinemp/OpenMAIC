import { describe, expect, it, vi } from 'vitest';
import { validateActivityContent } from '@openmaic/dsl';
import type { AICallFn, SceneOutline } from '@openmaic/generation';
import {
  generateSceneActions,
  generateSceneContent,
  takeSceneDepthReport,
  validateOutlineShape,
} from '@openmaic/generation';
import {
  CONTENT_ATTEMPTS,
  activityOutline,
  sqlActivityOutline,
  terminalActivityOutline,
  validActivityResponse,
  validSqlActivityResponse,
  validTerminalActivityResponse,
} from './scene-fixtures.js';

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

  it('accepts SQL and simulated terminal configs', () => {
    expect(validateOutlineShape(sqlActivityOutline())).toEqual([]);
    expect(validateOutlineShape(terminalActivityOutline())).toEqual([]);
    expect(
      validateOutlineShape({
        ...terminalActivityOutline(),
        activityConfig: { kind: 'terminal', runtime: 'simulation' },
      }),
    ).toEqual([]);
  });

  it('rejects a non-Python code lab and a server terminal lab', () => {
    expect(
      validateOutlineShape({
        ...activityOutline(),
        activityConfig: { kind: 'code', language: 'javascript' },
      }).join(' '),
    ).toContain('language must be python');
    expect(
      validateOutlineShape({
        ...terminalActivityOutline(),
        activityConfig: { kind: 'terminal', runtime: 'server' },
      }).join(' '),
    ).toContain('server terminal runtime');
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
    expect(system).toContain('Practice Lab Generator');
    expect(content).toMatchObject({
      type: 'activity',
      kind: 'code',
      language: 'python',
      entryFile: 'main.py',
      hints: ['Look the key up in the mapping.', 'Missing keys should raise KeyError.'],
      debrief: 'A registry lookup returns the registered instance or fails loudly.',
    });
    if (!content || !('kind' in content) || content.kind !== 'code') {
      throw new Error('expected code activity content');
    }
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

describe('generateSceneContent — SQL labs', () => {
  it('normalizes a SQL reply and uses the SQL prompt section', async () => {
    let system = '';
    const aiCall: AICallFn = async (systemPrompt) => {
      system = systemPrompt;
      return reply(validSqlActivityResponse());
    };

    const content = await generateSceneContent(sqlActivityOutline(), aiCall);
    expect(system).toContain('SQL lab runtime');
    expect(system).not.toContain('Code lab runtime');
    expect(system).not.toContain('Terminal lab runtime');
    expect(content).toMatchObject({
      type: 'activity',
      kind: 'sql',
      starterSql: 'select * from learners;',
    });
    if (!content || !('kind' in content) || content.kind !== 'sql') {
      throw new Error('expected SQL activity content');
    }
    expect(content.setupSql).toContain('create table learners');
    expect(content.referenceSql).toContain('create view adults');
    expect(content.checks[0]).toMatchObject({
      type: 'expectSqlRows',
      ordered: true,
      expected: [['Ada'], ['Linus']],
    });
    expect(validateActivityContent(content)).toEqual({ valid: true });
  });

  it('re-prompts a SQL lab that used the code check family', async () => {
    let calls = 0;
    let secondPrompt = '';
    const aiCall: AICallFn = async (_system, user) => {
      calls += 1;
      if (calls === 1) {
        return reply({
          ...validSqlActivityResponse(),
          checks: [{ id: 'tests', type: 'expectTests' }],
        });
      }
      secondPrompt = user;
      return reply(validSqlActivityResponse());
    };

    const content = await generateSceneContent(sqlActivityOutline(), aiCall);
    expect(calls).toBe(2);
    expect(secondPrompt).toContain('broke the lab contract');
    expect(secondPrompt).toContain('expectSqlRows');
    expect(content).toMatchObject({ type: 'activity', kind: 'sql' });
  });
});

describe('generateSceneContent — terminal labs', () => {
  it('normalizes a terminal reply and forces the simulation runtime', async () => {
    let system = '';
    const aiCall: AICallFn = async (systemPrompt) => {
      system = systemPrompt;
      // A model that copies a runtime field must not enable server isolation.
      return reply({ ...validTerminalActivityResponse(), runtime: 'server' });
    };

    const content = await generateSceneContent(terminalActivityOutline(), aiCall);
    expect(system).toContain('Terminal lab runtime');
    expect(system).not.toContain('SQL lab runtime');
    expect(content).toMatchObject({
      type: 'activity',
      kind: 'terminal',
      runtime: 'simulation',
      referenceCommands: ['echo done > notes.txt', 'pwd'],
    });
    if (!content || !('kind' in content) || content.kind !== 'terminal') {
      throw new Error('expected terminal activity content');
    }
    expect(content.checks.map((check) => check.type)).toEqual(['expectFile', 'expectState']);
    expect(validateActivityContent(content)).toEqual({ valid: true });
  });

  it('records a depth report when the reference commands are missing', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return reply({ ...validTerminalActivityResponse(), referenceCommands: [] });
    };

    const content = await generateSceneContent(terminalActivityOutline(), aiCall);
    expect(content).toBeNull();
    expect(calls).toBe(CONTENT_ATTEMPTS);
    expect(takeSceneDepthReport('activity-terminal-1')?.findings.join(' ')).toContain(
      'referenceCommands is empty',
    );
  });
});

describe('generateSceneActions — activity labs', () => {
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
