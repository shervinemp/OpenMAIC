import { describe, expect, it } from 'vitest';
import { validateActivityContent } from '@openmaic/dsl';
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
  addSqlCheck,
  addTerminalCheck,
  addTerminalReferenceCommand,
  removeSqlCheck,
  removeTerminalCheck,
  removeTerminalReferenceCommand,
  setSqlReference,
  setSqlSetup,
  setSqlStarter,
  setTerminalReferenceCommands,
  switchActivityKind,
  updateSqlActivityBasics,
  updateSqlCheck,
  updateTerminalBasics,
  updateTerminalCheck,
  updateTerminalReferenceCommand,
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

  it('keeps code-only mutations away from a SQL lab', () => {
    expect(addActivityFile(sql)).toBe(sql);
    expect(addActivityTest(sql)).toBe(sql);
    expect(addActivityCheck(sql, 'expectTests')).toBe(sql);
    expect(addActivityReferenceFile(sql)).toBe(sql);
    expect(updateActivityBasics(sql, { language: 'sql' })).toBe(sql);
    expect(removeActivityFile(sql, 0)).toBe(sql);
  });

  it('edits SQL basics and the three SQL bodies', () => {
    let next: ActivityContent = updateSqlActivityBasics(sql, {
      instructions: 'Return the adults.',
      timeLimitSec: 20,
      debrief: 'Views encapsulate a query.',
    });
    expect(next).toMatchObject({
      kind: 'sql',
      instructions: 'Return the adults.',
      timeLimitSec: 20,
      debrief: 'Views encapsulate a query.',
    });

    next = setSqlSetup(next, 'create table t (n int);');
    next = setSqlStarter(next, 'select * from t;');
    next = setSqlReference(next, 'select n from t;');
    expect(next).toMatchObject({
      setupSql: 'create table t (n int);',
      starterSql: 'select * from t;',
      referenceSql: 'select n from t;',
    });
  });

  it('adds, updates and removes SQL checks without touching code ones', () => {
    let next: ActivityContent = addSqlCheck(sql);
    if (next.kind !== 'sql') throw new Error('expected sql');
    expect(next.checks).toHaveLength(1);
    expect(next.checks[0]).toMatchObject({
      type: 'expectSqlRows',
      sql: '',
      expected: [],
      ordered: false,
    });

    next = updateSqlCheck(next, 0, {
      sql: 'select name from adults;',
      expected: [['Ada']],
      ordered: true,
      label: 'Adults',
    });
    if (next.kind !== 'sql') throw new Error('expected sql');
    expect(next.checks[0]).toMatchObject({
      id: expect.any(String),
      sql: 'select name from adults;',
      expected: [['Ada']],
      ordered: true,
      label: 'Adults',
    });

    next = removeSqlCheck(next, 0);
    if (next.kind !== 'sql') throw new Error('expected sql');
    expect(next.checks).toEqual([]);
  });

  it('edits hints on a SQL lab', () => {
    const next = addActivityHint(sql);
    expect(next.hints).toEqual(['']);
    expect(updateActivityHint(next, 0, 'try a view')).toMatchObject({ hints: ['try a view'] });
    expect(removeActivityHint(next, 0)).toMatchObject({ hints: [] });
  });
});

describe('switchActivityKind', () => {
  it('creates a valid SQL stub while keeping shared fields', () => {
    const source = activity({ instructions: 'Keep me', hints: ['hint'] });
    const next = switchActivityKind(source, 'sql');
    if (next.kind !== 'sql') throw new Error('expected sql');
    expect(next).toMatchObject({
      kind: 'sql',
      instructions: 'Keep me',
      hints: ['hint'],
      setupSql: '',
      starterSql: 'select 1 as value;',
    });
    expect(next.checks).toHaveLength(1);
    expect(next.checks[0]).toMatchObject({ type: 'expectSqlRows', sql: 'select 1 as value;' });
    expect(validateActivityContent(next)).toEqual({ valid: true });
  });

  it('creates a valid code stub from a SQL lab', () => {
    const sql: ActivityContent = {
      type: 'activity',
      kind: 'sql',
      instructions: 'Keep me',
      setupSql: 'create table t (n int);',
      starterSql: 'select * from t;',
      checks: [{ id: 'rows', type: 'expectSqlRows', sql: 'select n from t;', expected: [[1]] }],
    };
    const next = switchActivityKind(sql, 'code');
    if (next.kind !== 'code') throw new Error('expected code');
    expect(next).toMatchObject({
      kind: 'code',
      instructions: 'Keep me',
      language: 'python',
      entryFile: 'main.py',
    });
    expect(next.checks[0]).toMatchObject({ type: 'expectTests' });
    expect(validateActivityContent(next)).toEqual({ valid: true });
  });

  it('returns the same content for the current kind', () => {
    const source = activity();
    expect(switchActivityKind(source, 'code')).toBe(source);
  });
});

describe('terminal labs', () => {
  const terminal: ActivityContent = {
    type: 'activity',
    kind: 'terminal',
    instructions: 'Create a note.',
    files: [{ path: 'README.txt', content: 'workspace\n' }],
    checks: [{ id: 'c1', type: 'expectState', path: 'cwd', expected: '/home/learner' }],
    referenceCommands: ['echo done > notes.txt'],
  };

  it('updates basics and reference commands', () => {
    let next = updateTerminalBasics(terminal, {
      instructions: 'Create notes.txt.',
      timeLimitSec: 30,
      debrief: 'Redirection writes output to a file.',
    });
    expect(next).toMatchObject({
      kind: 'terminal',
      instructions: 'Create notes.txt.',
      timeLimitSec: 30,
    });

    next = addTerminalReferenceCommand(next);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.referenceCommands).toEqual(['echo done > notes.txt', '']);

    next = updateTerminalReferenceCommand(next, 1, 'pwd');
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.referenceCommands).toEqual(['echo done > notes.txt', 'pwd']);

    next = removeTerminalReferenceCommand(next, 0);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.referenceCommands).toEqual(['pwd']);

    next = setTerminalReferenceCommands(next, ['ls']);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.referenceCommands).toEqual(['ls']);
  });

  it('adds, updates and removes terminal checks of every family', () => {
    let next = addTerminalCheck(terminal, 'expectStdout');
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.checks[1]).toMatchObject({ type: 'expectStdout', expected: '', mode: 'exact' });

    next = addTerminalCheck(next, 'expectFile');
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.checks[2]).toMatchObject({
      type: 'expectFile',
      path: 'notes.txt',
      expected: '',
    });

    next = addTerminalCheck(next, 'expectState');
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.checks[3]).toMatchObject({ type: 'expectState', path: 'cwd' });

    next = updateTerminalCheck(next, 1, { expected: 'done', mode: 'contains' });
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.checks[1]).toMatchObject({ expected: 'done', mode: 'contains' });

    next = removeTerminalCheck(next, 1);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.checks).toHaveLength(3);
  });

  it('adds and edits terminal workspace files', () => {
    let next = addActivityFile(terminal);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.files[1].path).toBe('file2.txt');
    next = updateActivityFile(next, 1, { content: 'notes' });
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.files[1].content).toBe('notes');
    next = removeActivityFile(next, 1);
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next.files).toHaveLength(1);
  });

  it('creates a valid terminal stub from another lab kind', () => {
    const next = switchActivityKind(activity(), 'terminal');
    if (next.kind !== 'terminal') throw new Error('expected terminal');
    expect(next).toMatchObject({ kind: 'terminal', instructions: 'Write add().' });
    expect(next.referenceCommands).toEqual([]);
    expect(validateActivityContent(next)).toEqual({ valid: true });
  });
});
