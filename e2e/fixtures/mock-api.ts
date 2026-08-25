import type { Page } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { mockSceneContentResponse } from './test-data/scene-content';
import { createMockSceneActionsResponse } from './test-data/scene-actions';

/**
 * Multi-unit SSE fixture: two units with distinct lesson decks, including one
 * analytic-kind outline (comparison) so the deck exercises the §15.9 kinds.
 */
export const mockMultiUnitLessons: Array<{ title: string; objectives: string[] }> = [
  { title: 'Transport Basics', objectives: ['Explain packets'] },
  { title: 'Choosing Protocols', objectives: ['Compare TCP and UDP'] },
  { title: 'Caching & Balancing', objectives: ['Read a hit-rate chart'] },
];

export const mockMultiUnitOutlines = [
  {
    id: 'mu-1',
    type: 'slide' as const,
    title: 'Why Reliable Transport Matters',
    description: 'Motivate TCP.',
    keyPoints: ['IP is best-effort', 'TCP repairs loss'],
    order: 1,
    lessonId: 'mu-lesson-1',
  },
  {
    id: 'mu-2',
    type: 'comparison' as const,
    title: 'TCP vs UDP Side by Side',
    description: 'Compare the two transports.',
    keyPoints: ['Reliability', 'Overhead'],
    order: 2,
    lessonId: 'mu-lesson-1',
  },
  {
    id: 'mu-3',
    type: 'dataReading' as const,
    title: 'Reading a Hit-Rate Chart',
    description: 'Evaluate claims against plotted values.',
    keyPoints: ['Hit rate rises with size'],
    order: 3,
    lessonId: 'mu-lesson-2',
  },
];

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /** Mock the SSE outline streaming endpoint */
  async mockSceneOutlinesStream(outlines = mockOutlines) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const events = outlines
        .map(
          (outline, i) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index: i })}\n\n`,
        )
        .join('');
      const done = `data: ${JSON.stringify({ type: 'done', outlines, courseTitle: 'Mock Course' })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });
  }

  /** Mock the scene content generation endpoint */
  async mockSceneContent(response = mockSceneContentResponse) {
    await this.page.route('**/api/generate/scene-content', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
    });
  }

  /** Mock the scene actions generation endpoint.
   *  When no stageId is provided, it is extracted from the request body
   *  so the mock response matches the dynamically-generated stage id. */
  async mockSceneActions(stageId?: string) {
    await this.page.route('**/api/generate/scene-actions', async (route) => {
      let id = stageId ?? 'test-stage';
      if (!stageId) {
        try {
          const body = route.request().postDataJSON();
          if (body?.stageId) id = body.stageId;
        } catch {
          // fallback to default
        }
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMockSceneActionsResponse(id)),
      });
    });
  }

  /** Mock the server providers endpoint (returns empty — client-side config only) */
  async mockServerProviders() {
    await this.page.route('**/api/server-providers', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: {} }),
      });
    });
  }

  /** Mock the multi-unit SSE stream: syllabus → per-unit outlines + unitDone checkpoints → done. */
  async mockMultiUnitOutlinesStream(
    outlines = mockMultiUnitOutlines,
    lessons = mockMultiUnitLessons,
  ) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const head = [
        `data: ${JSON.stringify({
          type: 'languageDirective',
          data: 'Teach in English.',
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'courseTitle', data: 'Networking Essentials' })}\n\n`,
        `data: ${JSON.stringify({ type: 'syllabus', units: [
          { title: 'Unit 1', lessons: lessons.slice(0, 2) },
          { title: 'Unit 2', lessons: lessons.slice(2) },
        ] })}\n\n`,
      ];
      const unit1 = outlines.filter((o) => o.lessonId === 'mu-lesson-1');
      const unit2 = outlines.filter((o) => o.lessonId !== 'mu-lesson-1');
      const stream = (items: typeof outlines, startIndex: number) =>
        items
          .map(
            (outline, i) =>
              `data: ${JSON.stringify({ type: 'outline', data: outline, index: startIndex + i })}\n\n`,
          )
          .join('') +
          `data: ${JSON.stringify({ type: 'unitDone', index: startIndex === 0 ? 0 : 1 })}\n\n`;
      const done = `data: ${JSON.stringify({
        type: 'done',
        outlines,
        courseTitle: 'Networking Essentials',
        languageDirective: 'Teach in English.',
        blueprint: { courseTitle: 'Networking Essentials', lessons: [] },
      })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: head.join('') + stream(unit1, 0) + stream(unit2, unit1.length) + done,
      });
    });
  }

  /** Set up API mocks for the generation flow. Note: server-providers is already mocked by the base fixture. */
  async setupGenerationMocks(stageId?: string) {
    await this.mockSceneOutlinesStream();
    await this.mockSceneContent();
    await this.mockSceneActions(stageId);
  }
}
