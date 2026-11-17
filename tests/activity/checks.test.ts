import { describe, expect, it } from 'vitest';
import type {
  ActivityContent,
  CodeActivityContent,
  SqlActivityContent,
  TerminalActivityContent,
} from '@/lib/types/stage';
import {
  canonicalActivityText,
  evaluateActivityChecks,
  projectActivityForLearner,
  textMatches,
} from '@/lib/activity/checks';
import type { ActivityRunResult } from '@/lib/activity/protocol';

function report(overrides: Partial<ActivityRunResult> = {}): ActivityRunResult {
  return {
    status: 'ok',
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
    ...overrides,
  };
}

function codeActivity(checks: CodeActivityContent['checks']): CodeActivityContent {
  return {
    type: 'activity',
    kind: 'code',
    language: 'python',
    entryFile: 'main.py',
    instructions: 'Write add().',
    files: [{ path: 'main.py', content: 'def add(a, b): pass\n' }],
    tests: [
      { id: 'basic', name: 'adds numbers', code: 'assert add(2, 3) == 5' },
      { id: 'negative', name: 'adds negatives', code: 'assert add(-2, -3) == -5' },
    ],
    checks,
  };
}

describe('canonicalActivityText', () => {
  it('normalizes line endings and trailing whitespace without touching leading space', () => {
    expect(canonicalActivityText('a  \r\n  b\t\r\n\r\n')).toBe('a\n  b');
  });

  it('compares exact and contains on canonical text', () => {
    expect(textMatches('one\r\n two \n', 'one\n two')).toBe(true);
    expect(textMatches('prefix\nvalue\nsuffix', 'value', 'contains')).toBe(true);
    expect(textMatches('prefix\nvalue\nsuffix', 'value')).toBe(false);
  });
});

