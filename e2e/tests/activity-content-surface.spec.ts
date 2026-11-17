import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Activity lab surface, end to end:
 *  - the Pro-mode editor seeds from a code or SQL activity,
 *  - "Verify lab" runs the reference and the starter through the real browser
 *    runtime (Pyodide / PGlite) and proves the checks are satisfiable but not
 *    already met,
 *  - playback runs the starter (fails), then the learner's fix (passes).
 *
 * Labs are seeded through the server, like the quiz surface spec.
 */

async function seedDocument(page: Page, stageId: string, scene: Record<string, unknown>) {
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Lab deck',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [scene],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
}

async function seedCodeActivity(page: Page, prefix: string): Promise<string> {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId(prefix);
  const now = Date.now();
  await seedDocument(page, stageId, {
    id: 'scene-activity',
    stageId,
    type: 'activity',
    title: 'Build add()',
    order: 0,
    content: {
      type: 'activity',
      kind: 'code',
      language: 'python',
      entryFile: 'main.py',
      instructions: 'Write a function add(a, b) that returns the sum.',
      files: [{ path: 'main.py', content: 'def add(a, b):\n    return 0\n' }],
      tests: [
        {
          id: 'adds',
          name: 'adds two numbers',
          code: 'from main import add\nassert add(2, 3) == 5',
        },
      ],
      checks: [{ id: 'tests', type: 'expectTests' }],
      referenceFiles: [{ path: 'main.py', content: 'def add(a, b):\n    return a + b\n' }],
    },
    createdAt: now,
    updatedAt: now,
  });
  return stageId;
}

async function seedSqlActivity(page: Page, prefix: string): Promise<string> {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId(prefix);
  const now = Date.now();
  await seedDocument(page, stageId, {
    id: 'scene-sql',
    stageId,
    type: 'activity',
    title: 'Create the adults view',
    order: 0,
    content: {
      type: 'activity',
      kind: 'sql',
      instructions: 'Create a view named adults with every learner aged 21 or older.',
      setupSql:
        "create table learners (id int primary key, name text, age int); insert into learners values (1, 'Ada', 24), (2, 'Grace', 19), (3, 'Linus', 31);",
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
    },
    createdAt: now,
    updatedAt: now,
  });
  return stageId;
}

function activityEditor(page: Page) {
  const editor = page.locator('[data-activity-editor]');
  const atTarget = async (on: boolean) => {
    try {
      await expect(editor)[on ? 'toBeVisible' : 'toBeHidden']({ timeout: 1500 });
      return true;
    } catch {
      return false;
    }
  };
  const setProMode = async (on: boolean) => {
    if (await atTarget(on)) return;
    const switches = page.getByRole('switch');
    const count = await switches.count();
    for (let i = 0; i < count; i++) {
      await switches
        .nth(i)
        .click()
        .catch(() => {});
      if (await atTarget(on)) return;
    }
    await expect(editor)[on ? 'toBeVisible' : 'toBeHidden']();
  };
  return { editor, setProMode };
}

test.describe('Activity content surface', () => {
  test('verify the code reference, then solve the lab in playback', async ({ page }, testInfo) => {
    const STAGE = await seedCodeActivity(page, 'e2e-activity-surface');

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE);
    await classroom.waitForLoaded();

    const { editor, setProMode } = activityEditor(page);
    await setProMode(true);
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // Authoring writes through to the scene store.
    const instructions = page.getByTestId('activity-instructions');
    await instructions.fill('Write add(a, b) and make every test pass.');
    await expect(instructions).toHaveValue('Write add(a, b) and make every test pass.');

    // Reference verification runs twice through the browser Python runtime.
    await page.getByTestId('activity-verify').click();
    const verification = page.getByTestId('activity-verification');
    await expect(verification).toContainText('Lab verified', { timeout: 120_000 });

    await testInfo.attach('activity-editor-verified', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await setProMode(false);

    // Playback shows the authored brief and runs the starter.
    await expect(page.getByText('Write add(a, b) and make every test pass.')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('activity-run').click();
    await expect(page.getByTestId('activity-status')).toContainText(
      'Some checks need another look',
      { timeout: 120_000 },
    );

    // The learner fixes the function and every check passes.
    await page.getByTestId('activity-code').fill('def add(a, b):\n    return a + b\n');
    await page.getByTestId('activity-run').click();
    await expect(page.getByTestId('activity-status')).toContainText('All checks passed', {
      timeout: 120_000,
    });

    await testInfo.attach('activity-playback-passed', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });

  test('verify the SQL reference, then create the view in playback', async ({ page }, testInfo) => {
    const STAGE = await seedSqlActivity(page, 'e2e-sql-activity');

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE);
    await classroom.waitForLoaded();

    const { editor, setProMode } = activityEditor(page);
    await setProMode(true);
    await expect(editor).toBeVisible({ timeout: 10_000 });

    // The seeded setup and starter SQL reach the editor.
    await expect(page.getByTestId('activity-setup-sql')).toHaveValue(/create table learners/);
    await expect(page.getByTestId('activity-starter-sql')).toHaveValue('select * from learners;');

    await page.getByTestId('activity-verify').click();
    const verification = page.getByTestId('activity-verification');
    await expect(verification).toContainText('Lab verified', { timeout: 180_000 });

    await testInfo.attach('sql-activity-editor-verified', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await setProMode(false);

    // The starter runs, but the probe cannot find the view yet.
    await page.getByTestId('activity-run').click();
    await expect(page.getByTestId('activity-status')).toContainText(
      'Some checks need another look',
      { timeout: 180_000 },
    );
    await expect(page.getByTestId('activity-sql-output')).toContainText(/does not exist/);

    // The learner creates the view; the probe returns the expected rows.
    await page
      .getByTestId('activity-sql')
      .fill('create view adults as select name from learners where age >= 21;');
    await page.getByTestId('activity-run').click();
    await expect(page.getByTestId('activity-status')).toContainText('All checks passed', {
      timeout: 180_000,
    });
    await expect(page.getByTestId('activity-sql-output')).toContainText('Ada');

    await testInfo.attach('sql-activity-playback-passed', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
