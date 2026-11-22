/**
 * The System 1 model catalog is independent of the main LLM's providersConfig.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('dedicated System 1 model catalog', () => {
  const original = {
    decisionModels: useSettingsStore.getState().decisionModels,
    decisionModel: useSettingsStore.getState().decisionModel,
  };

  beforeEach(() => {
    useSettingsStore.setState({ decisionModels: [], decisionModel: '' });
  });

  afterEach(() => {
    useSettingsStore.setState(original);
  });

  it('rejects bare ids and accepts qualified provider:model ids', () => {
    const s = useSettingsStore.getState();
    s.addDecisionModel('gpt-4o-mini');
    expect(useSettingsStore.getState().decisionModels).toEqual([]);

    s.addDecisionModel('OpenAI:gpt-4o-mini');
    expect(useSettingsStore.getState().decisionModels).toEqual(['openai:gpt-4o-mini']);
    expect(useSettingsStore.getState().decisionModel).toBe('openai:gpt-4o-mini');
  });

  it('does not add the same model twice and does not clobber the current selection', () => {
    const s = useSettingsStore.getState();
    s.addDecisionModel('openai:gpt-4o-mini');
    s.addDecisionModel('google:gemini-2.0-flash');
    s.addDecisionModel('openai:gpt-4o-mini');

    const state = useSettingsStore.getState();
    expect(state.decisionModels).toEqual(['openai:gpt-4o-mini', 'google:gemini-2.0-flash']);
    expect(state.decisionModel).toBe('openai:gpt-4o-mini');
  });

  it('clears the selected model when its catalog entry is removed', () => {
    const s = useSettingsStore.getState();
    s.addDecisionModel('openai:gpt-4o-mini');
    s.addDecisionModel('google:gemini-2.0-flash');
    useSettingsStore.getState().setDecisionModel('google:gemini-2.0-flash');

    useSettingsStore.getState().removeDecisionModel('google:gemini-2.0-flash');
    const state = useSettingsStore.getState();
    expect(state.decisionModels).toEqual(['openai:gpt-4o-mini']);
    expect(state.decisionModel).toBe('');
  });
});
