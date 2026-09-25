'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  PanelLeftClose,
  PieChart,
  Cpu,
  MousePointer2,
  BookOpen,
  Play,
  Globe,
  AlertCircle,
  RefreshCw,
  ChevronRight,
  VolumeX,
  X,
  Dumbbell,
  Sigma,
  BookMarked,
  Library,
  Scale,
  LineChart,
  GitBranch,
  PenLine,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';
import type { Scene, SlideContent, InteractiveContent } from '@/lib/types/stage';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { indexScenesByOutline } from '@/lib/utils/outline-scene-match';

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Skip resolution (Pillar 2 §4.9): close a failed outline permanently. */
  readonly onSkipOutline?: (outlineId: string) => void;
  /** Re-kick the scene batch after a provider-failure pause. */
  readonly onResumeGeneration?: () => void;
  /** Run a narration/media byte repair pass over the course on demand. */
  readonly onRepairCourse?: () => void;
  /** Whether a course repair pass is running. */
  readonly courseRepairing?: boolean;
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
  onResumeGeneration,
  onRepairCourse,
  courseRepairing = false,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const repairActive = useStageStore.use.repairActive();
  const blueprint = useStageStore.use.blueprint();
  const generationPhase = useStageStore.use.generationPhase();
  const sceneDepth = useStageStore.use.sceneDepth();
  const lessonGroups = useStageStore.use.lessonGroups();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  // UNIFIED SERVING RULE: scenes whose `layout` phase failed are debt — they
  // do not render in either sidebar path (flat or blueprint-grouped) until
  // the layout train reports done. Same ledger family as content/actions.
  const layoutFailedOutlineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of lessonGroups) {
      for (const job of group.jobs) {
        if (job.phases.layout?.status === 'failed') ids.add(job.outlineId);
      }
    }
    return ids;
  }, [lessonGroups]);

  const servableScenes = useMemo(
    () =>
      scenes.filter((scene) => !scene.outlineId || !layoutFailedOutlineIds.has(scene.outlineId)),
    [scenes, layoutFailedOutlineIds],
  );

  // Pillar 2 lesson progress (from the persisted blueprint): per-lesson
  // done/total plus the audio-pending fill count — the "3/4 lessons
  // complete, 2 audio pending" completion display.
  const lessonProgress = useMemo(() => {
    if (!blueprint) return null;
    // Fill-decay membership comes from THE ONE QUEUE (failedOutlines covers
    // content-failed AND tts/media byte-decayed rows) — a count keyed on
    // `!audioId` alone would miss the actual decay mode (id present, bytes
    // gone). The count honestly reports unsettled material a lesson carries.
    const failedOutlineIds = new Set(failedOutlines.map((outline) => outline.id));
    const mediaStatusByOutline = new Map(
      lessonGroups.flatMap((group) => group.jobs.map((job) => [job.outlineId, job.phases.media])),
    );
    const materialized = indexScenesByOutline(scenes);
    const lessons = blueprint.lessons.map((lesson) => {
      const total = lesson.outlines.length;
      const done = lesson.outlines.filter((outline) => materialized.has(outline)).length;
      const reworked = lesson.outlines.filter(
        (outline) => sceneDepth[String(outline.order)]?.reworked,
      ).length;
      const mediaFailed = lesson.outlines.filter(
        (outline) =>
          mediaStatusByOutline.get(outline.id)?.status === 'failed' ||
          failedOutlineIds.has(outline.id),
      ).length;
      const audioPending = lesson.outlines.filter((outline) => {
        const scene = materialized.sceneFor(outline);
        return (
          scene &&
          (failedOutlineIds.has(outline.id) ||
            (scene.actions ?? []).some(
              (action) => action.type === 'speech' && !!action.text && !action.audioId,
            ))
        );
      }).length;
      return { title: lesson.title, total, done, reworked, mediaFailed, audioPending };
    });
    return { lessons };
  }, [blueprint, scenes, sceneDepth, lessonGroups, failedOutlines]);

  // Heavy-course structure (semester preset): blueprint.units already knows the
  // unit -> lesson -> outline hierarchy. Collapsible unit sections mount ONLY
  // the expanded unit's scene entries instead of one unvirtualized 600-item
  // thumbnail list. Single-unit / blueprint-less courses keep the flat list.
  const groupedUnits = useMemo(() => {
    const units = blueprint?.units;
    if (!units || units.length <= 1) return null;
    const progress = lessonProgress?.lessons ?? [];
    const failedOutlineIds = new Set(failedOutlines.map((outline) => outline.id));
    // UNIFIED SERVING RULE: a scene whose `layout` phase failed is debt — same
    // ledger family as content/actions/tts/media. It does not render in the
    // lesson list until the layout train reports done (deterministic pass →
    // bounded patch → split terminal), and its lesson counts it as pending.
    const layoutFailedByOutline = new Map(
      lessonGroups.flatMap((group) => group.jobs.map((job) => [job.outlineId, job.phases.layout])),
    );
    const indexByOutlineId = new Map(
      scenes.flatMap((scene, index) =>
        scene.outlineId ? [[scene.outlineId, index] as const] : [],
      ),
    );
    let lessonCursor = 0;
    const usedIndices = new Set<number>();
    const sections = units.map((unit, unitIndex) => {
      const lessons = unit.lessons.map((lesson) => {
        const lessonIndex = lessonCursor;
        lessonCursor += 1;
        const lessonScenes: Scene[] = [];
        const lessonIndices: number[] = [];
        for (const outline of lesson.outlines) {
          const sceneIndex = indexByOutlineId.get(outline.id);
          if (sceneIndex === undefined) continue;
          if (layoutFailedByOutline.get(outline.id)?.status === 'failed') continue;
          lessonScenes.push(scenes[sceneIndex]);
          lessonIndices.push(sceneIndex);
          usedIndices.add(sceneIndex);
        }
        const p = progress[lessonIndex];
        // ONE-QUEUE-faithful lesson completion: a lesson is done when its
        // slides are materialized AND the lesson carries no unsettled
        // material (fill-decayed audio/media re-enter the queue and demote
        // the lesson back out of "complete").
        const pending = lesson.outlines.filter((outline) =>
          failedOutlineIds.has(outline.id),
        ).length;
        const done = (p?.done ?? 0) - Math.min(p?.done ?? 0, pending);
        return {
          key: `u${unitIndex}-l${lessonIndex}`,
          title: lesson.title,
          scenes: lessonScenes,
          sceneIndices: lessonIndices,
          done,
          total: p?.total ?? lesson.outlines.length,
          reworked: p?.reworked ?? 0,
          pending,
        };
      });
      return {
        key: `unit-${unitIndex}`,
        title: unit.title,
        lessons,
        sceneCount: lessons.reduce((sum, lesson) => sum + lesson.scenes.length, 0),
        lessonDone: lessons.reduce(
          (sum, lesson) => sum + (lesson.done === lesson.total ? 1 : 0),
          0,
        ),
        lessonTotal: lessons.length,
      };
    });
    const unmatched = scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene, index }) => !usedIndices.has(index) && scene.outlineId != null);
    if (unmatched.length > 0) {
      sections.push({
        key: 'ungrouped',
        title: t('stage.ungroupedScenes'),
        lessons: [
          {
            key: 'ungrouped-all',
            title: t('stage.ungroupedScenes'),
            scenes: unmatched.map(({ scene }) => scene),
            sceneIndices: unmatched.map(({ index }) => index),
            done: unmatched.length,
            total: unmatched.length,
            reworked: 0,
            pending: 0,
          },
        ],
        sceneCount: unmatched.length,
        lessonDone: 0,
        lessonTotal: 1,
      });
    }
    return sections;
  }, [blueprint, scenes, lessonProgress, failedOutlines, lessonGroups, t]);

  const selectScene = useCallback(
    (sceneId: string) => {
      if (onSceneSelect) {
        onSceneSelect(sceneId);
      } else {
        setCurrentSceneId(sceneId);
      }
    },
    [onSceneSelect, setCurrentSceneId],
  );

  // One unit open at a time: the unit holding the active scene keeps the mount
  // bound small; other units become a compact, scannable table of contents.
  const [openUnits, setOpenUnits] = useState<Set<string>>(new Set());

  // Lesson sections collapse too, so an open unit shows a lesson list of ~52
  // titles instead of mounting every scene thumbnail at once (semester preset
  // can put a full lecture per lesson).
  const [openLessons, setOpenLessons] = useState<Set<string>>(new Set());

  const revealedSceneRef = useRef<string | null>(null);

  useEffect(() => {
    if (!groupedUnits || !currentSceneId) return;
    // Reveal ONCE per navigation. `groupedUnits` is rebuilt on every store
    // tick (phase records, scene arrivals, debt updates), and re-running the
    // reveal on those rebuilds collapsed the reader's expanded units and
    // lessons back to the active scene's section — the "sidebar resets during
    // regeneration" bug. Only an actual `currentSceneId` change (or the tree
    // resolving for the first time) may move the view now.
    if (revealedSceneRef.current === currentSceneId) return;
    revealedSceneRef.current = currentSceneId;
    const activeUnit = groupedUnits.find((unit) =>
      unit.lessons.some((lesson) => lesson.scenes.some((scene) => scene.id === currentSceneId)),
    );
    // Debt-hidden scene (layout failed → re-admitted by the train): the reader's
    // view stays untouched — and must not pop open later when the scene returns.
    if (!activeUnit) return;
    const activeLesson = activeUnit.lessons.find((lesson) =>
      lesson.scenes.some((scene) => scene.id === currentSceneId),
    );
    if (!openUnits.has(activeUnit.key)) {
      // A different unit: the unit accordion follows the navigation.
      setOpenUnits(new Set([activeUnit.key]));
      if (activeLesson) {
        setOpenLessons(new Set([activeLesson.key]));
      }
    } else if (activeLesson && !openLessons.has(activeLesson.key)) {
      // Same unit: keep every lesson the reader opened; just admit the active
      // one (canvas/keyboard navigation can target a collapsed lesson).
      setOpenLessons((prev) => new Set(prev).add(activeLesson.key));
    }
    // Keep the newly-active scene visible when its lesson auto-expands.
    requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-testid="scene-list"] [data-scene-id="${CSS.escape(currentSceneId)}"]`,
      );
      target?.scrollIntoView({ block: 'nearest' });
    });
  }, [currentSceneId, groupedUnits, openUnits, openLessons]);

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
      comparison: Scale,
      dataReading: LineChart,
      tradeoffs: GitBranch,
      freeResponse: PenLine,
    };
    return icons[kind] || BookOpen;
  };

  const displayWidth = collapsed ? 0 : sidebarWidth;

  const renderSceneItem = (scene: Scene, sceneIndex: number) => {
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
        data-scene-id={scene.id}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectScene(scene.id);
          }
        }}
        onClick={() => selectScene(scene.id)}
        className={cn(
          'group relative rounded-lg transition-all duration-200 cursor-pointer flex flex-col gap-1 p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900',
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
              {sceneIndex + 1}
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
              <LazySlideThumbnail
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
                <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">
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
  };

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
          <div className="flex items-center gap-1">
            {onRepairCourse && (
              <button
                onClick={onRepairCourse}
                disabled={courseRepairing || generationStatus === 'generating'}
                data-testid="repair-course"
                aria-label={t(courseRepairing ? 'stage.repairingCourse' : 'stage.repairCourse')}
                title={t(courseRepairing ? 'stage.repairingCourse' : 'stage.repairCourse')}
                className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-100/90 dark:hover:bg-gray-800/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200 disabled:opacity-50 disabled:active:scale-100"
              >
                {courseRepairing ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Wrench className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            <button
              onClick={() => onCollapseChange(true)}
              className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 text-gray-500 dark:text-gray-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-gray-200/90 dark:hover:bg-gray-700/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scenes List */}
        <div
          data-testid="scene-list"
          className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-2 scrollbar-thin border-r-[6px] border-transparent pt-1"
        >
          {groupedUnits && (
            <div className="flex flex-col gap-1">
              {groupedUnits.map((unit) => {
                const isOpen = openUnits.has(unit.key);
                return (
                  <div key={unit.key} className="flex flex-col gap-1" data-testid="unit-section">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      title={`${unit.title} — ${unit.lessonDone} of ${unit.lessonTotal} lessons complete, ${unit.sceneCount} scenes`}
                      onClick={() =>
                        setOpenUnits((prev) => {
                          const next = new Set(prev);
                          if (next.has(unit.key)) next.delete(unit.key);
                          else next.add(unit.key);
                          return next;
                        })
                      }
                      data-testid="unit-toggle"
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 rounded-md w-full flex items-center gap-1.5 px-1.5 py-1 text-left hover:bg-gray-100/70 dark:hover:bg-gray-800/50 transition-colors"
                    >
                      <ChevronRight
                        className={cn(
                          'w-3 h-3 shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-150',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="flex-1 truncate text-[11px] font-bold text-gray-700 dark:text-gray-200">
                        {unit.title}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-[10px] font-semibold tabular-nums',
                          unit.lessonDone === unit.lessonTotal && unit.lessonTotal > 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-gray-400 dark:text-gray-500',
                        )}
                      >
                        {unit.lessonDone}/{unit.lessonTotal}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="flex flex-col gap-1 ml-2 pl-2 border-l border-gray-100 dark:border-gray-800">
                        {unit.lessons.map((lesson) => {
                          const isLessonOpen = openLessons.has(lesson.key);
                          return (
                            <div
                              key={lesson.key}
                              className="flex flex-col gap-1"
                              data-testid="lesson-section"
                            >
                              <button
                                type="button"
                                aria-expanded={isLessonOpen}
                                title={`${lesson.title} — ${lesson.done} of ${lesson.total} scenes generated`}
                                onClick={() =>
                                  setOpenLessons((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(lesson.key)) next.delete(lesson.key);
                                    else next.add(lesson.key);
                                    return next;
                                  })
                                }
                                data-testid="lesson-toggle"
                                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 rounded-md w-full flex items-center gap-1 px-1 py-0.5 text-left hover:bg-gray-100/70 dark:hover:bg-gray-800/50 transition-colors"
                              >
                                <ChevronRight
                                  className={cn(
                                    'w-2.5 h-2.5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-150',
                                    isLessonOpen && 'rotate-90',
                                  )}
                                />
                                <span
                                  data-testid="lesson-title"
                                  className="flex-1 truncate text-[11px] font-semibold text-gray-600 dark:text-gray-300"
                                >
                                  {lesson.title}
                                </span>
                                <span
                                  className={cn(
                                    'shrink-0 text-[10px] font-semibold tabular-nums',
                                    lesson.done === lesson.total
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-gray-400 dark:text-gray-500',
                                    lesson.reworked > 0 && 'text-amber-500/90 dark:text-amber-400',
                                  )}
                                >
                                  {lesson.done}/{lesson.total}
                                </span>
                              </button>
                              {isLessonOpen &&
                                lesson.scenes.map((scene, i) =>
                                  renderSceneItem(scene, lesson.sceneIndices[i]),
                                )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* Lesson progress strip (Pillar 2): per-lesson done/total + audio fill state */}
          {!groupedUnits && lessonProgress && (
            <div className="flex flex-col gap-1 pb-1 border-b border-gray-100 dark:border-gray-800">
              <div className="flex flex-wrap gap-1">
                {lessonProgress.lessons.map((lesson, index) => (
                  <span
                    key={`${lesson.title}-${index}`}
                    title={lesson.title}
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold ring-1',
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
          {!groupedUnits && servableScenes.map((scene) => renderSceneItem(scene, scene.order))}
        </div>

        {/* Docked generation slot: a separate, always-visible panel UNDER the
            scroll container (both cards render at most one at a time). Keeping
            it out of the scroll flow means every completed scene no longer
            ships the scrolling list a full tile down — the status is fixed to
            the sidebar bottom and the scene list's scroll position stays put.
            RECOVERY INVARIANT: the dock is also driven by PERSISTED facts
            (blueprint outlines vs stored scenes), not just by the in-memory
            failed/generating queues — after a reload, a deck with unfinished
            pages still surfaces "finish remaining" instead of silently
            masquerading both as complete and as un-resumable. */}
        {/* RECOVERY = the classic red regenerate cards, hydrated from the
            persisted invariant (missing outline ⇒ failed regenerate box), so
            the same UI as before also survives reloads. Initiation stays
            manual (Retry per card) unless the user pauses/resumes. */}
        {(generatingOutlines.length > 0 || failedOutlines.length > 0) && (
          <div
            data-testid="generation-dock"
            className="shrink-0 p-2 space-y-2 border-t border-r-[6px] border-transparent border-t-gray-100 dark:border-t-gray-800"
          >
            {/* Single dock card: the active placeholder, or the failed outline
              when only the red card remains (ONE QUEUE — any unsettled phase
              surfaces the same classic regenerate card, Retry/Skip included). */}
            {(generatingOutlines.length > 0 || failedOutlines.length > 0) &&
              (() => {
                const outline = generatingOutlines[0] ?? failedOutlines[0];
                if (!outline) return null;
                const isFailed = failedOutlines.some((f) => f.id === outline.id);
                const isRetrying = retryingOutlineId === outline.id;
                const isPaused = generationStatus === 'paused';
                const isActive = currentSceneId === PENDING_SCENE_ID;

                return (
                  <div
                    key={`generating-${outline.id}`}
                    role="button"
                    tabIndex={0}
                    aria-disabled={isFailed}
                    onKeyDown={(e) => {
                      if (isFailed) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectScene(PENDING_SCENE_ID);
                      }
                    }}
                    onClick={() => {
                      if (isFailed) return;
                      selectScene(PENDING_SCENE_ID);
                    }}
                    className={cn(
                      'group relative rounded-lg flex flex-col gap-1 p-1.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400',
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
                                disabled={
                                  isRetrying ||
                                  repairActive === 'narration' ||
                                  repairActive === 'media'
                                }
                                className="p-1 -ml-1 rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                                title={t('generation.retryScene')}
                              >
                                <RefreshCw
                                  className={cn(
                                    'w-3.5 h-3.5',
                                    (isRetrying ||
                                      repairActive === 'narration' ||
                                      repairActive === 'media') &&
                                      'animate-spin',
                                  )}
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
                            <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 mt-0.5">
                              {isPaused
                                ? t('stage.paused')
                                : generationPhase === 'actions'
                                  ? t('generation.phaseActions')
                                  : generationPhase === 'tts'
                                    ? t('generation.phaseNarration')
                                    : generationPhase === 'content'
                                      ? t('generation.phaseContent')
                                      : t('stage.generating')}
                            </span>
                            {isPaused && onResumeGeneration && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onResumeGeneration();
                                }}
                                className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-purple-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-purple-500 transition-colors active:scale-95"
                                title={t('stage.resumeGeneration')}
                              >
                                <Play className="w-2.5 h-2.5" />
                                {t('stage.resumeGeneration')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {/* Phase chips (Pillar 2 §4.2): content → actions → tts → media → layout → semantics */}
                      {!isFailed && !isPaused && (
                        <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1">
                          {(
                            ['content', 'actions', 'tts', 'media', 'layout', 'semantics'] as const
                          ).map((phase) => (
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
          </div>
        )}

        {/* Spacer to push toggle button area */}
        <div className="mt-auto" />
      </div>
    </div>
  );
}

/**
 * Viewport-gated slide thumbnail for the playback sidebar. Scenes far outside
 * the viewport render SlideThumbnail's cheap placeholder instead of a full
 * SlideCanvas — which also spares every off-screen video element its
 * `preload="metadata"` fetch when the classroom opens. The placeholder keeps
 * the same box size, so gating never shifts layout.
 */
function LazySlideThumbnail({
  slide,
  sceneId,
  viewportSize,
  viewportRatio,
  size,
}: {
  readonly slide: SlideContent['canvas'];
  readonly sceneId: string;
  readonly viewportSize: number;
  readonly viewportRatio: number;
  readonly size: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref);
  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      <SlideThumbnail
        slide={slide}
        sceneId={sceneId}
        viewportSize={viewportSize}
        viewportRatio={viewportRatio}
        size={size}
        visible={visible}
      />
    </div>
  );
}
