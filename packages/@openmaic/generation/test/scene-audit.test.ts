import { describe, expect, it, vi } from 'vitest';

import { generateSceneContent } from '../src/scene-generator.js';
import type { SceneOutline } from '../src/outline-types.js';
import { widgetOutline } from './scene-fixtures.js';
import {
  buildSceneAuditPrompt,
  createAiSceneAuditor,
  projectSceneContent,
  summarizeSceneAuditIssues,
  verifySceneSafely,
} from '../src/scene-audit.js';

const glossaryContent = JSON.stringify({
  terms: Array.from({ length: 6 }, (_, index) => ({
    term: `Term ${index}`,
    definition: `Term ${index} is the name we use for this idea throughout the lesson and in every worked example.`,
  })),
});

const glossaryOutline = {
  id: 'scene_audit',
  order: 1,
  type: 'glossary',
  title: 'Key Terms',
  description: 'Vocabulary for this lesson',
  keyPoints: ['know the terms'],
} as unknown as SceneOutline;

describe('projectSceneContent', () => {
  it('drops authoring-only answers and layout noise', () => {
    const projected = projectSceneContent({
      id: 'scene_1',
      instructions: 'Solve it',
      referenceFiles: [{ path: 'answer.py', content: 'SECRET ANSWER' }],
      terms: [{ term: 'x', definition: 'y', layout: { x: 1, y: 2 } }],
    }) as Record<string, unknown>;
    const raw = JSON.stringify(projected);
    expect(raw).toContain('Solve it');
    expect(raw).not.toContain('referenceFiles');
    expect(raw).not.toContain('SECRET ANSWER');
    expect(raw).not.toContain('layout');
    expect(raw).not.toContain('"id"');
  });

  it('caps very long prose', () => {
    const projected = projectSceneContent({ instructions: 'a'.repeat(20000) }) as Record<
      string,
      unknown
    >;
    expect((projected.instructions as string).length).toBeLessThanOrEqual(12000);
  });
});

describe('AI scene auditor', () => {
  it('parses a structured verdict and fails open on garbage or a throw', async () => {
    const aiCall = vi.fn(
      async () => '[{"code":"wrong-definition","message":"Term 2 is defined incorrectly"}]',
    );
    expect(await createAiSceneAuditor(aiCall)({} as never)).toEqual([
      { code: 'wrong-definition', message: 'Term 2 is defined incorrectly' },
    ]);

    const garbage = vi.fn(async () => 'this is not json');
    expect(await createAiSceneAuditor(garbage)({} as never)).toEqual([]);

    const throwing = vi.fn(async () => {
      throw new Error('down');
    });
    const warn = vi.fn();
    expect(
      await verifySceneSafely(
        throwing,
        { sceneId: 's', kind: 'glossary', title: 'T', description: '', keyPoints: [], payload: {} },
        { warn },
      ),
    ).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('builds a prompt from the projection and never includes raw reference answers', () => {
    const { system, user } = buildSceneAuditPrompt({
      sceneId: 's',
      kind: 'exercise',
      title: 'Worked problem',
      description: 'Solve it',
      keyPoints: ['energy balance'],
      payload: projectSceneContent({ problems: [{ statement: 'Compute x', solution: 'x = 4' }] }),
    });
    expect(system).toMatch(/worked solution/i);
    expect(user).toContain('x = 4');
    expect(user).not.toContain('referenceFiles');
  });
});

describe('generic scene audit in the generation pipeline', () => {
  it('re-verifies each corrective pass and stops as soon as a rewrite is clean', async () => {
    const auditor = vi
      .fn()
      .mockResolvedValueOnce([{ code: 'wrong-definition', message: 'Term 2 is wrong' }])
      .mockResolvedValueOnce([]);
    const aiCall = vi.fn(
      async (_system: string, _user: string): Promise<string> => glossaryContent,
    );

    const content = await generateSceneContent(glossaryOutline, aiCall, {
      auditScenes: auditor,
    });

    // The rewrite is audited before it is accepted: two verdicts, not one.
    expect(auditor).toHaveBeenCalledTimes(2);
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(content).not.toBeNull();
    expect(aiCall.mock.calls[1][1]).toContain('[wrong-definition] Term 2 is wrong');
    expect(summarizeSceneAuditIssues([{ code: 'x', message: 'y' }])).toContain('[x] y');
  });

  it('keeps the cleanest rewrite when a later pass regresses instead of shipping the last one', async () => {
    const makeContent = (label: string) =>
      JSON.stringify({
        terms: Array.from({ length: 6 }, (_, index) => ({
          term: `${label} ${index}`,
          definition: `${label} term ${index} is explained here with enough words to stay a substantive definition for the learner.`,
        })),
      });
    const initial = makeContent('initial');
    const candidateA = makeContent('candidateA');
    const candidateB = makeContent('candidateB');
    const responses = [initial, candidateA, candidateB];
    const aiCall = vi.fn(async (): Promise<string> => responses.shift() ?? candidateB);
    const auditor = vi
      .fn()
      .mockResolvedValueOnce([
        { code: 'e1', message: 'first defect' },
        { code: 'e2', message: 'second defect' },
      ])
      .mockResolvedValueOnce([{ code: 'e3', message: 'one defect left' }])
      .mockResolvedValueOnce([
        { code: 'e4', message: 'regression four' },
        { code: 'e5', message: 'regression five' },
      ]);

    const content = await generateSceneContent(glossaryOutline, aiCall, {
      auditScenes: auditor,
    });

    expect(auditor).toHaveBeenCalledTimes(3);
    // The initial artifact had two findings, candidateA had one, candidateB
    // regressed to two — candidateA is the one that must be shipped.
    expect(JSON.stringify(content)).toContain('candidateA');
    expect(JSON.stringify(content)).not.toContain('candidateB');
  });

  it('does not audit widgets, which have their own verifier', async () => {
    const auditor = vi.fn(async () => []);
    const aiCall = vi.fn(
      async (): Promise<string> =>
        '<!DOCTYPE html><html><body><div id="experiment"><script type="application/json" id="widget-config">{"type":"simulation"}</script><p>Hi</p></div></body></html>',
    );

    const content = await generateSceneContent(widgetOutline(), aiCall, {
      auditScenes: auditor,
    });

    expect(content).not.toBeNull();
    expect(auditor).not.toHaveBeenCalled();
  });
});
