/**
 * Generation Types - Two-Stage Content Generation System
 *
 * Stage 1: User requirements + documents → Scene Outlines (per-page)
 * Stage 2: Scene Outlines → Full Scenes (slide/quiz/interactive/pbl with actions)
 */

import type { ActionType } from './action';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { CourseSizePreset, CourseDepthLevel } from '@/lib/constants/generation';

// ==================== PDF Image Types ====================

/**
 * Image extracted from PDF with metadata
 */
export interface PdfImage {
  id: string; // e.g., "img_1", "img_2"
  src: string; // base64 data URL (empty when stored in IndexedDB)
  pageNumber: number; // Page number in PDF
  description?: string; // Optional description for AI context
  storageId?: string; // Reference to IndexedDB (session_xxx_img_1)
  width?: number; // Image width (px or normalized)
  height?: number; // Image height (px or normalized)
  originalId?: string; // ID assigned by the extractor before bundle-level normalization
  sourceDocumentId?: string; // DocumentBundle source ID
  sourceDocumentName?: string; // Original source filename for citation back to material
  sourceDocumentOrder?: number; // Upload order in the bundle
  visionPriority?: number; // Higher values are attached first when vision budget is limited
}

/**
 * Image mapping for post-processing: image_id → base64 URL
 */
export type ImageMapping = Record<string, string>;

export interface SelectedCourseMaterial {
  id: string;
  file: File;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  order: number;
}

export interface SessionDocumentSource {
  id: string;
  name: string;
  size: number;
  lastModified?: number;
  mimeType?: string;
  order: number;
  storageKey: string;
  providerId?: string;
}

// ==================== Stage 1 Input ====================

export interface UploadedDocument {
  id: string;
  name: string; // Original filename
  type: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md' | 'image' | 'other';
  size: number; // Bytes
  uploadedAt: Date;
  contentSummary?: string; // Placeholder for parsing
  extractedTopics?: string[]; // Placeholder for parsing
  pageCount?: number;
  storageRef?: string;
}

/**
 * Simplified user requirements for course generation
 * All details (topic, duration, style, etc.) should be included in the requirement text
 */
export interface UserRequirements {
  requirement: string; // Single free-form text for all user input
  userNickname?: string; // Student nickname for personalization
  userBio?: string; // Student background for personalization
  webSearch?: boolean; // Enable web search for richer context
  interactiveMode?: boolean; // Enable Interactive Mode for interactive-first generation
  taskEngineMode?: boolean; // Enable vocational task-engine generation path
}

// ==================== Stage 1 Output: Scene Outlines (Simplified) ====================

/**
 * Widget outline configuration for interactive scenes
 * Unified for both normal and ultra modes
 */
export interface WidgetOutline {
  // Common field
  concept?: string;

  // Type-specific fields
  keyVariables?: string[]; // simulation
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system'; // diagram
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp'; // code
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action'; // game
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom'; // visualization3d
  objects?: string[]; // visualization3d
  interactions?: string[]; // visualization3d
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom'; // procedural-skill
  task?: string; // procedural-skill - task to perform
  tools?: string[]; // procedural-skill - tools or materials involved
  steps?: string[]; // procedural-skill - ordered procedure steps
  successCriteria?: string[]; // procedural-skill - checks for completion
  errorConsequences?: string[]; // procedural-skill - consequences for unsafe or incorrect actions
  challenge?: string; // game - description of what player does
  playerControls?: string[]; // game - what player controls
  nodeCount?: number; // diagram - approximate node count
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>; // diagram - prescribed nodes and optional hierarchy
  challengeType?: string; // code - type of coding challenge
}

/**
 * Simplified scene outline
 * Gives AI more freedom, only requiring intent description and key points
 */
export interface SceneOutline {
  id: string;
  type:
    | 'slide'
    | 'quiz'
    | 'interactive'
    | 'pbl'
    | 'exercise'
    | 'derivation'
    | 'glossary'
    | 'reading';
  title: string;
  description: string; // 1-2 sentences describing the purpose
  keyPoints: string[]; // 3-5 core key points
  teachingObjective?: string;
  estimatedDuration?: number; // seconds
  order: number;
  languageNote?: string; // LLM-inferred language note for this scene
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
   * Content depth level (Phase 2 §15.4), stamped at the outline stage from
   * the blueprint's derived level. The content stage enforces its floor.
   */
  depthLevel?: CourseDepthLevel;
  // Suggested image IDs (from PDF-extracted images)
  suggestedImageIds?: string[]; // e.g., ["img_1", "img_3"]
  // AI-generated media requests (when PDF images are insufficient)
  mediaGenerations?: MediaGenerationRequest[]; // e.g., [{ type: 'image', prompt: '...', elementId: 'gen_img_1' }]
  // Quiz-specific config
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
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
  // PBL-specific config
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    /** Opt into role-play scenario planning on top of the standard PBL v2 structure. */
    scenarioRoleplay?: boolean;
    /** Optional scenario brief used only when scenarioRoleplay is true. */
    scenarioBrief?: string;
  };
  // Widget fields (required for type === 'interactive' in unified mode)
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}

// ==================== Course Blueprint (curriculum contract) ====================

/**
 * Course flavor inferred from the requirement text. Feeds the type mix and
 * quiz cadence in the outline prompt contract.
 */
export type CourseType = 'explainer' | 'hands-on' | 'exam-prep';

/**
 * One lesson (section) of the course. Scene counts are derived from the
 * resolved course duration and validated — see lib/generation/blueprint.ts.
 */
