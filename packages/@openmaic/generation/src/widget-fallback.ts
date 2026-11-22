/**
 * Static widget fallback.
 *
 * A broken interactive is worse than a non-interactive reference card: dead
 * controls and probe TypeErrors ship as "working" simulations. When repeated
 * corrective passes cannot produce a sound widget, degrade the modality to a
 * self-contained, script-free diagram built from the outline and the last
 * widget config. The scene is kept (fail-open), but it no longer pretends to
 * be interactive.
 */

import type { WidgetType } from '@openmaic/dsl';

import type { SceneOutline } from './outline-types.js';
import type { WidgetConfig } from './scene-types.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderList(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `<section><h2>${escapeHtml(title)}</h2><ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</ul></section>`;
}

/** A deterministic, script-free replacement for an unsalvageable widget. */
export function buildStaticWidgetFallback(
  outline: SceneOutline,
  widgetConfig: WidgetConfig | undefined,
): { html: string; widgetType: WidgetType; widgetConfig: WidgetConfig | undefined } {
  const config = widgetConfig as Record<string, unknown> | undefined;
  const variables = Array.isArray(config?.variables) ? config.variables : [];
  const presets = Array.isArray(config?.presets) ? config.presets : [];

  const variableRows = variables
    .map((raw) => {
      const variable = raw as Record<string, unknown>;
      return `<li><strong>${escapeHtml(variable.label ?? variable.name)}</strong>: ${escapeHtml(
        variable.description ?? variable.unit ?? '',
      )}</li>`;
    })
    .filter((row) => row.includes('<strong>'));

  const presetRows = presets.map((raw) => {
    const preset = raw as Record<string, unknown>;
    return `<li>${escapeHtml(preset.name ?? 'Preset')}</li>`;
  });

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>',
    escapeHtml(outline.title ?? 'Reference'),
    '</title>',
    '<style>',
    'body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#0f172a}',
    'h1{font-size:24px;margin:0 0 8px}h2{font-size:16px;margin:20px 0 8px}',
    'p{line-height:1.5}ul{margin:4px 0;padding-left:20px}li{margin:4px 0}',
    '.note{background:#fff7ed;border-left:4px solid #f59e0b;padding:10px 14px;margin:12px 0}',
    '</style></head><body>',
    '<h1>',
    escapeHtml(outline.title ?? 'Reference'),
    '</h1>',
    '<p>',
    escapeHtml(outline.description ?? ''),
    '</p>',
    renderList('Key points', outline.keyPoints ?? []),
    renderList('Variables', variableRows),
    renderList('Scenarios', presetRows),
    '<p class="note">Interactive controls were unavailable for this scene. The reference above carries the same content as a static diagram.</p>',
    '</body></html>',
  ].join('\n');

  return { html, widgetType: 'diagram' as WidgetType, widgetConfig };
}
