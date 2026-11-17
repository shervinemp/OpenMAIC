/**
 * Pure, dependency-free structural validators for the slide DSL contract.
 *
 * This is the contract's authoritative, zero-dependency validation boundary for
 * in-process (TS / JS) producers and consumers — generators, importers, the
 * runtime engine. It checks object shape, required fields (including each action
 * variant's), known discriminants, and the scene `type` <-> `content` binding
 * that the public {@link Scene} type enforces. Producers can rely on it without
 * shipping a schema validator, because it adds no runtime dependency.
 *
 * The shipped JSON Schema (`@openmaic/dsl/schema/*`) is the cross-language
 * mirror of the same contract — reach for it from non-TS consumers, or when you
 * want exhaustive value-level (type / format) checking. These validators are a
 * structural subset (presence + discriminants); the schema additionally checks
 * each field's value shape. Both describe the same contract. No runtime
 * dependencies.
 */
import { isActionType } from './action.js';
import type { ActionType } from './action.js';
import { isActivityKind, isTerminalRuntime } from './activity.js';
import { isWidgetType } from './interactive.js';
import { isPBLProject } from './pbl.js';
import { isSceneType } from './stage.js';
import { isIsoTimestamp, isRuntimeSessionStatus } from './runtime.js';
import { isWellFormedDslVersion } from './version.js';

export interface ValidationIssue {
  /** JSON-pointer-ish path to the offending value, e.g. `/actions/0/elementId`. */
  path: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

/** Runtime kind of a required field, checked with `typeof` / `Array.isArray`. */
type FieldKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * Required fields beyond `ActionBase` (`id`) for each action variant, with the
 * runtime kind each must have. Checked for presence AND shape. Kept in lockstep
 * (both directions, names + kinds) with the generated `action.schema.json` by a
 * test — the schema, derived from the TS types, is the source of truth.
 */
const ACTION_REQUIRED_FIELDS: Record<ActionType, Readonly<Record<string, FieldKind>>> = {
  spotlight: { elementId: 'string' },
  laser: { elementId: 'string' },
  play_video: { elementId: 'string' },
  speech: { text: 'string' },
  wb_open: {},
  wb_draw_text: { content: 'string', x: 'number', y: 'number' },
  wb_draw_shape: { shape: 'string', x: 'number', y: 'number', width: 'number', height: 'number' },
  wb_draw_chart: {
    chartType: 'string',
    x: 'number',
    y: 'number',
    width: 'number',
    height: 'number',
    data: 'object',
  },
  wb_draw_latex: { latex: 'string', x: 'number', y: 'number' },
  wb_draw_table: { x: 'number', y: 'number', width: 'number', height: 'number', data: 'array' },
  wb_draw_line: { startX: 'number', startY: 'number', endX: 'number', endY: 'number' },
  wb_draw_code: { language: 'string', code: 'string', x: 'number', y: 'number' },
  wb_edit_code: { elementId: 'string', operation: 'string' },
  wb_clear: {},
  wb_delete: { elementId: 'string' },
  wb_close: {},
  discussion: { topic: 'string' },
  widget_highlight: { target: 'string' },
  widget_setState: { state: 'object' },
  widget_annotation: { target: 'string' },
  widget_reveal: { target: 'string' },
};

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'object') return isObject(value);
  return typeof value === kind;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'string')
    errors.push({ path: `${path}/${key}`, message: `expected string \`${key}\`` });
}

function reqNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'number')
    errors.push({ path: `${path}/${key}`, message: `expected number \`${key}\`` });
}

