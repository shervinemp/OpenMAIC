import type { SceneOutline } from '@/lib/types/generation';
import type { AgentInfo } from '@openmaic/generation';

/**
 * Canonical identity of the inputs that can change a scene's raw content or
 * actions. Any of these changing (a different model, outline edit, fresh
 * retrieval, agent roster edit) invalidates the draft. Keep this list in sync
 * with the payloads built in fetchSceneContent / resolveSceneActions.
 */
export interface SceneDraftKeyInput {
  stageId: string;
  outline: SceneOutline;
  retrievalContext?: string;
  languageDirective?: string;
  agents?: AgentInfo[];
  userProfile?: string;
  model?: string;
  taskEngineMode?: boolean;
  pdfImagesCount?: number;
  stageName?: string;
  stageDescription?: string;
  stageStyle?: string;
}

export function sceneDraftSourceKey(input: SceneDraftKeyInput): string {
  return JSON.stringify([
    'v1',
    input.stageId,
    input.outline.id,
    input.outline.type,
    input.outline.title,
    input.outline.description,
    input.outline.keyPoints,
    input.outline.depthLevel,
    input.outline.retrievalContext,
    input.retrievalContext,
    input.languageDirective,
    input.userProfile ?? '',
    input.agents?.map((agent) => `${agent.id}:${agent.role ?? ''}:${agent.persona ?? ''}`) ?? [],
    input.model ?? '',
    input.taskEngineMode === true,
    input.pdfImagesCount ?? 0,
    input.stageName ?? '',
    input.stageDescription ?? '',
    input.stageStyle ?? '',
  ]);
}
