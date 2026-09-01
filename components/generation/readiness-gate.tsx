'use client';

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId } from '@/lib/audio/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

export interface ReadinessIssue {
  key: string;
  status: string;
  detail?: string;
}

interface ReadinessCheck {
  key: string;
  status: string;
  blocking: boolean;
  detail?: string;
}

/**
 * Pre-flight for expensive generation runs: asks the server to probe the
 * enabled modalities (LLM provider, image/video providers incl. local
 * ComfyUI, TTS server) with the same resolution chain generation itself
 * uses. A dead media stack therefore surfaces before the run burns LLM
 * tokens, not after.
 *
 * The server decides which checks are blocking; this hook only collects
 * them. `probe` resolves to the blocking issues (also stored in `issues`
 * so the gate dialog renders), or null when generation may proceed
 * directly - including when the readiness endpoint itself is unavailable,
 * which must never block generation.
 */
export function useGenerationReadiness() {
  const [issues, setIssues] = useState<ReadinessIssue[] | null>(null);
  const [checking, setChecking] = useState(false);

  const probe = useCallback(async (): Promise<ReadinessIssue[] | null> => {
    const s = useSettingsStore.getState();
    const llm = getCurrentModelConfig();
    const imageConfig = s.imageProvidersConfig?.[s.imageProviderId];
    const videoConfig = s.videoProvidersConfig?.[s.videoProviderId];
    const ttsConfig = s.ttsProvidersConfig?.[s.ttsProviderId];

    setChecking(true);
    try {
      const res = await fetch('/api/generation-readiness', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          llm: {
            providerId: llm.providerId,
            modelId: llm.modelId,
            apiKey: llm.apiKey,
            baseUrl: llm.baseUrl,
          },
          image: {
            enabled: s.imageGenerationEnabled,
            providerId: s.imageProviderId,
            baseUrl: imageConfig?.baseUrl ?? '',
            modelSelected: !!s.imageModelId,
          },
          video: {
            enabled: s.videoGenerationEnabled,
            providerId: s.videoProviderId,
            baseUrl: videoConfig?.baseUrl ?? '',
            modelSelected: !!s.videoModelId,
          },
          tts: {
            enabled: s.ttsEnabled,
            providerId: s.ttsProviderId,
            // Mirror tts-providers.ts: config value first, registry default
            // for built-ins, custom providers always carry their own.
            baseUrl:
              ttsConfig?.baseUrl ||
              (s.ttsProviderId in TTS_PROVIDERS
                ? TTS_PROVIDERS[s.ttsProviderId as BuiltInTTSProviderId].defaultBaseUrl
                : '') ||
              '',
          },
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as { checks?: ReadinessCheck[] } | null;
      const blockingIssues = (data?.checks ?? []).filter((c) => c.blocking);
      const result =
        blockingIssues.length > 0
          ? blockingIssues.map(({ key, status, detail }) => ({ key, status, detail }))
          : null;
      setIssues(result);
      return result;
    } catch {
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  const dismiss = useCallback(() => setIssues(null), []);

  return { probe, checking, issues, dismiss };
}

export function ReadinessGateDialog({
  issues,
  onProceed,
  onReview,
}: {
  issues: ReadinessIssue[] | null;
  onProceed: () => void;
  onReview: () => void;
}) {
  // Rendered by the page; issues here always imply at least one blocker.
  if (!issues || issues.length === 0) return null;
  return <ReadinessGateDialogBody issues={issues} onProceed={onProceed} onReview={onReview} />;
}

function ReadinessGateDialogBody({
  issues,
  onProceed,
  onReview,
}: {
  issues: ReadinessIssue[];
  onProceed: () => void;
  onReview: () => void;
}) {
  const { t } = useI18n();

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
    <Dialog open onOpenChange={(open) => !open && onReview()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('generation.readiness.title')}</DialogTitle>
          <DialogDescription>{t('generation.readiness.description')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {issues.map((issue) => (
            <li key={issue.key} className="rounded-md bg-red-50 p-2 dark:bg-red-950/20">
              <span className="font-semibold">{label(issue.key)}</span>
              {issue.detail ? (
                <span className="mt-0.5 block text-xs text-muted-foreground">{issue.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onReview}>
            {t('generation.readiness.review')}
          </Button>
          <Button onClick={onProceed}>{t('generation.readiness.proceed')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
