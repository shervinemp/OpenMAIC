import { describe, expect, it } from 'vitest';
import type {
  CodeActivityContent,
  SqlActivityContent,
  TerminalActivityContent,
} from '@openmaic/dsl';
import {
  validateActivityDepth,
  validateSqlActivityDepth,
  validateTerminalActivityDepth,
} from '@openmaic/generation';
import { activityOutline, sqlActivityOutline, terminalActivityOutline } from './scene-fixtures.js';

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

function sqlLab(overrides: Partial<SqlActivityContent> = {}): SqlActivityContent {
  return {
    type: 'activity',
    kind: 'sql',
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
    referenceSql: 'create view adults as select name from learners where age >= 21;',
    ...overrides,
  };
}

function sqlFindings(content: SqlActivityContent): string {
  return validateSqlActivityDepth(sqlActivityOutline(), content).findings.join('\n');
}

describe('validateSqlActivityDepth', () => {
  it('accepts a seeded lab whose reference differs from the starter', () => {
    expect(validateSqlActivityDepth(sqlActivityOutline(), sqlLab())).toMatchObject({
      adequate: true,
      depthValidated: true,
      findings: [],
    });
  });

  it('flags a missing setup, starter or reference', () => {
    const text = sqlFindings(sqlLab({ setupSql: ' ', starterSql: ' ', referenceSql: ' ' }));
    expect(text).toContain('setupSql is empty');
    expect(text).toContain('starterSql is empty');
    expect(text).toContain('referenceSql is empty');
  });

  it('flags an identical starter and reference', () => {
    const reference = sqlLab().referenceSql!;
    expect(sqlFindings(sqlLab({ starterSql: reference }))).toContain(
      'asks the learner to do nothing',
    );
  });

  it('flags a probe without a query or with malformed rows', () => {
    const text = sqlFindings(
      sqlLab({
        checks: [
          {
            id: 'rows',
            type: 'expectSqlRows',
            sql: ' ',
            expected: [[1]],
          },
        ],
      }),
    );
    expect(text).toContain('has no query');
  });

  it('requires more probes as the course deepens', () => {
    const deep = { ...sqlActivityOutline(), depthLevel: 'university' as const };
    expect(validateSqlActivityDepth(deep, sqlLab()).findings).toEqual([
      expect.stringContaining('need at least 2'),
    ]);
  });
});

function terminalLab(overrides: Partial<TerminalActivityContent> = {}): TerminalActivityContent {
  return {
    type: 'activity',
    kind: 'terminal',
    runtime: 'simulation',
    instructions:
      'Create a file named `notes.txt` in your home directory whose content contains the word `done`. Then print the current working directory. The session starts in `/home/learner`. You can use output redirection with `echo`, and `pwd` prints the current directory. For example, `echo done > notes.txt` writes the file.',
    files: [{ path: 'README.txt', content: 'Workspace notes.\n', editable: false }],
    checks: [
      { id: 'file', type: 'expectFile', path: 'notes.txt', expected: 'done', mode: 'contains' },
      { id: 'cwd', type: 'expectState', path: 'cwd', expected: '/home/learner' },
    ],
    referenceCommands: ['echo done > notes.txt', 'pwd'],
    ...overrides,
  };
}

function terminalFindings(content: TerminalActivityContent): string {
  return validateTerminalActivityDepth(terminalActivityOutline(), content).findings.join('\n');
}

describe('validateTerminalActivityDepth', () => {
  it('accepts a simulated lab with executable reference commands', () => {
    expect(validateTerminalActivityDepth(terminalActivityOutline(), terminalLab())).toMatchObject({
      adequate: true,
      depthValidated: true,
      findings: [],
    });
  });

  it('rejects the server tier and missing or empty reference commands', () => {
    expect(terminalFindings(terminalLab({ runtime: 'server' }))).toContain(
      'must use the simulation runtime',
    );
    expect(terminalFindings(terminalLab({ referenceCommands: [] }))).toContain(
      'referenceCommands is empty',
    );
    expect(terminalFindings(terminalLab({ referenceCommands: [''] }))).toContain(
      'contains an empty command',
    );
    expect(terminalFindings(terminalLab({ referenceCommands: ['# TODO'] }))).toContain(
      'no executable command',
    );
  });

  it('flags a malformed or empty state expectation', () => {
    const text = terminalFindings(
      terminalLab({
        checks: [
          { id: 'bad', type: 'expectState', path: 'folder', expected: '/home/learner' },
          { id: 'empty', type: 'expectState', path: 'env.MODE', expected: ' ' },
        ],
      }),
    );
    expect(text).toContain('state path must be cwd, env.NAME, or file:path');
    expect(text).toContain('expects an empty state value');
  });
});