function done(errors: ValidationIssue[]): ValidationResult {
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Check a table of root-level envelope fields against their declared runtime
 * kinds, pushing one {@link ValidationIssue} per violation at path `/<field>`.
 *
 * One helper for all three runtime-envelope tables (session-required,
 * record-required, record-optional) so the presence / kind / emptiness rules
 * cannot drift between the copies. Two modes:
 *
 * - required (`opts.optional` falsy): the field must be present with its kind,
 *   and a required `'string'` must additionally be **non-empty** — an empty
 *   `id` / `learnerKey` passes `typeof` yet is useless as an identity/partition
 *   key, so it is a contract violation, not valid data.
 * - optional (`opts.optional` true): the field is only checked *when present*,
 *   and only for its `typeof` kind. Optional anchors (`sceneId`, `subAnchor`)
 *   stay lax on emptiness — an empty best-effort anchor is the app's business.
 *
 * `checkAction`'s variant-field loop is deliberately NOT routed through here:
 * it uses nested paths and a different "requires"/"must be" message shape.
 */
function checkFields(
  doc: Record<string, unknown>,
  fields: Readonly<Record<string, FieldKind>>,
  opts: { optional?: boolean },
  errors: ValidationIssue[],
): void {
  for (const [field, kind] of Object.entries(fields)) {
    const value = doc[field];
    if (opts.optional) {
      if (value !== undefined && !matchesKind(value, kind)) {
        errors.push({ path: `/${field}`, message: `expected ${kind} \`${field}\`` });
      }
      continue;
    }
    if (!matchesKind(value, kind)) {
      errors.push({ path: `/${field}`, message: `expected ${kind} \`${field}\`` });
      continue;
    }
    if (kind === 'string' && value === '') {
      errors.push({ path: `/${field}`, message: `expected non-empty string \`${field}\`` });
    }
  }
}

function checkAction(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'action must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  if (!isActionType(doc.type)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown action type: ${JSON.stringify(doc.type)}`,
    });
    return; // can't check variant fields without a known type
  }
  for (const [field, kind] of Object.entries(ACTION_REQUIRED_FIELDS[doc.type])) {
    const value = doc[field];
    if (value === undefined) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action requires \`${field}\``,
      });
    } else if (!matchesKind(value, kind)) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action field \`${field}\` must be ${kind}`,
      });
    }
  }
}

function checkInteractiveContent(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'interactive content must be an object' });
    return;
  }
  if (doc.type !== 'interactive') {
    errors.push({ path: `${path}/type`, message: 'expected `interactive` content type' });
  }
  if (typeof doc.html !== 'string' && typeof doc.url !== 'string') {
    errors.push({
      path: path || '/',
      message: 'interactive content requires `html` or `url` as a string',
    });
  }
  if (doc.url !== undefined && typeof doc.url !== 'string') {
    errors.push({ path: `${path}/url`, message: '`url` must be a string when present' });
  }
  if (doc.html !== undefined && typeof doc.html !== 'string') {
    errors.push({ path: `${path}/html`, message: '`html` must be a string when present' });
  }
  if (doc.widgetType !== undefined && !isWidgetType(doc.widgetType)) {
    errors.push({
      path: `${path}/widgetType`,
      message: `unknown widget type: ${JSON.stringify(doc.widgetType)}`,
    });
  }
  if (doc.widgetConfig !== undefined) {
    if (!isObject(doc.widgetConfig)) {
      errors.push({
        path: `${path}/widgetConfig`,
        message: '`widgetConfig` must be an object when present',
      });
    } else if (!isWidgetType(doc.widgetConfig.type)) {
      errors.push({
        path: `${path}/widgetConfig/type`,
        message: `unknown widget config type: ${JSON.stringify(doc.widgetConfig.type)}`,
      });
    }
  }
}

/** Check ids and test ids are addressed by reference, so duplicates are errors. */
function collectUniqueIds(
  values: unknown[],
  path: string,
  field: string,
  errors: ValidationIssue[],
): Set<string> {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!isObject(value)) return;
    const id = value.id;
    if (typeof id !== 'string' || id === '') return;
    if (seen.has(id)) {
      errors.push({
        path: `${path}/${index}/id`,
        message: `duplicate ${field} id: ${JSON.stringify(id)}`,
      });
    }
    seen.add(id);
  });
  return seen;
}

