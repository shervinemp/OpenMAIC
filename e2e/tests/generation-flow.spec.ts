import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';

const SETTINGS_STORAGE = createSettingsStorage();
const REVIEW_SETTINGS_STORAGE = createSettingsStorage({ reviewOutlineEnabled: true });

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-test-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

const PERSISTED_REVIEW_SESSION = JSON.stringify({
  sessionId: 'e2e-review-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: mockOutlines,
  languageDirective: 'Use Chinese for the generated course.',
  currentStep: 'generating',
  previewPhase: 'review',
});

// Crash point under test: web search completed (its results are persisted on
// the session) but the outline stream never finished. Resume must reuse the
// persisted research context instead of paying for the query again.
const WEB_SEARCH_DONE_SESSION = JSON.stringify({
  sessionId: 'e2e-websearch-resume',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
    webSearch: true,
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
  researchContext: 'Photosynthesis converts light energy into chemical energy.',
  researchSources: [
    { title: 'Photosynthesis - Wikipedia', url: 'https://en.wikipedia.org/wiki/Photosynthesis' },
  ],
});

test.describe('Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('maic:account:settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('completes generation pipeline and redirects to classroom', async ({ page, mockApi }) => {
    // Set up all API mocks
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Generation card with progress dots should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('opens outline editor from preview review opportunity and resumes generation', async ({
    page,
    mockApi,
  }) => {
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('persists always review preference from the outline editor', async ({ page, mockApi }) => {
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await preview.enableAlwaysReview();

    // The persist write goes through the KVStore and is asynchronous, so poll
    // rather than reading once straight after the toggle.
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw).state.reviewOutlineEnabled : undefined;
        }, SETTINGS_KV_KEY),
      )
      .toBe(true);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });

  test('automatically opens outline editor when always review is enabled', async ({
    page,
    mockApi,
  }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('maic:account:settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: REVIEW_SETTINGS_STORAGE, session: GENERATION_SESSION },
    );

    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForEditor();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });
});

test('resumes generation from a persisted outline review session', async ({ page, mockApi }) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: SETTINGS_STORAGE, session: PERSISTED_REVIEW_SESSION },
  );

  await mockApi.setupGenerationMocks();

  const preview = new GenerationPreviewPage(page);
  await preview.goto();

  await preview.waitForEditor();
  await preview.confirmOutlines();
  await preview.waitForRedirectToClassroom();
  expect(page.url()).toMatch(/\/classroom\//);
});

test('recovers outlines from IndexedDB after a mid-generation reload', async ({
  page,
  mockApi,
}) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: REVIEW_SETTINGS_STORAGE, session: GENERATION_SESSION },
  );

  await mockApi.setupGenerationMocks();

  // Registered AFTER the mocks: Playwright route handlers run LIFO, so this
  // counter runs first, then falls through to the mock. The post-reload
  // assertion uses it to prove the outlines came from the persisted session
  // record — NOT a second SSE run.
  let outlineStreamCalls = 0;
  await page.route('**/api/generate/scene-outlines-stream', async (route) => {
    outlineStreamCalls += 1;
    await route.fallback();
  });

  const preview = new GenerationPreviewPage(page);
  await preview.goto();

  // The outline stream parks at the review editor (reviewOutlineEnabled).
  await preview.waitForEditor();
  await expect(preview.editorTitle).toBeVisible();
  expect(outlineStreamCalls).toBe(1);

  // Real production recovery path: same tab, sessionStorage envelope intact,
  // full session hydrated from the IndexedDB record.
  await page.reload();

  await preview.waitForEditor();
  await expect(preview.editorTitle).toBeVisible();
  // No re-run of the outline stream — the persisted outlines came back.
  expect(outlineStreamCalls).toBe(1);

  // And the flow continues from the exact spot: confirm → content generation.
  await preview.confirmOutlines();
  await preview.waitForRedirectToClassroom();
  expect(page.url()).toMatch(/\/classroom\//);
});

test('resumes past a completed web search without re-running it', async ({ page, mockApi }) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: REVIEW_SETTINGS_STORAGE, session: WEB_SEARCH_DONE_SESSION },
  );

  await mockApi.setupGenerationMocks();

  // Registered after the mocks (LIFO runs it first). The fix means this
  // endpoint is never reached; if a regression re-runs the search, the mock
  // answers and the count assertion below fails.
  let webSearchCalls = 0;
  await page.route('**/api/web-search', async (route) => {
    webSearchCalls += 1;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: 'fresh context',
        sources: [{ title: 'Fresh result', url: 'https://example.com/fresh' }],
      }),
    });
  });

  const preview = new GenerationPreviewPage(page);
  await preview.goto();

  // Resume skips the search and goes straight to the outline step, which
  // parks at the review editor (reviewOutlineEnabled).
  await preview.waitForEditor();
  await expect(preview.editorTitle).toBeVisible();
  expect(webSearchCalls).toBe(0);
});
