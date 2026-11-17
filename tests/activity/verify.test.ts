import { describe, expect, it } from 'vitest';
import type { CodeActivityContent, SqlActivityContent, SqlValue } from '@/lib/types/stage';
import type { ActivityRunner } from '@/lib/activity/code-runner';
import type { ActivityRunRequest, ActivityRunResult } from '@/lib/activity/protocol';
import {
  referenceWorkspaceFiles,
  verifyCodeActivity,
  verifySqlActivity,
  workspaceFiles,
} from '@/lib/activity/verify';

function activity(overrides: Partial<CodeActivityContent> = {}): CodeActivityContent {
  return {
    type: 'activity',
    kind: 'code',
    language: 'python',
    entryFile: 'main.py',
    instructions: 'Write add().',
    files: [
      { path: 'main.py', content: 'def add(a, b):\n    return 0\n' },
      { path: 'data.txt', content: 'keep me', editable: false },
    ],
    tests: [{ id: 'basic', name: 'adds', code: 'from main import add\nassert add(2, 3) == 5' }],
    checks: [{ id: 'tests', type: 'expectTests' }],
    referenceFiles: [{ path: 'main.py', content: 'def add(a, b):\n    return a + b\n' }],
    ...overrides,
  };
}

class FakeRunner implements ActivityRunner {
  readonly requests: ActivityRunRequest[] = [];
  constructor(private readonly respond: (request: ActivityRunRequest) => ActivityRunResult) {}

  run(request: ActivityRunRequest): Promise<ActivityRunResult> {
    this.requests.push(request);
    return Promise.resolve(this.respond(request));
  }

  dispose(): void {}
}

function result(overrides: Partial<ActivityRunResult> = {}): ActivityRunResult {
  return {
    status: 'ok',
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    ...overrides,
  };
}

const passTests = result({ tests: [{ id: 'basic', passed: true }] });
const failTests = result({
  tests: [{ id: 'basic', passed: false, message: 'AssertionError' }],
  exitCode: 0,
});

describe('workspaceFiles', () => {
  it('merges overrides without mutating either side', () => {
    const starter = [
      { path: 'a.py', content: 'a' },
      { path: 'b.py', content: 'b' },
    ];
    const reference = [
      { path: 'a.py', content: 'solved' },
      { path: 'c.py', content: 'c' },
    ];
    expect(workspaceFiles(starter, reference)).toEqual({
      'a.py': 'solved',
      'b.py': 'b',
      'c.py': 'c',
    });
    expect(starter[0].content).toBe('a');
  });
});

describe('referenceWorkspaceFiles', () => {
  it('returns null when the lab has no reference solution', () => {
    expect(referenceWorkspaceFiles(activity({ referenceFiles: undefined }))).toBeNull();
    expect(referenceWorkspaceFiles(activity({ referenceFiles: [] }))).toBeNull();
  });

  it('keeps starter files the reference does not replace', () => {
    expect(referenceWorkspaceFiles(activity())).toMatchObject({
      'main.py': 'def add(a, b):\n    return a + b\n',
      'data.txt': 'keep me',
    });
  });
});

