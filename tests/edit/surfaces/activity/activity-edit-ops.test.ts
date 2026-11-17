import { describe, expect, it } from 'vitest';
import type { ActivityContent, CodeActivityContent } from '@/lib/types/stage';
import {
  addActivityCheck,
  addActivityFile,
  addActivityHint,
  addActivityReferenceFile,
  addActivityTest,
  createActivityEditHistory,
  moveActivityTest,
  removeActivityCheck,
  removeActivityFile,
  removeActivityHint,
  removeActivityReferenceFile,
  removeActivityTest,
  setActivityHints,
  updateActivityBasics,
  updateActivityCheck,
  updateActivityFile,
  updateActivityHint,
  updateActivityReferenceFile,
  updateActivityTest,
  commitActivityContent,
  redoActivity,
  undoActivity,
} from '@/components/edit/surfaces/activity/activity-edit-ops';

function activity(overrides: Partial<CodeActivityContent> = {}): CodeActivityContent {
  return {
    type: 'activity',
    kind: 'code',
    language: 'python',
    entryFile: 'main.py',
    instructions: 'Write add().',
    files: [{ path: 'main.py', content: 'def add(a, b): pass\n' }],
    tests: [{ id: 't1', name: 'basic', code: 'assert add(2, 3) == 5' }],
    checks: [{ id: 'c1', type: 'expectTests' }],
    ...overrides,
  };
}

describe('activity history', () => {
  it('commits, undoes and redoes content snapshots', () => {
    const initial = activity();
    const history = createActivityEditHistory(initial);
    const next = updateActivityBasics(initial, { instructions: 'Changed' });
    const committed = commitActivityContent(history, next);
    expect(committed.present).toBe(next);
    expect(committed.past).toEqual([initial]);
    const undone = undoActivity(committed);
    expect(undone.present).toBe(initial);
    const redone = redoActivity(undone);
    expect(redone.present).toBe(next);
  });

  it('drops a no-op commit', () => {
    const initial = activity();
    const history = createActivityEditHistory(initial);
    expect(commitActivityContent(history, initial)).toBe(history);
  });
});

describe('activity basics and hints', () => {
  it('updates only the supplied basics', () => {
    const next = updateActivityBasics(activity(), { instructions: 'New', timeLimitSec: 30 });
    expect(next).toMatchObject({ instructions: 'New', timeLimitSec: 30, language: 'python' });
  });

  it('adds, updates and removes hints', () => {
    let content: ActivityContent = addActivityHint(activity());
    expect(content.hints).toEqual(['']);
    content = updateActivityHint(content, 0, 'try a loop');
    expect(content.hints).toEqual(['try a loop']);
    content = setActivityHints(content, ['one', 'two']);
    content = removeActivityHint(content, 0);
    expect(content.hints).toEqual(['two']);
  });
});

describe('activity files', () => {
  it('adds a uniquely named file', () => {
    const next = addActivityFile(activity());
    expect(next.kind).toBe('code');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.files).toHaveLength(2);
    expect(next.files[1].path).toBe('file2.py');
  });

  it('updates and removes a file without touching siblings', () => {
    let next = updateActivityFile(activity(), 0, { content: 'print(1)' });
    expect(next.kind).toBe('code');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.files[0].content).toBe('print(1)');
    next = removeActivityFile(next, 0);
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.files).toEqual([]);
  });

  it('adds, updates and removes reference files', () => {
    let next = addActivityReferenceFile(activity());
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.referenceFiles?.[0].path).toBe('main.py');
    next = updateActivityReferenceFile(next, 0, { content: 'def add(a, b): return a + b' });
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.referenceFiles?.[0].content).toContain('a + b');
    next = removeActivityReferenceFile(next, 0);
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.referenceFiles).toEqual([]);
  });
});

describe('activity tests', () => {
  it('adds, updates, moves and removes tests', () => {
    let next: ActivityContent = addActivityTest(activity());
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.tests).toHaveLength(2);
    next = updateActivityTest(next, 1, { name: 'edge case', code: 'assert True' });
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.tests[1]).toMatchObject({ name: 'edge case', code: 'assert True' });
    next = moveActivityTest(next, 1, -1);
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.tests[0].name).toBe('edge case');
    next = removeActivityTest(next, 1);
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.tests).toHaveLength(1);
  });

  it('ignores an out-of-range move', () => {
    const content = activity();
    expect(moveActivityTest(content, 0, -1)).toBe(content);
    expect(moveActivityTest(content, 9, 1)).toBe(content);
  });
});

describe('activity checks', () => {
  it('creates the right shape for each check type', () => {
    let next: ActivityContent = addActivityCheck(activity(), 'expectStdout');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.checks[1]).toMatchObject({ type: 'expectStdout', expected: '', mode: 'exact' });

    next = addActivityCheck(next, 'expectFile');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.checks[2]).toMatchObject({ type: 'expectFile', path: 'output.txt' });

    next = addActivityCheck(next, 'expectTests');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.checks[3]).toMatchObject({ type: 'expectTests' });
  });

  it('updates only the addressed check and can remove it', () => {
    let next: ActivityContent = updateActivityCheck(activity(), 0, { label: 'All tests' });
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.checks[0]).toMatchObject({ id: 'c1', type: 'expectTests', label: 'All tests' });
    next = removeActivityCheck(next, 0);
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next.checks).toEqual([]);
  });
});

describe('non-code activities', () => {
  const sql: ActivityContent = {
    type: 'activity',
    kind: 'sql',
    instructions: 'Query.',
    setupSql: '',
    starterSql: '',
    checks: [],
  };

  it('passes through every mutation unchanged', () => {
    expect(addActivityFile(sql)).toBe(sql);
    expect(addActivityTest(sql)).toBe(sql);
    expect(addActivityCheck(sql, 'expectTests')).toBe(sql);
    expect(addActivityHint(sql)).toBe(sql);
    expect(addActivityReferenceFile(sql)).toBe(sql);
    expect(updateActivityBasics(sql, { language: 'sql' })).toBe(sql);
    expect(removeActivityFile(sql, 0)).toBe(sql);
  });
});
