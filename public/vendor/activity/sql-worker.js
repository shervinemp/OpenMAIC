/**
 * SQL lab worker (module worker).
 *
 * Loads PGlite from the app's own origin, builds a fresh in-memory database
 * for every attempt, applies the activity's setup SQL, then the learner's
 * submission, and finally runs each declared probe. Nothing here interprets
 * the result — the main thread's deterministic evaluator does that.
 *
 * Isolation tier: browser. The database is ephemeral and cannot reach the
 * host filesystem; SQL has no path to the page's JS globals, so no API
 * blocking is needed (unlike the Python worker).
 */

import { PGlite } from '/vendor/pglite/index.js';

/**
 * Postgres date/time types are returned as JS `Date` objects by default, which
 * makes the same query produce different text in different timezones. Return
 * Postgres's own text form instead so a lab grades identically everywhere.
 */
const TEXT_PARSERS = {
  1082: (value) => value, // date
  1083: (value) => value, // time
  1114: (value) => value, // timestamp without time zone
  1184: (value) => value, // timestamp with time zone
  1266: (value) => value, // time with time zone
};

let currentStage = 'init';

function post(message) {
  self.postMessage(message);
}

function describeError(error) {
  if (!error || typeof error !== 'object') return String(error);
  const parts = [`stage=${currentStage}`];
  if (error.name) parts.push(String(error.name));
  if (error.message) parts.push(String(error.message));
  if (typeof error.detail === 'string') parts.push(error.detail);
  if (typeof error.hint === 'string') parts.push(error.hint);
  if (typeof error.position === 'string') parts.push(`position=${error.position}`);
  if (parts.length === 1 && typeof error.stack === 'string') parts.push(error.stack);
  return parts.join('\n');
}

/** Coerce one cell into the JSON-safe union the activity contract compares. */
function toSqlValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  }
  if (value instanceof Uint8Array) {
    return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function runRequest(db, request) {
  const started = performance.now();

  currentStage = 'setup';
  const setupSql = typeof request.setupSql === 'string' ? request.setupSql : '';
  if (setupSql.trim()) {
    try {
      await db.exec(setupSql);
    } catch (error) {
      return {
        status: 'error',
        stdout: '',
        stderr: '',
        error: `The lab setup SQL failed: ${describeError(error)}`,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  currentStage = 'submission';
  let submissionError = '';
  const submissionSql = typeof request.submissionSql === 'string' ? request.submissionSql : '';
  if (submissionSql.trim()) {
    try {
      await db.exec(submissionSql);
    } catch (error) {
      // A broken submission is the learner's result, not a harness failure:
      // the probes run against whatever state the submission left behind and
      // fail with their own error, so nothing is fabricated or auto-passed.
      submissionError = describeError(error);
    }
  }

  const probes = {};
  currentStage = 'probes';
  for (const probe of Array.isArray(request.sqlProbes) ? request.sqlProbes : []) {
    if (!probe || typeof probe.id !== 'string') continue;
    try {
      const result = await db.query(probe.sql, [], {
        rowMode: 'array',
        parsers: TEXT_PARSERS,
      });
      probes[probe.id] = {
        columns: result.fields.map((field) => field.name),
        rows: result.rows.map((row) => row.map(toSqlValue)),
      };
    } catch (error) {
      probes[probe.id] = { error: describeError(error) };
    }
  }

  currentStage = 'done';
  return {
    status: 'ok',
    stdout: '',
    stderr: submissionError,
    exitCode: submissionError ? 1 : 0,
    sqlProbes: probes,
    durationMs: Math.round(performance.now() - started),
  };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== 'run' || typeof message.runId !== 'string') return;

  let db;
  try {
    currentStage = 'open';
    db = new PGlite();
    currentStage = 'ready';
    // Engine start-up is reported separately so the learner's time limit only
    // covers setup + submission + probes.
    await db.waitReady;
    post({ type: 'started', runId: message.runId });

    const result = await runRequest(db, message.request || {});
    post({ type: 'result', runId: message.runId, result });
  } catch (error) {
    post({ type: 'error', runId: message.runId, message: describeError(error) });
  } finally {
    if (db) {
      currentStage = 'close';
      try {
        await db.close();
      } catch {
        /* the worker is discarded if close fails */
      }
    }
  }
};
