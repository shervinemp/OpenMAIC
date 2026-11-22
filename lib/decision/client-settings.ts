/** Reads the single opt-in System 1 choice from Settings for outgoing requests. */
import { useSettingsStore } from '@/lib/store/settings';

export function getDecisionHeaders(): Record<string, string> {
  const state = useSettingsStore.getState();
  if (!state.decisionEnabled) return {};

  const provider = state.decisionProvider;
  if (provider === 'laya' || provider === 'jev') {
    if (!state.decisionEndpoint.trim()) return {};
    return {
      'x-decision-enabled': '1',
      'x-decision-provider': provider,
      'x-decision-endpoint': state.decisionEndpoint.trim(),
      'x-decision-mode': state.decisionMode,
    };
  }

  if (!state.decisionModel.trim()) return {};
  return {
    'x-decision-enabled': '1',
    'x-decision-provider': 'chat',
    'x-decision-model': state.decisionModel.trim(),
    'x-decision-mode': state.decisionMode,
  };
}
