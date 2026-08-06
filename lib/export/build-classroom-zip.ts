/**
 * Shared Classroom → ZIP builder.
 *
 * Extracted from `useExportClassroom` so the same per-course serialization
 * (manifest + inlined interactive HTML + audio/media blobs) can be reused by
 * both the single-course download and the full local backup.
 */
import type JSZip from 'jszip';

import { collectAudioFiles, collectMediaFiles, actionsToManifest } from './classroom-zip-utils';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  manifestAgentFromConfig,
  type ClassroomManifest,
  type ManifestStage,
  type ManifestScene,
  type MediaIndexEntry,
} from './classroom-zip-types';
import {
  inlineHtmlAssets,
  createAssetFetcher,
  type InlineOptions,
  type InlineReport,
} from './inline-assets';
import { createProxiedFetch } from './proxied-fetch';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, SceneContent, Stage } from '@/lib/types/stage';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';

export async function inlineSceneContent(
  content: SceneContent,
  options?: InlineOptions,
): Promise<{ content: SceneContent; report: InlineReport }> {
  if (content?.type !== 'interactive' || !('html' in content) || !content.html) {
    return { content, report: { inlined: [], failed: [] } };
  }
  const { html, report } = await inlineHtmlAssets(content.html, options);
  return { content: { ...content, html }, report };
}

export interface BuildStageZipOptions {
  /** Nest all entries under this directory (full-backup layout). Empty = root. */
  prefix?: string;
  /** Use this name as the stage name + file stem instead of `stage.name`. */
  latestName?: string;
}

export interface BuildStageZipResult {
  safeName: string;
  report: InlineReport;
}

export async function addStageContentToZip(
  zip: JSZip,
  stage: Stage,
  scenes: Scene[],
  options: BuildStageZipOptions = {},
): Promise<BuildStageZipResult> {
  const dir = options.prefix ? `${options.prefix.replace(/\/?$/, '')}/` : '';

  const documentScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
  const stageName = options.latestName || stage.name || 'classroom';

  // Roster is stage-embedded; the stage document is its single source of truth.
  const agentConfigs = stage.generatedAgentConfigs ?? [];

  // Audio + generated media (images/videos).
  const audioFiles = await collectAudioFiles(scenes);
  const mediaFiles = await collectMediaFiles(stage.id);

  // audioId → zipPath mapping for manifest references.
  const audioIdToPath = new Map<string, string>();
  for (const af of audioFiles) {
    audioIdToPath.set(af.record.id, af.zipPath);
  }

  const manifestStage: ManifestStage = {
    name: stageName,
    description: stage.description,
    language: stage.languageDirective,
    style: stage.style,
    videoManifest: stage.videoManifest,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  };

  const manifestAgents = agentConfigs.map(manifestAgentFromConfig);

  // agentId → index mapping for multiAgent references.
  const agentIdToIndex = new Map<string, number>();
  agentConfigs.forEach((agent, index) => agentIdToIndex.set(agent.id, index));

  const aggregateReport: InlineReport = { inlined: [], failed: [] };
  const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
  const manifestScenes: ManifestScene[] = await Promise.all(
    (documentScenes as Scene[]).map(async (scene) => {
      const { content, report } = await inlineSceneContent(scene.content, {
        fetcher: sharedFetcher,
      });
      for (const url of report.inlined) {
        if (!aggregateReport.inlined.includes(url)) aggregateReport.inlined.push(url);
      }
      for (const failure of report.failed) {
        if (!aggregateReport.failed.some((f) => f.url === failure.url)) {
          aggregateReport.failed.push(failure);
        }
      }
      return {
        type: scene.type,
        title: scene.title,
        order: scene.order,
        content,
        actions: scene.actions
          ? actionsToManifest(scene.actions, audioIdToPath, agentIdToIndex)
          : undefined,
        whiteboards: scene.whiteboards,
        ...(scene.multiAgent?.enabled
          ? {
              multiAgent: {
                enabled: true,
                agentIndices: (scene.multiAgent.agentIds ?? [])
                  .map((id) => agentIdToIndex.get(id))
                  .filter((index): index is number => index !== undefined),
                directorPrompt: scene.multiAgent.directorPrompt,
              },
            }
          : {}),
      };
    }),
  );

  // Media index entries.
  const mediaIndex: Record<string, MediaIndexEntry> = {};
  for (const af of audioFiles) {
    mediaIndex[af.zipPath] = {
      type: 'audio',
      format: af.record.format,
      duration: af.record.duration,
      voice: af.record.voice,
    };
  }
  for (const mf of mediaFiles) {
    mediaIndex[mf.zipPath] = {
      type: 'generated',
      mimeType: mf.record.mimeType,
      size: mf.record.size,
      prompt: mf.record.prompt,
    };
  }

  // Mark audio references whose blob could not be collected.
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech') {
        const audioId = (action as SpeechAction).audioId;
        if (audioId && !audioIdToPath.has(audioId)) {
          const missingPath = `audio/${audioId}.mp3`;
          mediaIndex[missingPath] = { type: 'audio', missing: true };
        }
      }
    }
  }

  const manifest: ClassroomManifest = {
    formatVersion: CLASSROOM_ZIP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: process.env.npm_package_version || '0.0.0',
    stage: manifestStage,
    agents: manifestAgents,
    scenes: manifestScenes,
    mediaIndex,
  };

  zip.file(`${dir}manifest.json`, JSON.stringify(manifest, null, 2));

  for (const af of audioFiles) {
    zip.file(dir + af.zipPath, af.record.blob);
  }
  for (const mf of mediaFiles) {
    zip.file(dir + mf.zipPath, mf.record.blob);
    if (mf.record.poster) {
      zip.file(dir + mf.zipPath.replace(/\.\w+$/, '.poster.jpg'), mf.record.poster);
    }
  }

  return {
    safeName: stageName.replace(/[\\/:*?"<>|]/g, '_') || 'classroom',
    report: aggregateReport,
  };
}
