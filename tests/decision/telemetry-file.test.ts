import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  flushDecisionTelemetry,
  loadDecisionTelemetryFromDisk,
  resetDecisionTelemetryFileForTests,
} from '@/lib/decision/telemetry-file';
import {
  readDecisionTelemetry,
  readShadowAgreement,
  recordDecisionEvent,
  resetDecisionTelemetryForTests,
} from '@/lib/decision/telemetry';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'openmaic-decision-telemetry-'));
  resetDecisionTelemetryForTests();
  resetDecisionTelemetryFileForTests();
});

afterEach(async () => {
  resetDecisionTelemetryForTests();
  resetDecisionTelemetryFileForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('decision telemetry persistence', () => {
  it('round-trips counters and shadow agreement through one snapshot', async () => {
    const file = path.join(dir, 'nested', 'telemetry.json');
    recordDecisionEvent({
      site: 'exam-grading',
      provider: 'laya',
      mode: 'shadow',
      outcome: 'shadow-agree',
    });
    recordDecisionEvent({
      site: 'exam-grading',
      provider: 'laya',
      mode: 'shadow',
      outcome: 'shadow-disagree',
    });

    await flushDecisionTelemetry(file);
    const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as { savedAt?: number };
    expect(saved.savedAt).toBeTypeOf('number');

    resetDecisionTelemetryForTests();
    expect(readDecisionTelemetry()).toEqual([]);

    loadDecisionTelemetryFromDisk(file);

    expect(readDecisionTelemetry()).toEqual([
      { key: 'exam-grading|laya|shadow|shadow-agree', count: 1 },
      { key: 'exam-grading|laya|shadow|shadow-disagree', count: 1 },
    ]);
    expect(readShadowAgreement()[0]).toMatchObject({
      agree: 1,
      disagree: 1,
      decided: 2,
      agreementRate: 0.5,
    });
  });

  it('overwrites the snapshot instead of appending duplicate counts', async () => {
    const file = path.join(dir, 'overwrite.json');
    recordDecisionEvent({
      site: 'quiz-verify',
      provider: 'laya',
      mode: 'replace',
      outcome: 'decision',
    });
    await flushDecisionTelemetry(file);

    recordDecisionEvent({
      site: 'quiz-verify',
      provider: 'laya',
      mode: 'replace',
      outcome: 'decision',
    });
    await flushDecisionTelemetry(file);

    resetDecisionTelemetryForTests();
    loadDecisionTelemetryFromDisk(file);

    expect(readDecisionTelemetry()).toEqual([
      { key: 'quiz-verify|laya|replace|decision', count: 2 },
    ]);
  });

  it('treats a missing snapshot as a fresh process', () => {
    expect(() => loadDecisionTelemetryFromDisk(path.join(dir, 'absent.json'))).not.toThrow();
    expect(readDecisionTelemetry()).toEqual([]);
  });

  it('ignores a malformed snapshot without throwing', async () => {
    const file = path.join(dir, 'broken.json');
    await fs.writeFile(file, '{not json', 'utf-8');

    expect(() => loadDecisionTelemetryFromDisk(file)).not.toThrow();
    expect(readDecisionTelemetry()).toEqual([]);
  });

  it('loads one file at most once per process', async () => {
    const file = path.join(dir, 'once.json');
    await fs.writeFile(
      file,
      JSON.stringify({ counters: [{ key: 'site|laya|replace|decision', count: 2 }] }),
      'utf-8',
    );

    loadDecisionTelemetryFromDisk(file);
    loadDecisionTelemetryFromDisk(file);

    expect(readDecisionTelemetry()).toEqual([{ key: 'site|laya|replace|decision', count: 2 }]);
  });
});
