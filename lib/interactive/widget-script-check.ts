/**
 * Browser-side parse check for an interactive widget's inline scripts.
 *
 * The generator checks widget scripts before it accepts them
 * (`findInteractiveScriptSyntaxFailure` in @openmaic/generation), but that
 * check compiles with `node:vm` and cannot run here — so a widget stored
 * before the check existed, or edited since, was never looked at again, and a
 * syntax error leaves it dead for every learner.
 *
 * Same selection as the generator's check: classic inline scripts only (no
 * `src`, no data or module types, nothing inside `<template>`), parsed by the
 * browser's own HTML parser, which never runs them. Each body is compiled with
 * `new Function`, which parses without executing. One difference from a
 * classic Script: a top-level `return` passes here — a miss, never a false
 * alarm. Returns null when there is nothing to check or no parser.
 */

const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

export interface WidgetScriptFailure {
  /** 1-based position among the document's script elements. */
  readonly scriptIndex: number;
  readonly message: string;
}

export function findWidgetScriptFailure(html: string): WidgetScriptFailure | null {
  if (!html.trim() || typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(html, 'text/html');
  const scripts = Array.from(document.querySelectorAll('script'));
  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index]!;
    if (script.hasAttribute('src')) continue;
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase().split(';', 1)[0]!.trim();
    if (!CLASSIC_JAVASCRIPT_TYPES.has(type)) continue;
    const source = script.textContent ?? '';
    if (!source.trim()) continue;
    try {
      // Parse only: the constructed function is never called.
      new Function(source);
    } catch (error) {
      // Only a parse error is a verdict. A CSP without 'unsafe-eval' makes
      // every construction throw (EvalError): this page cannot check, which
      // says nothing about the widget.
      if (!(error instanceof SyntaxError)) return null;
      return { scriptIndex: index + 1, message: error.message };
    }
  }
  return null;
}
