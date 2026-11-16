'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { Whiteboard } from '@/components/whiteboard';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import type { CanvasToolbarProps } from '@/components/canvas/canvas-toolbar';
import type { Scene, StageMode } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ClassroomCompletePageConnected } from '@/components/scene-renderers/classroom-complete';
import { ContainBox } from '@/components/edit/ContainBox';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardElementReference } from '@/lib/types/chat';
import { SlideElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';

interface CanvasAreaProps extends CanvasToolbarProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly hideToolbar?: boolean;
  readonly isPendingScene?: boolean;
  readonly isCourseComplete?: boolean;
  readonly isGenerationFailed?: boolean;
  readonly onRetryGeneration?: () => void;
  readonly elementPickActive?: boolean;
  readonly whiteboardElementReference?: WhiteboardElementReference;
  readonly onPickWhiteboardElement?: (element: PPTElement) => void;
  readonly onPickElement?: (element: PPTElement) => void;
  readonly onCancelElementPick?: () => void;
}

export function CanvasArea({
  currentScene,
  currentSceneIndex,
  scenesCount,
  mode,
  engineState,
  isLiveSession,
  isSoftClosing,
  softCloseDeadline,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  isPresenting,
  onTogglePresentation,
  showStopDiscussion,
  onStopDiscussion,
  onContinueDiscussion,
  hideToolbar,
  isPendingScene,
  isCourseComplete,
  isGenerationFailed,
  onRetryGeneration,
  elementPickActive,
  whiteboardElementReference,
  onPickElement,
  onPickWhiteboardElement,
  onCancelElementPick,
}: CanvasAreaProps) {
  const { t } = useI18n();
  const inWorkbenchPanel = useInWorkbenchPanel();
  const isPhone = useMediaQuery('(max-width: 767px)');
  const [slideZoomed, setSlideZoomed] = useState(false);
  const canZoom = isPhone && (currentScene?.type === 'slide' || currentScene?.type === 'quiz');
  // State only takes effect on zoomable scenes; leaving one (or resizing to
  // desktop) naturally falls back to fit without a reset effect.
  const zoomed = canZoom && slideZoomed;
  const showControls = mode === 'playback' && !whiteboardOpen;
  const showPlayHint =
    showControls &&
    engineState !== 'playing' &&
    currentScene?.type === 'slide' &&
    !isLiveSession &&
    !isPendingScene &&
    !zoomed;

  const handleSlideClick = useCallback(
    (e: React.MouseEvent) => {
      if (!showControls || isLiveSession || currentScene?.type !== 'slide') return;
      // Don't trigger page play/pause when clicking inside a video element's visual area.
      // Video elements may be visually covered by other slide elements (e.g. text),
      // so we check click coordinates against all video element bounding rects.
      const container = e.currentTarget as HTMLElement;
      const videoEls = container.querySelectorAll('[data-video-element]');
      for (const el of videoEls) {
        const rect = el.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          return;
        }
      }
      onPlayPause();
    },
    [showControls, isLiveSession, onPlayPause, currentScene?.type],
  );

  return (
    <div className="w-full h-full flex flex-col bg-gray-50 dark:bg-gray-900 group/canvas">
      {/* Slide area — takes remaining space */}
      <div
        className={cn(
          'flex-1 min-h-0 relative overflow-hidden transition-colors duration-500',
          currentScene?.type === 'interactive'
            ? 'bg-blue-50/30 dark:bg-blue-900/10'
            : 'bg-gray-50/30 dark:bg-gray-900/30',
        )}
      >
        <div
          className={cn(
            'h-full w-full p-2',
            zoomed ? 'overflow-auto overscroll-contain' : 'flex items-center justify-center',
          )}
        >
          <StageViewport
            zoomed={zoomed}
            workbench={inWorkbenchPanel}
            interactive={currentScene?.type === 'interactive'}
            className={cn(
              'bg-white dark:bg-gray-800 shadow-2xl rounded-lg overflow-hidden relative transition-all duration-700',
              showControls && !isLiveSession && currentScene?.type === 'slide' && 'cursor-pointer',
              currentScene?.type === 'interactive'
                ? 'shadow-blue-200/50 dark:shadow-blue-900/50 ring-1 ring-blue-900/5 dark:ring-blue-500/10'
                : 'shadow-gray-200/50 dark:shadow-gray-800/50 ring-1 ring-gray-950/5 dark:ring-white/5',
            )}
            onClick={handleSlideClick}
          >
            {/* Whiteboard Layer */}
            <div className="absolute inset-0 z-[110] pointer-events-none">
              <SceneProvider>
                <Whiteboard
                  isOpen={whiteboardOpen}
                  onClose={onWhiteboardClose}
                  elementPickActive={elementPickActive && whiteboardOpen}
                  whiteboardElementReference={whiteboardElementReference}
                  onPickElement={onPickWhiteboardElement}
                  onCancelElementPick={onCancelElementPick}
                />
              </SceneProvider>
            </div>

            {/* Scene Content */}
            {currentScene && !whiteboardOpen && (
              <div className="absolute inset-0">
                <SceneProvider>
                  <SceneRenderer scene={currentScene} mode={mode} />
                </SceneProvider>
              </div>
            )}

            {elementPickActive &&
              !whiteboardOpen &&
              onPickElement &&
              onCancelElementPick &&
              currentScene?.type === 'slide' &&
              currentScene.content.type === 'slide' && (
                <SlideElementPickOverlay
                  scene={currentScene}
                  onPick={onPickElement}
                  onCancel={onCancelElementPick}
                />
              )}

            {/* Pending Scene Loading / Completion Overlay */}
            <AnimatePresence>
              {isPendingScene && !currentScene && isCourseComplete && (
                <motion.div
                  key="course-complete"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="absolute inset-0"
                >
                  <ClassroomCompletePageConnected />
                </motion.div>
              )}
              {isPendingScene && !currentScene && !isCourseComplete && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  className="absolute inset-0 z-[105] flex flex-col items-center justify-center bg-white dark:bg-gray-800"
                >
                  {isGenerationFailed ? (
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                        <svg
                          className="w-6 h-6 text-red-400 dark:text-red-500"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                          />
                        </svg>
                      </div>
                      <span className="text-sm text-red-500 dark:text-red-400 font-medium">
                        {t('stage.generationFailed')}
                      </span>
                      {onRetryGeneration && (
                        <button
                          onClick={onRetryGeneration}
                          className="mt-1 px-4 py-1.5 text-xs font-medium rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                        >
                          {t('generation.retryScene')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-4">
                      {/* Spinner */}
                      <div className="relative w-12 h-12">
                        <div className="absolute inset-0 rounded-full border-2 border-gray-100 dark:border-gray-700" />
                        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 dark:border-t-purple-400 animate-spin" />
                      </div>
                      {/* Text */}
                      <motion.span
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.3 }}
                        className="text-sm text-gray-400 dark:text-gray-500 font-medium"
                      >
                        {t('stage.generatingNextPage')}
                      </motion.span>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Scene Number Badge */}
            {currentScene && (
              <div className="absolute top-4 right-4 text-gray-200 dark:text-gray-700 font-black text-4xl opacity-50 pointer-events-none select-none mix-blend-multiply dark:mix-blend-screen">
                {(currentSceneIndex + 1).toString().padStart(2, '0')}
              </div>
            )}
          </StageViewport>
        </div>

        {canZoom && (
          <button
            type="button"
            aria-label={zoomed ? 'Fit slide to screen' : 'Zoom slide'}
            title={zoomed ? 'Fit slide to screen' : 'Zoom slide'}
            onClick={() => setSlideZoomed((value) => !value)}
            className="absolute left-3 top-3 z-[103] flex h-9 w-9 items-center justify-center rounded-full border border-gray-200/80 bg-white/90 text-gray-600 shadow-md backdrop-blur transition-colors hover:text-purple-600 dark:border-gray-700/80 dark:bg-gray-800/90 dark:text-gray-300 dark:hover:text-purple-400"
          >
            {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </button>
        )}

        {/* Play hint — breathing button when idle or paused (slides only).
            It sits in the letterbox margin around the slide, so it never covers
            body copy even on full pages. */}
        <AnimatePresence>
          {showPlayHint && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 z-[102] flex items-end justify-end p-4 pointer-events-none"
            >
              <motion.button
                type="button"
                aria-label="Play"
                initial={{ scale: 0.85 }}
                animate={{ scale: [1, 1.06] }}
                exit={{ scale: 1.15, opacity: 0 }}
                transition={{
                  default: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                  scale: {
                    repeat: Infinity,
                    repeatType: 'mirror',
                    duration: 1,
                    ease: 'easeInOut',
                  },
                }}
                className="w-14 h-14 rounded-full bg-white dark:bg-gray-800 flex items-center justify-center pointer-events-auto cursor-pointer shadow-[0_4px_30px_rgba(147,51,234,0.15),inset_0_0_0_1px_rgba(233,213,255,0.5)] dark:shadow-[0_4px_30px_rgba(147,51,234,0.3),inset_0_0_0_1px_rgba(126,34,206,0.3)]"
                style={{ willChange: 'transform' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlayPause();
                }}
              >
                <Play className="w-6 h-6 text-purple-600 dark:text-purple-400 fill-purple-600/90 dark:fill-purple-400/90 ml-0.5" />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Canvas Toolbar — in document flow, only when not merged into roundtable ── */}
      {!hideToolbar && (
        <CanvasToolbar
          className={cn(
            'shrink-0 h-9 px-2 min-w-0 overflow-x-auto scrollbar-hide',
            'bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl',
            'border-t border-gray-200/40 dark:border-gray-700/40',
          )}
          currentSceneIndex={currentSceneIndex}
          scenesCount={scenesCount}
          engineState={engineState}
          isLiveSession={isLiveSession}
          isSoftClosing={isSoftClosing}
          softCloseDeadline={softCloseDeadline}
          whiteboardOpen={whiteboardOpen}
          sidebarCollapsed={sidebarCollapsed}
          chatCollapsed={chatCollapsed}
          onToggleSidebar={onToggleSidebar}
          onToggleChat={onToggleChat}
          onPrevSlide={onPrevSlide}
          onNextSlide={onNextSlide}
          onPlayPause={onPlayPause}
          onWhiteboardClose={onWhiteboardClose}
          isPresenting={isPresenting}
          onTogglePresentation={onTogglePresentation}
          showStopDiscussion={showStopDiscussion}
          onStopDiscussion={onStopDiscussion}
          onContinueDiscussion={onContinueDiscussion}
        />
      )}
    </div>
  );
}

function StageViewport({
  workbench,
  interactive,
  zoomed = false,
  className,
  onClick,
  children,
}: {
  readonly workbench: boolean;
  readonly interactive: boolean;
  readonly zoomed?: boolean;
  readonly className?: string;
  readonly onClick?: (event: React.MouseEvent) => void;
  readonly children: ReactNode;
}) {
  if (interactive) {
    return (
      <div className={cn('h-full w-full', className)} onClick={onClick}>
        {children}
      </div>
    );
  }
  if (!workbench) {
    return (
      <div
        className={cn(
          'aspect-[16/9]',
          zoomed ? 'w-[260%] max-w-none shrink-0' : 'h-full max-h-full max-w-full',
          className,
        )}
        onClick={onClick}
      >
        {children}
      </div>
    );
  }
  return (
    <ContainBox fit="contain" className={className}>
      <div className="relative h-full w-full" onClick={onClick}>
        {children}
      </div>
    </ContainBox>
  );
}
