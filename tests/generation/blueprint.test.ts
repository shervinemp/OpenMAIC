import { describe, expect, test } from 'vitest';
import {
  assignLessonIds,
  buildCourseBlueprint,
  clampDurationMinutes,
  deriveContractForRequest,
  deriveCourseContract,
  inferCourseType,
  parseDurationFromText,
  perLessonSceneCap,
  renderCourseContract,
  splitIntoLessons,
  summarizeBlueprintValidation,
  validateBlueprint,
  type ParsedOutlineResponse,
} from '@/lib/generation/blueprint';
import {
  COURSE_SIZE_PRESETS,
  resolveSizePreset,
  type CourseSizePreset,
} from '@/lib/constants/generation';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';

function makeOutline(index: number, type: SceneOutline['type'] = 'slide'): SceneOutline {
  const base: SceneOutline = {
    id: `scene_${index}`,
    type,
    title: `Scene ${index}`,
    description: `Describe scene ${index} with a concrete example.`,
    keyPoints: [`Key A ${index}`, `Key B ${index}`],
    order: index,
  };
  if (type === 'quiz') {
    base.quizConfig = { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] };
  }
  if (type === 'interactive') {
    base.widgetType = 'diagram';
    base.widgetOutline = { diagramType: 'flowchart' };
  }
  if (type === 'pbl') {
    base.pblConfig = {
      projectTopic: 'Topic',
      projectDescription: 'Description',
      targetSkills: ['skill'],
      issueCount: 2,
    };
  }
  return base;
}

function makeParsed(outlineCount: number): ParsedOutlineResponse {
  return {
    languageDirective: 'Teach in English.',
    courseTitle: 'Test Course',
    lessons: Array.from({ length: 2 }, (_, i) => ({
      title: `Lesson ${i + 1}`,
      objectives: [`Objective ${i + 1}`],
    })),
    audience: 'General learners',
    objectives: ['Objective 1', 'Objective 2'],
    outlines: Array.from({ length: outlineCount }, (_, i) => makeOutline(i + 1)),
  };
}

describe('parseDurationFromText', () => {
  test('parses minute and hour signals', () => {
    expect(parseDurationFromText('teach me X in 20 min')).toBe(20);
    expect(parseDurationFromText('45 minutes course')).toBe(45);
    expect(parseDurationFromText('1 hour intro')).toBe(60);
    expect(parseDurationFromText('1.5 hours deep dive')).toBe(90);
  });

  test('hours win over trailing minutes (1 hour 30 minutes → 90, not 30)', () => {
    expect(parseDurationFromText('1 hour 30 minutes')).toBe(90);
  });

  test('returns null when no duration signal', () => {
    expect(parseDurationFromText('teach me photosynthesis')).toBeNull();
    expect(parseDurationFromText('')).toBeNull();
  });
});

describe('clampDurationMinutes', () => {
  test('clamps to the sane range and defaults on garbage', () => {
    expect(clampDurationMinutes(20)).toBe(20);
    expect(clampDurationMinutes(0)).toBe(1);
    expect(clampDurationMinutes(9999)).toBe(600);
    expect(clampDurationMinutes(Number.NaN)).toBe(20);
  });
});

describe('inferCourseType', () => {
  test('detects exam prep before hands-on', () => {
    expect(inferCourseType('Databricks Data Engineer Prep')).toBe('exam-prep');
    expect(inferCourseType('AWS Associate certification exam')).toBe('exam-prep');
    expect(inferCourseType('build a to-do app project')).toBe('hands-on');
    expect(inferCourseType('workshop on woodworking')).toBe('hands-on');
    expect(inferCourseType('teach me photosynthesis')).toBe('explainer');
  });
});

describe('deriveCourseContract', () => {
  test('matches the effective mapping table', () => {
    const cases: Array<[number, number, number, number[]]> = [
      [10, 10, 1, [10]],
      [15, 15, 2, [8, 7]],
      [20, 20, 2, [10, 10]],
      [30, 30, 3, [10, 10, 10]],
      [45, 30, 5, [6, 6, 6, 6, 6]],
      [60, 30, 6, [5, 5, 5, 5, 5, 5]],
      [3, 5, 1, [5]],
    ];
    for (const [duration, total, lessons, targets] of cases) {
      const contract = deriveCourseContract(duration);
      expect(contract.durationMinutes).toBe(duration);
      expect(contract.totalSceneTarget).toBe(total);
      expect(contract.lessonCount).toBe(lessons);
      expect(contract.lessonSceneTargets).toEqual(targets);
    }
  });

  test('lesson targets always sum to the course total', () => {
    for (let duration = 1; duration <= 120; duration++) {
      const contract = deriveCourseContract(duration);
      const sum = contract.lessonSceneTargets.reduce((a, b) => a + b, 0);
      expect(sum).toBe(contract.totalSceneTarget);
      for (const target of contract.lessonSceneTargets) {
        expect(target).toBeGreaterThanOrEqual(3);
        expect(target).toBeLessThanOrEqual(12);
      }
    }
  });

  test('exam-prep uses the tighter quiz cadence', () => {
    expect(deriveCourseContract(20, 'exam-prep').quizPlacement).toBe(3);
    expect(deriveCourseContract(20, 'explainer').quizPlacement).toBe(4);
  });
});

