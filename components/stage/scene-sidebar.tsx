'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  PanelLeftClose,
  PieChart,
  Cpu,
  MousePointer2,
  BookOpen,
  Globe,
  AlertCircle,
  RefreshCw,
  Trophy,
  VolumeX,
  X,
  Dumbbell,
  Sigma,
  BookMarked,
  Library,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Scene, SlideContent, InteractiveContent } from '@/lib/types/stage';
import { PENDING_SCENE_ID } from '@/lib/store/stage';

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Skip resolution (Pillar 2 §4.9): close a failed outline permanently. */
  readonly onSkipOutline?: (outlineId: string) => void;
  readonly isCourseComplete?: boolean;
}

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 170;
const MAX_WIDTH = 400;

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  onSkipOutline,
  isCourseComplete,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const blueprint = useStageStore.use.blueprint();
  const generationPhase = useStageStore.use.generationPhase();
  const sceneDepth = useStageStore.use.sceneDepth();
  const lessonGroups = useStageStore.use.lessonGroups();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  // Pillar 2 lesson progress (from the persisted blueprint): per-lesson
  // done/total plus the audio-pending fill count — the "3/4 lessons
  // complete, 2 audio pending" completion display.
  const lessonProgress = useMemo(() => {
    if (!blueprint) return null;
    const mediaStatusByOutline = new Map(
      lessonGroups.flatMap((group) => group.jobs.map((job) => [job.outlineId, job.phases.media])),
    );
    const sceneByOrder = new Map(scenes.map((scene) => [scene.order, scene]));
    const lessons = blueprint.lessons.map((lesson) => {
      const total = lesson.outlines.length;
      const done = lesson.outlines.filter((outline) =>
        scenes.some((scene) => scene.order === outline.order),
      ).length;
      const reworked = lesson.outlines.filter(
        (outline) => sceneDepth[String(outline.order)]?.reworked,
      ).length;
      const mediaFailed = lesson.outlines.filter(
        (outline) => mediaStatusByOutline.get(outline.id)?.status === 'failed',
      ).length;
      const audioPending = lesson.outlines.filter((outline) => {
        const scene = sceneByOrder.get(outline.order);
        return (
          scene &&
          (scene.actions ?? []).some(
            (action) => action.type === 'speech' && !!action.text && !action.audioId,
          )
        );
      }).length;
      return { title: lesson.title, total, done, reworked, mediaFailed, audioPending };
    });
    return { lessons };
  }, [blueprint, scenes, sceneDepth, lessonGroups]);

  const [retryingOutlineId, setRetryingOutlineId] = useState<string | null>(null);

  const handleRetryOutline = async (outlineId: string) => {
    if (!onRetryOutline) return;
    setRetryingOutlineId(outlineId);
    try {
      await onRetryOutline(outlineId);
    } finally {
      setRetryingOutlineId(null);
    }
  };

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isDraggingRef = useRef(false);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (me: MouseEvent) => {
        const delta = me.clientX - startX;
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
        setSidebarWidth(newWidth);
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth],
  );

  const getSceneTypeIcon = (scene: Scene) => {
    const kind = scene.sceneKind ?? scene.type;
    const icons = {
      slide: BookOpen,
      quiz: PieChart,
      interactive: MousePointer2,
      pbl: Cpu,
      exercise: Dumbbell,
      derivation: Sigma,
      glossary: BookMarked,
      reading: Library,
    };
    return icons[kind] || BookOpen;
  };

  const displayWidth = collapsed ? 0 : sidebarWidth;

  return (
    <div
      style={{
        width: displayWidth,
        transition: isDraggingRef.current ? 'none' : 'width 0.3s ease',
      }}
      className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-r border-gray-100 dark:border-gray-800 shadow-[2px_0_24px_rgba(0,0,0,0.02)] flex flex-col shrink-0 z-20 relative overflow-visible"
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          onMouseDown={handleDragStart}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group hover:bg-purple-400/30 dark:hover:bg-purple-600/30 active:bg-purple-500/40 dark:active:bg-purple-500/40 transition-colors"
        >
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
        </div>
      )}

      <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
        {/* Logo Header */}
        <div className="h-10 flex items-center justify-between shrink-0 relative mt-3 mb-1 px-3">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 cursor-pointer rounded-lg px-1.5 -mx-1.5 py-1 -my-1 hover:bg-gray-100/80 dark:hover:bg-gray-800/60 active:scale-[0.97] transition-all duration-150"
            title={t('generation.backToHome')}
          >
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-6" />
          </button>
          <button
            onClick={() => onCollapseChange(true)}
            className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 text-gray-500 dark:text-gray-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-gray-200/90 dark:hover:bg-gray-700/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* Scenes List */}
        <div
          data-testid="scene-list"
          className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-2 scrollbar-hide pt-1"
        >
          {/* Lesson progress strip (Pillar 2): per-lesson done/total + audio fill state */}
          {lessonProgress && (
            <div className="flex flex-col gap-1 pb-1 border-b border-gray-100 dark:border-gray-800">
              <div className="flex flex-wrap gap-1">
                {lessonProgress.lessons.map((lesson, index) => (
                  <span
                    key={`${lesson.title}-${index}`}
                    title={lesson.title}
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold ring-1',
                      lesson.done === lesson.total
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 ring-emerald-200 dark:ring-emerald-800'
                        : 'bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500 ring-gray-200 dark:ring-gray-700',
                    )}
                  >
                    <span className="max-w-[72px] truncate">
                      {lesson.title.replace(/^Lesson \d+: /, '')}
                    </span>
                    <span className="opacity-70">
                      {lesson.done}/{lesson.total}
                    </span>
                    {lesson.reworked > 0 && (
                      <span
                        className="text-amber-500/90 dark:text-amber-400"
                        title={t('generation.reworkedForDepthCount', { count: lesson.reworked })}
                      >
                        {lesson.reworked}↻
                      </span>
                    )}
                    {lesson.mediaFailed > 0 && (
                      <span
                        className="text-red-500/90 dark:text-red-400"
                        title={t('generation.mediaFailedCount', { count: lesson.mediaFailed })}
                      >
                        {lesson.mediaFailed}!
                      </span>
                    )}
                    {lesson.audioPending > 0 && (
                      <span
                        className="text-amber-500/90 dark:text-amber-400"
                        title={t('generation.audioPendingCount', { count: lesson.audioPending })}
                      >
                        <VolumeX className="w-2.5 h-2.5 inline -mt-0.5" />
                        {lesson.audioPending}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
          {scenes.map((scene, index) => {
            const isActive = currentSceneId === scene.id;
            const Icon = getSceneTypeIcon(scene);
            const isSlide = scene.type === 'slide';
            const isInteractive = scene.type === 'interactive';
            const slideContent = isSlide ? (scene.content as SlideContent) : null;
            const interactiveContent = isInteractive ? (scene.content as InteractiveContent) : null;

            return (
              <div
                key={scene.id}
                data-testid="scene-item"
                onClick={() => {
                  if (onSceneSelect) {
                    onSceneSelect(scene.id);
                  } else {
                    setCurrentSceneId(scene.id);
                  }
                }}
                className={cn(
                  'group relative rounded-lg transition-all duration-200 cursor-pointer flex flex-col gap-1 p-1.5',
                  isActive
                    ? 'bg-purple-50 dark:bg-purple-900/20 ring-1 ring-purple-200 dark:ring-purple-700'
                    : 'hover:bg-gray-50/80 dark:hover:bg-gray-800/50',
                )}
              >
                {/* Scene Header */}
                <div className="flex justify-between items-center px-2 pt-0.5">
                  <div className="flex items-center gap-2 max-w-full">
                    <span
                      className={cn(
                        'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                        isActive
                          ? 'bg-purple-600 dark:bg-purple-500 text-white shadow-sm shadow-purple-500/30'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span
                      data-testid="scene-title"
                      className={cn(
                        'text-xs font-bold truncate transition-colors',
                        isActive
                          ? 'text-purple-700 dark:text-purple-300'
                          : 'text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100',
                      )}
                    >
                      {scene.title}
                    </span>
                    {sceneDepth[String(scene.order)]?.reworked && (
                      <span
                        className="shrink-0 text-amber-500/90 dark:text-amber-400"
                        title={t('generation.reworkedForDepth')}
                      >
                        ↻
                      </span>
                    )}
                  </div>
                </div>

                {/* Thumbnail */}
                <div className="relative aspect-video w-full rounded overflow-hidden bg-gray-100 dark:bg-gray-800 ring-1 ring-black/5 dark:ring-white/5">
                  <div className="absolute inset-0 flex items-center justify-center">
                    {isSlide && slideContent ? (
                      <SlideThumbnail
                        slide={slideContent.canvas}
                        sceneId={scene.id}
                        viewportSize={viewportSize}
                        viewportRatio={viewportRatio}
                        size={Math.max(100, sidebarWidth - 28)}
                      />
                    ) : scene.type === 'quiz' ? (
                      /* Quiz: question bar + 2x2 option grid */
                      <div className="w-full h-full bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/20 p-2 flex flex-col">
                        <div className="h-1.5 w-4/5 bg-orange-200/70 dark:bg-orange-700/30 rounded-full mb-1.5" />
                        <div className="flex-1 grid grid-cols-2 gap-1">
                          {[0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className={cn(
                                'rounded flex items-center gap-1 px-1',
                                i === 1
                                  ? 'bg-orange-400/20 dark:bg-orange-500/20 border border-orange-300/50 dark:border-orange-600/30'
                                  : 'bg-white/60 dark:bg-white/5 border border-orange-100/60 dark:border-orange-800/20',
                              )}
                            >
                              <div
                                className={cn(
                                  'w-1.5 h-1.5 rounded-full shrink-0',
                                  i === 1
                                    ? 'bg-orange-400 dark:bg-orange-500'
                                    : 'bg-orange-200 dark:bg-orange-700/50',
                                )}
                              />
                              <div
                                className={cn(
                                  'h-1 rounded-full flex-1',
                                  i === 1
                                    ? 'bg-orange-300/60 dark:bg-orange-600/40'
                                    : 'bg-orange-100/80 dark:bg-orange-800/30',
                                )}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : scene.type === 'interactive' && interactiveContent?.html ? (
                      /* Interactive: live iframe preview */
                      <ThumbnailInteractive
                        content={interactiveContent}
                        size={Math.max(100, sidebarWidth - 28)}
                      />
                    ) : scene.type === 'interactive' ? (
                      /* Interactive: browser window with chrome + content */
                      <div className="w-full h-full bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 p-1.5 flex flex-col">
                        <div className="flex items-center gap-1 mb-1 pb-1 border-b border-emerald-200/40 dark:border-emerald-700/20">
                          <div className="flex gap-0.5">
                            <div className="w-1 h-1 rounded-full bg-red-300 dark:bg-red-500/60" />
                            <div className="w-1 h-1 rounded-full bg-amber-300 dark:bg-amber-500/60" />
                            <div className="w-1 h-1 rounded-full bg-green-300 dark:bg-green-500/60" />
                          </div>
                          <div className="h-1.5 flex-1 bg-emerald-200/40 dark:bg-emerald-700/30 rounded-full ml-0.5" />
                        </div>
                        <div className="flex-1 flex gap-1">
                          <div className="w-1/4 space-y-1 pt-0.5">
                            {[1, 2, 3].map((i) => (
                              <div
                                key={i}
                                className="h-0.5 w-full bg-emerald-200/60 dark:bg-emerald-700/30 rounded-full"
                              />
                            ))}
                          </div>
                          <div className="flex-1 bg-emerald-100/40 dark:bg-emerald-800/20 rounded flex items-center justify-center border border-emerald-200/40 dark:border-emerald-700/20">
                            <Globe className="w-4 h-4 text-emerald-300/80 dark:text-emerald-600/50" />
                          </div>
                        </div>
                      </div>
                    ) : scene.type === 'pbl' ? (
                      /* PBL: kanban board with 3 columns */
                      <div className="w-full h-full bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/20 p-1.5 flex flex-col">
                        <div className="flex items-center gap-1 mb-1.5">
                          <div className="w-1.5 h-1.5 rounded bg-blue-300 dark:bg-blue-600" />
                          <div className="h-1 w-8 bg-blue-200/60 dark:bg-blue-700/30 rounded-full" />
                        </div>
                        <div className="flex-1 flex gap-1 overflow-hidden">
                          {[0, 1, 2].map((col) => (
                            <div
                              key={col}
                              className="flex-1 bg-white/50 dark:bg-white/5 rounded p-0.5 flex flex-col gap-0.5"
                            >
                              <div
                                className={cn(
                                  'h-0.5 w-3 rounded-full mb-0.5',
                                  col === 0
                                    ? 'bg-blue-300/70'
                                    : col === 1
                                      ? 'bg-amber-300/70'
                                      : 'bg-green-300/70',
                                )}
                              />
                              {Array.from({
                                length: col === 0 ? 3 : col === 1 ? 2 : 1,
                              }).map((_, i) => (
                                <div
                                  key={i}
                                  className="h-2 w-full bg-blue-100/60 dark:bg-blue-800/20 rounded border border-blue-200/30 dark:border-blue-700/20"
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      /* Fallback */
                      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-500">
                        <Icon className="w-4 h-4" />
                        <span className="text-[9px] font-bold uppercase tracking-wider opacity-80">
                          {scene.type}
                        </span>
                      </div>
                    )}

                    {isSlide && (
                      <div
                        className={cn(
                          'absolute inset-0 bg-purple-500/0 transition-colors',
                          isActive
                            ? 'bg-purple-500/0'
                            : 'group-hover:bg-black/5 dark:group-hover:bg-white/5',
                        )}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Single placeholder for the next generating page (clickable) */}
          {generatingOutlines.length > 0 &&
            (() => {
              const outline = generatingOutlines[0];
              const isFailed = failedOutlines.some((f) => f.id === outline.id);
              const isRetrying = retryingOutlineId === outline.id;
              const isPaused = generationStatus === 'paused';
              const isActive = currentSceneId === PENDING_SCENE_ID;

              return (
                <div
                  key={`generating-${outline.id}`}
                  onClick={() => {
                    if (isFailed) return;
                    if (onSceneSelect) {
                      onSceneSelect(PENDING_SCENE_ID);
                    } else {
                      setCurrentSceneId(PENDING_SCENE_ID);
                    }
                  }}
                  className={cn(
                    'group relative rounded-lg flex flex-col gap-1 p-1.5 transition-all duration-200',
                    isFailed
                      ? 'opacity-100 cursor-default'
                      : 'cursor-pointer hover:bg-gray-50/80 dark:hover:bg-gray-800/50',
                    !isFailed && !isActive && 'opacity-60',
                    isActive &&
                      !isFailed &&
                      'bg-purple-50 dark:bg-purple-900/20 ring-1 ring-purple-200 dark:ring-purple-700 opacity-100',
                  )}
                >
                  {/* Scene Header */}
                  <div className="flex justify-between items-center px-2 pt-0.5">
                    <div className="flex items-center gap-2 max-w-full">
                      <span
                        className={cn(
                          'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                          isActive && !isFailed
                            ? 'bg-purple-600 dark:bg-purple-500 text-white shadow-sm shadow-purple-500/30'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                        )}
                      >
                        {scenes.length + 1}
                      </span>
                      <span
                        className={cn(
                          'text-xs font-bold truncate transition-colors',
                          isActive && !isFailed
                            ? 'text-purple-700 dark:text-purple-300'
                            : isFailed
                              ? 'text-gray-700 dark:text-gray-200'
                              : 'text-gray-400 dark:text-gray-500',
                        )}
                      >
                        {outline.title}
                      </span>
                    </div>
                  </div>

                  {/* Skeleton Thumbnail */}
                  <div
                    className={cn(
                      'relative aspect-video w-full rounded overflow-hidden ring-1',
                      isFailed
                        ? 'bg-red-50/30 dark:bg-red-950/10 ring-red-100 dark:ring-red-900/20'
                        : 'bg-gray-100 dark:bg-gray-800 ring-black/5 dark:ring-white/5',
                    )}
                  >
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                      {isFailed ? (
                        <div className="flex items-center gap-1 text-xs font-medium text-red-500/90 dark:text-red-400">
                          {onRetryOutline ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetryOutline(outline.id);
                              }}
                              disabled={isRetrying}
                              className="p-1 -ml-1 rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                              title={t('generation.retryScene')}
                            >
                              <RefreshCw
                                className={cn('w-3.5 h-3.5', isRetrying && 'animate-spin')}
                              />
                            </button>
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5" />
                          )}
                          {onSkipOutline && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onSkipOutline(outline.id);
                              }}
                              disabled={isRetrying}
                              className="p-1 rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                              title={t('generation.skipScene')}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span>
                            {isRetrying
                              ? t('generation.retryingScene')
                              : t('stage.generationFailed')}
                          </span>
                        </div>
                      ) : (
                        <>
                          <div
                            className={cn(
                              'h-2 w-3/5 bg-gray-200 dark:bg-gray-700 rounded',
                              !isPaused && 'animate-pulse',
                            )}
                          />
                          <div
                            className={cn(
                              'h-1.5 w-2/5 bg-gray-200 dark:bg-gray-700 rounded',
                              !isPaused && 'animate-pulse',
                            )}
                          />
                          <span className="text-[9px] font-medium text-gray-400 dark:text-gray-500 mt-0.5">
                            {isPaused ? t('stage.paused') : t('stage.generating')}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Phase chips (Pillar 2 §4.2): content → actions → tts → media */}
                    {!isFailed && !isPaused && (
                      <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1">
                        {(['content', 'actions', 'tts', 'media'] as const).map((phase) => (
                          <span
                            key={phase}
                            className={cn(
                              'flex-1 h-1 rounded-full transition-colors',
                              generationPhase === phase
                                ? 'bg-purple-500 dark:bg-purple-400 animate-pulse'
                                : 'bg-gray-200 dark:bg-gray-700',
                            )}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Course-complete placeholder (shown when outline is exhausted) */}
          {isCourseComplete &&
            generatingOutlines.length === 0 &&
            (() => {
              const isActive = currentSceneId === PENDING_SCENE_ID;
              return (
                <div
                  key="course-complete-slot"
                  onClick={() => {
                    if (onSceneSelect) {
                      onSceneSelect(PENDING_SCENE_ID);
                    } else {
                      setCurrentSceneId(PENDING_SCENE_ID);
                    }
                  }}
                  className={cn(
                    'group relative rounded-lg flex flex-col gap-1 p-1.5 transition-all duration-200 cursor-pointer hover:bg-amber-50/60 dark:hover:bg-amber-900/10',
                    !isActive && 'opacity-80',
                    isActive &&
                      'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-700 opacity-100',
                  )}
                >
                  <div className="flex justify-between items-center px-2 pt-0.5">
                    <div className="flex items-center gap-2 max-w-full">
                      <span
                        className={cn(
                          'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                          isActive
                            ? 'bg-amber-500 dark:bg-amber-400 text-white shadow-sm shadow-amber-500/30'
                            : 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {scenes.length + 1}
                      </span>
                      <span
                        className={cn(
                          'text-xs font-bold truncate transition-colors',
                          isActive
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {t('stage.courseComplete')}
                      </span>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'relative aspect-video w-full rounded overflow-hidden ring-1 flex items-center justify-center transition-all',
                      'bg-amber-50/80 dark:bg-amber-950/20',
                      isActive
                        ? 'ring-amber-300 dark:ring-amber-700'
                        : 'ring-amber-100 dark:ring-amber-900/40',
                    )}
                  >
                    {/* soft radial glow */}
                    <div
                      className="absolute inset-0"
                      style={{
                        background:
                          'radial-gradient(circle at 50% 55%, rgba(251, 191, 36, 0.14), transparent 65%)',
                      }}
                    />
                    {/* sparkles (subtle) */}
                    <svg
                      viewBox="0 0 20 20"
                      className="absolute top-1 right-1.5 w-1.5 h-1.5 text-amber-300/70 dark:text-amber-400/60"
                      aria-hidden
                    >
                      <path
                        d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                        fill="currentColor"
                      />
                    </svg>
                    <svg
                      viewBox="0 0 20 20"
                      className="absolute bottom-1 left-1.5 w-1 h-1 text-amber-300/60 dark:text-amber-400/50"
                      aria-hidden
                    >
                      <path
                        d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                        fill="currentColor"
                      />
                    </svg>
                    <Trophy
                      className="relative w-8 h-8 text-amber-500 dark:text-amber-400"
                      strokeWidth={1.6}
                    />
                    {lessonProgress && (
                      <span className="relative mt-1.5 text-[9px] font-semibold text-amber-600/90 dark:text-amber-400/90">
                        {t('generation.lessonCompletion', {
                          done: lessonProgress.lessons.filter((l) => l.done === l.total).length,
                          total: lessonProgress.lessons.length,
                          scenes: scenes.length,
                        })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}
        </div>

        {/* Spacer to push toggle button area */}
        <div className="mt-auto" />
      </div>
    </div>
  );
}
