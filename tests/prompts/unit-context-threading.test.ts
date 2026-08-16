import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNIT_CONTEXT = '## What Was Taught So Far (this unit)\n- Process states: ready; running; blocked';

const CONTENT_PROMPT_IDS = [
  PROMPT_IDS.SLIDE_CONTENT,
  PROMPT_IDS.QUIZ_CONTENT,
  PROMPT_IDS.EXERCISE_CONTENT,
  PROMPT_IDS.DERIVATION_CONTENT,
  PROMPT_IDS.GLOSSARY_CONTENT,
  PROMPT_IDS.READING_CONTENT,
] as const;

function baseVariables(promptId: (typeof CONTENT_PROMPT_IDS)[number]) {
  const shared = {
    title: 'Scheduling',
    description: 'Compare scheduling policies.',
    keyPoints: '1. FCFS\n2. Round robin',
    languageDirective: 'Teach in English.',
  };
  switch (promptId) {
    case PROMPT_IDS.SLIDE_CONTENT:
      return {
        ...shared,
        elements: 'auto',
        assignedImages: 'No images',
        canvas_width: 1000,
        canvas_height: 562.5,
        teacherContext: '',
      };
    case PROMPT_IDS.QUIZ_CONTENT:
      return {
        ...shared,
        questionCount: 2,
        difficulty: 'medium',
        questionTypes: 'single',
      };
    default:
      return shared;
  }
}

describe('unitContext coherence threading in content prompts (Phase 2 §15.5)', () => {
  test('injects the unit-so-far block when provided', () => {
    for (const promptId of CONTENT_PROMPT_IDS) {
      const prompt = buildPrompt(promptId, {
        ...baseVariables(promptId),
        unitContext: UNIT_CONTEXT,
      });
      expect(prompt, promptId).not.toBeNull();
      expect(prompt!.user).toContain('What Was Taught So Far (this unit)');
      expect(prompt!.user).toContain('Process states');
      expect(prompt!.user).not.toContain('{{');
    }
  });

  test('leaves no template residue when absent (other callers unchanged)', () => {
    for (const promptId of CONTENT_PROMPT_IDS) {
      const prompt = buildPrompt(promptId, baseVariables(promptId));
      expect(prompt, promptId).not.toBeNull();
      expect(prompt!.user).not.toContain('{{');
      expect(prompt!.user).not.toContain('What Was Taught So Far');
    }
  });
});