describe('size presets (Phase 2 §15.3)', () => {
  test('preset table is the documented scale', () => {
    expect(COURSE_SIZE_PRESETS.compact).toEqual({
      durationMinutes: 20,
      maxScenes: 30,
      maxLessons: 8,
      scenesPerMinute: 1.0,
    });
    expect(COURSE_SIZE_PRESETS.semester.maxScenes).toBe(600);
    expect(COURSE_SIZE_PRESETS.intensive.maxScenes).toBe(360);
    expect(COURSE_SIZE_PRESETS.standard.maxScenes).toBe(60);
  });

  test('resolveSizePreset normalizes garbage to compact', () => {
    expect(resolveSizePreset('standard')).toBe('standard');
    expect(resolveSizePreset('garbage')).toBe('compact');
    expect(resolveSizePreset(undefined)).toBe('compact');
    expect(resolveSizePreset(42)).toBe('compact');
  });

  test('compact is byte-for-byte today\'s behavior', () => {
    const contract = deriveCourseContract(60, 'explainer', 'compact');
    expect(contract.totalSceneTarget).toBe(30); // capped
    expect(contract.lessonCount).toBe(6);
    expect(contract.sizePreset).toBe('compact');
  });

  test('standard raises the scene cap', () => {
    const contract = deriveCourseContract(60, 'explainer', 'standard');
    expect(contract.totalSceneTarget).toBe(60);
    expect(contract.lessonCount).toBe(6);
    const sum = contract.lessonSceneTargets.reduce((a, b) => a + b, 0);
    expect(sum).toBe(60);
  });

  test('intensive scales density to 2 scenes/min', () => {
    const contract = deriveCourseContract(180, 'explainer', 'intensive');
    expect(contract.totalSceneTarget).toBe(360);
    expect(contract.lessonCount).toBe(18);
  });

  test('semester clamps lessons and totals at the preset caps', () => {
    const contract = deriveCourseContract(600, 'explainer', 'semester');
    expect(contract.totalSceneTarget).toBe(600);
    expect(contract.lessonCount).toBe(48); // 60 lessons clamped to 48
  });

  test('deriveContractForRequest: explicit duration wins, preset caps stay', () => {
    const explicit = deriveContractForRequest('compact', 'explainer', 40);
    expect(explicit.durationMinutes).toBe(40);
    expect(explicit.totalSceneTarget).toBe(30); // compact cap still binds
    expect(explicit.sizePreset).toBe('compact');

    const fallback = deriveContractForRequest('intensive', 'explainer', undefined);
    expect(fallback.durationMinutes).toBe(180);
    expect(fallback.totalSceneTarget).toBe(360);
    expect(fallback.sizePreset).toBe('intensive');
  });

  test('per-lesson cap scales with the preset', () => {
    expect(perLessonSceneCap('compact')).toBe(12);
    expect(perLessonSceneCap('intensive')).toBeGreaterThanOrEqual(20);
    expect(perLessonSceneCap('semester')).toBeGreaterThan(perLessonSceneCap('compact'));
  });

  test('buildCourseBlueprint stamps the preset onto the blueprint', () => {
    const contract = deriveCourseContract(180, 'explainer', 'intensive');
    const blueprint = buildCourseBlueprint(
      makeParsed(360),
      'requirement',
      contract,
      'explainer',
      'Fallback',
    );
    expect(blueprint.sizePreset).toBe('intensive');
    expect(blueprint.lessons).toHaveLength(18);
  });

  test('validateBlueprint accepts a preset-scaled blueprint', () => {
    const contract = deriveCourseContract(180, 'explainer', 'intensive');
    const blueprint = buildCourseBlueprint(
      makeParsed(360),
      'requirement',
      contract,
      'explainer',
      'Fallback',
    );
    const report = validateBlueprint(blueprint);
    expect(report.errors).toEqual([]);
  });

  test('validateBlueprint derives lesson count from the blueprint preset', () => {
    const presets: CourseSizePreset[] = ['compact', 'standard', 'intensive', 'semester'];
    for (const preset of presets) {
      const config = COURSE_SIZE_PRESETS[preset];
      const contract = deriveCourseContract(config.durationMinutes, 'explainer', preset);
      const blueprint = buildCourseBlueprint(
        makeParsed(contract.totalSceneTarget),
        'requirement',
        contract,
        'explainer',
        'Fallback',
      );
      const report = validateBlueprint(blueprint);
      expect(report.errors).toEqual([]);
    }
  });
});

