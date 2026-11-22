'use client';

/**
 * Decision Model settings. System 1 has its own model catalog, deliberately
 * separate from the main LLM's providersConfig and picker. One choice is sent
 * as headers for every grading/verification site; no separate server config.
 */

import { useState } from 'react';
import { Brain, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettingsStore } from '@/lib/store/settings';

function normalizeQualifiedModel(value: string): string | null {
  const clean = value.trim();
  const colon = clean.indexOf(':');
  if (colon <= 0 || colon === clean.length - 1) return null;
  return clean.slice(0, colon).toLowerCase() + clean.slice(colon);
}

export function DecisionConfigPanel() {
  const decisionEnabled = useSettingsStore((s) => s.decisionEnabled);
  const decisionProvider = useSettingsStore((s) => s.decisionProvider);
  const decisionModel = useSettingsStore((s) => s.decisionModel);
  const decisionModels = useSettingsStore((s) => s.decisionModels);
  const decisionEndpoint = useSettingsStore((s) => s.decisionEndpoint);
  const decisionMode = useSettingsStore((s) => s.decisionMode);
  const setDecisionEnabled = useSettingsStore((s) => s.setDecisionEnabled);
  const setDecisionProvider = useSettingsStore((s) => s.setDecisionProvider);
  const setDecisionModel = useSettingsStore((s) => s.setDecisionModel);
  const addDecisionModel = useSettingsStore((s) => s.addDecisionModel);
  const removeDecisionModel = useSettingsStore((s) => s.removeDecisionModel);
  const setDecisionEndpoint = useSettingsStore((s) => s.setDecisionEndpoint);
  const setDecisionMode = useSettingsStore((s) => s.setDecisionMode);

  const [newModel, setNewModel] = useState('');

  // A selection persisted from an older build may not be in the new catalog;
  // keep it visible instead of rendering an empty Select.
  const modelOptions =
    decisionModel && !decisionModels.includes(decisionModel)
      ? [decisionModel, ...decisionModels]
      : decisionModels;

  const handleAdd = (value: string) => {
    const normalized = normalizeQualifiedModel(value);
    if (!normalized) return;
    addDecisionModel(normalized);
    setNewModel('');
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Brain className="h-5 w-5" />
        <div>
          <h2 className="text-base font-semibold">Decision Model</h2>
          <p className="text-xs text-muted-foreground">
            A dedicated System 1 model for grading and verification — separate from your main LLM.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium">Enable decision model</p>
            <p className="mt-0.5 max-w-xl text-[11px] text-muted-foreground">
              Off uses the normal LLM everywhere. If the decision model is unavailable or abstains,
              the LLM baseline is used.
            </p>
          </div>
          <Switch checked={decisionEnabled} onCheckedChange={setDecisionEnabled} />
        </div>

        {decisionEnabled && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Select
              value={decisionProvider}
              onValueChange={(value) =>
                setDecisionProvider(value as 'chat' | 'laya' | 'jev')
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">Dedicated model</SelectItem>
                <SelectItem value="laya">Laya (typed)</SelectItem>
                <SelectItem value="jev">Jev (typed)</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={decisionMode}
              onValueChange={(value) => setDecisionMode(value as 'shadow' | 'replace')}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shadow">Shadow — compare, keep LLM answer</SelectItem>
                <SelectItem value="replace">Replace — use the decision answer</SelectItem>
              </SelectContent>
            </Select>

            {decisionProvider === 'chat' ? (
              <div className="col-span-full space-y-3 rounded-lg border border-border/50 bg-background/40 p-3">
                <div>
                  <p className="text-[13px] font-medium">System 1 models</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    This catalog is independent of the main LLM. Add qualified{' '}
                    <code>provider:model</code> ids (for example an OpenAI or Gemini model), then
                    choose one below.
                  </p>
                </div>

                <div className="flex gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    placeholder="provider:model"
                    value={newModel}
                    onChange={(event) => setNewModel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      handleAdd(newModel);
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Add System 1 model"
                    onClick={() => handleAdd(newModel)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                <Select value={decisionModel} onValueChange={setDecisionModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a System 1 model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {decisionModels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {decisionModels.map((model) => (
                      <button
                        key={model}
                        type="button"
                        onClick={() => removeDecisionModel(model)}
                        aria-label={`Remove ${model} from System 1 models`}
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted"
                      >
                        {model}
                        <X className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Input
                className="w-full sm:col-span-2"
                placeholder="http://127.0.0.1:8090"
                value={decisionEndpoint}
                onChange={(event) => setDecisionEndpoint(event.target.value)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
