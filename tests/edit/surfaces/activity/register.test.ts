import { describe, expect, it } from 'vitest';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
// Importing the surface index runs its side-effect registration.
import { activitySurface } from '@/components/edit/surfaces/activity';

describe('activity surface registration', () => {
  it('registers itself under scene type "activity"', () => {
    const resolved = sceneEditorRegistry.resolve('activity');
    expect(resolved).toBe(activitySurface);
    expect(resolved?.sceneType).toBe('activity');
    expect(resolved?.SurfaceComponent).toBeTypeOf('function');
    expect(resolved?.useSurfaceState).toBeTypeOf('function');
  });
});
