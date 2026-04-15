import { create } from 'zustand';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import { defaultRichTextAttrs } from '@/lib/prosemirror/utils';
import type { TextFormatPainter, ShapeFormatPainter, CreatingElement } from '@/lib/types/edit';
import type { PercentageGeometry } from '@/lib/types/action';

/**
 * Spotlight options
 */
export interface SpotlightOptions {
  radius?: number; // Spotlight radius (pixels)
  dimness?: number; // Background dimming level (0-1)
  transition?: number; // Transition animation duration (milliseconds)
}

/**
 * Highlight overlay options
 */
export interface HighlightOverlayOptions {
  color?: string; // Highlight color
  opacity?: number; // Highlight opacity (0-1)
  borderWidth?: number; // Border width
  animated?: boolean; // Whether to animate
}

/**
 * Laser pointer options
 */
export interface LaserOptions {
  color?: string; // Laser pointer color, default red
  duration?: number; // Duration (milliseconds)
}

/**
 * Canvas Store - Manages all UI state of the Canvas editor
 *
 * Responsibilities:
 * - Element selection state (selected, handling, editing)
 * - Canvas viewport state (zoom, drag, ruler, grid)
 * - Toolbar and panel state
 * - Element being created
 * - Rich text editing state
 * - Format painter state
 *
 * Note: Does not manage slide data (elements, background, etc.), which is managed by Scene Context
 */

// ==================== Store Interface ====================

interface CanvasState {
  // ===== Element selection state =====
  activeElementIdList: string[]; // Currently selected element IDs
  handleElementId: string; // Element being operated (drag, resize, etc.)
  activeGroupElementId: string; // Selected child element within a group
  editingElementId: string; // Element being edited (e.g., text editing)
  hiddenElementIdList: string[]; // Hidden element IDs

  // ===== Teaching feature state =====
  spotlightElementId: string; // Element focused by spotlight
  spotlightOptions: SpotlightOptions | null; // Spotlight configuration
  spotlightMode: 'pixel' | 'percentage'; // Spotlight mode: pixel or percentage
  spotlightPercentageGeometry: PercentageGeometry | null; // Percentage mode geometry info
  highlightedElementIds: string[]; // Highlighted element IDs
  highlightOptions: HighlightOverlayOptions | null; // Highlight configuration
  laserElementId: string; // Element focused by laser pointer
  laserOptions: LaserOptions | null; // Laser pointer configuration
  zoomTarget: { elementId: string; scale: number } | null; // Zoom target

  // ===== Canvas viewport state =====
  canvasScale: number; // Canvas actual zoom scale
  canvasPercentage: number; // Canvas percentage (used to calculate canvasScale)
  viewportSize: number; // Viewport width base (default 1000px)
  viewportRatio: number; // Viewport aspect ratio (default 0.5625, i.e. 16:9)
  canvasDragged: boolean; // Whether canvas is being dragged

  // ===== Display aids =====
  showRuler: boolean; // Show ruler
  gridLineSize: number; // Grid line size (0 means hidden)

  // ===== Toolbar and panels =====
  toolbarState: 'design' | 'ai' | 'elAnimation'; // Right toolbar state
  showSelectPanel: boolean; // Selection panel
  showSearchPanel: boolean; // Find and replace panel

  // ===== Element creation =====
  creatingElement: CreatingElement | null; // Element being created (needs draw-to-insert)
  creatingCustomShape: boolean; // Drawing custom shape (arbitrary polygon)

  // ===== Editing state =====
  isScaling: boolean; // Element scaling in progress
  clipingImageElementId: string; // Image being cropped
  richTextAttrs: TextAttrs; // Rich text editing state

  // ===== Format painter =====
  textFormatPainter: TextFormatPainter | null; // Text format painter
  shapeFormatPainter: ShapeFormatPainter | null; // Shape format painter

  // ===== Video playback =====
  playingVideoElementId: string; // Video element currently playing

