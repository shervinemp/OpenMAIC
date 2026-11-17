import type { WidgetType } from '@openmaic/dsl';
import type { CourseDepthLevel } from './constants.js';

export type { WidgetType } from '@openmaic/dsl';

/** Image extracted from a source document with metadata used by outline prompts. */
export interface PdfImage {
  id: string;
  src: string;
  pageNumber: number;
  description?: string;
  storageId?: string;
  width?: number;
  height?: number;
  originalId?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
}

export type ImageMapping = Record<string, string>;

/** Activity families the course generator can author. */
export type ActivityOutlineKind = 'code' | 'sql' | 'terminal';

export interface ActivityOutlineConfig {
  kind: ActivityOutlineKind;
  /** Code labs only. Python is the only executable runtime today. */
  language?: string;
  /**
   * Terminal labs only. Outlines may request `simulation`; `server` exists in
   * the contract so the planner can be rejected explicitly, but generation
   * never emits an operator-gated lab.
   */
  runtime?: 'simulation' | 'server';
}

/** Free-form requirements accepted by outline generation. */
export interface UserRequirements {
  requirement: string;
  userNickname?: string;
  userBio?: string;
  webSearch?: boolean;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom';
  task?: string;
  tools?: string[];
  steps?: string[];
  successCriteria?: string[];
  errorConsequences?: string[];
  challenge?: string;
  playerControls?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challengeType?: string;
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  style?: string;
}

/** A generation-ready description of one course scene. */
export interface SceneOutline {
  id: string;
  type:
    | 'slide'
    | 'quiz'
    | 'activity'
    | 'interactive'
    | 'pbl'
    // Specialized university-level kinds (Phase 2 §15.4b): render as slides.
    | 'exercise'
    | 'derivation'
    | 'glossary'
    | 'reading'
    // Analytic kinds (Phase 2 §15.9): render as slides.
    | 'comparison'
    | 'dataReading'
    | 'tradeoffs'
    | 'freeResponse';
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  /** Lesson membership (assigned during blueprint canonicalization; playback
      order remains the global `order`). */
  lessonId?: string;
  /**
   * Per-scene retrieval context rendered at the outline stage (Pillar 3b):
   * top-k source chunks with `[source p.N]` citation markers. Injected into
   * the content prompt and used as the citation ground-truth.
   */
  retrievalContext?: string;
  /**
   * Content depth level for this scene (Phase 2 §15.4), derived from the
   * blueprint's derived level. The content stage enforces its floor.
   */
  depthLevel?: CourseDepthLevel;
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text' | 'numeric' | 'ordering' | 'matching')[];
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    scenarioRoleplay?: boolean;
    scenarioBrief?: string;
  };
  /**
   * Hands-on lab configuration. `kind` selects the activity family: a Python
   * code lab, a PostgreSQL SQL lab, or a simulated terminal lab. `language`
   * applies to code labs only; generated terminal labs are always the
   * deterministic simulation (the server tier is operator-gated and never
   * authored by the model).
   */
  activityConfig?: ActivityOutlineConfig;
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}
