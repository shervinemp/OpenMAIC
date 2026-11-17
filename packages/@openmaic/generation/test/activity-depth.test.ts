import { describe, expect, it } from 'vitest';
import type { CodeActivityContent } from '@openmaic/dsl';
import { validateActivityDepth } from '@openmaic/generation';
import { activityOutline } from './scene-fixtures.js';

function lab(overrides: Partial<CodeActivityContent> = {}): CodeActivityContent {
  return {
    type: 'activity',
    kind: 'code',
    language: 'python',
    entryFile: 'main.py',
    instructions:
      'Implement `resolve(registry, key)`. Return the instance stored under `key`. When the key is missing, raise `KeyError`. Do not mutate the registry. For example, resolving an unknown key raises an error.',
    files: [{ path: 'main.py', content: 'def resolve(registry, key):\n    return None\n' }],
    tests: [
      {
        id: 'finds',
        name: 'finds',
        code: 'from main import resolve\nassert resolve({"a": 1}, "a") == 1',
      },
      {
        id: 'rejects',
        name: 'rejects',
        code: 'from main import resolve\ntry:\n    resolve({}, "a")\nexcept KeyError:\n    pass\nelse:\n    raise AssertionError',
      },
    ],
    checks: [{ id: 'tests', type: 'expectTests' }],
    referenceFiles: [
      { path: 'main.py', content: 'def resolve(registry, key):\n    return registry[key]\n' },
    ],
    ...overrides,
  };
}

function findings(content: CodeActivityContent): string {
  return validateActivityDepth(activityOutline(), content).findings.join('\n');
}

describe('validateActivityDepth', () => {
  it('accepts a runnable lab with visible tests, a tests check and a different reference', () => {
    expect(validateActivityDepth(activityOutline(), lab())).toMatchObject({
      adequate: true,
      depthValidated: true,
      findings: [],
    });
  });

  it('flags instructions that do not explain the task', () => {
    expect(findings(lab({ instructions: 'Write it.' }))).toContain(
      'explain the goal, the inputs and outputs, and the constraints',
    );
  });

  it('flags too few tests at the scene depth', () => {
    expect(findings(lab({ tests: [lab().tests[0]!] }))).toContain('need at least 2');
  });

  it('flags a lab whose tests are all hidden', () => {
    expect(
      findings(
        lab({
          tests: lab().tests.map((test) => ({ ...test, hidden: true })),
        }),
      ),
    ).toContain('keep at least one visible test');
  });

  it('flags placeholder and empty tests', () => {
    const text = findings(
      lab({
        tests: [
          { id: 'placeholder', name: 'p', code: 'assert True' },
          { id: 'empty', name: 'e', code: '   ' },
        ],
      }),
    );
    expect(text).toContain('placeholder');
    expect(text).toContain('has no code');
  });

  it('requires a tests check', () => {
    expect(
      findings(
        lab({
          checks: [{ id: 'out', type: 'expectStdout', expected: 'ok' }],
        }),
      ),
    ).toContain('no expectTests check');
  });

  it('flags a missing reference and an unchanged starter', () => {
    expect(findings(lab({ referenceFiles: [] }))).toContain(
      'referenceFiles does not provide the entry file',
    );

    const starter = lab().files[0]!.content;
    expect(findings(lab({ referenceFiles: [{ path: 'main.py', content: starter }] }))).toContain(
      'asks the learner to do nothing',
    );
  });

  it('flags a starter that embeds the reference solution', () => {
    const reference = 'def resolve(registry, key):\n    return registry[key]\n';
    expect(
      findings(
        lab({
          files: [{ path: 'main.py', content: `# TODO\n# ${reference}` }],
          referenceFiles: [{ path: 'main.py', content: reference }],
        }),
      ),
    ).toContain('embeds the reference solution');
  });

  it('flags empty output expectations and unchanged read-only inputs', () => {
    const text = findings(
      lab({
        files: [
          { path: 'main.py', content: 'def resolve(): pass\n' },
          { path: 'seed.txt', content: 'fixed', editable: false },
        ],
        checks: [
          { id: 'tests', type: 'expectTests' },
          { id: 'stdout', type: 'expectStdout', expected: '  ' },
          { id: 'seed', type: 'expectFile', path: 'seed.txt', expected: 'fixed' },
        ],
      }),
    );
    expect(text).toContain('expects empty text');
    expect(text).toContain('unchanged read-only input');
  });

  it('flags a tests check that names undeclared tests', () => {
    expect(
      findings(lab({ checks: [{ id: 'tests', type: 'expectTests', testIds: ['ghost'] }] })),
    ).toContain('names undeclared tests');
  });
});
