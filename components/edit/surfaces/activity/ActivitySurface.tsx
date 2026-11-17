import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { ActivityContent } from '@/lib/types/stage';
import { ActivityForm } from './ActivityForm';
import { useActivitySurfaceState, type ActivitySelection } from './use-activity-surface';

/**
 * The activity SceneEditorSurface - a structured form for code and SQL labs.
 * The
 * chrome contributes undo/redo; every editing affordance lives inline in the
 * form, including authoring-time verification of the reference solution.
 */
export const activitySurface: SceneEditorSurface<ActivityContent, ActivitySelection> = {
  sceneType: 'activity',
  SurfaceComponent: ActivityForm,
  useSurfaceState: useActivitySurfaceState,
};
