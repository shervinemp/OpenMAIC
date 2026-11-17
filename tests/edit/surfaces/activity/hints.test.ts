import { describe, expect, it } from 'vitest';
import type { ActivityContent, CodeActivityContent } from '@/lib/types/stage';
import { buildActivityHints } from '@/components/edit/surfaces/activity/use-activity-surface';

const t = (key: string) => key;

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
    referenceFiles: [{ path: 'main.py', content: 'def add(a, b): return a + b\n' }],
    ...overrides,
  };
}

describe('buildActivityHints', () => {
  it('emits nothing for a fully configured lab', () => {
    expect(buildActivityHints(activity(), t)).toEqual([]);
  });

  it('flags missing instructions, checks and reference', () => {
    const hints = buildActivityHints(
      activity({ instructions: '  ', checks: [], referenceFiles: [] }),
      t,
    );
    expect(hints.map((hint) => hint.message)).toEqual([
      'edit.activity.hint.emptyInstructions',
      'edit.activity.hint.noChecks',
      'edit.activity.hint.noReference',
    ]);
  });

  it('flags an entry file outside the workspace', () => {
    const hints = buildActivityHints(activity({ entryFile: 'solution.py' }), t);
    expect(hints.map((hint) => hint.message)).toContain('edit.activity.hint.entryMissing');
  });

  it('flags a tests check with no declared tests', () => {
    const hints = buildActivityHints(activity({ tests: [] }), t);
    expect(hints.map((hint) => hint.message)).toContain('edit.activity.hint.noTests');
  });

  it('flags a reference workspace without the entry file', () => {
    const hints = buildActivityHints(
      activity({ referenceFiles: [{ path: 'other.py', content: '' }] }),
      t,
    );
    expect(hints.map((hint) => hint.message)).toContain('edit.activity.hint.entryNotInReference');
  });

  it('flags duplicate test and check ids', () => {
    const hints = buildActivityHints(
      activity({
        tests: [
          { id: 'same', name: 'a', code: '' },
          { id: 'same', name: 'b', code: '' },
        ],
        checks: [
          { id: 'dup', type: 'expectTests' },
          { id: 'dup', type: 'expectTests' },
        ],
      }),
      t,
    );
    const messages = hints.map((hint) => hint.message);
    expect(messages).toContain('edit.activity.hint.duplicateTestIds');
    expect(messages).toContain('edit.activity.hint.duplicateCheckIds');
  });

  it('caps the rail at five hints', () => {
    const hints = buildActivityHints(
      activity({
        instructions: '',
        entryFile: 'missing.py',
        files: [],
        checks: [
          { id: 'dup', type: 'expectTests' },
          { id: 'dup', type: 'expectTests' },
        ],
        tests: [
          { id: 'same', name: 'a', code: '' },
          { id: 'same', name: 'b', code: '' },
        ],
        referenceFiles: [{ path: 'other.py', content: '' }],
      }),
      t,
    );
    expect(hints).toHaveLength(5);
  });

  it('marks a terminal lab as not editable', () => {
    const terminal: ActivityContent = {
      type: 'activity',
      kind: 'terminal',
      instructions: 'x',
      files: [],
      checks: [{ id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' }],
    };
    expect(buildActivityHints(terminal, t)).toEqual([
      {
        id: 'unsupported',
        severity: 'info',
        message: 'edit.activity.hint.unsupportedKind',
      },
    ]);
  });

  it('flags a SQL lab without setup, starter or reference SQL', () => {
    const sql: ActivityContent = {
      type: 'activity',
      kind: 'sql',
      instructions:
        'Create a view named adults that returns every learner aged 21 or older, ordered by name.',
      setupSql: '',
      starterSql: '',
      checks: [],
    };
    const messages = buildActivityHints(sql, t).map((hint) => hint.message);
    expect(messages).toContain('edit.activity.hint.setupMissing');
    expect(messages).toContain('edit.activity.hint.starterMissing');
    expect(messages).toContain('edit.activity.hint.noChecks');
    expect(messages).toContain('edit.activity.hint.noReferenceSql');
  });

  it('flags a SQL reference identical to the starter', () => {
    const sql: ActivityContent = {
      type: 'activity',
      kind: 'sql',
      instructions:
        'Create a view named adults that returns every learner aged 21 or older, ordered by name.',
      setupSql: 'create table learners (name text, age int);',
      starterSql: 'select 1;',
      referenceSql: 'select 1;',
      checks: [{ id: 'rows', type: 'expectSqlRows', sql: 'select 1;', expected: [[1]] }],
    };
    expect(buildActivityHints(sql, t).map((hint) => hint.message)).toContain(
      'edit.activity.hint.referenceMatchesStarter',
    );
  });
});