describe('verifyCodeActivity', () => {
  it('passes when the reference passes every check and the starter fails one', async () => {
    const runner = new FakeRunner((request) =>
      request.files?.['main.py']?.includes('a + b') ? passTests : failTests,
    );
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.reference?.evaluation.passed).toBe(true);
    expect(report.starter?.evaluation.passed).toBe(false);
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1].files?.['main.py']).toContain('return 0');
    expect(runner.requests[1].files?.['data.txt']).toBe('keep me');
  });

  it('stops before the starter run when the reference fails', async () => {
    const runner = new FakeRunner(() => failTests);
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues[0]).toContain('failed');
    expect(report.starter).toBeUndefined();
    expect(runner.requests).toHaveLength(1);
  });

  it('reports a reference runner error as unverified', async () => {
    const runner = new FakeRunner(() => result({ status: 'error', error: 'engine failed' }));
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('engine failed');
  });

  it('reports a reference timeout as unverified', async () => {
    const runner = new FakeRunner(() => result({ status: 'timeout' }));
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('timed out');
  });

  it('rejects a lab whose starter already passes', async () => {
    const runner = new FakeRunner(() => passTests);
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('asks the learner to do nothing');
  });

  it('rejects a starter that only produces ungraded checks', async () => {
    const runner = new FakeRunner((request) =>
      request.files?.['main.py']?.includes('a + b')
        ? passTests
        : result({ tests: [{ id: 'other', passed: true }] }),
    );
    const report = await verifyCodeActivity(activity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('no definite failures');
  });

  it('refuses to verify a lab without a reference solution', async () => {
    const runner = new FakeRunner(() => passTests);
    const report = await verifyCodeActivity(activity({ referenceFiles: undefined }), runner);
    expect(report.ok).toBe(false);
    expect(report.issues[0]).toContain('no reference solution');
    expect(runner.requests).toHaveLength(0);
  });

  it('refuses a reference workspace that omits the entry file', async () => {
    const runner = new FakeRunner(() => failTests);
    const report = await verifyCodeActivity(
      activity({
        entryFile: 'solution.py',
        files: [{ path: 'main.py', content: '' }],
        referenceFiles: [{ path: 'main.py', content: 'x' }],
      }),
      runner,
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0]).toContain('entry file');
  });

  it('supports a reference-only check for a lab with no meaningful starter run', async () => {
    const runner = new FakeRunner(() => passTests);
    const report = await verifyCodeActivity(activity(), runner, { referenceOnly: true });
    expect(report.ok).toBe(true);
    expect(report.starter).toBeUndefined();
    expect(runner.requests).toHaveLength(1);
  });

  it('refuses a lab with no checks', async () => {
    const runner = new FakeRunner(() => passTests);
    const report = await verifyCodeActivity(activity({ checks: [] }), runner);
    expect(report.ok).toBe(false);
    expect(runner.requests).toHaveLength(0);
  });
});

function sqlActivity(overrides: Partial<SqlActivityContent> = {}): SqlActivityContent {
  return {
    type: 'activity',
    kind: 'sql',
    instructions: 'Create a view of adult learners.',
    setupSql:
      "create table learners (id int primary key, name text, age int); insert into learners values (1, 'Ada', 24), (2, 'Grace', 19);",
    starterSql: 'select * from learners;',
    checks: [
      {
        id: 'rows',
        type: 'expectSqlRows',
        sql: 'select name from adults order by name;',
        expected: [['Ada']],
        ordered: true,
      },
    ],
    referenceSql: 'create view adults as select name from learners where age >= 21;',
    ...overrides,
  };
}

function sqlRows(rows: SqlValue[][]): ActivityRunResult {
  return result({ sqlProbes: { rows: { columns: ['name'], rows } } });
}

describe('verifySqlActivity', () => {
  it('passes when the reference returns the expected rows and the starter does not', async () => {
    const runner = new FakeRunner((request) =>
      request.submissionSql?.includes('create view') ? sqlRows([['Ada']]) : sqlRows([]),
    );
    const report = await verifySqlActivity(sqlActivity(), runner);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.reference?.evaluation.passed).toBe(true);
    expect(report.starter?.evaluation.passed).toBe(false);
    expect(runner.requests).toHaveLength(2);
  });

  it('refuses a lab without reference SQL', async () => {
    const runner = new FakeRunner(() => sqlRows([['Ada']]));
    const report = await verifySqlActivity(sqlActivity({ referenceSql: undefined }), runner);
    expect(report.ok).toBe(false);
    expect(report.issues[0]).toContain('no reference SQL');
    expect(runner.requests).toHaveLength(0);
  });

  it('reports a reference probe error as unverified', async () => {
    const runner = new FakeRunner((request) =>
      request.submissionSql?.includes('create view')
        ? result({ sqlProbes: { rows: { error: 'relation "adults" does not exist' } } })
        : sqlRows([]),
    );
    const report = await verifySqlActivity(sqlActivity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('does not exist');
  });

  it('rejects a starter that already produces the expected rows', async () => {
    const runner = new FakeRunner(() => sqlRows([['Ada']]));
    const report = await verifySqlActivity(sqlActivity(), runner);
    expect(report.ok).toBe(false);
    expect(report.issues.join(' ')).toContain('asks the learner to do nothing');
  });

  it('supports a reference-only run', async () => {
    const runner = new FakeRunner(() => sqlRows([['Ada']]));
    const report = await verifySqlActivity(sqlActivity(), runner, { referenceOnly: true });
    expect(report.ok).toBe(true);
    expect(report.starter).toBeUndefined();
    expect(runner.requests).toHaveLength(1);
  });
});