export interface LessonBlueprint {
  /** Lesson/section title (teaching language). */
  title: string;
  /** 1-2 learning objectives for THIS lesson. */
  objectives: string[];
  /** DERIVED — informational: even split of the course duration. */
  durationMinutes: number;
  /** DERIVED — greedy even split of the course-wide total, clamped. */
  sceneTarget: number;
  /** The lesson's deck. Length validated against sceneTarget. */
  outlines: SceneOutline[];
}

/**
 * One unit (chapter) of a university-scale course (Phase 2 §15.1). A unit
 * groups N lessons; single-unit courses (today's shape) remain valid when
 * `units` is absent on the blueprint.
 */
export interface UnitBlueprint {
  /** Unit/chapter title (teaching language). */
  title: string;
  /** 1-2 unit-level objectives. */
  objectives: string[];
  /** DERIVED — even split of the course duration across units. */
  durationMinutes: number;
  /** DERIVED — scene total for the unit (sums across units = course total). */
  sceneTarget: number;
  /** Lessons belonging to this unit, in order. */
  lessons: LessonBlueprint[];
}

/**
 * The curriculum as a validated contract (Pillar 1). Produced by the
 * outline stage; consumed by the job model and the UI.
 */
export interface CourseBlueprint {
  /** Display name for the course (≤ 30 chars, teaching language). */
  title: string;
  /** 2-5 sentence language directive (existing semantics). */
  languageDirective: string;
  /** RESOLVED course duration — never a model guess. */
  durationMinutes: number;
  /** Inferred audience; free text. */
  audience: string;
  /** 2-5 course-level learning objectives. */
  objectives: string[];
  /** DERIVED — course flavor from requirement keywords. */
  courseType: CourseType;
  /** DERIVED — lesson split: ceil(duration / LESSON_MINUTES), clamped. */
  lessonCount: number;
  /** DERIVED — quiz placement cadence (every N scenes, course-wide). */
  quizPlacement: number;
  /**
   * The size preset the contract was derived under (Phase 2 §15.3).
   * Optional for backward compatibility; treated as 'compact' when absent.
   */
  sizePreset?: CourseSizePreset;
  /**
   * Content depth level (Phase 2 §15.4), derived from the size preset at
   * outline stage. Optional for backward compatibility; treated as 'intro'.
   */
  depthLevel?: CourseDepthLevel;
  /** The course, split into lessons (each validated against its target). */
  lessons: LessonBlueprint[];
  /**
   * Unit (chapter) level for university-scale courses (Phase 2 §15.1).
   * Absent = single-unit course; `units[].lessons` always equals the flat
   * `lessons` projection in order.
   */
  units?: UnitBlueprint[];
}

// ==================== Stage 3 Output: Generated Content ====================

import type { PPTElement, SlideBackground } from '@openmaic/dsl';
import type { QuizQuestion } from './stage';

/**
 * AI-generated slide content
 */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/**
 * AI-generated quiz content
 */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

// ==================== Specialized Scene Content (Phase 2 §15.4b) ====================
//
// Exercise / derivation / glossary / reading outlines generate STRUCTURED
// content first (strong depth validation), which the content generator then
// renders into slide elements. The resulting scene is a slide — the DSL
// scene-type set stays closed — but the depth contract for these kinds is
// enforced on the structured payload.

/**
 * One worked problem on an exercise scene: a single problem per scene with
 * its full worked solution and (at university depth) a pedagogical analysis.
 */
export interface ExerciseProblem {
  id: string;
  statement: string;
  /** Optional leading hint shown before the worked solution. */
  hint?: string;
  /** Full worked solution — required. */
  solution: string;
  /** Why the method works / common pitfalls — required at university depth. */
  analysis?: string;
}

export interface GeneratedExerciseContent {
  problems: ExerciseProblem[];
}

/**
 * One derivation/proof step. `latex` is the rendered formula; `explanation`
 * is the prose that motivates the step. `claim` is the optional goal being
 * established.
 */
export interface DerivationStep {
  id: string;
  claim?: string;
  latex: string;
  explanation: string;
}

export interface GeneratedDerivationContent {
  steps: DerivationStep[];
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

export interface GeneratedGlossaryContent {
  terms: GlossaryTerm[];
}

export interface ReadingItem {
  title: string;
  /** Book / paper / site name. */
  source?: string;
  /** What the learner gains from this item. */
  whyRead: string;
  /** Optional `[source N]` citation back to the retrieved material. */
  citation?: string;
}

export interface GeneratedReadingContent {
  items: ReadingItem[];
}

// ==================== PBL Generation Types ====================

import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

/**
 * AI-generated PBL content.
 *
 * PBL v2 generation returns a legacy-compatible `projectConfig` plus the full
 * v2 payload so existing storage/rendering paths can migrate incrementally.
 */
export interface GeneratedPBLContent {
  projectConfig: PBLProjectConfig;
  projectV2?: PBLProjectV2;
}

// ==================== Interactive Generation Types ====================

import type { WidgetConfig, WidgetType } from './widgets';

/**
 * Scientific model output from scientific modeling stage
 */
export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/**
 * AI-generated interactive content
 */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

// ==================== Legacy Types (for compatibility) ====================

export interface SuggestedSlideElement {
  type: 'text' | 'image' | 'shape' | 'chart' | 'latex' | 'line';
  purpose: 'title' | 'subtitle' | 'content' | 'example' | 'diagram' | 'formula' | 'highlight';
  contentHint: string;
  position?: 'top' | 'center' | 'bottom' | 'left' | 'right';
  chartType?: 'bar' | 'line' | 'pie' | 'radar';
  textOutline?: string[];
}

export interface SuggestedQuizQuestion {
  type: 'single' | 'multiple' | 'short_answer';
  questionOutline: string;
  suggestedOptions?: string[];
  targetConceptId?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface SuggestedAction {
  type: ActionType;
  description: string;
  timing?: 'start' | 'middle' | 'end' | 'after-content';
}
