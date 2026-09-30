/**
 * Recover narration that a cleanup pass deleted along with an element-less scene.
 *
 * The old empty-part prune removed slide parts that had no canvas elements, and
 * some of those parts carried a whole lesson's narration (see
 * lib/maintenance/prune-empty-parts.ts, which now carries it over instead).
 * The lines were already voiced, so their audio is usually still in the asset
 * store. The course-git snapshot history still has the deleted scenes, so the
 * narration can be put back without a single model call.
 *
 * For every scene that exists in the history but not in the course now, has
 * speech actions, and whose split siblings still exist: the lost scene's
 * actions (speech and unanchored riders) are placed on those siblings by what
 * each line is about, in front of what they already play.
 *
 *   node scripts/recover-lost-narration.mts --stage <id>            # report only
 *   node scripts/recover-lost-narration.mts --stage <id> --apply    # write
 *
 * Options: --persistence-dir (default $PERSISTENCE_DIR or .data/persistence),
 * --repo (default: the stage's binding), --max-revisions (default: all).
 *
 * Stop the app first: the write goes to the document file directly (temp file +
 * rename). A copy of the document is saved under <persistence-dir>/backups/
 * before anything is written. Plain Node (type stripping), no build step.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// Node's type stripping needs the extension; tsc's rule against it is moot for a
// script it does not build.
// @ts-expect-error TS5097
import { alignActionsToParts, slideTextOf } from '../lib/maintenance/narration-align.ts';

type Json = Record<string, unknown>;
type Action = Json & { id?: string; type?: string; text?: string; audioId?: string };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const stageId = arg('stage');
if (!stageId) {
  console.error('usage: recover-lost-narration.mts --stage <id> [--apply]');
  process.exit(2);
}
const persistenceDir = resolve(
  arg('persistence-dir') ?? process.env.PERSISTENCE_DIR ?? '.data/persistence',
);
const maxRevisions = Number(arg('max-revisions') ?? Infinity);

function repoPath(): string {
  const given = arg('repo');
  if (given) return given;
  const bindings = JSON.parse(
    readFileSync(join(persistenceDir, 'course-git', 'bindings.json'), 'utf8'),
  ) as {
    bindings: Array<{ stageId: string; repoPath: string }>;
  };
  const binding = bindings.bindings.find((entry) => entry.stageId === stageId);
  if (!binding) throw new Error(`no git binding for ${stageId}; pass --repo`);
  return binding.repoPath;
}

const PART = /(?:__p\d+(?:-[a-z0-9]+)?)+$/i;
const baseOf = (id: string) => id.replace(PART, '');
const isAnchored = (action: Action) => typeof action.elementId === 'string';

function main(): void {
  const documentPath = join(
    persistenceDir,
    'documents',
    `${encodeURIComponent(String(stageId))}.json`,
  );
  if (!existsSync(documentPath))
    throw new Error(`course ${stageId} not found in ${persistenceDir}`);
  const document = JSON.parse(readFileSync(documentPath, 'utf8')) as {
    scenes: Json[];
    stage: Json;
  };
  const scenes = document.scenes;
  const currentIds = new Set(scenes.map((scene) => String(scene.id)));
  const currentActionIds = new Set(
    scenes.flatMap((scene) =>
      ((scene.actions as Action[]) ?? []).map((action) => String(action.id)),
    ),
  );
  const assetNames = new Set(
    existsSync(join(persistenceDir, 'assets'))
      ? readdirSync(join(persistenceDir, 'assets')).map((name) => decodeURIComponent(name))
      : [],
  );

  const repo = repoPath();
  const file = `${String(stageId).replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
  const revisions = execFileSync('git', ['log', '--format=%h', '--', file], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .slice(0, maxRevisions);
  console.log(`${revisions.length} snapshot revision(s) in ${repo}`);

  // Newest version of every scene that is gone now and spoke.
  const lost = new Map<string, { scene: Json; rev: string }>();
  for (const [index, rev] of revisions.entries()) {
    let old: { scenes: Json[] };
    try {
      old = JSON.parse(
        execFileSync('git', ['show', `${rev}:${file}`], { cwd: repo, maxBuffer: 1 << 30 }).toString(
          'utf8',
        ),
      );
    } catch {
      continue;
    }
    for (const scene of old.scenes) {
      const id = String(scene.id);
      if (currentIds.has(id) || lost.has(id)) continue;
      const actions = (scene.actions as Action[]) ?? [];
      if (!actions.some((action) => action.type === 'speech')) continue;
      lost.set(id, { scene, rev });
    }
    if ((index + 1) % 25 === 0) console.log(`  scanned ${index + 1}/${revisions.length}`);
  }
  console.log(`${lost.size} vanished scene(s) carried narration`);

  const edits = new Map<string, Action[]>(); // surviving sibling id -> actions to prepend
  let restoredLines = 0;
  let missingAudio = 0;
  let noSiblings = 0;
  for (const [lostId, { scene }] of lost) {
    const siblings = scenes
      .filter((candidate) => candidate.type === 'slide' && baseOf(String(candidate.id)) === lostId)
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    if (siblings.length === 0) {
      noSiblings += 1;
      continue;
    }
    const actions = ((scene.actions as Action[]) ?? []).filter(
      (action) => !isAnchored(action) && !currentActionIds.has(String(action.id)),
    );
    if (actions.length === 0) continue;
    const placement = alignActionsToParts(
      actions as Array<{ type: string; text?: string }>,
      siblings.map(slideTextOf),
    );
    siblings.forEach((sibling, position) => {
      const mine = actions.filter((_, index) => placement[index] === position);
      if (mine.length === 0) return;
      edits.set(String(sibling.id), [...(edits.get(String(sibling.id)) ?? []), ...mine]);
      restoredLines += mine.filter((action) => action.type === 'speech').length;
      missingAudio += mine.filter(
        (action) => action.type === 'speech' && action.audioId && !assetNames.has(action.audioId),
      ).length;
    });
  }

  console.log({
    scenesToReceiveNarration: edits.size,
    speechLinesRestored: restoredLines,
    linesWhoseAudioBytesAreGone: missingAudio,
    vanishedScenesWithNoSurvivingSibling: noSiblings,
  });
  if (!flag('apply')) {
    console.log('report only; re-run with --apply to write');
    return;
  }
  if (edits.size === 0) return;

  const backups = join(persistenceDir, 'backups');
  mkdirSync(backups, { recursive: true });
  const backup = join(backups, `${stageId}-${Date.now()}.json`);
  copyFileSync(documentPath, backup);
  console.log(`backup: ${backup}`);

  const now = Date.now();
  for (const scene of scenes) {
    const add = edits.get(String(scene.id));
    if (!add) continue;
    scene.actions = [...add, ...((scene.actions as Action[]) ?? [])];
    scene.updatedAt = now;
  }
  // Strictly newer than what was stored, so a tab still holding the old copy
  // cannot overwrite this with a stale full save.
  document.stage.updatedAt = Math.max(now, Number(document.stage.updatedAt ?? 0) + 1);
  const temp = `${documentPath}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(document), 'utf8');
  renameSync(temp, documentPath);
  console.log(`wrote ${edits.size} scene(s)`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
