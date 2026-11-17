import { describe, expect, it } from 'vitest';
import type {
  CodeActivityContent,
  SqlActivityContent,
  TerminalActivityContent,
} from '@/lib/types/stage';
import {
  DEFAULT_ACTIVITY_TIME_LIMIT_MS,
  MAX_ACTIVITY_TIME_LIMIT_MS,
  buildActivityRunRequest,
  clampTimeLimitMs,
} from '@/lib/activity/protocol';

const code: CodeActivityContent = {
  type: 'activity',
  kind: 'code',
  language: 'python',
  entryFile: 'main.py',
  instructions: 'x',
  files: [{ path: 'main.py', content: '' }],
  tests: [{ id: 't', name: 't', code: 'assert True' }],
  checks: [{ id: 'tests', type: 'expectTests' }],
  timeLimitSec: 5,
};

const sql: SqlActivityContent = {
  type: 'activity',
  kind: 'sql',
  instructions: 'x',
  setupSql: 'create table t (n int);',
  starterSql: '',
  checks: [
    { id: 'a', type: 'expectSqlRows', sql: 'select 1', expected: [[1]] },
    { id: 'b', type: 'expectSqlRows', sql: 'select 2', expected: [[2]] },
  ],
};

const terminal: TerminalActivityContent = {
  type: 'activity',
  kind: 'terminal',
  instructions: 'x',
  files: [
    { path: 'readme.txt', content: 'hi' },
    { path: 'dir/file.txt', content: 'nested' },
  ],
  checks: [{ id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' }],
};

describe('buildActivityRunRequest', () => {
  it('builds a code request with the submitted workspace and tests', () => {
    const request = buildActivityRunRequest(code, {
      kind: 'code',
      files: { 'main.py': 'print(1)' },
    });
    expect(request).toMatchObject({
      kind: 'code',
      timeLimitMs: 5000,
      files: { 'main.py': 'print(1)' },
      entryFile: 'main.py',
    });
    expect(request?.tests).toHaveLength(1);
  });

  it('builds a SQL request with one probe per check', () => {
    const request = buildActivityRunRequest(sql, { kind: 'sql', sql: 'select 1;' });
    expect(request).toMatchObject({
      kind: 'sql',
      setupSql: 'create table t (n int);',
      submissionSql: 'select 1;',
      sqlProbes: [
        { id: 'a', sql: 'select 1' },
        { id: 'b', sql: 'select 2' },
      ],
    });
  });

  it('builds a terminal request from the initial files and command transcript', () => {
    const request = buildActivityRunRequest(terminal, { kind: 'terminal', commands: ['pwd'] });
    expect(request).toMatchObject({
      kind: 'terminal',
      commands: ['pwd'],
      initialFiles: { 'readme.txt': 'hi', 'dir/file.txt': 'nested' },
    });
  });

  it('refuses a submission that belongs to another activity kind', () => {
    expect(buildActivityRunRequest(code, { kind: 'sql', sql: 'select 1' })).toBeNull();
    expect(buildActivityRunRequest(sql, { kind: 'code', files: {} })).toBeNull();
    expect(buildActivityRunRequest(terminal, { kind: 'sql', sql: 'select 1' })).toBeNull();
  });
});

describe('clampTimeLimitMs', () => {
  it('defaults when absent or invalid, and clamps to the hard ceiling', () => {
    expect(clampTimeLimitMs(undefined)).toBe(DEFAULT_ACTIVITY_TIME_LIMIT_MS);
    expect(clampTimeLimitMs(Number.NaN)).toBe(DEFAULT_ACTIVITY_TIME_LIMIT_MS);
    expect(clampTimeLimitMs(0)).toBe(DEFAULT_ACTIVITY_TIME_LIMIT_MS);
    expect(clampTimeLimitMs(0.1)).toBe(1000);
    expect(clampTimeLimitMs(10_000)).toBe(MAX_ACTIVITY_TIME_LIMIT_MS);
  });
});
