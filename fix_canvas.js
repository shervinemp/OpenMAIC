const fs = require('fs');
let content = fs.readFileSync('lib/store/canvas.ts', 'utf-8');

// I replaced useCanvasStoreBase before but I probably broke the exports or interface declarations.
// Let's rewrite lib/store/canvas.ts properly from scratch to fix it.

content = content.replace(/import \{ StateCreator \} from 'zustand';\n\nconst createSelectionSlice/g, `
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

const createSelectionSlice`);

fs.writeFileSync('lib/store/canvas.ts', content);