  // ===== Whiteboard =====
  whiteboardOpen: boolean; // Whether whiteboard is open
  whiteboardClearing: boolean; // Whiteboard clear animation in progress

  // ===== Other =====
  thumbnailsFocus: boolean; // Whether left thumbnail area is focused
  editorAreaFocus: boolean; // Whether editor area is focused
  disableHotkeys: boolean; // Whether hotkeys are disabled
  selectedTableCells: string[]; // Selected table cells

  // ===== Actions =====

  // ----- Element selection -----
  setActiveElementIdList: (ids: string[]) => void;
  setHandleElementId: (id: string) => void;
  setActiveGroupElementId: (id: string) => void;
  setEditingElementId: (id: string) => void;
  setHiddenElementIdList: (ids: string[]) => void;
  clearSelection: () => void; // Clear all selections

  // ----- Canvas viewport -----
  setCanvasScale: (scale: number) => void;
  setCanvasPercentage: (percentage: number) => void;
  setViewportSize: (size: number) => void;
  setViewportRatio: (ratio: number) => void;
  setCanvasDragged: (dragged: boolean) => void;

  // ----- Display aids -----
  setRulerState: (show: boolean) => void;
  setGridLineSize: (size: number) => void;

  // ----- Toolbar and panels -----
  setToolbarState: (state: 'design' | 'ai') => void;
  setSelectPanelState: (show: boolean) => void;
  setSearchPanelState: (show: boolean) => void;

  // ----- Element creation -----
  setCreatingElement: (element: CreatingElement | null) => void;
  setCreatingCustomShapeState: (creating: boolean) => void;

  // ----- Editing state -----
  setScalingState: (isScaling: boolean) => void;
  setClipingImageElementId: (id: string) => void;
  setRichtextAttrs: (attrs: TextAttrs) => void;

  // ----- Format painter -----
  setTextFormatPainter: (painter: TextFormatPainter | null) => void;
  setShapeFormatPainter: (painter: ShapeFormatPainter | null) => void;

  // ----- Video playback -----
  playVideo: (elementId: string) => void;
  pauseVideo: () => void;

  // ----- Whiteboard -----
  setWhiteboardOpen: (open: boolean) => void;
  setWhiteboardClearing: (clearing: boolean) => void;

  // ----- Other -----
  setThumbnailsFocus: (focus: boolean) => void;
  setEditorAreaFocus: (focus: boolean) => void;
  setDisableHotkeysState: (disable: boolean) => void;
  setSelectedTableCells: (cells: string[]) => void;

  // ----- Teaching features -----
  setSpotlight: (elementId: string, options?: SpotlightOptions) => void;
  clearSpotlight: () => void;
  setSpotlightPercentage: (
    elementId: string,
    geometry: PercentageGeometry,
    options?: SpotlightOptions,
  ) => void;
  setHighlight: (elementIds: string[], options?: HighlightOverlayOptions) => void;
  clearHighlight: () => void;
  setLaser: (elementId: string, options?: LaserOptions) => void;
  clearLaser: () => void;
  setZoom: (elementId: string, scale: number) => void;
  clearZoom: () => void;
  clearAllEffects: () => void;

  // ----- Batch operations -----
  resetCanvasState: () => void; // Reset Canvas state (used when switching scenes)
}

// ==================== Initial State ====================

