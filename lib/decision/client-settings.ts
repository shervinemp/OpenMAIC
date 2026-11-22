/** Reads the optional System 1 choice from Settings for outgoing requests. */
import { useSettingsStore } from '@/lib/store/settings';

export function getDecisionHeaders(): Record<string, string> {
  const { decisionEnabled, decisionModel, decisionMode } = useSettingsStore.getState();
  if (!decisionEnabled || !decisionModel.trim()) return {};
  return {
    'x-decision-enabled': '1',
    'x-decision-model': decisionModel.trim(),
    'x-decision-mode': decisionMode,
  };
}
