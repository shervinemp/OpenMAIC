'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

export interface ReadinessIssue {
  key: string;
  detail?: string;
}

interface ReadinessResponse {
  checks?: Array<{ key: string; status: string; detail?: string }>;
}

const BLOCKING = new Set(['unreachable', 'unconfigured', 'auth_error']);

/**
 * Pre-flight for expensive generation runs: probes the enabled modalities
 * (LLM provider reachability, ComfyUI server + workflow selection, TTS
 * server) and surfaces anything that would waste tokens discovered
 * mid-run. Advisory only - the user can proceed anyway.
 */
export function useGenerationReadiness() {
  const [issues, setIssues] = useState<ReadinessIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [resolveGate, setResolveGate] = useState<((proceed: boolean) => void) | null>(null);

  const check = async (): Promise<boolean> => {
    const s = useSettingsStore.getState();
    setChecking(true);
    try {
      const res = await fetch('/api/generation-readiness', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          llm: { providerId: s.providerId, modelId: s.modelId },
          image: {
            enabled: s.imageGenerationEnabled,
            providerId: s.imageProviderId,
            baseUrl: s.imageProvidersConfig[s.imageProviderId]?.baseUrl,
            modelSelected: !!s.imageModelId,
          },
          video: {
            enabled: s.videoGenerationEnabled,
            providerId: s.videoProviderId,
            baseUrl: s.videoProvidersConfig[s.videoProviderId]?.baseUrl,
            modelSelected: !!s.videoModelId,
          },
          tts: {
            enabled: s.ttsEnabled,
            providerId: s.ttsProviderId,
            baseUrl: s.ttsProvidersConfig?.[s.ttsProviderId]?.baseUrl,
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ReadinessResponse;
      const blocking = (data.checks ?? [])
        .filter((c) => BLOCKING.has(c.status))
        .map((c) => ({ key: c.key, detail: c.detail }));
      if (blocking.length === 0) return true;
      setIssues(blocking);
      return await new Promise<boolean>((resolve) => setResolveGate(() => resolve));
    } catch {
      // Readiness itself failed (server restarting, etc.) - do not block.
      return true;
    } finally {
      setChecking(false);
    }
  };

  const settle = (proceed: boolean) => {
    setIssues(null);
    setResolveGate(null);
    resolveGate?.(proceed);
  };

  return { check, checking, issues, settle };
}

export function ReadinessGateDialog({
  issues,
  onProceed,
  onCancel,
}: {
  issues: ReadinessIssue[] | null;
  onProceed: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (!issues || issues.length === 0) return null;

  const label = (key: string): string => {
    switch (key) {
      case 'llm':
        return t('generation.readiness.llm');
      case 'image':
        return t('generation.readiness.image');
      case 'video':
        return t('generation.readiness.video');
      case 'tts':
        return t('generation.readiness.tts');
      default:
        return key;
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('generation.readiness.title')}</DialogTitle>
          <DialogDescription>{t('generation.readiness.description')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {issues.map((issue) => (
            <li key={issue.key} className="rounded-md bg-red-50 dark:bg-red-950/20 p-2">
              <span className="font-semibold">{label(issue.key)}</span>
              {issue.detail ? (
                <span className="block text-xs text-muted-foreground mt-0.5">{issue.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('generation.readiness.review')}
          </Button>
          <Button onClick={onProceed}>{t('generation.readiness.proceed')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
