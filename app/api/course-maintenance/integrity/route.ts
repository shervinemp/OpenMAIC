import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';

export const runtime = 'nodejs';

const gunzipAsync = promisify(gunzip);

async function validJson(path: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(path, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

async function validBackup(path: string): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    let text: string;
    try {
      text = (await gunzipAsync(bytes)).toString('utf8');
    } catch {
      text = bytes.toString('utf8');
    }
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Integrity report for every file-backed course document and its backups. */
export async function GET(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const dir = process.env.PERSISTENCE_DIR;
  if (!dir) return apiError('INVALID_REQUEST', 400, 'Only the file-backed store is supported');

  try {
    const documentsDir = join(dir, 'documents');
    const files = (await readdir(documentsDir)).filter(
      (name) => name.endsWith('.json') && !name.includes('.tmp-'),
    );
    const courses = [];
    for (const file of files) {
      const path = join(documentsDir, file);
      const backups: string[] = [];
      for (const suffix of ['.bak.gz', '.bak.1.gz', '.bak.2.gz', '.bak']) {
        if (await validBackup(path + suffix)) backups.push(suffix);
      }
      courses.push({
        file,
        documentValid: await validJson(path),
        validBackups: backups,
      });
    }
    return apiSuccess({
      courses,
      summary: {
        total: courses.length,
        corrupt: courses.filter((c) => !c.documentValid).length,
        withoutBackup: courses.filter((c) => c.validBackups.length === 0).length,
      },
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Integrity scan failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Create a verified gzip backup for any valid document that lacks one. */
export async function POST(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const dir = process.env.PERSISTENCE_DIR;
  if (!dir) return apiError('INVALID_REQUEST', 400, 'Only the file-backed store is supported');

  try {
    const { JsonFileDocumentStore } = await import('@openmaic/storage/server/file-document-store');
    const store = new JsonFileDocumentStore({
      dir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const documentsDir = join(dir, 'documents');
    const files = (await readdir(documentsDir)).filter(
      (name) => name.endsWith('.json') && !name.includes('.tmp-'),
    );
    const created: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      const path = join(documentsDir, file);
      if (!(await validJson(path))) continue;
      if (await validBackup(path + '.bak.gz')) continue;
      const stageId = file.slice(0, -'.json'.length);
      try {
        const document = await store.loadDocument(stageId);
        if (!document) {
          failed.push(stageId);
          continue;
        }
        // A save through the hardened store writes a verified gzip backup.
        await store.saveDocument(document as never);
        created.push(stageId);
      } catch {
        failed.push(stageId);
      }
    }
    return apiSuccess({ created, failed });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Backup repair failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
