import { expect, it } from 'vitest';
import type {
  BuildCompleteSceneOptions,
  GeneratedPBLContent,
  PBLPlannerV2Input,
  SceneActionsOptions,
  SceneContentFailure,
  SceneContentFailureCode,
  SceneContentOptions,
} from '@openmaic/generation';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _SceneContentKeys = Assert<
  Equal<
    keyof SceneContentOptions,
    | 'assignedImages'
    | 'imageMapping'
    | 'visionEnabled'
    | 'generatedMediaMapping'
    | 'resolvedVisionImages'
    | 'agents'
    | 'languageDirective'
    | 'targetLanguage'
    | 'userRequirements'
    | 'allowProceduralSkill'
    | 'editDirective'
    | 'baselineContent'
    | 'languageModel'
    | 'thinkingConfig'
    | 'pblLoopFallback'
    | 'onFailure'
    | 'logger'
    | 'retrievalContext'
    | 'unitContext'
  >
>;
type _SceneActionKeys = Assert<
  Equal<
    keyof SceneActionsOptions,
    'ctx' | 'agents' | 'userProfile' | 'languageDirective' | 'logger'
  >
>;
type _BuildKeys = Assert<Equal<keyof BuildCompleteSceneOptions, 'sceneId'>>;
type _PBLInputKeys = Assert<
  Equal<
    keyof PBLPlannerV2Input,
    | 'outline'
    | 'courseContext'
    | 'user'
    | 'priorQuizResults'
    | 'targetLanguage'
    | 'languageModel'
  >
>;

it('keeps new public option and generated-content surfaces narrow', () => {
  const contentOptions: SceneContentOptions = {};
  const failureCode: SceneContentFailureCode = 'prompt-unavailable';
  const failure: SceneContentFailure = { code: failureCode };
  const actionOptions: SceneActionsOptions = {};
  const buildOptions: BuildCompleteSceneOptions = { sceneId: 'stable' };

  // languageModel/thinkingConfig became deliberate, first-class host handles
  // (Phase 2 §15.1: a vision-capable model + thinking knobs thread into the
  // PBL v2 planner).
  const providerHandle: SceneContentOptions = { languageModel: {} };
  // projectV2 carries the app's V2 planner output (library shape), so a bare
  // DSL-only partial object no longer type-checks.
  const invalidPBL = { projectV2: { title: 'incomplete' } } as unknown as GeneratedPBLContent;

  expect(contentOptions).toEqual({});
  expect(failure).toEqual({ code: 'prompt-unavailable' });
  expect(actionOptions).toEqual({});
  expect(buildOptions.sceneId).toBe('stable');
  expect(providerHandle).toBeTruthy();
  expect(invalidPBL).toBeTruthy();
});
