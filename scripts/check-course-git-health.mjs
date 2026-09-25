/**
 * Course repo health check — run a `git fsck` pass over every bound course
 * repository and fail loudly on any corruption.
 *
 * WHY: three loose-object corruptions happened under concurrent writers
 * (two dev-server instances shared the object database before the
 * cross-process lock landed). The lock prevents new corruption, but an
 * EXISTING corrupt object is silent until the next commit — an early loud
 * warning bounds the recovery (clean-root rebuild + force push) to minutes
 * instead of days of drift. Designed for CI/pre-push or any scheduled check.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const persistenceDir = process.env.PERSISTENCE_DIR?.trim() ?? '';
if (!persistenceDir) {
  console.error('PERSISTENCE_DIR is not configured');
  process.exit(2);
}

const bindingsFile = join(persistenceDir, 'course-git', 'bindings.json');
let bindings = [];
try {
  bindings = JSON.parse(readFileSync(bindingsFile, 'utf8')).bindings ?? [];
} catch {
  console.log('no course-git bindings file yet — nothing to check');
  process.exit(0);
}

let failures = 0;
for (const binding of bindings) {
  try {
    const stdout = execFileSync('git', ['fsck'], {
      cwd: binding.repoPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = execFileSync('git', ['fsck'], {
      cwd: binding.repoPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ignoreExitCode: true,
    });
    const text = `${stdout}${stderr}`;
    if (/corrupt|missing|invalid/.test(text)) {
      console.error(`[HEALTH] ${binding.stageId}: CORRUPTION detected in ${binding.repoPath}`);
      console.error(text.trim());
      failures += 1;
    } else {
      console.log(`[health] ${binding.stageId}: clean`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[HEALTH] ${binding.stageId}: fsck failed — ${message}`);
    failures += 1;
  }
}
process.exit(failures > 0 ? 1 : 0);
