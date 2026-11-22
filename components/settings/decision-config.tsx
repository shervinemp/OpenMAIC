'use client';

/**
 * System 1 (decision layer) settings. One choice for every decision site,
 * selected the same way as the main LLM; no separate server-side config.
 */

import { useMemo } from 'react';
import { Brain } from 'lucide-react';

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
import { useLLMPickerGroups } from './use-llm-picker-groups';

export function DecisionConfigPanel() {
  const { groups } = useLLMPickerGroups();

  const decisionEnabled = useSettingsStore((s) => s.decisionEnabled);
  const decisionProvider = useSettingsStore((s) => s.decisionProvider);
  const decisionModel = useSettingsStore((s) => s.decisionModel);
  const decisionEndpoint = useSettingsStore((s) => s.decisionEndpoint);
  const decisionMode = useSettingsStore((s) => s.decisionMode);
  const setDecisionEnabled = useSettingsStore((s) => s.setDecisionEnabled);
  const setDecisionProvider = useSettingsStore((s) => s.setDecisionProvider);
  const setDecisionModel = useSettingsStore((s) => s.setDecisionModel);
  const setDecisionEndpoint = useSettingsStore((s) => s.setDecisionEndpoint);
  const setDecisionMode = useSettingsStore((s) => s.setDecisionMode);

  const modelOptions = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          value: `${group.id}:${model.id}`,
          label: `${group.name} · ${model.name}`,
        })),
      ),
    [groups],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Brain className="h-5 w-5" />
        <div>
          <h2 className="text-base font-semibold">System 1 decision model</h2>
          <p className="text-xs text-muted-foreground">
            One choice for all grading and verification sites, selected just like the main LLM.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium">Enable System 1</p>
            <p className="mt-0.5 max-w-xl text-[11px] text-muted-foreground">
              Off means the normal LLM is used everywhere. If the decision provider is unavailable
              or abstains, the LLM baseline is used.
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
                <SelectItem value="chat">Chat model</SelectItem>
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
              <Select value={decisionModel} onValueChange={setDecisionModel}>
                <SelectTrigger className="w-full sm:col-span-2">
                  <SelectValue placeholder="Choose one model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
