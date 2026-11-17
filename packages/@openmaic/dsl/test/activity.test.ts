import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KINDS,
  SCENE_TYPES,
  isActivityContent,
  isActivityKind,
  isCodeActivityContent,
  isSqlActivityContent,
  isTerminalActivityContent,
  validateScene,
} from '@openmaic/dsl';

const codeActivity = {
  type: 'activity',
  kind: 'code',
  language: 'python',
  entryFile: 'main.py',
  instructions: 'Write `add(a, b)`.',
  files: [{ path: 'main.py', content: 'def add(a, b):\n    return a + b\n' }],
  tests: [{ id: 'basic', name: 'adds numbers', code: 'assert add(2, 3) == 5' }],
  checks: [{ id: 'tests', type: 'expectTests' }],
} as const;

function scene(content: unknown) {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    title: 'Code lab',
    order: 1,
    type: 'activity',
    content,
  };
}

describe('activity contract', () => {
  it('registers the activity scene and kind families', () => {
    expect(SCENE_TYPES).toContain('activity');
    expect(ACTIVITY_KINDS).toEqual(['code', 'sql', 'terminal']);
    expect(isActivityKind('code')).toBe(true);
    expect(isActivityKind('cyber')).toBe(false);
  });

  it('narrows each activity kind', () => {
    expect(isActivityContent(codeActivity)).toBe(true);
    expect(isCodeActivityContent(codeActivity)).toBe(true);
    expect(isSqlActivityContent(codeActivity)).toBe(false);
    expect(isTerminalActivityContent(codeActivity)).toBe(false);
  });

  it('accepts a well-formed code activity scene', () => {
    expect(validateScene(scene(codeActivity))).toEqual({ valid: true });
  });

  it('accepts a SQL activity with probe checks', () => {
    const sql = {
      type: 'activity',
      kind: 'sql',
      instructions: 'Return every learner older than 20.',
      setupSql:
        "create table learners (name text, age int); insert into learners values ('a', 21);",
      starterSql: 'select * from learners;',
      checks: [
        {
          id: 'rows',
          type: 'expectSqlRows',
          sql: 'select name from learners where age > 20 order by name;',
          expected: [['a']],
          ordered: true,
        },
      ],
    };
    expect(validateScene(scene(sql))).toEqual({ valid: true });
  });

  it('accepts a terminal activity with state and file checks', () => {
    const terminal = {
      type: 'activity',
      kind: 'terminal',
      instructions: 'Create notes.txt.',
      files: [{ path: 'README.txt', content: 'hi' }],
      checks: [
        { id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' },
        { id: 'file', type: 'expectFile', path: 'notes.txt', expected: 'done' },
      ],
    };
    expect(validateScene(scene(terminal))).toEqual({ valid: true });
    expect(validateScene(scene({ ...terminal, runtime: 'server' }))).toEqual({ valid: true });
    expect(validateScene(scene({ ...terminal, runtime: 'simulation' }))).toEqual({
      valid: true,
    });
  });

  it('rejects an unknown terminal runtime and a runtime on another kind', () => {
    const terminal = {
      type: 'activity',
      kind: 'terminal',
      instructions: 'x',
      files: [],
      checks: [{ id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' }],
    };
    const unknown = validateScene(scene({ ...terminal, runtime: 'container' }));
    expect(unknown.valid).toBe(false);
    if (!unknown.valid) {
      expect(unknown.errors.map((error) => error.path)).toContain('/content/runtime');
    }

    const codeRuntime = validateScene(scene({ ...codeActivity, runtime: 'server' }));
    expect(codeRuntime.valid).toBe(false);
  });

  it('rejects a code activity whose entry file is not in the workspace', () => {
    const result = validateScene(scene({ ...codeActivity, entryFile: 'missing.py' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.path)).toContain('/content/entryFile');
    }
  });

  it('rejects traversal and absolute paths', () => {
    for (const path of ['../escape.py', '/etc/passwd', 'a\\b.py', 'a//b.py']) {
      const result = validateScene(scene({ ...codeActivity, files: [{ path, content: '' }] }));
      expect(result.valid, path).toBe(false);
    }
  });

  it('rejects duplicate check ids and duplicate test ids', () => {
    const duplicateChecks = validateScene(
      scene({
        ...codeActivity,
        checks: [
          { id: 'same', type: 'expectTests' },
          { id: 'same', type: 'expectStdout', expected: 'ok' },
        ],
      }),
    );
    expect(duplicateChecks.valid).toBe(false);

    const duplicateTests = validateScene(
      scene({
        ...codeActivity,
        tests: [
          { id: 't', name: 'one', code: 'assert True' },
          { id: 't', name: 'two', code: 'assert True' },
        ],
      }),
    );
    expect(duplicateTests.valid).toBe(false);
  });

  it('rejects a check family that does not belong to the kind', () => {
    const result = validateScene(
      scene({
        ...codeActivity,
        checks: [
          {
            id: 'rows',
            type: 'expectSqlRows',
            sql: 'select 1',
            expected: [[1]],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.path)).toContain('/content/checks/0/type');
    }
  });

  it('rejects an activity with no checks', () => {
    const result = validateScene(scene({ ...codeActivity, checks: [] }));
    expect(result.valid).toBe(false);
  });

  it('rejects non-scalar expected SQL cells', () => {
    const result = validateScene(
      scene({
        type: 'activity',
        kind: 'sql',
        instructions: 'Query.',
        setupSql: '',
        starterSql: '',
        checks: [
          {
            id: 'rows',
            type: 'expectSqlRows',
            sql: 'select payload from t;',
            expected: [[{ a: 1 }]],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.path)).toContain('/content/checks/0/expected/0/0');
    }
  });

  it('tolerates unknown optional fields from older documents', () => {
    const result = validateScene(scene({ ...codeActivity, legacyNote: 'kept' }));
    expect(result).toEqual({ valid: true });
  });
});
