import { describe, expect, it } from 'vitest';

import { buildStaticWidgetFallback } from '../src/widget-fallback.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { WidgetConfig } from '../src/scene-types.js';

const outline = {
  id: 'scene_widget',
  type: 'interactive',
  title: 'Particles Escaping',
  description: 'A simulation of evaporation at the particle level.',
  keyPoints: ['Temperature changes the escape rate', 'Only surface particles can escape'],
} as unknown as SceneOutline;

describe('static widget fallback', () => {
  it('produces a self-contained, script-free document from the outline', () => {
    const result = buildStaticWidgetFallback(outline, undefined);
    expect(result.widgetType).toBe('diagram');
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('Particles Escaping');
    expect(result.html).toContain('Only surface particles can escape');
    expect(result.html).not.toContain('<script');
  });

  it('carries declared variables and presets as readable text', () => {
    const config = {
      type: 'simulation',
      variables: [{ name: 'temperature', label: 'Temperature', unit: '°C' }],
      presets: [{ name: 'Hot liquid' }],
    } as unknown as WidgetConfig;
    const result = buildStaticWidgetFallback(outline, config);
    expect(result.html).toContain('Temperature');
    expect(result.html).toContain('Hot liquid');
    expect(result.widgetConfig).toBe(config);
  });

  it('escapes learner text', () => {
    const hostile = {
      ...outline,
      title: '<img src=x onerror=alert(1)>',
    } as SceneOutline;
    expect(buildStaticWidgetFallback(hostile, undefined).html).not.toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});