function checkActivityFile(
  doc: unknown,
  path: string,
  seenPaths: Set<string>,
  errors: ValidationIssue[],
): void {
  if (!isObject(doc)) {
    errors.push({ path, message: 'activity file must be an object' });
    return;
  }
  if (typeof doc.path !== 'string' || doc.path.trim() === '') {
    errors.push({ path: `${path}/path`, message: 'activity file requires a non-empty `path`' });
  } else {
    const filePath = doc.path;
    const segments = filePath.split('/');
    if (
      filePath.startsWith('/') ||
      filePath.includes('\\') ||
      segments.some((segment) => segment === '..' || segment === '' || segment === '.')
    ) {
      errors.push({
        path: `${path}/path`,
        message:
          'activity file paths must be relative, forward-slash separated, and contain no `..` segments',
      });
    }
    if (seenPaths.has(filePath)) {
      errors.push({
        path: `${path}/path`,
        message: `duplicate activity file path: ${JSON.stringify(filePath)}`,
      });
    }
    seenPaths.add(filePath);
  }
  if (typeof doc.content !== 'string') {
    errors.push({ path: `${path}/content`, message: 'activity file requires string `content`' });
  }
  if (doc.editable !== undefined && typeof doc.editable !== 'boolean') {
    errors.push({ path: `${path}/editable`, message: '`editable` must be a boolean when present' });
  }
}

function checkActivityTests(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!Array.isArray(doc)) {
    errors.push({ path, message: 'code activity requires a `tests` array' });
    return;
  }
  collectUniqueIds(doc, path, 'test', errors);
  doc.forEach((test, index) => {
    const testPath = `${path}/${index}`;
    if (!isObject(test)) {
      errors.push({ path: testPath, message: 'activity test must be an object' });
      return;
    }
    for (const field of ['id', 'name', 'code'] as const) {
      if (typeof test[field] !== 'string' || test[field] === '') {
        errors.push({
          path: `${testPath}/${field}`,
          message: `activity test requires a non-empty \`${field}\``,
        });
      }
    }
    if (test.hidden !== undefined && typeof test.hidden !== 'boolean') {
      errors.push({
        path: `${testPath}/hidden`,
        message: '`hidden` must be a boolean when present',
      });
    }
  });
}

const CODE_CHECK_TYPES = new Set(['expectTests', 'expectStdout', 'expectFile']);
const SQL_CHECK_TYPES = new Set(['expectSqlRows']);
const TERMINAL_CHECK_TYPES = new Set(['expectStdout', 'expectFile', 'expectState']);

function isSqlCellValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function checkActivityCheck(
  doc: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  errors: ValidationIssue[],
): void {
  if (!isObject(doc)) {
    errors.push({ path, message: 'activity check must be an object' });
    return;
  }
  if (typeof doc.id !== 'string' || doc.id === '') {
    errors.push({ path: `${path}/id`, message: 'activity check requires a non-empty `id`' });
  }
  if (typeof doc.type !== 'string' || !allowed.has(doc.type)) {
    errors.push({
      path: `${path}/type`,
      message: `check type ${JSON.stringify(doc.type)} is not valid for this activity kind`,
    });
    return;
  }
  if (doc.label !== undefined && typeof doc.label !== 'string') {
    errors.push({ path: `${path}/label`, message: '`label` must be a string when present' });
  }
  if (
    doc.points !== undefined &&
    (typeof doc.points !== 'number' || !Number.isFinite(doc.points) || doc.points < 0)
  ) {
    errors.push({
      path: `${path}/points`,
      message: '`points` must be a finite non-negative number',
    });
  }
  if (doc.hidden !== undefined && typeof doc.hidden !== 'boolean') {
    errors.push({ path: `${path}/hidden`, message: '`hidden` must be a boolean when present' });
  }

  const textExpected = () => {
    if (typeof doc.expected !== 'string') {
      errors.push({ path: `${path}/expected`, message: '`expected` must be a string' });
    }
    if (doc.mode !== undefined && doc.mode !== 'exact' && doc.mode !== 'contains') {
      errors.push({ path: `${path}/mode`, message: '`mode` must be `exact` or `contains`' });
    }
  };

  switch (doc.type) {
    case 'expectTests':
      if (doc.testIds !== undefined) {
        if (!Array.isArray(doc.testIds) || doc.testIds.some((id) => typeof id !== 'string')) {
          errors.push({
            path: `${path}/testIds`,
            message: '`testIds` must be an array of strings when present',
          });
        }
      }
      break;
    case 'expectStdout':
      textExpected();
      break;
    case 'expectFile':
      if (typeof doc.path !== 'string' || doc.path === '') {
        errors.push({ path: `${path}/path`, message: '`path` must be a non-empty string' });
      }
      textExpected();
      break;
    case 'expectSqlRows':
      if (typeof doc.sql !== 'string' || doc.sql.trim() === '') {
        errors.push({ path: `${path}/sql`, message: '`sql` must be a non-empty string' });
      }
      if (!Array.isArray(doc.expected) || doc.expected.some((row) => !Array.isArray(row))) {
        errors.push({ path: `${path}/expected`, message: '`expected` must be an array of rows' });
      } else {
        const width = (doc.expected[0] as unknown[] | undefined)?.length;
        doc.expected.forEach((row, index) => {
          if (width !== undefined && (row as unknown[]).length !== width) {
            errors.push({
              path: `${path}/expected/${index}`,
              message: 'every expected SQL row must have the same number of columns',
            });
          }
          (row as unknown[]).forEach((cell, cellIndex) => {
            if (!isSqlCellValue(cell)) {
              errors.push({
                path: `${path}/expected/${index}/${cellIndex}`,
                message: 'expected SQL cells must be string, number, boolean or null',
              });
            }
          });
        });
      }
      if (doc.ordered !== undefined && typeof doc.ordered !== 'boolean') {
        errors.push({
          path: `${path}/ordered`,
          message: '`ordered` must be a boolean when present',
        });
      }
      break;
    case 'expectState':
      if (typeof doc.path !== 'string' || doc.path === '') {
        errors.push({ path: `${path}/path`, message: '`path` must be a non-empty string' });
      }
      textExpected();
      break;
  }
}