const initialState = {
  // Element selection
  activeElementIdList: [],
  handleElementId: '',
  activeGroupElementId: '',
  editingElementId: '',
  hiddenElementIdList: [],

  // Canvas viewport
  canvasScale: 1,
  canvasPercentage: 90,
  viewportSize: 1000,
  viewportRatio: 0.5625, // 16:9
  canvasDragged: false,

  // Display aids
  showRuler: false,
  gridLineSize: 0,

  // Toolbar and panels
  toolbarState: 'ai' as const,
  showSelectPanel: false,
  showSearchPanel: false,

  // Element creation
  creatingElement: null,
  creatingCustomShape: false,

  // Editing state
  isScaling: false,
  clipingImageElementId: '',
  richTextAttrs: defaultRichTextAttrs,

  // Format painter
  textFormatPainter: null,
  shapeFormatPainter: null,

  // Video playback
  playingVideoElementId: '',

  // Whiteboard
  whiteboardOpen: false,
  whiteboardClearing: false,

  // Other: false,
  editorAreaFocus: false,
  thumbnailsFocus: false,
  disableHotkeys: false,
  selectedTableCells: [],

  // Teaching features
  spotlightElementId: '',
  spotlightOptions: null,
  spotlightMode: 'pixel' as const,
  spotlightPercentageGeometry: null,
  highlightedElementIds: [],
  highlightOptions: null,
  laserElementId: '',
  laserOptions: null,
  zoomTarget: null,
};

// ==================== Store Implementation ====================


export interface SelectionSlice {
  activeElementIdList: string[];
  handleElementId: string;
  activeGroupElementId: string;
  editingElementId: string;
  hiddenElementIdList: string[];

  setActiveElementIdList: (ids: string[]) => void;
  setHandleElementId: (id: string) => void;
  setActiveGroupElementId: (id: string) => void;
  setEditingElementId: (id: string) => void;
  setHiddenElementIdList: (ids: string[]) => void;
  clearSelection: () => void;
}

export interface ViewportSlice {
  canvasScale: number;
  canvasPercentage: number;
  viewportSize: number;
  viewportRatio: number;
  canvasDragged: boolean;

  panX: number;
  panY: number;
  viewZoom: number;

  setCanvasScale: (scale: number) => void;
  setCanvasPercentage: (percentage: number) => void;
  setViewportSize: (size: number) => void;
  setViewportRatio: (ratio: number) => void;
  setCanvasDragged: (dragged: boolean) => void;
  setPanX: (x: number | ((prev: number) => number)) => void;
  setPanY: (y: number | ((prev: number) => number)) => void;
  setViewZoom: (zoom: number | ((prev: number) => number)) => void;
}

export interface TeachingAidsSlice {
  spotlightElementId: string;
  spotlightOptions: SpotlightOptions | null;
  spotlightMode: 'pixel' | 'percentage';
  spotlightPercentageGeometry: PercentageGeometry | null;
  highlightedElementIds: string[];
  highlightOptions: HighlightOverlayOptions | null;
  laserElementId: string;
  laserOptions: LaserOptions | null;
  zoomTarget: { elementId: string; scale: number } | null;

  setSpotlight: (elementId: string, options?: SpotlightOptions) => void;
  clearSpotlight: () => void;
  setSpotlightPercentage: (
    elementId: string,
    geometry: PercentageGeometry,
    options?: SpotlightOptions,
  ) => void;
  setHighlight: (elementIds: string[], options?: HighlightOverlayOptions) => void;
  clearHighlight: () => void;
  setLaser: (elementId: string, options?: LaserOptions) => void;
  clearLaser: () => void;
  setZoom: (elementId: string, scale: number) => void;
  clearZoom: () => void;
  clearAllEffects: () => void;
}

export interface OtherCanvasState {
  showRuler: boolean;
  gridLineSize: number;
  toolbarState: 'design' | 'ai' | 'elAnimation';
  showSelectPanel: boolean;
  showSearchPanel: boolean;
  creatingElement: CreatingElement | null;
  creatingCustomShape: boolean;
  isScaling: boolean;
  clipingImageElementId: string;
  richTextAttrs: TextAttrs;
  textFormatPainter: TextFormatPainter | null;
  shapeFormatPainter: ShapeFormatPainter | null;
  playingVideoElementId: string;
  whiteboardOpen: boolean;
  whiteboardClearing: boolean;
  thumbnailsFocus: boolean;
  editorAreaFocus: boolean;
  disableHotkeys: boolean;
  selectedTableCells: string[];

