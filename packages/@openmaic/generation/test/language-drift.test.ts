import { describe, expect, it } from 'vitest';
import type { AICallFn, SceneOutline } from '@openmaic/generation';
import {
  collectLearnerText,
  detectLanguageDrift,
  generateSceneActions,
  generateSceneContent,
  inferTargetLanguage,
  takeSceneDepthSummary,
} from '@openmaic/generation';
import { slideOutline, substantiveSlideTexts } from './scene-fixtures.js';

const CHINESE_PROSE =
  '蒸发是水从液态转变为气态的自然过程，太阳提供的热量让水分子获得足够的能量离开液面。' +
  '当液态水被加热时，分子运动加快，最终挣脱彼此之间的吸引力并以水蒸气的形式进入空气。' +
  '例如，炎热天气里的水坑会比寒冷天气里的水坑缩小得更快，因为温度越高蒸发过程越迅速；当湿度达到 100% 时，蒸发会明显减慢。' +
  '凝结是蒸发的相反过程，空气中的水蒸气遇冷后重新聚集为液态水滴，最终形成云或露水。';

const ENGLISH_PROSE =
  'Evaporation moves water from liquid into vapor when the molecules gain enough energy. ' +
  'Heating the liquid makes the molecules move faster until they escape into the air. ' +
  'For example, a puddle shrinks faster on a hot day than on a cold one. ' +
  'Condensation is the reverse process that returns vapor to liquid water.';

const SPANISH_PROSE =
  'La evaporación es el proceso por el cual el agua pasa de un estado líquido a un estado gaseoso. ' +
  'Cuando el líquido se calienta, las moléculas obtienen energía y se mueven con más rapidez. ' +
  'Por ejemplo, un charco se seca más rápido en un día caluroso que en un día frío. ' +
  'La condensación es el proceso contrario: el vapor de agua se enfría y vuelve a formar pequeñas gotas de agua líquida. ' +
  'Estos dos procesos forman parte del ciclo del agua en la naturaleza y ocurren continuamente en la atmósfera.';

describe('inferTargetLanguage', () => {
  it('reads the primary teaching language, not incidental mentions', () => {
    expect(
      inferTargetLanguage('Teach in Chinese (Simplified). Use English for technical terms.')?.code,
    ).toBe('zh');
    expect(
      inferTargetLanguage('Use English for code identifiers, but teach in Chinese.')?.code,
    ).toBe('zh');
    expect(inferTargetLanguage('The course language is Spanish.')?.code).toBe('es');
    expect(inferTargetLanguage('Write all content in Japanese.')?.code).toBe('ja');
    expect(inferTargetLanguage('中文授课，专业术语可保留英文。')?.code).toBe('zh');
  });

  it('returns null when the directive names no language', () => {
    expect(inferTargetLanguage('Match the language of the learner requirement.')).toBeNull();
  });
});

describe('detectLanguageDrift', () => {
  it('passes a scene written in the target script', () => {
    expect(detectLanguageDrift(CHINESE_PROSE, 'Teach in Chinese.')).toBeNull();
    expect(detectLanguageDrift(ENGLISH_PROSE, 'Teach in English.')).toBeNull();
    expect(detectLanguageDrift('Это курс по анализу данных.', 'Teach in Russian.')).toBeNull();
  });

  it('flags a scene whose target script is nearly absent', () => {
    const finding = detectLanguageDrift(ENGLISH_PROSE, 'Teach in Chinese (Simplified).');
    expect(finding).toMatchObject({ targetLabel: 'Chinese', detectedLabel: 'Latin' });
    expect(finding?.finding).toContain('target language (Chinese)');
    expect(detectLanguageDrift(CHINESE_PROSE, 'Teach in English.')).toMatchObject({
      targetLabel: 'English',
      detectedLabel: 'Han (Chinese/Japanese)',
    });
  });

  it('passes bilingual technical prose when the target still leads', () => {
    const mixed = `在 Python 中使用 DataFrame 进行聚合。${CHINESE_PROSE} The API returns JSON.`;
    expect(
      detectLanguageDrift(mixed, 'Teach in Chinese; keep technical terms in English.'),
    ).toBeNull();
  });

  it('ignores short scenes and silent directives', () => {
    expect(detectLanguageDrift('Hello world.', 'Teach in Chinese.')).toBeNull();
    expect(detectLanguageDrift(ENGLISH_PROSE, undefined)).toBeNull();
    expect(detectLanguageDrift(ENGLISH_PROSE, 'No language named here.')).toBeNull();
  });

  it('flags clear Latin-script drift when function words diverge', () => {
    expect(detectLanguageDrift(SPANISH_PROSE, 'Teach in English.')).toMatchObject({
      targetLabel: 'English',
      detectedLabel: 'Spanish',
    });
    expect(detectLanguageDrift(ENGLISH_PROSE, 'Teach in Spanish.')).toMatchObject({
      targetLabel: 'Spanish',
      detectedLabel: 'English',
    });
    expect(detectLanguageDrift(ENGLISH_PROSE, 'Teach in English.')).toBeNull();
    expect(detectLanguageDrift(SPANISH_PROSE, 'Teach in Spanish.')).toBeNull();
  });
});

