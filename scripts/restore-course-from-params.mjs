/**
 * One-shot course creation from parameters.
 *
 * Uses the app's own HTTP workflow: extract/index (if no handle is given),
 * outline stream, document persistence, then a backend generation job.
 * Credentials are read from .env.local locally and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureCoverSlide } from './lib/cover-slide.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const root = process.cwd();
const pdf = arg('--pdf');
const model = arg('--model', 'opencode:opencode-go/hungerg-free');
const handle = arg('--handle');
const indexFile = arg('--index-file');
const requirement = arg(
  '--requirement',
  'Teach a semester-long professional course on Unix and Linux system administration using the Unix and Linux System Administration Handbook (2017, Addison-Wesley). Cover the Unix philosophy and command-line environment, filesystems and storage, users and permissions, process and service management, networking, DNS and email, logging and monitoring, backups and recovery, shell scripting and automation, package management, virtualization and containers, and security hardening. Use precise industry terminology and practical examples suitable for working system administrators.',
);
const preset = arg('--preset', 'semester');
const base = 'http://127.0.0.1:3000';
const out = arg('--result', path.join(root, '.data', 'course-creation-result.json'));
const requestedStageId = arg('--stage-id');
const checkpoint = arg('--checkpoint', out + '.checkpoint.json');

function token() {
  const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  const match = /^PERSISTENCE_DEV_TOKEN=(.+)$/m.exec(env);
  return match ? match[1].trim() : '';
}

async function readSse(response, label, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const result = { final: null, syllabus: null, outlines: [], unitDone: -1, error: null };
  let events = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      onFrame?.();
      events += 1;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === 'done' || (!evt.type && evt.outlines)) result.final = evt;
      if (evt.type === 'syllabus') {
        result.syllabus = {
          units: evt.units,
          lessons: evt.lessons,
          languageDirective: evt.languageDirective,
          courseTitle: evt.courseTitle,
          audience: evt.audience,
          objectives: evt.objectives,
        };
      }
      if (evt.type === 'outline' && evt.data?.id) result.outlines.push(evt.data);
      if (evt.type === 'unitDone' && typeof evt.index === 'number') {
        result.unitDone = Math.max(result.unitDone, evt.index);
      }
      if (evt.type === 'error') {
        result.error = typeof evt.error === 'string' ? evt.error : JSON.stringify(evt);
        console.error(label + ' stream error', result.error.slice(0, 400));
      }
    }
  }
  console.log(
    label + ' events=' + events + ' terminal=' + (result.final ? 'yes' : 'no') +
      ' outlines=' + result.outlines.length + ' unitDone=' + result.unitDone,
  );
  return result;
}

async function extractAndIndex() {
  if (!pdf) throw new Error('--pdf is required when no --handle is given');
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(pdf)], { type: 'application/pdf' }), path.basename(pdf));
  const extracted = await fetch(base + '/api/extract-document', { method: 'POST', body: form });
  if (!extracted.ok) throw new Error('extract failed: ' + extracted.status);
  const ed = await extracted.json();
  // Bound the index request: a full 1,000+ page textbook can be several MB.
  // Evenly spaced slices preserve whole-book coverage without a giant payload.
  let text = ed.data.text || '';
  if (text.length > 500_000) {
    const count = 480;
    const width = Math.ceil(500_000 / count);
    const slices = [];
    for (let i = 0; i < count; i += 1) {
      const start = Math.floor((i / count) * (text.length - width));
      slices.push(text.slice(start, start + width));
    }
    text = slices.join('\n\n---\n\n');
    console.log('sampled index text to ' + text.length + ' chars');
  }
  const index = await fetch(base + '/api/documents/index', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, images: [], language: 'en' }),
  });
  if (!index.ok) throw new Error('index failed: ' + index.status);
  const done = await readSse(index, 'index');
  if (!done.final) throw new Error('index produced no terminal event');
  return done.final.data;
}

const modelHeaders = {
  'content-type': 'application/json',
  'x-model': model,
  // The server's opencode provider is an OpenAI-compatible provider, so its
  // declared type is 'openai' — sending 'opencode' is rejected as a mismatch.
  'x-provider-type': 'openai',
  'x-base-url': 'http://127.0.0.1:8787/v1',
};

let indexDone;
if (handle) {
  indexDone = { handle, digest: indexFile ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).digest : undefined };
} else {
  indexDone = await extractAndIndex();
}
console.log('handle=' + indexDone.handle);

// Publish a placeholder immediately so the course card exists (and is
// pausable/removable) while the outline stream is still running.
const now = Date.now();
const stageId = requestedStageId || 'stage-' + randomBytes(9).toString('base64url');
const cancelPath = path.join(root, 'data', 'course-creation', `${stageId}.cancel`);
const persistenceHeaders = {
  'content-type': 'application/json',
  authorization: 'Bearer ' + token(),
  'x-learner-key': 'local',
};
const putDocument = async (document) => {
  const saved = await fetch(base + '/api/persistence/documents/' + stageId, {
    method: 'PUT',
    headers: persistenceHeaders,
    body: JSON.stringify(document),
  });
  if (!saved.ok) {
    throw new Error('document save failed: ' + saved.status + ' ' + (await saved.text()).slice(0, 500));
  }
};
await putDocument({
  dslVersion: '0.3.0',
  stage: {
    id: stageId,
    name: arg('--title') || 'Course (generating)',
    style: 'professional',
    createdAt: now,
    updatedAt: now,
    interactiveMode: false,
    taskEngineMode: false,
  },
  scenes: [],
  outline: {
    outlines: [],
    lessonGroups: [],
    requirement,
    generationComplete: false,
    generationActive: true,
    createdAt: now,
    updatedAt: now,
  },
});
console.log('placeholder stage=' + stageId);

const setActive = async (active) => {
  const response = await fetch(base + '/api/persistence/documents/' + stageId, {
    headers: persistenceHeaders,
  });
  if (!response.ok) return;
  const payload = await response.json();
  const document = payload.document ?? payload.data ?? payload;
  if (!document.outline) return;
  document.outline.generationActive = active;
  document.stage.updatedAt = Date.now();
  await putDocument(document);
};

const outlineBody = {
  requirements: {
    requirement,
    userNickname: '',
    userBio: '',
    webSearch: false,
    interactiveMode: false,
    taskEngineMode: false,
  },
  sizePreset: preset,
  pdfHandle: indexDone.handle,
  pdfDigest: indexDone.digest,
  pdfImages: [],
  imageMapping: {},
};
// A long semester stream can die mid-flight on transient provider errors.
// The app's own resume contract lets us restart from the last completed unit
// instead of paying for the whole outline pass again.
let cp = null;
try {
  cp = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
} catch {
  // No prior checkpoint: start fresh.
}
const collected = new Map();
for (const o of cp?.outlines ?? []) if (o?.id) collected.set(o.id, o);
let syllabus = cp?.syllabus ?? null;
let resumeFromUnitIndex = cp?.resumeFromUnitIndex ?? 0;
let final = null;
const outlineFile = arg('--outline-file', out + '.outlines.json');
if (fs.existsSync(outlineFile)) {
  final = JSON.parse(fs.readFileSync(outlineFile, 'utf8'));
  console.log('loaded outlines from ' + outlineFile + ' count=' + (final.outlines || []).length);
} else {
const MAX_ATTEMPTS = 8;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const body = { ...outlineBody };
  if (collected.size) body.resumeOutlines = [...collected.values()];
  if (syllabus) body.resumeSyllabus = syllabus;
  if (resumeFromUnitIndex > 0) body.resumeFromUnitIndex = resumeFromUnitIndex;
  console.log(
    'outline attempt ' + attempt + ' resumed=' + (attempt > 1) + ' unit=' +
      resumeFromUnitIndex + ' outlines=' + collected.size,
  );
  let stream;
  try {
    stream = await fetch(base + '/api/generate/scene-outlines-stream', {
      method: 'POST',
      headers: modelHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4 * 60 * 60 * 1000),
    });
  } catch (error) {
    console.error('outline stream fetch failed: ' + String(error).slice(0, 300));
    continue;
  }
  if (!stream.ok) {
    console.error('outline stream status=' + stream.status + ' ' + (await stream.text()).slice(0, 400));
    continue;
  }
  let run;
  try {
    run = await readSse(stream, 'outlines', () => {
      if (fs.existsSync(cancelPath)) throw new Error('OUTLINE_CANCELLED');
    });
  } catch (error) {
    if (!String(error).includes('OUTLINE_CANCELLED')) throw error;
    fs.rmSync(cancelPath, { force: true });
    await setActive(false);
    console.log('outline generation cancelled by user');
    process.exit(0);
  }
  for (const o of run.outlines) if (o?.id) collected.set(o.id, o);
  if (run.syllabus) syllabus = run.syllabus;
  if (run.unitDone >= 0) resumeFromUnitIndex = Math.max(resumeFromUnitIndex, run.unitDone + 1);
  if (run.final) {
    final = run.final;
    break;
  }
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  fs.writeFileSync(
    checkpoint,
    JSON.stringify(
      { outlines: [...collected.values()], syllabus, resumeFromUnitIndex, error: run.error },
      null,
      2,
    ),
  );
  console.log('checkpoint saved: ' + checkpoint);
}
if (!final) throw new Error('outline stream did not complete after ' + MAX_ATTEMPTS + ' attempts');
fs.rmSync(checkpoint, { force: true });
// Persist the expensive outline result BEFORE any document write: a later
// failure must never force us to re-pay a 600-outline model pass.
fs.mkdirSync(path.dirname(outlineFile), { recursive: true });
fs.writeFileSync(outlineFile, JSON.stringify(final));
console.log('saved outlines to ' + outlineFile);
}

const outlines = final.outlines || [];
const blueprint = final.blueprint;
const title = arg('--title') || final.courseTitle || 'Unix and Linux System Administration';
const languageDirective = final.languageDirective || '';
if (!outlines.length) throw new Error('no outlines generated');

const groups = new Map();
for (const outline of outlines) {
  const lessonId = outline.lessonId || (blueprint?.lessons || []).find((l) =>
    (l.outlines || []).some((o) => o.id === outline.id),
  )?.title || 'lesson_1';
  if (!groups.has(lessonId)) groups.set(lessonId, []);
  groups.get(lessonId).push(outline.id);
}
const lessonGroups = [...groups].map(([lessonId, ids]) => ({
  lessonId,
  jobs: ids.map((outlineId) => ({
    outlineId,
    phases: Object.fromEntries(
      ['content', 'actions', 'tts', 'media', 'layout', 'semantics'].map((phase) => [
        phase,
        { status: 'pending', attempts: 0, updatedAt: now },
      ]),
    ),
  })),
}));

const document = {
  dslVersion: '0.3.0',
  stage: {
    id: stageId,
    name: title,
    style: 'professional',
    createdAt: now,
    updatedAt: now,
    interactiveMode: false,
    taskEngineMode: false,
    languageDirective,
  },
  scenes: [],
  outline: {
    outlines,
    blueprint,
    lessonGroups,
    requirement,
    generationComplete: false,
    generationActive: false,
    createdAt: now,
    updatedAt: now,
  },
};
const saved = await fetch(base + '/api/persistence/documents/' + stageId, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + token(),
    'x-learner-key': 'local',
  },
  body: JSON.stringify(document),
});
if (!saved.ok) throw new Error('document save failed: ' + saved.status + ' ' + (await saved.text()).slice(0, 500));
console.log('saved stage=' + stageId + ' outlines=' + outlines.length + ' lessons=' + lessonGroups.length);

// A graphic opening slide makes the course card a real preview instead of a
// text wall. It is optional: a provider failure must never block generation.
try {
  const cover = await ensureCoverSlide({
    base,
    token: token(),
    stageId,
    title,
    description: requirement,
    modelHeaders,
  });
  console.log('cover=' + JSON.stringify(cover));
} catch (error) {
  console.error('cover slide skipped: ' + String(error).slice(0, 400));
}

const started = await fetch(base + '/api/generation/continue', {
  method: 'POST',
  headers: modelHeaders,
  body: JSON.stringify({ stageId, includeFailed: true }),
});
if (!started.ok) throw new Error('job start failed: ' + started.status + ' ' + (await started.text()).slice(0, 500));
const job = await started.json();
console.log('job=' + job.jobId);
fs.writeFileSync(out, JSON.stringify({ stageId, jobId: job.jobId, title, outlines: outlines.length, model }, null, 2));
console.log('wrote ' + out);
