import { readGenerationProfile } from '@openmaic/generation';
import type { PBLPlannerV2Input, SceneOutline } from '@openmaic/generation';

// The generation contracts in fixture form. Upstream's parity mocks returned
// one-element slides, bare-recall quiz stems and five-scene decks, which the
// depth and course contracts reject (and re-prompt) by design; these helpers
// give a test a conforming payload so it asserts its real subject.

/** Model calls per scene before it fails as `invalid-model-output`. */
export const CONTENT_ATTEMPTS = readGenerationProfile().contentAttempts + 1;

/** Four substantive text elements: the slide depth floor at the default depth. */
export function substantiveSlideTexts(): Array<Record<string, unknown>> {
  return [
    'Evaporation moves water from liquid into vapor.',
    'Molecules gain energy when the liquid is heated by the sun.',
    'For example, a puddle shrinks faster on a hot day than on a cold one.',
    'Condensation is the reverse process that returns vapor to water.',
  ].map((text, i) => ({
    id: `depth_text_${i + 1}`,
    type: 'text',
    left: 60,
    top: 160 + i * 70,
    width: 880,
    height: 60,
    content: `<p>${text}</p>`,
    defaultFontName: '',
    defaultColor: '#333333',
  }));
}

/**
 * An outline response that meets the course contract for a default
 * 20-minute request (2 lessons x 10 scenes). `first` overrides the first
 * outline; `overrides` the wrapper fields.
 */
export function conformingOutlineResponse(
  overrides: Record<string, unknown> = {},
  first: Partial<SceneOutline> = {},
): Record<string, unknown> {
  const outlines: SceneOutline[] = Array.from({ length: 20 }, (_, i) => ({
    id: `scene_${i + 1}`,
    type: 'slide',
    title: `Topic ${i + 1}`,
    description: `Describe topic ${i + 1} with a concrete example.`,
    keyPoints: [`Key point A for topic ${i + 1}`, `Key point B for topic ${i + 1}`],
    order: i + 1,
  }));
  outlines[0] = { ...outlines[0]!, ...first };
  return {
    languageDirective: 'Teach in English.',
    courseTitle: 'Photosynthesis Basics',
    lessons: [
      { title: 'Basics', objectives: ['Understand the core process'] },
      { title: 'Deeper', objectives: ['Apply the core process'] },
    ],
    audience: 'General learners',
    objectives: ['Define the process', 'Explain the process'],
    outlines,
    ...overrides,
  };
}

export function slideOutline(): SceneOutline {
  return {
    id: 'slide-1',
    type: 'slide',
    title: 'Dependency Injection',
    description: 'Explain dependency injection with one concrete example.',
    keyPoints: ['Caller owns dependencies', 'Pure generation seam'],
    order: 1,
  };
}

export function comparisonOutline(): SceneOutline {
  return {
    id: 'comparison-1',
    type: 'comparison',
    title: 'Data Lake vs. Data Warehouse vs. Lakehouse',
    description: 'Compare the three storage architectures on exam-relevant dimensions.',
    keyPoints: ['Openness', 'Schema timing'],
    order: 5,
  };
}

export function tradeoffsOutline(): SceneOutline {
  return {
    id: 'tradeoffs-1',
    type: 'tradeoffs',
    title: 'Choosing a Governance Model',
    description: 'Weigh the three governance options under stated constraints.',
    keyPoints: ['Cost', 'Control'],
    order: 6,
  };
}

export function dataReadingOutline(): SceneOutline {
  return {
    id: 'dataReading-1',
    type: 'dataReading',
    title: 'Reading the Throughput Chart',
    description: 'Judge claims against the plotted throughput values.',
    keyPoints: ['Read the axes', 'Cite values'],
    order: 7,
  };
}

export function quizOutline(): SceneOutline {
  return {
    id: 'quiz-1',
    type: 'quiz',
    title: 'Dependency Injection Check',
    description: 'Check the core idea.',
    keyPoints: ['Injected collaborators'],
    order: 2,
    quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
  };
}

export function widgetOutline(): SceneOutline {
  return {
    id: 'widget-1',
    type: 'interactive',
    title: 'Energy Widget',
    description: 'Explore how energy changes with a slider.',
    keyPoints: ['Move the slider', 'Observe the result'],
    order: 3,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Energy transfer', keyVariables: ['energy'] },
  };
}

export function pblOutline(): SceneOutline {
  return {
    id: 'pbl-1',
    type: 'pbl',
    title: 'CSV Data Analyzer',
    description: 'Build a small CSV analysis project.',
    keyPoints: ['CSV', 'DataFrame', 'Summary'],
    teachingObjective: 'Practice an end-to-end data analysis workflow.',
    order: 4,
    pblConfig: {
      projectTopic: 'CSV Data Analyzer',
      projectDescription: 'Build a small CSV analysis project.',
      targetSkills: ['CSV parsing', 'DataFrame analysis', 'Summary writing'],
      issueCount: 2,
    },
  };
}

export function pblPlannerInput(): PBLPlannerV2Input {
  const outline = pblOutline();
  return {
    outline,
    courseContext: { allOutlines: [outline], languageDirective: 'Reply in English.' },
    targetLanguage: 'en-US',
  };
}

export function validPBLResponse(): string {
  return JSON.stringify({
    projectInfo: {
      title: 'CSV Data Analyzer project',
      description: 'Build a tool that reads CSV data and reports findings.',
      learningObjective: 'Practice DataFrame analysis end to end.',
      gains: ['Understand tabular CSV data', 'Inspect a DataFrame', 'Write a concise finding'],
      proficiency: 'beginner',
    },
    instructorRole: {
      name: 'CSV Analysis Coach',
      description: 'I will guide you through each step.',
      systemPrompt: 'You are a warm CSV analysis coach.',
    },
    milestones: [
      {
        title: 'Load the CSV data',
        description: 'Create a small sample and load it.',
        briefing: 'Start with a small CSV sample.',
        completionCriteria: 'A DataFrame has been loaded.',
        debrief: 'The data is ready.',
        microtasks: [
          {
            title: 'Prepare and load a CSV',
            description: 'Create a few rows, load them, and inspect the columns.',
            hints: ['Keep the sample small.'],
          },
        ],
      },
      {
        title: 'Summarize and report',
        description: 'Compute a summary and write findings.',
        briefing: 'Turn the data into an insight.',
        completionCriteria: 'A concise finding is written.',
        debrief: 'The analysis is complete.',
        microtasks: [
          {
            title: 'Write one finding',
            description: 'Choose a useful summary and explain what it means.',
            hints: ['Tie the finding to the rows.'],
          },
        ],
      },
    ],
  });
}