describe('evaluateActivityChecks — code', () => {
  it('passes a test check when every declared test passes', () => {
    const activity = codeActivity([{ id: 'tests', type: 'expectTests' }]);
    const result = evaluateActivityChecks(
      activity,
      report({
        tests: [
          { id: 'basic', passed: true },
          { id: 'negative', passed: true },
        ],
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.percent).toBe(100);
    expect(result.results[0]).toMatchObject({ status: 'passed', earned: 1, possible: 1 });
  });

  it('fails a test check and names the failing tests', () => {
    const activity = codeActivity([{ id: 'tests', type: 'expectTests' }]);
    const result = evaluateActivityChecks(
      activity,
      report({
        tests: [
          { id: 'basic', passed: true },
          { id: 'negative', passed: false, message: 'AssertionError' },
        ],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.results[0].status).toBe('failed');
    expect(result.results[0].message).toContain('adds negatives');
    expect(result.results[0].actual).toBe('AssertionError');
  });

  it('grades only the named subset of tests', () => {
    const activity = codeActivity([{ id: 'tests', type: 'expectTests', testIds: ['basic'] }]);
    const result = evaluateActivityChecks(
      activity,
      report({
        tests: [
          { id: 'basic', passed: true },
          { id: 'negative', passed: false },
        ],
      }),
    );
    expect(result.passed).toBe(true);
  });

  it('leaves the check ungraded when the runner omits a required test', () => {
    const activity = codeActivity([{ id: 'tests', type: 'expectTests' }]);
    const result = evaluateActivityChecks(
      activity,
      report({ tests: [{ id: 'basic', passed: true }] }),
    );
    expect(result.results[0].status).toBe('ungraded');
    expect(result.percent).toBeNull();
    expect(result.passed).toBe(false);
  });

  it('treats an undeclared test id as an authoring error, not a learner failure', () => {
    const activity = codeActivity([
      { id: 'tests', type: 'expectTests', testIds: ['does-not-exist'] },
    ]);
    const result = evaluateActivityChecks(
      activity,
      report({ tests: [{ id: 'does-not-exist', passed: false }] }),
    );
    expect(result.results[0].status).toBe('ungraded');
  });

  it('checks stdout with canonical comparison', () => {
    const activity = codeActivity([{ id: 'out', type: 'expectStdout', expected: 'hello\nworld' }]);
    const result = evaluateActivityChecks(activity, report({ stdout: 'hello\r\nworld  \r\n' }));
    expect(result.passed).toBe(true);
  });

  it('fails a stdout check with a real diff', () => {
    const activity = codeActivity([
      { id: 'out', type: 'expectStdout', expected: 'hello', mode: 'contains' },
    ]);
    const result = evaluateActivityChecks(activity, report({ stdout: 'goodbye' }));
    expect(result.results[0]).toMatchObject({
      status: 'failed',
      expected: 'hello',
      actual: 'goodbye',
    });
  });

  it('fails a missing file and passes matching content', () => {
    const activity = codeActivity([
      { id: 'out', type: 'expectFile', path: 'result.txt', expected: '42' },
    ]);
    expect(
      evaluateActivityChecks(activity, report({ files: { 'result.txt': '42\n' } })).passed,
    ).toBe(true);
    expect(evaluateActivityChecks(activity, report({ files: {} })).results[0].status).toBe(
      'failed',
    );
  });

  it('leaves file checks ungraded when the runner reports no file snapshot', () => {
    const activity = codeActivity([
      { id: 'out', type: 'expectFile', path: 'result.txt', expected: '42' },
    ]);
    const result = evaluateActivityChecks(activity, report());
    expect(result.results[0].status).toBe('ungraded');
  });

  it('never grades a runner failure or timeout against the learner', () => {
    const activity = codeActivity([
      { id: 'tests', type: 'expectTests' },
      { id: 'out', type: 'expectStdout', expected: 'ok' },
    ]);
    for (const status of ['error', 'timeout'] as const) {
      const result = evaluateActivityChecks(
        activity,
        report({ status, error: 'engine failed', tests: [{ id: 'basic', passed: false }] }),
      );
      expect(result.results.every((entry) => entry.status === 'ungraded')).toBe(true);
      expect(result.earned).toBe(0);
      expect(result.possible).toBe(0);
      expect(result.percent).toBeNull();
      expect(result.passed).toBe(false);
    }
  });

  it('excludes ungraded checks from the denominator and weights points', () => {
    const activity = codeActivity([
      { id: 'out', type: 'expectStdout', expected: 'ok', points: 3 },
      { id: 'file', type: 'expectFile', path: 'x', expected: 'y', points: 1 },
    ]);
    const result = evaluateActivityChecks(activity, report({ stdout: 'ok', files: {} }));
    expect(result.results[0].status).toBe('passed');
    expect(result.results[1].status).toBe('failed');
    expect(result.possible).toBe(4);
    expect(result.earned).toBe(3);
    expect(result.percent).toBe(75);
    expect(result.passed).toBe(false);
  });

  it('does not let an empty check list count as a pass', () => {
    const activity = codeActivity([]);
    const result = evaluateActivityChecks(activity, report());
    expect(result.passed).toBe(false);
    expect(result.percent).toBeNull();
  });
});

describe('evaluateActivityChecks — SQL', () => {
  function sqlActivity(checks: SqlActivityContent['checks']): SqlActivityContent {
    return {
      type: 'activity',
      kind: 'sql',
      instructions: 'Query.',
      setupSql: '',
      starterSql: '',
      checks,
    };
  }

  it('compares unordered rows as a multiset', () => {
    const activity = sqlActivity([
      {
        id: 'rows',
        type: 'expectSqlRows',
        sql: 'select name from t',
        expected: [
          ['a', 1],
          ['b', 2],
        ],
      },
    ]);
    const result = evaluateActivityChecks(
      activity,
      report({
        sqlProbes: {
          rows: {
            columns: ['name', 'n'],
            rows: [
              ['b', 2],
              ['a', '1'],
            ],
          },
        },
      }),
    );
    expect(result.passed).toBe(true);
  });

  it('requires row order when ordered is true', () => {
    const activity = sqlActivity([
      {
        id: 'rows',
        type: 'expectSqlRows',
        sql: 'select n from t order by n',
        expected: [[1], [2]],
        ordered: true,
      },
    ]);
    const result = evaluateActivityChecks(
      activity,
      report({ sqlProbes: { rows: { rows: [[2], [1]] } } }),
    );
    expect(result.results[0].status).toBe('failed');
    expect(result.results[0].message).toContain('Row 1');
  });

  it('fails rather than passing when a probe query errors', () => {
    const activity = sqlActivity([
      { id: 'rows', type: 'expectSqlRows', sql: 'select * from dropped', expected: [['x']] },
    ]);
    const result = evaluateActivityChecks(
      activity,
      report({ sqlProbes: { rows: { error: 'relation "dropped" does not exist' } } }),
    );
    expect(result.results[0].status).toBe('failed');
  });

  it('leaves a missing probe ungraded', () => {
    const activity = sqlActivity([
      { id: 'rows', type: 'expectSqlRows', sql: 'select 1', expected: [[1]] },
    ]);
    const result = evaluateActivityChecks(activity, report({ sqlProbes: {} }));
    expect(result.results[0].status).toBe('ungraded');
  });
});

describe('evaluateActivityChecks — terminal', () => {
  function terminalActivity(checks: TerminalActivityContent['checks']): TerminalActivityContent {
    return {
      type: 'activity',
      kind: 'terminal',
      instructions: 'Use the shell.',
      files: [],
      checks,
    };
  }

  it('checks session state and falls back to the file snapshot', () => {
    const activity = terminalActivity([
      { id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' },
      { id: 'file', type: 'expectState', path: 'file:notes.txt', expected: 'done' },
    ]);
    const result = evaluateActivityChecks(
      activity,
      report({ state: { cwd: '/home/learner' }, files: { 'notes.txt': 'done\n' } }),
    );
    expect(result.passed).toBe(true);
  });

  it('fails missing state when a snapshot exists, and is ungraded without one', () => {
    const activity = terminalActivity([
      { id: 'env', type: 'expectState', path: 'env.HOME', expected: '/home/learner' },
    ]);
    expect(evaluateActivityChecks(activity, report({ state: {} })).results[0].status).toBe(
      'failed',
    );
    expect(evaluateActivityChecks(activity, report()).results[0].status).toBe('ungraded');
  });
});

describe('projectActivityForLearner', () => {
  it('removes hidden tests and the reference solution from a code lab', () => {
    const activity: CodeActivityContent = {
      ...codeActivity([{ id: 'tests', type: 'expectTests' }]),
      tests: [
        { id: 'public', name: 'public', code: 'assert True' },
        { id: 'secret', name: 'secret', code: 'assert secret()', hidden: true },
      ],
      referenceFiles: [{ path: 'main.py', content: 'def add(a, b): return a + b\n' }],
    };
    const projected = projectActivityForLearner(activity);
    expect(projected.kind).toBe('code');
    if (projected.kind !== 'code') throw new Error('expected code');
    expect(projected.tests.map((test) => test.id)).toEqual(['public']);
    expect(projected.referenceFiles).toBeUndefined();
    // The stored activity is not mutated.
    expect(activity.referenceFiles).toHaveLength(1);
  });

  it('removes SQL and terminal references', () => {
    const sql: SqlActivityContent = {
      type: 'activity',
      kind: 'sql',
      instructions: 'x',
      setupSql: '',
      starterSql: '',
      checks: [],
      referenceSql: 'select 1',
    };
    expect(projectActivityForLearner(sql)).not.toHaveProperty('referenceSql');

    const terminal: TerminalActivityContent = {
      type: 'activity',
      kind: 'terminal',
      instructions: 'x',
      files: [{ path: 'a', content: 'b' }],
      checks: [],
      referenceCommands: ['cat a'],
    };
    expect(projectActivityForLearner(terminal)).not.toHaveProperty('referenceCommands');
  });
});

describe('evaluateActivityChecks accepts every activity kind', () => {
  it('narrows the union without casting at the call site', () => {
    const activity: ActivityContent = codeActivity([
      { id: 'out', type: 'expectStdout', expected: 'ok' },
    ]);
    expect(evaluateActivityChecks(activity, report({ stdout: 'ok' })).passed).toBe(true);
  });
});
