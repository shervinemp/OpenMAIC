// Behavior-parity port of lib/generation/outline-generator.ts assertions from
// tests/generation/media-prompt-wiring.test.ts and procedural-skill-content-gates.test.ts.
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_LANGUAGE_DIRECTIVE,
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  sanitizeProceduralSkillOutline,
  type AICallFn,
  type GenerationLogger,
  type SceneOutline,
  type UserRequirements,
} from '@openmaic/generation';
import { conformingOutlineResponse } from './scene-fixtures.js';

const baseOutline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  title: 'Photosynthesis',
  description: 'How plants make food',
  keyPoints: ['light', 'water', 'carbon dioxide'],
  order: 99,
};

describe('generateSceneOutlinesFromRequirements', () => {
  test('returns enriched outlines from a valid wrapped response', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify(conformingOutlineResponse({}, { ...baseOutline, id: '', order: 42 })),
    );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      aiCall,
    );

    expect(result.success).toBe(true);
    expect(result.data?.languageDirective).toBe('Teach in English.');
    expect(result.data?.courseTitle).toBe('Photosynthesis Basics');
    expect(result.data?.outlines[0]?.id).toBeTruthy();
    expect(result.data?.outlines[0]?.order).toBe(1);
  });

  test('integrates repairable JSON parsing', async () => {
    // A conforming deck with a malformed first outline key ("order: 7"),
    // which the JSON repair pass has to recover.
    const response = JSON.stringify(
      conformingOutlineResponse({ courseTitle: 'Repair' }, { title: 'Repairable' }),
    ).replace('"order":1}', '"order: 7"}');
    expect(() => JSON.parse(response)).toThrow();
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Test repair' },
      undefined,
      undefined,
      async () => response,
    );

    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({ title: 'Repairable', order: 1 });
  });

  test('supports the legacy flat-array response with a default language directive', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () => JSON.stringify(conformingOutlineResponse().outlines),
    );

    expect(result.success).toBe(true);
    expect(result.data?.languageDirective).toBe(DEFAULT_LANGUAGE_DIRECTIVE);
  });

  test('passes media enable flags into prompt conditionals', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return JSON.stringify(conformingOutlineResponse({ courseTitle: 'Evaporation' }));
    };
    const requirements: UserRequirements = {
      requirement: 'Teach evaporation with an animation',
    };

    const result = await generateSceneOutlinesFromRequirements(
      requirements,
      undefined,
      undefined,
      aiCall,
      { imageGenerationEnabled: false, videoGenerationEnabled: true },
    );

    expect(result.success).toBe(true);
    expect(capturedPrompt).toContain('gen_vid_1');
    expect(capturedPrompt).not.toContain('gen_img_');
    expect(capturedPrompt).not.toContain('suggestedImageIds');
    expect(capturedPrompt).not.toContain('{{');
  });

  const requirements: UserRequirements = { requirement: 'Teach photosynthesis' };
  async function runWith(raw: unknown) {
    return generateSceneOutlinesFromRequirements(requirements, undefined, undefined, async () =>
      JSON.stringify(raw),
    );
  }

  test('trims and caps a string courseTitle', async () => {
    const result = await runWith(
      conformingOutlineResponse({ courseTitle: `  ${'A '.repeat(80)}  ` }),
    );
    expect(result.data?.courseTitle?.length).toBeLessThanOrEqual(120);
    expect(result.data?.courseTitle?.startsWith(' ')).toBe(false);
  });

  test.each([
    [conformingOutlineResponse({ courseTitle: undefined })],
    [conformingOutlineResponse({ courseTitle: '   ' })],
    [conformingOutlineResponse({ courseTitle: 123 })],
  ])('omits a missing, empty, or non-string courseTitle', async (raw) => {
    const result = await runWith(raw);
    expect(result.success).toBe(true);
    expect(result.data?.courseTitle).toBeUndefined();
  });
});

describe('outline fallbacks', () => {
  test('downgrades incomplete interactive and PBL outlines', () => {
    expect(applyOutlineFallbacks({ ...baseOutline, type: 'interactive' }, true).type).toBe('slide');
    expect(applyOutlineFallbacks({ ...baseOutline, type: 'pbl' }, true).type).toBe('slide');
    expect(
      applyOutlineFallbacks(
        {
          ...baseOutline,
          type: 'pbl',
          pblConfig: { projectTopic: 'Garden', projectDescription: 'Grow it', targetSkills: [] },
        },
        false,
      ).type,
    ).toBe('slide');
  });

  test('keeps configured interactive and PBL outlines when a language model is present', () => {
    const interactive = {
      ...baseOutline,
      type: 'interactive' as const,
      widgetType: 'diagram' as const,
      widgetOutline: { concept: 'Cycle' },
    };
    const pbl = {
      ...baseOutline,
      type: 'pbl' as const,
      pblConfig: { projectTopic: 'Garden', projectDescription: 'Grow it', targetSkills: [] },
    };
    expect(applyOutlineFallbacks(interactive, true)).toBe(interactive);
    expect(applyOutlineFallbacks(pbl, true)).toBe(pbl);
  });

  test('logs a fallback through the injected structural logger', () => {
    const warn = vi.fn();
    const logger: GenerationLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    applyOutlineFallbacks({ ...baseOutline, type: 'interactive' }, true, { logger });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('sanitizeProceduralSkillOutline', () => {
  const procedural: SceneOutline = {
    ...baseOutline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a device',
      tools: ['meter'],
      steps: ['inspect'],
      successCriteria: ['within range'],
      errorConsequences: ['stop'],
      interactions: ['inspect details'],
    },
  };

  test('strips every task-engine field and preserves unrelated widget fields', () => {
    const safe = sanitizeProceduralSkillOutline(procedural);
    expect(safe.widgetType).toBe('diagram');
    expect(safe.widgetOutline).toEqual({
      concept: 'calibration procedure',
      interactions: ['inspect details'],
    });
    expect(safe.description).toContain('Present this as a process or structure diagram.');
  });

  test('uses the fallback description when the source description is empty', () => {
    expect(sanitizeProceduralSkillOutline({ ...procedural, description: '' }).description).toBe(
      'Present this topic as a process or structure diagram.',
    );
  });

  test('retains procedural-skill only when explicitly allowed', () => {
    expect(applyOutlineFallbacks(procedural, true, { allowProceduralSkill: true }).widgetType).toBe(
      'procedural-skill',
    );
  });
});
