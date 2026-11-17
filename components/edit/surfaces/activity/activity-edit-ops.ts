/**
 * Pure editing operations for the activity content surface.
 *
 * Code and SQL labs are authorable; terminal activities pass through unchanged
 * so an imported scene stays readable without pretending to edit fields the
 * form does not expose.
 *
 * The history primitive is the same snapshot shape the quiz surface uses:
 * every helper returns a new content object, and the session store folds it in
 * as one undo step.
 */
import type {
  ActivityCheck,
  ActivityContent,
  ActivityExpectFileCheck,
  ActivityExpectSqlRowsCheck,
  ActivityExpectStateCheck,
  ActivityExpectStdoutCheck,
  ActivityFile,
  ActivityTest,
  CodeActivityCheck,
  CodeActivityContent,
  SqlActivityContent,
  TerminalActivityCheck,
  TerminalActivityContent,
} from '@/lib/types/stage';
import { createElementId } from '@/lib/edit/element-id';

export interface ActivityEditHistory {
  past: ActivityContent[];
  present: ActivityContent;
  future: ActivityContent[];
}

export function createActivityEditHistory(present: ActivityContent): ActivityEditHistory {
  return { past: [], present, future: [] };
}

export function commitActivityContent(
  history: ActivityEditHistory,
  next: ActivityContent,
): ActivityEditHistory {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoActivity(history: ActivityEditHistory): ActivityEditHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoActivity(history: ActivityEditHistory): ActivityEditHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

function code(content: ActivityContent): CodeActivityContent | null {
  return content.kind === 'code' ? content : null;
}

export function updateActivityBasics(
  content: ActivityContent,
  patch: Partial<
    Pick<
      CodeActivityContent,
      'instructions' | 'language' | 'entryFile' | 'timeLimitSec' | 'debrief'
    >
  >,
): ActivityContent {
  const current = code(content);
  if (!current) return content;
  return { ...current, ...patch };
}

export function setActivityHints(content: ActivityContent, hints: string[]): ActivityContent {
  return { ...content, hints };
}

export function addActivityHint(content: ActivityContent): ActivityContent {
  return { ...content, hints: [...(content.hints ?? []), ''] };
}

export function updateActivityHint(
  content: ActivityContent,
  index: number,
  value: string,
): ActivityContent {
  const hints = [...(content.hints ?? [])];
  if (index < 0 || index >= hints.length) return content;
  hints[index] = value;
  return { ...content, hints };
}

export function removeActivityHint(content: ActivityContent, index: number): ActivityContent {
  const hints = (content.hints ?? []).filter((_, i) => i !== index);
  return { ...content, hints };
}

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

type FileBearingActivity = CodeActivityContent | TerminalActivityContent;

/** Code and terminal labs both own a workspace file list; SQL does not. */
function filesOf(content: ActivityContent): FileBearingActivity | null {
  return content.kind === 'code' || content.kind === 'terminal' ? content : null;
}

export function addActivityFile(content: ActivityContent): ActivityContent {
  const current = filesOf(content);
  if (!current) return content;
  const extension = content.kind === 'code' ? 'py' : 'txt';
  const used = new Set(current.files.map((file) => file.path));
  let ordinal = current.files.length + 1;
  let path = `file${ordinal}.${extension}`;
  while (used.has(path)) path = `file${++ordinal}.${extension}`;
  return {
    ...current,
    files: [...current.files, { path, content: '' }],
  };
}

export function updateActivityFile(
  content: ActivityContent,
  index: number,
  patch: Partial<ActivityFile>,
): ActivityContent {
  const current = filesOf(content);
  if (!current || index < 0 || index >= current.files.length) return content;
  const files = current.files.map((file, i) => (i === index ? { ...file, ...patch } : file));
  return { ...current, files };
}

export function removeActivityFile(content: ActivityContent, index: number): ActivityContent {
  const current = filesOf(content);
  if (!current || index < 0 || index >= current.files.length) return content;
  return { ...current, files: current.files.filter((_, i) => i !== index) };
}

export function addActivityReferenceFile(content: ActivityContent): ActivityContent {
  const current = code(content);
  if (!current) return content;
  const reference = current.referenceFiles ?? [];
  const path = current.entryFile || current.files[0]?.path || 'main.py';
  return { ...current, referenceFiles: [...reference, { path, content: '' }] };
}

export function updateActivityReferenceFile(
  content: ActivityContent,
  index: number,
  patch: Partial<ActivityFile>,
): ActivityContent {
  const current = code(content);
  const reference = current?.referenceFiles;
  if (!current || !reference || index < 0 || index >= reference.length) return content;
  const referenceFiles = reference.map((file, i) => (i === index ? { ...file, ...patch } : file));
  return { ...current, referenceFiles };
}

export function removeActivityReferenceFile(
  content: ActivityContent,
  index: number,
): ActivityContent {
  const current = code(content);
  const reference = current?.referenceFiles;
  if (!current || !reference || index < 0 || index >= reference.length) return content;
  return { ...current, referenceFiles: reference.filter((_, i) => i !== index) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export function addActivityTest(content: ActivityContent): ActivityContent {
  const current = code(content);
  if (!current) return content;
  const test: ActivityTest = {
    id: createElementId('test'),
    name: '',
    code: '',
  };
  return { ...current, tests: [...current.tests, test] };
}

export function updateActivityTest(
  content: ActivityContent,
  index: number,
  patch: Partial<ActivityTest>,
): ActivityContent {
  const current = code(content);
  if (!current || index < 0 || index >= current.tests.length) return content;
  return {
    ...current,
    tests: current.tests.map((test, i) => (i === index ? { ...test, ...patch } : test)),
  };
}

export function removeActivityTest(content: ActivityContent, index: number): ActivityContent {
  const current = code(content);
  if (!current || index < 0 || index >= current.tests.length) return content;
  return { ...current, tests: current.tests.filter((_, i) => i !== index) };
}

export function moveActivityTest(
  content: ActivityContent,
  index: number,
  delta: -1 | 1,
): ActivityContent {
  const current = code(content);
  if (!current) return content;
  const target = index + delta;
  if (index < 0 || index >= current.tests.length || target < 0 || target >= current.tests.length) {
    return content;
  }
  const tests = [...current.tests];
  [tests[index], tests[target]] = [tests[target], tests[index]];
  return { ...current, tests };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function createActivityCheck(type: CodeActivityCheck['type']): CodeActivityCheck {
  const id = createElementId('check');
  switch (type) {
    case 'expectTests':
      return { id, type: 'expectTests' };
    case 'expectStdout':
      return { id, type: 'expectStdout', expected: '', mode: 'exact' };
    case 'expectFile':
      return { id, type: 'expectFile', path: 'output.txt', expected: '', mode: 'exact' };
  }
}

export function addActivityCheck(
  content: ActivityContent,
  type: CodeActivityCheck['type'],
): ActivityContent {
  const current = code(content);
  if (!current) return content;
  return { ...current, checks: [...current.checks, createActivityCheck(type)] };
}

export function updateActivityCheck(
  content: ActivityContent,
  index: number,
  patch: Partial<ActivityCheck>,
): ActivityContent {
  const current = code(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return {
    ...current,
    checks: current.checks.map((check, i) =>
      i === index ? ({ ...check, ...patch } as CodeActivityCheck) : check,
    ),
  };
}

export function removeActivityCheck(content: ActivityContent, index: number): ActivityContent {
  const current = code(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return { ...current, checks: current.checks.filter((_, i) => i !== index) };
}

// ---------------------------------------------------------------------------
// SQL labs
// ---------------------------------------------------------------------------

function sql(content: ActivityContent): SqlActivityContent | null {
  return content.kind === 'sql' ? content : null;
}

export function updateSqlActivityBasics(
  content: ActivityContent,
  patch: Partial<Pick<SqlActivityContent, 'instructions' | 'timeLimitSec' | 'debrief'>>,
): ActivityContent {
  const current = sql(content);
  if (!current) return content;
  return { ...current, ...patch };
}

export function setSqlSetup(content: ActivityContent, setupSql: string): ActivityContent {
  const current = sql(content);
  if (!current) return content;
  return { ...current, setupSql };
}

export function setSqlStarter(content: ActivityContent, starterSql: string): ActivityContent {
  const current = sql(content);
  if (!current) return content;
  return { ...current, starterSql };
}

export function setSqlReference(content: ActivityContent, referenceSql: string): ActivityContent {
  const current = sql(content);
  if (!current) return content;
  return { ...current, referenceSql };
}

export function createSqlCheck(): ActivityExpectSqlRowsCheck {
  return {
    id: createElementId('check'),
    type: 'expectSqlRows',
    sql: '',
    expected: [],
    ordered: false,
  };
}

export function addSqlCheck(content: ActivityContent): ActivityContent {
  const current = sql(content);
  if (!current) return content;
  return { ...current, checks: [...current.checks, createSqlCheck()] };
}

export function updateSqlCheck(
  content: ActivityContent,
  index: number,
  patch: Partial<ActivityExpectSqlRowsCheck>,
): ActivityContent {
  const current = sql(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return {
    ...current,
    checks: current.checks.map((check, i) =>
      i === index ? ({ ...check, ...patch } as ActivityExpectSqlRowsCheck) : check,
    ),
  };
}

export function removeSqlCheck(content: ActivityContent, index: number): ActivityContent {
  const current = sql(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return { ...current, checks: current.checks.filter((_, i) => i !== index) };
}

/**
 * Switch the lab family. Kind-specific fields are reset to a valid stub;
 * shared instructions/hints/debrief/time limit survive. The caller's undo
 * history makes the reset reversible.
 */
export function switchActivityKind(
  content: ActivityContent,
  kind: 'code' | 'sql' | 'terminal',
): ActivityContent {
  if (content.kind === kind) return content;
  const common = {
    type: 'activity' as const,
    instructions: content.instructions,
    ...(content.hints !== undefined ? { hints: content.hints } : {}),
    ...(content.debrief !== undefined ? { debrief: content.debrief } : {}),
    ...(content.timeLimitSec !== undefined ? { timeLimitSec: content.timeLimitSec } : {}),
  };
  if (kind === 'code') {
    return {
      ...common,
      kind: 'code',
      language: 'python',
      entryFile: 'main.py',
      files: [{ path: 'main.py', content: '' }],
      tests: [],
      checks: [{ id: createElementId('check'), type: 'expectTests' }],
    };
  }
  if (kind === 'terminal') {
    return {
      ...common,
      kind: 'terminal',
      files: [{ path: 'README.txt', content: 'Workspace files appear here.\n' }],
      referenceCommands: [],
      checks: [
        {
          id: createElementId('check'),
          type: 'expectFile',
          path: 'notes.txt',
          expected: 'done',
        },
      ],
    };
  }
  return {
    ...common,
    kind: 'sql',
    setupSql: '',
    starterSql: 'select 1 as value;',
    checks: [
      {
        id: createElementId('check'),
        type: 'expectSqlRows',
        sql: 'select 1 as value;',
        expected: [[1]],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Terminal labs
// ---------------------------------------------------------------------------

function terminal(content: ActivityContent): TerminalActivityContent | null {
  return content.kind === 'terminal' ? content : null;
}

export function updateTerminalBasics(
  content: ActivityContent,
  patch: Partial<Pick<TerminalActivityContent, 'instructions' | 'timeLimitSec' | 'debrief'>>,
): ActivityContent {
  const current = terminal(content);
  if (!current) return content;
  return { ...current, ...patch };
}

export function setTerminalReferenceCommands(
  content: ActivityContent,
  commands: string[],
): ActivityContent {
  const current = terminal(content);
  if (!current) return content;
  return { ...current, referenceCommands: commands };
}

export function addTerminalReferenceCommand(content: ActivityContent): ActivityContent {
  const current = terminal(content);
  if (!current) return content;
  return { ...current, referenceCommands: [...(current.referenceCommands ?? []), ''] };
}

export function updateTerminalReferenceCommand(
  content: ActivityContent,
  index: number,
  value: string,
): ActivityContent {
  const current = terminal(content);
  const commands = current?.referenceCommands;
  if (!current || !commands || index < 0 || index >= commands.length) return content;
  return {
    ...current,
    referenceCommands: commands.map((command, i) => (i === index ? value : command)),
  };
}

export function removeTerminalReferenceCommand(
  content: ActivityContent,
  index: number,
): ActivityContent {
  const current = terminal(content);
  const commands = current?.referenceCommands;
  if (!current || !commands || index < 0 || index >= commands.length) return content;
  return { ...current, referenceCommands: commands.filter((_, i) => i !== index) };
}

export function createTerminalCheck(type: TerminalActivityCheck['type']): TerminalActivityCheck {
  const id = createElementId('check');
  if (type === 'expectStdout') {
    return {
      id,
      type: 'expectStdout',
      expected: '',
      mode: 'exact',
    } satisfies ActivityExpectStdoutCheck;
  }
  if (type === 'expectFile') {
    return {
      id,
      type: 'expectFile',
      path: 'notes.txt',
      expected: '',
      mode: 'exact',
    } satisfies ActivityExpectFileCheck;
  }
  return {
    id,
    type: 'expectState',
    path: 'cwd',
    expected: '/home/learner',
  } satisfies ActivityExpectStateCheck;
}

export function addTerminalCheck(
  content: ActivityContent,
  type: TerminalActivityCheck['type'],
): ActivityContent {
  const current = terminal(content);
  if (!current) return content;
  return { ...current, checks: [...current.checks, createTerminalCheck(type)] };
}

export function updateTerminalCheck(
  content: ActivityContent,
  index: number,
  patch:
    | Partial<ActivityExpectStdoutCheck>
    | Partial<ActivityExpectFileCheck>
    | Partial<ActivityExpectStateCheck>,
): ActivityContent {
  const current = terminal(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return {
    ...current,
    checks: current.checks.map((check, i) =>
      i === index ? ({ ...check, ...patch } as TerminalActivityCheck) : check,
    ),
  };
}

export function removeTerminalCheck(content: ActivityContent, index: number): ActivityContent {
  const current = terminal(content);
  if (!current || index < 0 || index >= current.checks.length) return content;
  return { ...current, checks: current.checks.filter((_, i) => i !== index) };
}
