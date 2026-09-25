import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

const now = 1_800_000_000_000;

describe('actionsSourceHash persistence fidelity', () => {
  let pool: PGlitePool;
  let ownerCookie: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    ownerCookie = randomUUID();
    vi.stubEnv('DATABASE_URL', `postgres://hash-fidelity-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('round-trips the app-level actions fingerprint through save/load', async () => {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

    const stageId = 'hash-fidelity';
    const document = {
      stage: { id: stageId, name: 'Hash fidelity', createdAt: now, updatedAt: now },
      scenes: [
        {
          id: 'scene-0',
          stageId,
          order: 1,
          type: 'slide',
          title: 'Stamped',
          content: {
            type: 'slide',
            canvas: {
              id: 'canvas-0',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: {
                backgroundColor: '#fff',
                themeColors: ['#000'],
                fontColor: '#000',
                fontName: 'Inter',
              },
              elements: [],
            },
          },
          actions: [{ type: 'speech', id: 'a0', text: 'hi', audioId: 'tts_x_a0' }],
          actionsSourceHash: 'v1:abc123',
          createdAt: now,
          updatedAt: now,
        },
      ],
      outline: {
        outlines: [],
        generationComplete: false,
        createdAt: now,
        updatedAt: now,
      },
    };

    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId: `anon:${ownerCookie}`,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });

    await store.saveDocument(document as never);
    const loaded = await store.loadDocument(stageId);
    const scene = (loaded as { scenes: Array<{ actionsSourceHash?: string }> }).scenes[0];
    expect(scene?.actionsSourceHash).toBe('v1:abc123');
  });
});
