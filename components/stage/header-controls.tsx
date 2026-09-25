'use client';

import { useCallback, useState } from 'react';
import {
  Archive,
  BookCheck,
  Download,
  FileDown,
  Film,
  FolderGit2,
  Loader2,
  Monitor,
  Moon,
  NotebookText,
  Package,
  Ruler,
  Settings,
  Sun,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportClassroom } from '@/lib/export/use-export-classroom';
import { isScriptExportReady, useExportScript } from '@/lib/export/use-export-script';
import { isVideoExportEnabled } from '@/lib/config/feature-flags';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { CircularProgress } from '@/components/ui/circular-progress';
import { VideoExportDialog } from './video-export-dialog';
import ExamOverlay from '@/components/exam/exam-view';
import { LanguageSwitcher } from '../language-switcher';
import { SettingsDialog } from '../settings';
import { GitBindingDialog } from './git-binding-dialog';
import { isGitSyncAvailable } from '@/lib/persistence/git-course-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly showGlobalControls?: boolean;
  readonly showCourseActions?: boolean;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level global controls: language picker, theme picker, settings
 * modal trigger, and the Pro Switch. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  showGlobalControls = true,
  showCourseActions = true,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [examsOpen, setExamsOpen] = useState(false);
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const gitSyncAvailable = isGitSyncAvailable();
  const stageId = useStageStore((s) => s.stage?.id ?? null);
  const unitCount = useStageStore((s) => s.blueprint?.units?.length ?? 0);
  const examsAvailable = unitCount >= 2;

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { exporting: isExportingZip, exportClassroomZip } = useExportClassroom();
  const { exporting: isExportingScript, exportScriptDocx, exportScriptMd } = useExportScript();
  const videoExportEnabled = isVideoExportEnabled();
  // Video render lives in a global store so its progress ring stays on the
  // export button even after the menu closes / scenes switch mid-render.
  const videoRendering = useVideoRenderStore(
    (s) => s.status === 'compiling' || s.status === 'rendering',
  );
  const videoRenderPercent = useVideoRenderStore((s) => s.percent);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutResult, setLayoutResult] = useState<{
    clamped: number;
    flagged: number;
    lines: Array<{ sceneTitle: string; message: string; severity: string }>;
  } | null>(null);

  const runPlacementSweep = useCallback(async (repair: boolean) => {
    setLayoutBusy(true);
    setLayoutMenuOpen(false);
    try {
      const { useStageStore } = await import('@/lib/store');
      const { sweepScenePlacement } = await import('@/lib/slides/placement-sweep');
      const state = useStageStore.getState();
      const current = state.scenes.find(
        (scene) => scene.id === (state as { currentSceneId?: string }).currentSceneId,
      );
      const scene = current ?? state.scenes.find((scene) => scene.type === 'slide');
      if (!scene) throw new Error('no slide scene');
      const result = sweepScenePlacement(scene as never, { repair });
      if (repair && result.elementsClamped > 0) {
        state.setScenes(
          state.scenes.map((entry) => (entry.id === scene.id ? result.scene : entry)) as never,
        );
      }
      setLayoutResult({
        clamped: result.elementsClamped,
        flagged: result.findings.length,
        lines: result.findings.map((finding) => ({
          sceneTitle: scene.title || scene.id,
          message: finding.message,
          severity: finding.severity,
        })),
      });
    } catch (error) {
      console.error('[layout-sweep]', error);
    } finally {
      setLayoutBusy(false);
    }
  }, []);

  // Keep the original full-generation gate for the export menu. Script files
  // are text-only, but the latest review confirmed that this menu intentionally
  // stays unavailable until all media tasks have completed or failed.
  const canExport = isScriptExportReady({ scenes, generatingOutlines, failedOutlines }, mediaTasks);
  const exportLabel = canExport ? t('export.pptx') : t('share.notReady');

  const compact = variant === 'compact';
  const proChecked = proModeActive ?? mode === 'edit';

  if (!showGlobalControls && !showCourseActions) {
    return onToggleEditMode ? (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('stage.proMode')}
        </span>
        <Switch
          checked={proChecked}
          onCheckedChange={onToggleEditMode}
          disabled={!canEdit}
          aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
        />
      </div>
    ) : null;
  }

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts pad to `px-8`, so the right edge
  // anchors identically too.
  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          'shrink-0 flex items-center gap-1 backdrop-blur-md shadow-sm rounded-full',
          compact
            ? 'bg-zinc-100/70 dark:bg-zinc-800/70 border border-zinc-200/60 dark:border-zinc-700/60 px-1.5 py-1'
            : 'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50 px-2 py-1.5',
        )}
      >
        {/* Language — Radix DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. */}
        <LanguageSwitcher />

        {/* Theme — same Portal-backed DropdownMenu pattern. Non-modal keeps
            Radix from body scroll-locking a fixed-height classroom layout. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
              aria-label={t('settings.theme')}
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Exams — semester midterm/final opening an overlay; hidden when
            the course has no unit blueprint (single-unit course). */}
        {examsAvailable && (
          <button
            onClick={() => setExamsOpen(true)}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
            aria-label={t('exams.title')}
          >
            <BookCheck className="w-4 h-4" />
          </button>
        )}

        {/* Layout sweep — deterministic placement probe (overflow + text
            occlusion) over every slide scene of the open course, ZERO LLM
            calls. The ruler icon keeps it visually distinct from the
            generation controls (no palette of spinners/colors); the fix
            action only moves out-of-bounds elements back inside the
            canvas and never rewrites content. */}
        <DropdownMenu modal={false} open={layoutMenuOpen} onOpenChange={setLayoutMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
              aria-label={t('layoutScan.title')}
              title={t('layoutScan.title')}
            >
              <Ruler className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[220px]">
            <DropdownMenuItem
              onSelect={() => void runPlacementSweep(false)}
              className="cursor-pointer gap-2.5"
            >
              <Ruler className="w-4 h-4 text-gray-400 shrink-0" />
              <div>
                <div>{t('layoutScan.scan')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('layoutScan.scanDesc')}
                </div>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void runPlacementSweep(true)}
              className="cursor-pointer gap-2.5"
            >
              <Ruler className="w-4 h-4 text-violet-400 shrink-0" />
              <div>
                <div>{t('layoutScan.fix')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('layoutScan.fixDesc')}
                </div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
          aria-label={t('settings.title')}
        >
          <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
        </button>
      </div>

      <Dialog
        open={layoutResult !== null || layoutBusy}
        onOpenChange={(open) => !open && setLayoutResult(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            {layoutBusy
              ? t('layoutScan.scanning')
              : layoutResult && layoutResult.flagged === 0
                ? t('layoutScan.clean')
                : t('layoutScan.title')}
          </DialogHeader>
          {layoutBusy && <Loader2 className="w-4 h-4 animate-spin mx-auto my-6" />}
          {!layoutBusy && layoutResult && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {layoutResult.clamped > 0
                  ? `${t('layoutScan.clamped')} ${layoutResult.clamped}`
                  : layoutResult.flagged === 0
                    ? t('layoutScan.cleanDesc')
                    : `${t('layoutScan.flagged')} ${layoutResult.flagged}`}
              </p>
              {layoutResult.lines.length > 0 && (
                <div className="max-h-64 overflow-y-auto space-y-1.5 rounded-md border border-gray-100 dark:border-gray-800 p-2">
                  {layoutResult.lines.map((line, index) => (
                    <div key={index} className="text-[12px] leading-snug">
                      <span
                        className={cn(
                          'font-medium',
                          line.severity === 'error' ? 'text-red-500' : 'text-amber-500',
                        )}
                      >
                        {line.severity === 'error' ? '⛔' : '⚠'}
                      </span>{' '}
                      <span className="text-gray-600 dark:text-gray-300">{line.sceneTitle}</span>
                      <span className="text-gray-400"> — {line.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). Fades in with its
          host bar on the mode swap (no cross-bar layoutId morph: the
          playback Header and edit CommandBar have different left-side
          widths, so morphing made the pill visibly drift). */}
      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border shadow-sm transition-colors duration-200',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            proChecked
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          // When disabled (e.g. the course-complete placeholder), explain why
          // on hover and point the user to a real scene instead of a bare
          // "Edit course" label they can't act on.
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : proChecked
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              'text-[11px] font-bold uppercase tracking-[0.14em] tabular-nums select-none transition-colors duration-200',
              proChecked
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={proChecked}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      {/* Export / Download — lives to the right of the Pro Switch.
          Not a settings function so it does not belong inside the
          settings pill; kept as a separate sibling sitting between the
          Pro Switch and the right edge of the chrome. */}
      <DropdownMenu modal={false} open={exportMenuOpen} onOpenChange={setExportMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            disabled={!canExport || isExporting || isExportingZip || isExportingScript}
            title={
              isExporting || isExportingZip || isExportingScript
                ? t('export.exporting')
                : exportLabel
            }
            className={cn(
              'shrink-0 p-2 rounded-full transition-all',
              canExport && !isExporting && !isExportingZip && !isExportingScript
                ? 'text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed opacity-50',
            )}
            aria-label={exportLabel}
          >
            {isExporting || isExportingZip || isExportingScript ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : videoRendering ? (
              // Persistent ring: video render runs in the background; keep it
              // visible on the button whether or not the menu is open.
              <CircularProgress value={videoRenderPercent} size={20} className="text-primary" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="min-w-[240px]">
          <DropdownMenuItem
            disabled={!canExport}
            onSelect={exportPPTX}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <FileDown className="w-4 h-4 text-gray-400 shrink-0" />
            <span>{t('export.pptx')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canExport}
            onSelect={exportResourcePack}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <Package className="w-4 h-4 text-gray-400 shrink-0" />
            <div>
              <div>{t('export.resourcePack')}</div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('export.resourcePackDesc')}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canExport || isExportingZip}
            onSelect={exportClassroomZip}
            className="cursor-pointer gap-2.5"
            title={canExport ? undefined : t('export.mediaPending')}
          >
            <Archive className="w-4 h-4 text-gray-400 shrink-0" />
            <div>
              <div>{t('export.classroomZip')}</div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('export.classroomZipDesc')}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <span>{t('export.script')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              <DropdownMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptMd}
                className="cursor-pointer gap-2.5"
              >
                <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
                <div>
                  <div>{t('export.scriptMd')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.scriptMdDesc')}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptDocx}
                className="cursor-pointer gap-2.5"
              >
                <NotebookText
                  className="w-4 h-4 text-gray-400 dark:text-gray-500"
                  aria-hidden="true"
                />
                <div>
                  <div>{t('export.scriptDocx')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.scriptDocxDesc')}
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {videoExportEnabled && (
            <DropdownMenuItem
              disabled={!canExport}
              onSelect={() => setVideoDialogOpen(true)}
              className="cursor-pointer gap-2.5 border-t border-gray-200 dark:border-gray-700"
              title={canExport ? undefined : t('export.mediaPending')}
            >
              <Film className="w-4 h-4 text-gray-400 shrink-0" />
              <div>
                <div>{t('export.video')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('export.videoDesc')}
                </div>
              </div>
            </DropdownMenuItem>
          )}
          {gitSyncAvailable && (
            <DropdownMenuItem
              onSelect={() => setGitDialogOpen(true)}
              className="cursor-pointer gap-2.5"
            >
              <FolderGit2 className="w-4 h-4 text-gray-400 shrink-0" />
              <div>
                <div>{t('gitSync.dialogTitle')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('gitSync.menuDesc')}
                </div>
              </div>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {examsAvailable && <ExamOverlay open={examsOpen} onOpenChange={setExamsOpen} />}
      {videoExportEnabled && (
        <VideoExportDialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen} />
      )}
      {gitSyncAvailable && (
        <Dialog open={gitDialogOpen} onOpenChange={setGitDialogOpen}>
          <DialogContent className="max-w-[460px] p-0">
            <DialogHeader className="sr-only">{t('gitSync.dialogTitle')}</DialogHeader>
            <GitBindingDialog
              stageId={stageId}
              open={gitDialogOpen}
              onOpenChange={setGitDialogOpen}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