function checkActivityContent(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'activity content must be an object' });
    return;
  }
  if (doc.type !== 'activity') {
    errors.push({ path: `${path}/type`, message: 'expected `activity` content type' });
  }
  if (!isActivityKind(doc.kind)) {
    errors.push({
      path: `${path}/kind`,
      message: `unknown activity kind: ${JSON.stringify(doc.kind)}`,
    });
    return; // per-kind fields cannot be checked without a known kind
  }
  if (typeof doc.instructions !== 'string') {
    errors.push({
      path: `${path}/instructions`,
      message: 'activity requires string `instructions`',
    });
  }
  if (doc.hints !== undefined) {
    if (!Array.isArray(doc.hints) || doc.hints.some((hint) => typeof hint !== 'string')) {
      errors.push({ path: `${path}/hints`, message: '`hints` must be an array of strings' });
    }
  }
  if (doc.debrief !== undefined && typeof doc.debrief !== 'string') {
    errors.push({ path: `${path}/debrief`, message: '`debrief` must be a string when present' });
  }
  if (doc.concepts !== undefined) {
    if (
      !Array.isArray(doc.concepts) ||
      doc.concepts.some((concept) => typeof concept !== 'string')
    ) {
      errors.push({
        path: `${path}/concepts`,
        message: '`concepts` must be an array of strings when present',
      });
    }
  }
  if (
    doc.timeLimitSec !== undefined &&
    (typeof doc.timeLimitSec !== 'number' ||
      !Number.isFinite(doc.timeLimitSec) ||
      doc.timeLimitSec <= 0)
  ) {
    errors.push({
      path: `${path}/timeLimitSec`,
      message: '`timeLimitSec` must be a finite positive number',
    });
  }
  if (doc.runtime !== undefined && doc.kind !== 'terminal') {
    errors.push({
      path: `${path}/runtime`,
      message: '`runtime` is only valid on terminal activities',
    });
  }
  if (doc.kind === 'terminal' && doc.runtime !== undefined && !isTerminalRuntime(doc.runtime)) {
    errors.push({
      path: `${path}/runtime`,
      message: '`runtime` must be `simulation` or `server` when present',
    });
  }

  const allowedChecks =
    doc.kind === 'code'
      ? CODE_CHECK_TYPES
      : doc.kind === 'sql'
        ? SQL_CHECK_TYPES
        : TERMINAL_CHECK_TYPES;

  if (!Array.isArray(doc.checks)) {
    errors.push({ path: `${path}/checks`, message: 'activity requires a `checks` array' });
  } else {
    if (doc.checks.length === 0) {
      errors.push({ path: `${path}/checks`, message: 'activity requires at least one check' });
    }
    collectUniqueIds(doc.checks, `${path}/checks`, 'check', errors);
    doc.checks.forEach((check, index) => {
      checkActivityCheck(check, `${path}/checks/${index}`, allowedChecks, errors);
    });
  }

  if (doc.kind === 'code') {
    if (typeof doc.language !== 'string' || doc.language === '') {
      errors.push({ path: `${path}/language`, message: 'code activity requires a `language`' });
    }
    if (typeof doc.entryFile !== 'string' || doc.entryFile === '') {
      errors.push({ path: `${path}/entryFile`, message: 'code activity requires an `entryFile`' });
    }
    const filePaths = new Set<string>();
    if (!Array.isArray(doc.files)) {
      errors.push({ path: `${path}/files`, message: 'code activity requires a `files` array' });
    } else {
      doc.files.forEach((file, index) => {
        checkActivityFile(file, `${path}/files/${index}`, filePaths, errors);
      });
      if (
        typeof doc.entryFile === 'string' &&
        doc.entryFile !== '' &&
        !filePaths.has(doc.entryFile)
      ) {
        errors.push({
          path: `${path}/entryFile`,
          message: '`entryFile` must name one of the activity files',
        });
      }
    }
    checkActivityTests(doc.tests, `${path}/tests`, errors);
    if (doc.referenceFiles !== undefined) {
      if (!Array.isArray(doc.referenceFiles)) {
        errors.push({
          path: `${path}/referenceFiles`,
          message: '`referenceFiles` must be an array',
        });
      } else {
        const referencePaths = new Set<string>();
        doc.referenceFiles.forEach((file, index) => {
          checkActivityFile(file, `${path}/referenceFiles/${index}`, referencePaths, errors);
        });
      }
    }
  } else if (doc.kind === 'sql') {
    if (typeof doc.setupSql !== 'string') {
      errors.push({ path: `${path}/setupSql`, message: 'sql activity requires string `setupSql`' });
    }
    if (typeof doc.starterSql !== 'string') {
      errors.push({
        path: `${path}/starterSql`,
        message: 'sql activity requires string `starterSql`',
      });
    }
    if (doc.referenceSql !== undefined && typeof doc.referenceSql !== 'string') {
      errors.push({ path: `${path}/referenceSql`, message: '`referenceSql` must be a string' });
    }
  } else {
    const filePaths = new Set<string>();
    if (!Array.isArray(doc.files)) {
      errors.push({ path: `${path}/files`, message: 'terminal activity requires a `files` array' });
    } else {
      doc.files.forEach((file, index) => {
        checkActivityFile(file, `${path}/files/${index}`, filePaths, errors);
      });
    }
    if (doc.referenceCommands !== undefined) {
      if (
        !Array.isArray(doc.referenceCommands) ||
        doc.referenceCommands.some((command) => typeof command !== 'string')
      ) {
        errors.push({
          path: `${path}/referenceCommands`,
          message: '`referenceCommands` must be an array of strings',
        });
      }
    }
  }
}

