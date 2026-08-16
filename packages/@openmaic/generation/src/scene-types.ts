import type {
  Action,
  InteractiveContent,
  PBLContent,
  PBLProject,
  PPTElement,
  QuizContent,
  QuizQuestion,
  Scene,
  SlideBackground,
  SlideContent,
  WidgetConfigBase,
  WidgetType,
} from '@openmaic/dsl';

/** AI-generated slide payload before it is assembled into a scene. */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/** AI-generated quiz payload before it is assembled into a scene. */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/** AI-generated interactive payload before it is assembled into a scene. */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfigBase;
}

/** AI-generated PBL payload. The persisted project contract is owned by the DSL. */
export interface GeneratedPBLContent {
  projectV2: PBLProject;
}

export type GeneratedSceneContent =
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent;

export type CompleteSceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent;

/** Scene assembled by the package, including the originating outline identity. */
export type CompleteScene = Scene<Action, CompleteSceneContent> & { outlineId: string };

/** Widget configuration emitted by the model and normalized by the scene layer. */
export type WidgetConfig = WidgetConfigBase;

// ==================== Specialty scene content (Phase 2 15.4b) ====================
// Structured payload types for the four specialty scene kinds. Each kind has
// a count floor that scales with the course depth level (constants.ts); the
// scene-type set stays closed - but the depth contract for these kinds is
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
  /** Full worked solution - required. */
  solution: string;
  /** Why the method works / common pitfalls - required at university depth. */
  analysis?: string;
}

export interface GeneratedExerciseContent {
  problems: ExerciseProblem[];
}

/**
 * One derivation/proof step. latex is the rendered formula; xplanation
 * is the prose that motivates the step. claim is the optional goal being
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
  /** Optional [source N] citation back to the retrieved material. */
  citation?: string;
}

export interface GeneratedReadingContent {
  items: ReadingItem[];
}