describe('assignLessonIds + splitIntoLessons', () => {
  test('assigns lesson membership positionally', () => {
    const outlines = Array.from({ length: 20 }, (_, i) => makeOutline(i + 1));
    const assigned = assignLessonIds(outlines, [10, 10]);
    expect(assigned.slice(0, 10).every((o) => o.lessonId === 'lesson_1')).toBe(true);
    expect(assigned.slice(10).every((o) => o.lessonId === 'lesson_2')).toBe(true);

    const contract = deriveCourseContract(20);
    const lessons = splitIntoLessons(assigned, contract, {});
    expect(lessons).toHaveLength(2);
    expect(lessons[0].outlines).toHaveLength(10);
    expect(lessons[1].outlines).toHaveLength(10);
  });

  test('buildCourseBlueprint prefers model-provided lesson metadata, derives fallbacks', () => {
    const contract = deriveCourseContract(20);
    const withMeta = buildCourseBlueprint(makeParsed(20), 'req', contract, 'explainer', 'Fallback');
    expect(withMeta.lessons[0].title).toBe('Lesson 1');
    expect(withMeta.lessons[0].objectives).toEqual(['Objective 1']);
    expect(withMeta.audience).toBe('General learners');
    expect(withMeta.objectives).toEqual(['Objective 1', 'Objective 2']);

    const bare: ParsedOutlineResponse = {
      languageDirective: 'Teach in English.',
      outlines: Array.from({ length: 20 }, (_, i) => makeOutline(i + 1)),
    };
    const derived = buildCourseBlueprint(bare, 'req', contract, 'explainer', 'Fallback');
    expect(derived.lessons[0].title).toContain('Scene 1');
    expect(derived.lessons[0].objectives.length).toBeGreaterThan(0);
    expect(derived.audience).toBe('General learners');
    expect(derived.title).toBe('Fallback');
  });
});

function validBlueprint(): CourseBlueprint {
  const contract = deriveCourseContract(20);
  return buildCourseBlueprint(makeParsed(20), 'req', contract, 'explainer', 'Fallback');
}

describe('validateBlueprint', () => {
  test('accepts a conforming blueprint', () => {
    const report = validateBlueprint(validBlueprint());
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test('rejects a thin deck (below lesson target)', () => {
    const blueprint = validBlueprint();
    blueprint.lessons[0].outlines = blueprint.lessons[0].outlines.slice(0, 3);
    const report = validateBlueprint(blueprint);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('target 10'))).toBe(true);
  });

  test('tolerance accepts ±1 per lesson', () => {
    const blueprint = validBlueprint();
    blueprint.lessons[0].outlines = blueprint.lessons[0].outlines.slice(0, 9);
    expect(validateBlueprint(blueprint, { tolerance: true }).valid).toBe(true);
    expect(validateBlueprint(blueprint).valid).toBe(false);
  });

  test('rejects course-wide floor violations', () => {
    const contract = deriveCourseContract(10);
    const parsed: ParsedOutlineResponse = {
      languageDirective: 'Teach in English.',
      objectives: ['a', 'b'],
      outlines: Array.from({ length: 3 }, (_, i) => makeOutline(i + 1)),
    };
    const blueprint = buildCourseBlueprint(parsed, 'req', contract, 'explainer', 'F');
    const report = validateBlueprint(blueprint);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('floor'))).toBe(true);
  });

  test('rejects structural violations (quiz without quizConfig, duplicate order)', () => {
    const blueprint = validBlueprint();
    const quiz = makeOutline(99, 'quiz');
    delete quiz.quizConfig;
    blueprint.lessons[0].outlines[0] = quiz;
    blueprint.lessons[1].outlines[1] = { ...blueprint.lessons[1].outlines[1], order: 2 };
    const report = validateBlueprint(blueprint);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('quizConfig'))).toBe(true);
    expect(report.errors.some((e) => e.includes('duplicate outline order'))).toBe(true);
  });

  test('emits placement warnings (quiz cadence, caps)', () => {
    const blueprint = validBlueprint();
    const report = validateBlueprint(blueprint);
    expect(report.warnings.some((w) => w.includes('quiz cadence'))).toBe(true);
  });

  test('legacy mode accepts any count with a single lesson', () => {
    const blueprint = validBlueprint();
    blueprint.lessons = [
      { ...blueprint.lessons[0], outlines: blueprint.lessons.flatMap((l) => l.outlines) },
    ];
    expect(validateBlueprint(blueprint, { legacy: true }).valid).toBe(true);
  });
});

describe('summarizeBlueprintValidation + renderCourseContract', () => {
  test('feedback is concrete and actionable', () => {
    const blueprint = validBlueprint();
    blueprint.lessons[0].outlines = blueprint.lessons[0].outlines.slice(0, 4);
    const report = validateBlueprint(blueprint);
    const summary = summarizeBlueprintValidation(report);
    expect(summary).toContain('target 10');
    expect(summary).toContain('course contract');
  });

  test('contract text carries the hard numbers', () => {
    const text = renderCourseContract(deriveCourseContract(20), 'explainer');
    expect(text).toContain('EXACTLY 2 lessons');
    expect(text).toContain('EXACTLY 10 scene outlines');
    expect(text).toContain('Total scenes: 20');
    expect(text).toContain('quiz at or near global outline #4');
  });
});