  setRulerState: (show: boolean) => void;
  setGridLineSize: (size: number) => void;
  setToolbarState: (state: 'design' | 'ai' | 'elAnimation') => void;
  setSelectPanelState: (show: boolean) => void;
  setSearchPanelState: (show: boolean) => void;
  setCreatingElement: (element: CreatingElement | null) => void;
  setCreatingCustomShapeState: (creating: boolean) => void;
  setScalingState: (isScaling: boolean) => void;
  setClipingImageElementId: (id: string) => void;
  setRichtextAttrs: (attrs: TextAttrs) => void;
  setTextFormatPainter: (painter: TextFormatPainter | null) => void;
  setShapeFormatPainter: (painter: ShapeFormatPainter | null) => void;
  playVideo: (elementId: string) => void;
  pauseVideo: () => void;
  setWhiteboardOpen: (open: boolean) => void;
  setWhiteboardClearing: (clearing: boolean) => void;
  setThumbnailsFocus: (focus: boolean) => void;
  setEditorAreaFocus: (focus: boolean) => void;
  setDisableHotkeysState: (disable: boolean) => void;
  setSelectedTableCells: (cells: string[]) => void;
  resetCanvasState: () => void;
}

export type CanvasState = SelectionSlice & ViewportSlice & TeachingAidsSlice & OtherCanvasState;

import { StateCreator } from 'zustand';

const createSelectionSlice: StateCreator<CanvasState, [], [], SelectionSlice> = (set) => ({
  ...initialSelectionState,
  setActiveElementIdList: (ids) => {
    set({ activeElementIdList: ids });
    if (ids.length === 1) {
      set({ handleElementId: ids[0] });
    } else if (ids.length === 0) {
      set({ handleElementId: '' });
    }
    if (ids.length > 0) {
      set({ toolbarState: 'design' });
    }
  },
  setHandleElementId: (id) => set({ handleElementId: id }),
  setActiveGroupElementId: (id) => set({ activeGroupElementId: id }),
  setEditingElementId: (id) => set({ editingElementId: id }),
  setHiddenElementIdList: (ids) => set({ hiddenElementIdList: ids }),
  clearSelection: () => set({
    activeElementIdList: [],
    handleElementId: '',
    activeGroupElementId: '',
    editingElementId: '',
  }),
});

const createViewportSlice: StateCreator<CanvasState, [], [], ViewportSlice> = (set) => ({
  ...initialViewportState,
  setCanvasScale: (scale) => set({ canvasScale: scale }),
  setCanvasPercentage: (percentage) => set({ canvasPercentage: percentage }),
  setViewportSize: (size) => set({ viewportSize: size }),
  setViewportRatio: (ratio) => set({ viewportRatio: ratio }),
  setCanvasDragged: (dragged) => set({ canvasDragged: dragged }),
  setPanX: (x) => set((state) => ({ panX: typeof x === "function" ? x(state.panX) : x })),
  setPanY: (y) => set((state) => ({ panY: typeof y === "function" ? y(state.panY) : y })),
  setViewZoom: (zoom) => set((state) => ({ viewZoom: typeof zoom === "function" ? zoom(state.viewZoom) : zoom })),
});

