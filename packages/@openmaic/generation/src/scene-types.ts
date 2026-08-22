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

// ==================== Analytic scene kinds (Phase 2 ┬º15.9) ====================

/**
 * One dimension row of a compare-and-contrast table. `cells[i]` is what the
 * row says about `subjects[i]` ΓÇö a complete sentence per cell, not a label.
 */
export interface ComparisonRow {
  id: string;
  /** The property being compared across subjects (e.g. "Time complexity"). */
  dimension: string;
  /** One cell per subject, same order as the content's `subjects`. */
  cells: string[];
}

export interface GeneratedComparisonContent {
  /** The 2-3 concepts being compared, column order for every row. */
  subjects: string[];
  rows: ComparisonRow[];
  /** Optional synthesis: when is each subject the right choice. */
  takeaways?: string[];
}

/** Verdict on one claim made about a chart/dataset. */
export interface DataClaim {
  id: string;
  statement: string;
  verdict: 'supported' | 'refuted' | 'insufficient';
  /** Why the data supports/refutes the claim (cite concrete values). */
  explanation: string;
}

export interface DataSeriesPoint {
  x: number;
  y: number;
}

export interface DataSeries {
  name: string;
  points: DataSeriesPoint[];
}

export interface GeneratedDataReadingContent {
  chartTitle: string;
  chartType: 'bar' | 'line' | 'scatter';
  xAxisLabel: string;
  yAxisLabel: string;
  /** Unit / scale note rendered under the chart description (optional). */
  unitNote?: string;
  series: DataSeries[];
  /** At least two claims with verdicts grounded in the plotted values. */
  claims: DataClaim[];
}

/** One option in a trade-off decision scene. */
export interface TradeoffOption {
  id: string;
  name: string;
  pros: string[];
  cons: string[];
  /** When this option is the right call (optional). */
  bestFor?: string;
}

export interface GeneratedTradeoffsContent {
  /** The decision context: situation + hard constraints (complete sentences). */
  context: string;
  constraints: string[];
  options: TradeoffOption[];
  recommendation: {
    /** Name of the chosen option (must match an option's name). */
    choice: string;
    /** Why it wins under the stated constraints ΓÇö not a generic platitude. */
    justification: string;
  };
}

