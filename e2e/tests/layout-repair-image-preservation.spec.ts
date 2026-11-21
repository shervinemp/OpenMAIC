/**
 * Exercise image preservation through the real on-load layout-repair pipeline,
 * not just the pure helper unit test.
 *
 * The course is seeded into the e2e server's OWN file-backed store
 * (PERSISTENCE_DIR=.data/persistence-e2e in playwright.config.ts), never the
 * developer's workspace store. A fresh browser document then opens the
 * classroom, which runs the on-load maintenance sweep and POSTs to
 * /api/course-maintenance/layout-repair. The seeded slide deliberately has an
 * interior decorative shape with no text over it — a split-ghost — so the
 * repair's apply branch actually runs. In that same pass sit:
 *
 *   - the ghost shape, which MUST be deleted (proves the pass ran), and
 *   - an interior generated image with no text over it, which the pre-fix
 *     orphan logic deleted as a "decorative" and which MUST now survive.
 *
 * The image bytes live in the owner's asset pool, so a surviving element also
 * has to resolve to a blob in the browser.
 */
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import { seedServerDocument, readServerDocument, uniqueStageId } from '../fixtures/server-seed';

const E2E_PERSISTENCE_TOKEN = 'e2e-persistence-token';

/**
 * Like the shared `seedServerAsset`, but carries the file-backed backend's
 * development token (the shared helper only forwards the owner cookie, which
 * the isolated e2e server does not accept for asset writes).
 */
async function seedImageAsset(
  page: import('@playwright/test').Page,
  bytes: Uint8Array,
): Promise<string> {
  const { HttpAssetStore } = await import('@openmaic/storage/asset/http');
  const store = new HttpAssetStore({
    baseUrl: '/api/persistence',
    headers: () => ({ authorization: `Bearer ${E2E_PERSISTENCE_TOKEN}` }),
    fetch: async (input, init) => {
      const body =
        init?.body === undefined || init.body === null
          ? undefined
          : Buffer.from(await new Response(init.body).arrayBuffer());
      const response = await page.request.fetch(String(input), {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(body === undefined ? {} : { data: body }),
      });
      return new Response(response.status() === 204 ? null : await response.body(), {
        status: response.status(),
        headers: response.headers(),
      });
    },
  });
  return store.put(new Blob([bytes], { type: 'image/png' }), { contentType: 'image/png' });
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const GHOST_ID = 'shape-orphan-ghost';
const IMAGE_ID = 'img-generated';

async function seedLayoutDebtStage(page: import('@playwright/test').Page): Promise<{
  stageId: string;
  assetId: string;
}> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId('e2e-layout-image-stage');
  const assetId = await seedImageAsset(page, Buffer.from(PNG_BASE64, 'base64'));
  const now = Date.now();

  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Layout Repair Image Preservation',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: 'scene-layout-image',
        outlineId: 'outline-layout-image',
        stageId,
        type: 'slide',
        title: 'Figure beside the text',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-layout-image',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: '#ffffff' },
            elements: [
              {
                id: 'text-1',
                type: 'text',
                left: 60,
                top: 130,
                width: 400,
                height: 300,
                rotate: 0,
                content: '<p>Collection</p>',
              },
              {
                id: GHOST_ID,
                type: 'shape',
                left: 520,
                top: 130,
                width: 420,
                height: 300,
                rotate: 0,
                path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
                viewBox: [200, 200],
                fill: '#eeeeee',
              },
              {
                id: IMAGE_ID,
                type: 'image',
                left: 520,
                top: 130,
                width: 420,
                height: 300,
                rotate: 0,
                src: assetId,
                mediaRef: assetId,
              },
            ],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: {
      outlines: [
        {
          id: 'outline-layout-image',
          type: 'slide',
          title: 'Figure beside the text',
          description: 'A generated figure that stands alone beside the prose',
          keyPoints: [],
          order: 0,
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
  });
  return { stageId, assetId };
}

test.describe('on-load layout repair', () => {
  test('strips a ghost shape but preserves the interior generated image and its bytes', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { stageId, assetId } = await seedLayoutDebtStage(page);

    // A brand-new document in the same browser context: fresh module state,
    // so the on-load maintenance sweep runs from scratch.
    const classroom = await context.newPage();
    await classroom.goto(`/classroom/${stageId}`);
    await expect(classroom.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });

    const readElements = async (): Promise<Array<Record<string, unknown>>> => {
      const doc = await readServerDocument(page, stageId);
      const scene = doc?.scenes?.[0] as
        | { content?: { canvas?: { elements?: Array<Record<string, unknown>> } } }
        | undefined;
      return scene?.content?.canvas?.elements ?? [];
    };

    // The repair pass must actually have run: the ghost is gone from the
    // server-side document, not just from the in-memory store.
    await expect
      .poll(async () => (await readElements()).some((element) => element.id === GHOST_ID), {
        timeout: 45_000,
        message: 'on-load repair should strip the orphan decorative shape',
      })
      .toBe(false);

    const elements = await readElements();
    const image = elements.find((element) => element.id === IMAGE_ID);
    expect(image, 'the interior generated image must survive the repair').toBeDefined();
    expect(image?.type).toBe('image');
    expect(image?.src).toBe(assetId);
    expect(image?.mediaRef).toBe(assetId);

    // The asset itself still resolves to renderable bytes in the browser.
    await expect
      .poll(async () => classroom.locator('img[src^="blob:"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    await classroom.close();
  });
});