const createTeachingAidsSlice: StateCreator<CanvasState, [], [], TeachingAidsSlice> = (set) => ({
  ...initialTeachingAidsState,
  setSpotlight: (elementId, options = {}) => set({
    spotlightElementId: elementId,
    spotlightMode: 'pixel',
    spotlightOptions: {
      radius: 200,
      dimness: 0.7,
      transition: 300,
      ...options,
    },
    spotlightPercentageGeometry: null,
  }),
  setSpotlightPercentage: (elementId, geometry, options = {}) => set({
    spotlightElementId: elementId,
    spotlightMode: 'percentage',
    spotlightPercentageGeometry: geometry,
    spotlightOptions: {
      dimness: 0.7,
      transition: 300,
      ...options,
    },
  }),
  clearSpotlight: () => set({
    spotlightElementId: '',
    spotlightOptions: null,
    spotlightMode: 'pixel',
    spotlightPercentageGeometry: null,
  }),
  setHighlight: (elementIds, options = {}) => set({
    highlightedElementIds: elementIds,
    highlightOptions: {
      color: '#ff6b6b',
      opacity: 0.3,
      borderWidth: 3,
      animated: true,
      ...options,
    },
  }),
  clearHighlight: () => set({
    highlightedElementIds: [],
    highlightOptions: null,
  }),
  setLaser: (elementId, options = {}) => set({
    laserElementId: elementId,
    laserOptions: {
      color: '#ff0000',
      duration: 3000,
      ...options,
    },
  }),
  clearLaser: () => set({
    laserElementId: '',
    laserOptions: null,
  }),
  setZoom: (elementId, scale) => set({
    zoomTarget: { elementId, scale },
  }),
  clearZoom: () => set({
    zoomTarget: null,
  }),
  clearAllEffects: () => set({
    spotlightElementId: '',
    spotlightOptions: null,
    spotlightMode: 'pixel',
    spotlightPercentageGeometry: null,
    highlightedElementIds: [],
    highlightOptions: null,
    laserElementId: '',
    laserOptions: null,
    zoomTarget: null,
    playingVideoElementId: '',
  }),
});

const createOtherCanvasStateSlice: StateCreator<CanvasState, [], [], OtherCanvasState> = (set, get) => ({
  ...initialOtherState,
  setRulerState: (show) => set({ showRuler: show }),
  setGridLineSize: (size) => set({ gridLineSize: size }),
  setToolbarState: (state) => set({ toolbarState: state }),
  setSelectPanelState: (show) => set({ showSelectPanel: show }),
  setSearchPanelState: (show) => set({ showSearchPanel: show }),
  setCreatingElement: (element) => set({ creatingElement: element }),
  setCreatingCustomShapeState: (creating) => set({ creatingCustomShape: creating }),
  setScalingState: (isScaling) => set({ isScaling }),
  setClipingImageElementId: (id) => set({ clipingImageElementId: id }),
  setRichtextAttrs: (attrs) => set({ richTextAttrs: attrs }),
  setTextFormatPainter: (painter) => set({ textFormatPainter: painter }),
  setShapeFormatPainter: (painter) => set({ shapeFormatPainter: painter }),
  playVideo: (elementId) => set({ playingVideoElementId: elementId }),
  pauseVideo: () => set({ playingVideoElementId: '' }),
  setWhiteboardOpen: (open) => set({ whiteboardOpen: open }),
  setWhiteboardClearing: (clearing) => set({ whiteboardClearing: clearing }),
  setThumbnailsFocus: (focus) => set({ thumbnailsFocus: focus }),
  setEditorAreaFocus: (focus) => set({ editorAreaFocus: focus }),
  setDisableHotkeysState: (disable) => set({ disableHotkeys: disable }),
  setSelectedTableCells: (cells) => set({ selectedTableCells: cells }),
  resetCanvasState: () => {
    set({ playingVideoElementId: '' });
    set({
      ...initialState,
      viewportSize: get().viewportSize,
      viewportRatio: get().viewportRatio,
      panX: get().panX,
      panY: get().panY,
      viewZoom: get().viewZoom,
    });
  },
});

const useCanvasStoreBase = create<CanvasState>((...a) => ({
  ...createSelectionSlice(...a),
  ...createViewportSlice(...a),
  ...createTeachingAidsSlice(...a),
  ...createOtherCanvasStateSlice(...a),
}));

// Enhance store with selectors, supporting store.use.xxx() syntax
export const useCanvasStore = createSelectors(useCanvasStoreBase);
