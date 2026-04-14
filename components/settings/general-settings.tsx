'use client';

import { useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { clearDatabase } from '@/lib/utils/database';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { useSettingsStore } from '@/lib/store/settings';
import { ModelSelector } from '@/components/settings/model-selector';
import { parseModelString } from '@/lib/ai/providers';

const log = createLogger('GeneralSettings');

export function GeneralSettings() {
  const { t } = useI18n();
  const settings = useSettingsStore();

  // Clear cache state
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const confirmPhrase = t('settings.clearCacheConfirmPhrase');
  const isConfirmValid = confirmInput === confirmPhrase;

  const handleClearCache = useCallback(async () => {
    if (!isConfirmValid) return;
    setClearing(true);
    try {
      // 1. Clear IndexedDB
      await clearDatabase();
      // 2. Clear localStorage
      localStorage.clear();
      // 3. Clear sessionStorage
      sessionStorage.clear();

      toast.success(t('settings.clearCacheSuccess'));

      // Reload page after a short delay
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      log.error('Failed to clear cache:', error);
      toast.error(t('settings.clearCacheFailed'));
      setClearing(false);
    }
  }, [isConfirmValid, t]);

  const clearCacheItems =
    t('settings.clearCacheConfirmItems').split('、').length > 1
      ? t('settings.clearCacheConfirmItems').split('、')
      : t('settings.clearCacheConfirmItems').split(', ');

  const routerParsed = parseModelString(settings.routerModel || 'openai:gpt-4o-mini');
  const fastParsed = parseModelString(settings.fastModel || 'openai:gpt-4o-mini');

  return (
    <div className="flex flex-col gap-8">
      {/* Smart Routing Settings */}
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Switch
            checked={settings.enableSmartRouting}
            onCheckedChange={(c) => settings.setEnableSmartRouting(c)}
          />
          <Label className="text-base font-medium">Enable Smart LLM Routing</Label>
        </div>

        {settings.enableSmartRouting && (
          <div className="pl-6 space-y-6 border-l-2 border-primary/20">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Evaluator Model (Decides Complexity)</Label>
              <div className="h-[300px] border rounded-md overflow-hidden bg-background">
                <ModelSelector
                  providerId={routerParsed.providerId}
                  modelId={routerParsed.modelId}
                  onModelChange={(pId, mId) => settings.setRouterModel(`${pId}:${mId}`)}
                  providersConfig={settings.providersConfig}
                />
              </div>
            </div>
            <div className="space-y-3">
              <Label className="text-sm font-medium">Fast/Cheap Model (For Simple Queries)</Label>
              <div className="h-[300px] border rounded-md overflow-hidden bg-background">
                <ModelSelector
                  providerId={fastParsed.providerId}
                  modelId={fastParsed.modelId}
                  onModelChange={(pId, mId) => settings.setFastModel(`${pId}:${mId}`)}
                  providersConfig={settings.providersConfig}
                />
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Complexity Threshold (1-10)</Label>
                <span className="text-sm font-bold w-6 text-right">
                  {settings.complexityThreshold}
                </span>
              </div>
              <Slider
                value={[settings.complexityThreshold]}
                min={1}
                max={10}
                step={1}
                onValueChange={([val]) => settings.setComplexityThreshold(val)}
              />
              <p className="text-xs text-muted-foreground">
                Queries scoring below this go to the Fast Model. Above goes to your Default Heavy
                Model.
              </p>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Max Length Threshold (characters)</Label>
                <span className="text-sm font-bold w-12 text-right">
                  {settings.maxLengthThreshold}
                </span>
              </div>
              <Slider
                value={[settings.maxLengthThreshold]}
                min={500}
                max={10000}
                step={100}
                onValueChange={([val]) => settings.setMaxLengthThreshold(val)}
              />
              <p className="text-xs text-muted-foreground">
                Queries longer than this are automatically routed to the Default Heavy Model.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* Danger Zone - Clear Cache */}
      <div className="relative rounded-xl border border-destructive/30 bg-destructive/[0.03] dark:bg-destructive/[0.06] overflow-hidden">
        {/* Subtle diagonal stripe pattern for danger emphasis */}
        <div
          className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              transparent,
              transparent 10px,
              currentColor 10px,
              currentColor 11px
            )`,
          }}
        />

        <div className="relative p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-destructive">{t('settings.dangerZone')}</h3>
          </div>

          {/* Content */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{t('settings.clearCache')}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t('settings.clearCacheDescription')}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setConfirmInput('');
                setShowClearDialog(true);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.clearCache')}
            </Button>
          </div>
        </div>
      </div>

      {/* Clear Cache Confirmation Dialog */}
      <AlertDialog
        open={showClearDialog}
        onOpenChange={(open) => {
          if (!clearing) {
            setShowClearDialog(open);
            if (!open) setConfirmInput('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('settings.clearCacheConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('settings.clearCacheConfirmDescription')}</p>
                <ul className="space-y-1.5 ml-1">
                  {clearCacheItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive/60 shrink-0" />
                      {item.trim()}
                    </li>
                  ))}
                </ul>
                <div className="pt-1">
                  <Label className="text-xs font-medium text-foreground">
                    {t('settings.clearCacheConfirmInput')}
                  </Label>
                  <Input
                    className="mt-1.5 h-9 text-sm"
                    placeholder={confirmPhrase}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isConfirmValid) {
                        handleClearCache();
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!isConfirmValid || clearing}
              onClick={handleClearCache}
            >
              {clearing ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1.5" />
              )}
              {t('settings.clearCacheButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
