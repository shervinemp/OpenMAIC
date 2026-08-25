import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Multi-unit outline streaming (Phase 2 §15.8): the SSE stream carries a
 * syllabus, per-unit outline batches with unitDone checkpoints, and a final
 * done event with the assembled blueprint. The analytic scene kinds
 * (comparison / dataReading) ride through as first-class outline types.
 */
test.describe('Multi-unit outline streaming', () => {
  test('syllabus + per-unit outlines + unitDone checkpoints reach the classroom', async ({
    page,
    mockApi,
  }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.mockSceneContent();
    await mockApi.mockSceneActions();
    await mockApi.mockMultiUnitOutlinesStream();

    const home = new HomePage(page);
    await home.goto();
    await home.fillRequirement('Teach me computer networking');
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    // The mocked stream completes near-instantly, so the page may already be
    // in the classroom when we look - assert on the end state, whose sidebar
    // carries every outline title from the multi-unit deck.
    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();
    await expect(
      page.getByText('Why Reliable Transport Matters', { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });
  });
});