function checkPBLContent(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'pbl content must be an object' });
    return;
  }
  if (doc.type !== 'pbl') {
    errors.push({ path: `${path}/type`, message: 'expected `pbl` content type' });
  }
  if (doc.projectV2 !== undefined && !isPBLProject(doc.projectV2)) {
    errors.push({
      path: `${path}/projectV2`,
      message: '`projectV2` must be a structurally valid PBL project when present',
    });
  }
  if (doc.projectConfig !== undefined && !isObject(doc.projectConfig)) {
    errors.push({
      path: `${path}/projectConfig`,
      message: '`projectConfig` must be an object when present',
    });
  }
}

function checkScene(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'scene must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  reqString(doc, 'stageId', path, errors);
  reqString(doc, 'title', path, errors);
  reqNumber(doc, 'order', path, errors);

  // The scene `type` is bound to its `content` (see `Scene`) for every
  // persisted kind owned by the contract.
  const t = doc.type;
  if (!isSceneType(t)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown scene type: ${JSON.stringify(t)}`,
    });
  }

  const content = doc.content;
  if (!isObject(content)) {
    errors.push({ path: `${path}/content`, message: 'scene `content` must be an object' });
  } else if (isSceneType(t)) {
    if (content.type !== t) {
      errors.push({
        path: `${path}/content/type`,
        message: `content type ${JSON.stringify(content.type)} does not match scene type ${JSON.stringify(t)}`,
      });
    } else if (t === 'slide' && !isObject(content.canvas)) {
      errors.push({
        path: `${path}/content/canvas`,
        message: 'slide content requires an object `canvas`',
      });
    } else if (t === 'quiz' && !Array.isArray(content.questions)) {
      errors.push({
        path: `${path}/content/questions`,
        message: 'quiz content requires a `questions` array',
      });
    } else if (t === 'activity') {
      checkActivityContent(content, `${path}/content`, errors);
    } else if (t === 'interactive') {
      checkInteractiveContent(content, `${path}/content`, errors);
    } else if (t === 'pbl') {
      checkPBLContent(content, `${path}/content`, errors);
    }
  }

  if (doc.actions !== undefined) {
    if (!Array.isArray(doc.actions)) {
      errors.push({ path: `${path}/actions`, message: '`actions` must be an array' });
    } else {
      doc.actions.forEach((a, i) => checkAction(a, `${path}/actions/${i}`, errors));
    }
  }
}

/** Validate a {@link Stage} aggregate (course metadata; scenes are separate). */
export function validateStage(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc))
    return { valid: false, errors: [{ path: '/', message: 'stage must be an object' }] };
  reqString(doc, 'id', '', errors);
  reqString(doc, 'name', '', errors);
  reqNumber(doc, 'createdAt', '', errors);
  reqNumber(doc, 'updatedAt', '', errors);
  return done(errors);
}

/** Validate a {@link Scene} aggregate, including its nested content + actions. */
export function validateScene(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkScene(doc, '', errors);
  return done(errors);
}

/** Validate a standalone activity content payload. */
export function validateActivityContent(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkActivityContent(doc, '', errors);
  return done(errors);
}

/** Validate a standalone interactive content payload. */
export function validateInteractiveContent(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkInteractiveContent(doc, '', errors);
  return done(errors);
}

/** Validate a standalone current or legacy PBL content payload. */
export function validatePBLContent(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkPBLContent(doc, '', errors);
  return done(errors);
}

/** Validate a single {@link Action}, including its variant-required fields. */
export function validateAction(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkAction(doc, '', errors);
  return done(errors);
}

/** Required envelope fields of a runtime session, with their runtime kinds. */
const RUNTIME_SESSION_REQUIRED_FIELDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  kind: 'string',
  stageId: 'string',
  learnerKey: 'string',
  status: 'string',
  createdAt: 'string',
  updatedAt: 'string',
};

/**
 * Validate a runtime session envelope (#869). Payloads live on records, so
 * this is a pure envelope check; `kind` is an open string by design.
 */
export function validateRuntimeSession(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) {
    return { valid: false, errors: [{ path: '/', message: 'runtime session must be an object' }] };
  }
  checkFields(doc, RUNTIME_SESSION_REQUIRED_FIELDS, {}, errors);
  if (typeof doc.status === 'string' && !isRuntimeSessionStatus(doc.status)) {
    errors.push({
      path: '/status',
      message: `unknown session status: ${JSON.stringify(doc.status)}`,
    });
  }
  // `createdAt` / `updatedAt` are documented ISO-8601 strings. The table check
  // above only proves they are strings and, being required, already reports an
  // empty string as non-empty. Refine only a present NON-EMPTY string to the ISO
  // format, so an empty (or wrong-typed) value is reported once — by the table —
  // not twice at the same path.
  if (typeof doc.createdAt === 'string' && doc.createdAt !== '' && !isIsoTimestamp(doc.createdAt)) {
    errors.push({ path: '/createdAt', message: 'expected ISO 8601 `createdAt`' });
  }
  if (typeof doc.updatedAt === 'string' && doc.updatedAt !== '' && !isIsoTimestamp(doc.updatedAt)) {
    errors.push({ path: '/updatedAt', message: 'expected ISO 8601 `updatedAt`' });
  }
  // `runtimeDslVersion` is REQUIRED on a session: sessions are stamped at write
  // time and the runtime line has no unversioned epoch (nothing legitimately
  // predates the runtime envelope), so an absent stamp is a bug — a misrouted
  // legacy document or an unstamped producer write — not legacy data to lift.
  // Kept as its own block (not folded into the required-field table) so an
  // absent stamp gets a specific message and is reported exactly once at
  // `/runtimeDslVersion`. A present stamp must be a well-formed `x.y.z` string:
  // `migrateRuntime`/`runtimeDslVersionOf` throw on a malformed stamp, so
  // accepting a string like `'legacy'` here would only defer the failure to
  // read time.
  if (doc.runtimeDslVersion === undefined) {
    errors.push({
      path: '/runtimeDslVersion',
      message: 'missing `runtimeDslVersion`; runtime sessions are stamped at write time',
    });
  } else if (typeof doc.runtimeDslVersion !== 'string') {
    errors.push({ path: '/runtimeDslVersion', message: 'expected string `runtimeDslVersion`' });
  } else if (!isWellFormedDslVersion(doc.runtimeDslVersion)) {
    errors.push({
      path: '/runtimeDslVersion',
      message: 'malformed `runtimeDslVersion`: expected x.y.z',
    });
  }
  // A session versions on `runtimeDslVersion`; the document line's `dslVersion`
  // is never part of a session's shape. This is the one deliberate exception to
  // the structural-subset rule (unknown fields ignored): a stray sibling stamp
  // is evidence of a misrouted migration, and once stored it makes the envelope
  // ambiguous to the cross-line guard (`migrate`/`migrateRuntime` fail loud on
  // own-stamp-absent + sibling-stamp-present), so reject it at the door.
  if (doc.dslVersion !== undefined) {
    errors.push({
      path: '/dslVersion',
      message:
        'unexpected document-line `dslVersion` on a runtime session; sessions version on `runtimeDslVersion`',
    });
  }
  return done(errors);
}

/** Required envelope fields of a runtime record, with their runtime kinds. */
const RUNTIME_RECORD_REQUIRED_FIELDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  sessionId: 'string',
  seq: 'number',
  createdAt: 'string',
};

/** Optional anchor fields of a runtime record, with their runtime kinds. */
const RUNTIME_RECORD_OPTIONAL_FIELDS: Readonly<Record<string, FieldKind>> = {
  sceneId: 'string',
  actionIndex: 'number',
  subAnchor: 'string',
};

/**
 * Validate a runtime record envelope (#869). The payload is app-owned and
 * checked only for presence — per-kind payload validators are injected at
 * the store boundary, exactly like scene-content validators (#860).
 */
export function validateRuntimeRecord(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) {
    return { valid: false, errors: [{ path: '/', message: 'runtime record must be an object' }] };
  }
  checkFields(doc, RUNTIME_RECORD_REQUIRED_FIELDS, {}, errors);
  checkFields(doc, RUNTIME_RECORD_OPTIONAL_FIELDS, { optional: true }, errors);

  // `seq` is the sole replay ordering key, so it must be a real array-like
  // index. `matchesKind(_, 'number')` above already accepts NaN / Infinity /
  // negative / fractional (all `typeof === 'number'`); narrow to a non-negative
  // integer here so a malformed value can't silently corrupt replay order.
  if (typeof doc.seq === 'number' && !(Number.isInteger(doc.seq) && doc.seq >= 0)) {
    errors.push({ path: '/seq', message: 'expected non-negative integer `seq`' });
  }
  // `actionIndex` is an index into a scene's actions when present: same
  // non-negative-integer rule as `seq` (a wrong-typed value was already flagged
  // by the optional-field check above, so only refine a present number here).
  if (
    typeof doc.actionIndex === 'number' &&
    !(Number.isInteger(doc.actionIndex) && doc.actionIndex >= 0)
  ) {
    errors.push({ path: '/actionIndex', message: 'expected non-negative integer `actionIndex`' });
  }

  // `createdAt` is a documented ISO-8601 string (display metadata; ordering is
  // `seq`). Refine only a present non-empty string to the ISO format; an empty
  // string is already reported once by the required-field table above.
  if (typeof doc.createdAt === 'string' && doc.createdAt !== '' && !isIsoTimestamp(doc.createdAt)) {
    errors.push({ path: '/createdAt', message: 'expected ISO 8601 `createdAt`' });
  }

  // Require a real payload value, not merely the key. `'payload' in doc` would
  // pass an explicit `{ payload: undefined }`; reject that. `null` stays legal —
  // it is a value an app may have deliberately stored.
  if (doc.payload === undefined) {
    errors.push({ path: '/payload', message: 'expected `payload`' });
  }
  return done(errors);
}
