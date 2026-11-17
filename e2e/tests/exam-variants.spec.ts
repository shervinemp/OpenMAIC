import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const SETTINGS_STORAGE = createSettingsStorage();

/**
 * Semester exam overlay, end to end:
 *  - the pool is seeded with a two-second budget per section,
 *  - Section A auto-advances to Section B when its timer expires,
 *  - Section B auto-submits when its timer expires, and
 *  - the saved attempt feeds the list's performance analytics.
 *
 * The written grader is mocked because this spec tests the exam harness, not
 * the LLM rubric grader (covered by `tests/api/exam-grade.test.ts`).
 */

const MC_POOL = Array.from({ length: 4 }, (_, index) => ({
  id: `mc_${index + 1}`,
  question: `Scenario ${index + 1}: pick the defensible option.`,
  options: [
    { label: `Correct ${index + 1}`, value: 'A' },
    { label: `Distractor ${index + 1}`, value: 'B' },
    { label: `Distractor ${index + 1}B`, value: 'C' },
    { label: `Distractor ${index + 1}C`, value: 'D' },
  ],
  answer: ['A'],
  analysis: 'A is defensible; the distractors encode common confusions.',
  points: 1,
}));

const FR_POOL = Array.from({ length: 2 }, (_, index) => ({
  id: `fr_${index + 1}`,
  prompt: `Written task ${index + 1}: justify your design.`,
  rubric: [
    { id: `r${index}a`, criterion: 'Names the constraint', weight: 'essential', lookFor: 'x' },
    { id: `r${index}b`, criterion: 'Justifies the choice', weight: 'important', lookFor: 'y' },
  ],
  sampleAnswer: 'A strong answer.',
  maxPoints: 10,
}));

function midtermSpec(generatedAt: number, timing = { mcSec: 3, frSec: 3 }) {
  return {
    kind: 'midterm',
    title: 'Midterm Exam',
    coverage: 'Units 1-1',
    unitRange: { from: 0, to: 0 },
    mcQuestions: MC_POOL,
    frQuestions: FR_POOL,
    formConfig: { mcCount: 2, frCount: 1 },
    timing,
    generatedAt,
  };
}

async function seedExamCourse(
  page: Page,
  prefix: string,
  options: { withMidterm?: boolean } = {},
): Promise<string> {
  const { withMidterm = true } = options;
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });

  const stageId = uniqueStageId(prefix);
  const now = Date.now();
  const blueprint = {
    title: 'Exam harness',
    languageDirective: 'Teach in English.',
    durationMinutes: 120,
    audience: 'students',
    objectives: ['Explain the material', 'Apply it under constraints'],
    courseType: 'explainer',
    lessonCount: 2,
    quizPlacement: 4,
    units: [1, 2].map((unit) => ({
      title: `Unit ${unit}`,
      objectives: [`Objective ${unit}`],
      durationMinutes: 60,
      sceneTarget: 1,
      lessons: [],
    })),
    lessons: [],
  };

  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Exam harness',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [],
    outline: {
      outlines: [],
      blueprint,
      lessonGroups: [],
      generationComplete: true,
      exams: withMidterm ? { midterm: midtermSpec(now) } : {},
      examAttempts: {},
      createdAt: now,
      updatedAt: now,
    },
  });
  return stageId;
}

test.describe('Exam variants and timers', () => {
  test('times both sections, auto-submits, and records analytics', async ({ page }, testInfo) => {
    const stageId = await seedExamCourse(page, 'e2e-exam-variants');

    await page.route('**/api/exam/grade-fr', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          score: 6,
          maxPoints: 10,
          comment: 'Solid justification.',
          criteria: [{ id: 'r0a', met: true, comment: 'named' }],
        }),
      }),
    );

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Exams' }).click();
    await expect(page.getByRole('dialog', { name: 'Exams' })).toBeVisible();
    await expect(page.getByText('Midterm Exam').first()).toBeVisible();

    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('timer')).toBeVisible();

    // Section A expires and hands over without losing the learner's work.
    await expect(page.getByText(/Time is up for Section A/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Section B — Constructed response')).toBeVisible();

    // Section B expires and submits the attempt.
    await expect(
      page.getByText('Submitted automatically when the section timer ran out.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Overall score')).toBeVisible();

    await testInfo.attach('exam-auto-submitted', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'Close exam' }).click();
    await page.getByRole('button', { name: 'Exams' }).click();

    const performance = page.getByText('Performance', { exact: true });
    await expect(performance).toBeVisible();
    await performance.click();
    await expect(page.getByText('Weakest multiple choice')).toBeVisible();
    await expect(page.getByText('Weakest written')).toBeVisible();
    await expect(page.getByText(/#1 · \d+%/)).toBeVisible();

    await testInfo.attach('exam-analytics', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});

test.describe('Exam generation hand-off', () => {
  test('starts a freshly generated exam without a reload', async ({ page }) => {
    const stageId = await seedExamCourse(page, 'e2e-exam-generated', { withMidterm: false });
    const now = Date.now();
    await page.route('**/api/generate/exam', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          exam: midtermSpec(now, { mcSec: 1200, frSec: 1800 }),
        }),
      }),
    );

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Exams' }).click();
    await page.getByRole('button', { name: 'Generate' }).first().click();

    // The freshly returned spec is used immediately; the exam does not sit in
    // the list waiting for a store round-trip.
    await expect(page.getByRole('timer')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Section A — Multiple choice')).toBeVisible();

    await page.getByRole('button', { name: 'Close exam' }).click();
    await page.getByRole('button', { name: 'Exams' }).click();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  });
});