describe('collectLearnerText', () => {
  it('keeps prose and drops code, files and answer keys', () => {
    const text = collectLearnerText({
      instructions: 'Write a function.',
      files: [{ path: 'main.py', content: 'def add(a, b): return a + b' }],
      tests: [{ code: 'assert add(1, 2) == 3' }],
      checks: [{ id: 'tests', type: 'expectTests' }],
      options: [
        { label: 'First option', value: 'A' },
        { label: 'Second option', value: 'B' },
      ],
      analysis: 'The first option is correct.',
      elements: [
        { id: 't1', type: 'text', content: 'A sentence.', defaultFontName: 'Arial' },
        { id: 't2', type: 'text', content: '<p><strong>段落文字</strong></p>' },
      ],
    });
    expect(text).toContain('Write a function.');
    expect(text).toContain('First option');
    expect(text).toContain('The first option is correct.');
    expect(text).toContain('A sentence.');
    expect(text).toContain('段落文字');
    expect(text).not.toContain('strong');
    expect(text).not.toContain('def add');
    expect(text).not.toContain('assert add');
    expect(text).not.toContain('Arial');
  });
});

function chineseSlideResponse(): string {
  const texts = [
    '蒸发是水从液态转变为气态的自然过程，太阳提供的热量让水分子获得足够的能量离开液面。',
    '当液态水被加热时，分子运动加快，最终挣脱彼此之间的吸引力并以水蒸气的形式进入空气。',
    '例如，炎热天气里的水坑会比寒冷天气里的水坑缩小得更快，因为温度越高蒸发过程越迅速；当湿度达到 100% 时，蒸发会明显减慢。',
    '凝结是蒸发的相反过程，空气中的水蒸气遇冷后重新聚集为液态水滴，最终形成云或露水。',
  ];
  return JSON.stringify({
    elements: texts.map((content, index) => ({
      type: 'text',
      left: 80,
      top: 60 + index * 90,
      width: 840,
      height: 80,
      content,
    })),
    background: { type: 'solid', color: '#ffffff' },
  });
}

function englishSlideResponse(): string {
  return JSON.stringify({
    elements: [
      {
        type: 'text',
        left: 80,
        top: 60,
        width: 840,
        height: 100,
        content: 'Dependency injection',
      },
      ...substantiveSlideTexts(),
    ],
    background: { type: 'solid', color: '#ffffff' },
  });
}

describe('generateSceneContent — language gate', () => {
  it('rewrites once when the first scene drifts out of the course language', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const aiCall: AICallFn = async (_system, user) => {
      calls += 1;
      prompts.push(user);
      return calls === 1 ? englishSlideResponse() : chineseSlideResponse();
    };

    const content = await generateSceneContent(slideOutline(), aiCall, {
      languageDirective: 'Teach in Chinese (Simplified).',
    });

    expect(calls).toBe(2);
    expect(prompts[1]).toContain('LANGUAGE COMPLIANCE (NON-NEGOTIABLE)');
    expect(prompts[1]).toContain('Chinese');
    expect(JSON.stringify(content)).toContain('蒸发是水从液态');
    expect(takeSceneDepthSummary('slide-1')).toBeUndefined();
  });

  it('keeps a usable scene and records the finding when the rewrite still drifts', async () => {
    const aiCall: AICallFn = async () => englishSlideResponse();
    const content = await generateSceneContent(slideOutline(), aiCall, {
      languageDirective: 'Teach in Chinese (Simplified).',
    });

    expect(content).not.toBeNull();
    expect(JSON.stringify(content)).toContain('Evaporation moves water');
    expect(takeSceneDepthSummary('slide-1')?.findings.join(' ')).toContain('language drift');
  });

  it('does not call the model twice for a scene already in the target language', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return englishSlideResponse();
    };
    const outline: SceneOutline = { ...slideOutline(), id: 'slide-en' };
    await generateSceneContent(outline, aiCall, { languageDirective: 'Teach in English.' });
    expect(calls).toBe(1);
  });
});

describe('generateSceneActions — language gate', () => {
  const content = {
    elements: [
      {
        id: 'text_1',
        type: 'text' as const,
        left: 0,
        top: 0,
        width: 400,
        height: 80,
        content: 'Dependency injection',
        rotate: 0,
        lineHeight: 1,
        fill: '#000000',
        vertical: false,
        defaultFontName: 'Arial',
        defaultColor: '#000000',
      },
    ],
  };

  it('rewrites narration once when the speech drifts', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const aiCall: AICallFn = async (_system, user) => {
      calls += 1;
      prompts.push(user);
      const text = calls === 1 ? ENGLISH_PROSE : CHINESE_PROSE;
      return JSON.stringify([
        { type: 'text', content: text },
        { type: 'text', content: text },
      ]);
    };

    const actions = await generateSceneActions(slideOutline(), content, aiCall, {
      languageDirective: 'Teach in Chinese (Simplified).',
    });

    expect(calls).toBe(2);
    expect(prompts[1]).toContain('LANGUAGE COMPLIANCE (NON-NEGOTIABLE)');
    expect(JSON.stringify(actions)).toContain('蒸发是水从液态');
  });
});
