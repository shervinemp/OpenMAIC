import { describe, expect, test } from 'vitest';
import { generateSceneContent, generateSceneOutlinesFromRequirements } from '@openmaic/generation';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { AICallFn } from '@openmaic/generation';

/**
 * The outline stage now enforces the course contract: a deck must satisfy
 * the derived per-lesson scene targets or the run fails with a validation
 * report. Mocks below therefore return conforming decks (default duration
 * 20 min → 2 lessons × 10 scenes).
 */
function makeOutlines(count: number): SceneOutline[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `scene_${i + 1}`,
    type: 'slide',
    title: `Topic ${i + 1}`,
    description: `Describe topic ${i + 1} with a concrete example.`,
    keyPoints: [`Key point A for topic ${i + 1}`, `Key point B for topic ${i + 1}`],
    order: i + 1,
  }));
}

function conformingResponse(overrides: Record<string, unknown> = {}) {
  return {
    languageDirective: 'Teach in English.',
    courseTitle: 'Evaporation',
    lessons: [
      { title: 'Basics', objectives: ['Understand evaporation'] },
      { title: 'Deeper', objectives: ['Apply evaporation'] },
    ],
    audience: 'General learners',
    objectives: ['Define evaporation', 'Explain the process'],
    outlines: makeOutlines(20),
    ...overrides,
  };
}

describe('media prompt condition wiring', () => {
  test('outline generation passes media enable flags into conditional snippets', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return JSON.stringify(conformingResponse());
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
    expect(capturedPrompt).toContain('Course contract');
  });

  test('slide content generation exposes only media element rules backed by outline media', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      // Slide content now runs the depth contract: return 4 substantive text
      // elements (the depth contract minimum) plus the outline's video element.
      return JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'title',
            type: 'text',
            left: 60,
            top: 80,
            width: 880,
            height: 76,
            content: '<p style="font-size: 28px;">Evaporation moves water from liquid into vapor.</p>',
            defaultFontName: '',
            defaultColor: '#333333',
          },
          {
            id: 'body1',
            type: 'text',
            left: 60,
            top: 160,
            width: 880,
            height: 60,
            content: '<p>Molecules gain energy when the liquid is heated by the sun.</p>',
            defaultFontName: '',
            defaultColor: '#333333',
          },
          {
            id: 'body2',
            type: 'text',
            left: 60,
            top: 230,
            width: 880,
            height: 60,
            content: '<p>For example, a puddle shrinks faster on a hot day than on a cold one.</p>',
            defaultFontName: '',
            defaultColor: '#333333',
          },
          {
            id: 'body3',
            type: 'text',
            left: 60,
            top: 300,
            width: 880,
            height: 60,
            content: '<p>Condensation is the reverse process that returns vapor to water.</p>',
            defaultFontName: '',
            defaultColor: '#333333',
          },
          {
            id: 'video1',
            type: 'video',
            left: 60,
            top: 370,
            width: 880,
            height: 160,
            mediaRef: 'gen_vid_unique1',
            defaultFontName: '',
            defaultColor: '#333333',
          },
        ],
      });
    };

    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Evaporation Motion',
      description: 'Explain evaporation as a moving process',
      keyPoints: ['Molecules gain energy', 'Water changes into vapor'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'Animation of water molecules evaporating',
          elementId: 'gen_vid_unique1',
          aspectRatio: '16:9',
        },
      ],
    };

    const result = await generateSceneContent(outline, aiCall);

    expect(result).not.toBeNull();
    expect(capturedPrompt).toContain('VideoElement');
    expect(capturedPrompt).toContain('mediaRef');
    expect(capturedPrompt).toContain('gen_vid_unique1');
    expect(capturedPrompt).not.toContain('"src": "gen_vid_1"');
    expect(capturedPrompt).not.toContain('ImageElement');
    expect(capturedPrompt).not.toContain('gen_img_');
    expect(capturedPrompt).not.toContain('{{');
  });
});

describe('outline courseTitle parsing', () => {
  const baseRequirements: UserRequirements = { requirement: 'Teach photosynthesis' };

  async function runWith(raw: unknown) {
    const aiCall: AICallFn = async (_system, _user) => JSON.stringify(raw);
    return generateSceneOutlinesFromRequirements(baseRequirements, undefined, undefined, aiCall);
  }

  test('adopts a string courseTitle from the wrapper object', async () => {
    const result = await runWith(conformingResponse({ courseTitle: 'Photosynthesis Basics' }));

    expect(result.success).toBe(true);
    expect(result.data?.courseTitle).toBe('Photosynthesis Basics');
    expect(result.data?.blueprint.title).toBe('Photosynthesis Basics');
  });

  test('trims whitespace and caps overlong courseTitle defensively', async () => {
    const long = 'A '.repeat(80); // 160 chars
    const result = await runWith(
      conformingResponse({
        courseTitle: `  ${long}  `,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.courseTitle?.length).toBeLessThanOrEqual(120);
    // trimmed
    expect(result.data?.courseTitle?.startsWith(' ')).toBe(false);
  });

  test('returns undefined courseTitle when the field is missing (graceful fallback)', async () => {
    const result = await runWith(
      conformingResponse({
        courseTitle: undefined,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.courseTitle).toBeUndefined();
  });

  test('ignores a non-string / empty courseTitle', async () => {
    const result = await runWith(
      conformingResponse({
        courseTitle: '   ',
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.courseTitle).toBeUndefined();
  });
});
