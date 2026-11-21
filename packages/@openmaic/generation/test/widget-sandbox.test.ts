import { describe, expect, it } from 'vitest';

import {
  probeWidgetHtml,
  type WidgetPresetClaim,
  type WidgetVariableClaim,
} from '../src/widget-sandbox.js';

const WATER_CYCLE_VARIABLES: WidgetVariableClaim[] = [
  { name: 'temperature', min: -10, max: 40, default: 25 },
  { name: 'humidity', min: 0, max: 100, default: 50 },
  { name: 'windSpeed', min: 0, max: 20, default: 5 },
];

const WATER_CYCLE_PRESETS: WidgetPresetClaim[] = [
  { name: 'Rainy (condensation)', variables: { temperature: 8, humidity: 100, windSpeed: 3 } },
  { name: 'Dry and windy', variables: { temperature: 32, humidity: 15, windSpeed: 18 } },
];

/**
 * Realistic water-cycle fixture: Magnus saturation vapor pressure, a clamped
 * net-evaporation rate, sliders with `${name}-slider` ids, and the standard
 * non-executable observation node written by publishState().
 */
const WATER_CYCLE_HTML = [
  '<!DOCTYPE html>',
  '<html><head><meta charset="utf-8"><title>Water Cycle</title></head><body>',
  '<div id="experiment">',
  '  <canvas id="canvas" width="320" height="200"></canvas>',
  '  <div id="temperature-display">25 C</div>',
  '  <div id="humidity-display">50 %</div>',
  '  <div id="windSpeed-display">5 m/s</div>',
  '  <div id="rate-display">0.000</div>',
  '  <div id="condensation-badge">Evaporation</div>',
  '  <input type="range" id="temperature-slider" min="-10" max="40" step="1" value="25">',
  '  <input type="range" id="humidity-slider" min="0" max="100" step="1" value="50">',
  '  <input type="range" id="windSpeed-slider" min="0" max="20" step="1" value="5">',
  '  <button id="reset-btn">Reset</button>',
  '</div>',
  '<script type="application/json" id="widget-config">',
  '{"type":"simulation","concept":"water_cycle","variables":[' +
    '{"name":"temperature","min":-10,"max":40,"default":25},' +
    '{"name":"humidity","min":0,"max":100,"default":50},' +
    '{"name":"windSpeed","min":0,"max":20,"default":5}],"presets":[' +
    '{"name":"Rainy (condensation)","variables":{"temperature":8,"humidity":100,"windSpeed":3}}]}' +
    '</script>',
  '<script>',
  'function publishState(observation) {',
  '  const root = document.getElementById("experiment");',
  '  if (!root) throw new Error("Missing interaction scope");',
  '  try {',
  '    const raw = JSON.stringify(observation);',
  '    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 32768) throw new Error("Invalid state publication");',
  '    let node = root.querySelector("script[data-maic-observation]");',
  '    if (!node) {',
  '      node = document.createElement("script");',
  '      node.type = "application/json";',
  '      node.setAttribute("data-maic-observation", "");',
  '      root.appendChild(node);',
  '    }',
  '    node.textContent = raw;',
  '  } catch (error) {',
  '    root.querySelectorAll("script[data-maic-observation]").forEach(node => node.remove());',
  '    throw error;',
  '  }',
  '}',
  'function saturationVaporPressure(tempC) {',
  '  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));',
  '}',
  'function computeNetEvaporation(temp, humidity, wind) {',
  '  const es = saturationVaporPressure(temp);',
  '  const ea = es * (humidity / 100);',
  '  return Math.max(0, es - ea) * (1 + 0.02 * wind);',
  '}',
  'const sliders = {',
  '  temperature: document.getElementById("temperature-slider"),',
  '  humidity: document.getElementById("humidity-slider"),',
  '  windSpeed: document.getElementById("windSpeed-slider"),',
  '};',
  'function update() {',
  '  const temperature = Number(sliders.temperature.value);',
  '  const humidity = Number(sliders.humidity.value);',
  '  const windSpeed = Number(sliders.windSpeed.value);',
  '  const rate = computeNetEvaporation(temperature, humidity, windSpeed);',
  '  const condensing = humidity > 85 && temperature < 15;',
  '  document.getElementById("temperature-display").textContent = temperature + " C";',
  '  document.getElementById("humidity-display").textContent = humidity + " %";',
  '  document.getElementById("windSpeed-display").textContent = windSpeed + " m/s";',
  '  document.getElementById("rate-display").textContent = rate.toFixed(3);',
  '  document.getElementById("condensation-badge").textContent = condensing ? "Condensation" : "Evaporation";',
  '  const ctx = document.getElementById("canvas").getContext("2d");',
  '  ctx.clearRect(0, 0, 320, 200);',
  '  const gradient = ctx.createLinearGradient(0, 0, 0, 200);',
  '  gradient.addColorStop(0, "#87ceeb");',
  '  gradient.addColorStop(1, "#006994");',
  '  ctx.fillStyle = gradient;',
  '  ctx.fillRect(0, 0, 320, 200);',
  '  publishState({',
  '    summary: "Net evaporation " + rate.toFixed(3) + " mm/day",',
  '    netEvaporationRate: rate,',
  '    condensationBadge: condensing ? "Condensation" : "Evaporation",',
  '    timerFired: !!globalThis.__maicTimerFired,',
  '    env: { process: typeof process, require: typeof require, module: typeof module, fetch: typeof fetch, WebSocket: typeof WebSocket },',
  '    state: { temperature, humidity, windSpeed, netEvaporationRate: rate },',
  '  });',
  '}',
  'Object.values(sliders).forEach(slider => slider.addEventListener("input", update));',
  'document.getElementById("reset-btn").addEventListener("click", () => {',
  '  sliders.temperature.value = "25";',
  '  sliders.humidity.value = "50";',
  '  sliders.windSpeed.value = "5";',
  '  update();',
  '});',
  'update();',
  '</script>',
  '<script>',
  'window.addEventListener("message", function (event) {',
  '  const state = event.data && event.data.state;',
  '  if (!state) return;',
  '  Object.entries(state).forEach(function (entry) {',
  '    const slider = document.getElementById(entry[0] + "-slider");',
  '    if (slider) {',
  '      slider.value = entry[1];',
  '      slider.dispatchEvent(new Event("input", { bubbles: true }));',
  '    }',
  '  });',
  '});',
  'setTimeout(function () { globalThis.__maicTimerFired = true; }, 0);',
  'setInterval(function () { globalThis.__maicTimerFired = true; }, 1);',
  'requestAnimationFrame(function () { globalThis.__maicTimerFired = true; });',
  '</script>',
  '</body></html>',
].join('\n');

const FILTERED_SCRIPTS_HTML = [
  '<div id="experiment"></div>',
  '<template><script>throw new Error("template script must not run");</script></template>',
  '<script src="https://example.invalid/evil.js"></script>',
  '<script type="application/json" id="widget-config">{"type":"simulation"}</script>',
  '<script type="module">throw new Error("module script must not run");</script>',
  '<script>',
  'const root = document.getElementById("experiment");',
  'const node = document.createElement("script");',
  'node.setAttribute("data-maic-observation", "");',
  'node.textContent = JSON.stringify({ summary: "ok" });',
  'root.appendChild(node);',
  '</script>',
].join('');

const MISSING_SLIDERS_HTML = [
  '<div id="experiment"></div>',
  '<script>',
  'function publishState(observation) {',
  '  const root = document.getElementById("experiment");',
  '  const node = document.createElement("script");',
  '  node.setAttribute("data-maic-observation", "");',
  '  node.textContent = JSON.stringify(observation);',
  '  root.appendChild(node);',
  '}',
  'publishState({ summary: "no controls" });',
  '</script>',
].join('');

describe('probeWidgetHtml', () => {
  it('runs inline scripts, captures observations, and produces all probe snapshots', () => {
    const result = probeWidgetHtml(WATER_CYCLE_HTML, {
      variables: WATER_CYCLE_VARIABLES,
      presets: WATER_CYCLE_PRESETS,
    });

    expect(result.errors).toEqual([]);
    expect(result.snapshots.map((snapshot) => snapshot.label)).toEqual([
      'default',
      'preset:Rainy (condensation)',
      'preset:Dry and windy',
      'var:temperature=min',
      'var:temperature=max',
      'var:humidity=min',
      'var:humidity=max',
      'var:windSpeed=min',
      'var:windSpeed=max',
    ]);

    for (const snapshot of result.snapshots) {
      expect(snapshot.published).not.toBeNull();
      expect(typeof snapshot.published?.summary).toBe('string');
      expect(snapshot.values.temperature).toBeTypeOf('number');
    }

    const rainy = result.snapshots.find(
      (snapshot) => snapshot.label === 'preset:Rainy (condensation)',
    );
    expect(rainy?.values).toEqual({ temperature: 8, humidity: 100, windSpeed: 3 });
    expect(rainy?.visibleText['condensation-badge']).toBe('Condensation');
    expect(rainy?.visibleText['rate-display']).toBe('0.000');
  });

  it('fires load/DOMContentLoaded so event-driven widgets publish an observation', () => {
    const html = [
      '<!DOCTYPE html><html><body><div id="experiment">',
      '<input type="range" id="rate-slider" min="0" max="10" value="5">',
      '<span id="rate-display"></span>',
      '<script>',
      'function publishState(o) {',
      "  var root = document.getElementById('experiment');",
      "  var node = root.querySelector('script[data-maic-observation]');",
      "  if (!node) { node = document.createElement('script'); node.setAttribute('data-maic-observation',''); root.appendChild(node); }",
      '  node.textContent = JSON.stringify(o);',
      '}',
      'function init() {',
      "  var slider = document.getElementById('rate-slider');",
      '  function update() {',
      '    var rate = Number(slider.value);',
      "    document.getElementById('rate-display').textContent = String(rate);",
      '    publishState({ summary: "rate=" + rate, state: { rate: rate } });',
      '  }',
      "  slider.addEventListener('input', update);",
      '  update();',
      '}',
      "window.addEventListener('load', init);",
      '</script></div></body></html>',
    ].join('');

    const result = probeWidgetHtml(html, {
      variables: [{ name: 'rate', min: 0, max: 10, default: 5 }],
      presets: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.snapshots[0]?.published).toEqual({
      summary: 'rate=5',
      state: { rate: 5 },
    });
  });

  it('shows the clamped-rate defect: rainy preset publishes 0 and no rate is negative', () => {
    const result = probeWidgetHtml(WATER_CYCLE_HTML, {
      variables: WATER_CYCLE_VARIABLES,
      presets: WATER_CYCLE_PRESETS,
    });

    const rainy = result.snapshots.find(
      (snapshot) => snapshot.label === 'preset:Rainy (condensation)',
    );
    expect(rainy?.published?.netEvaporationRate).toBe(0);

    const rates = result.snapshots
      .map((snapshot) => snapshot.published?.netEvaporationRate)
      .filter((rate): rate is number => typeof rate === 'number');
    expect(rates.length).toBe(result.snapshots.length);
    for (const rate of rates) expect(rate).toBeGreaterThanOrEqual(0);
  });

  it('freezes timers and exposes no host globals inside the sandbox', () => {
    const result = probeWidgetHtml(WATER_CYCLE_HTML, {
      variables: WATER_CYCLE_VARIABLES,
      presets: WATER_CYCLE_PRESETS,
    });

    const published = result.snapshots[0]?.published;
    expect(published?.timerFired).toBe(false);
    expect(published?.env).toEqual({
      process: 'undefined',
      require: 'undefined',
      module: 'undefined',
      fetch: 'undefined',
      WebSocket: 'undefined',
    });
    expect((globalThis as unknown as Record<string, unknown>).__maicTimerFired).toBeUndefined();
  });

  it('skips data, external, module, and template scripts', () => {
    const result = probeWidgetHtml(FILTERED_SCRIPTS_HTML, { variables: [], presets: [] });

    expect(result.errors).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.published?.summary).toBe('ok');
  });

  it('records throwing scripts in errors instead of throwing out of probeWidgetHtml', () => {
    const result = probeWidgetHtml(
      '<div id="experiment"></div><script>throw new Error("boom");</script>',
      {
        variables: [],
        presets: [],
      },
    );

    expect(result.snapshots).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toContain('boom');
  });

  it('records missing slider elements in errors and keeps the published observation', () => {
    const result = probeWidgetHtml(MISSING_SLIDERS_HTML, {
      variables: [{ name: 'ghost', min: 0, max: 1 }],
      presets: [],
    });

    expect(result.errors.join(' ')).toContain('Missing slider element: ghost-slider');
    expect(result.snapshots.map((snapshot) => snapshot.label)).toEqual([
      'default',
      'var:ghost=min',
      'var:ghost=max',
    ]);
    for (const snapshot of result.snapshots) {
      expect(snapshot.published?.summary).toBe('no controls');
    }
  });

  it('caps the number of snapshots at 50', () => {
    const variables: WidgetVariableClaim[] = Array.from({ length: 25 }, (_, index) => ({
      name: `v${index}`,
      min: 0,
      max: 1,
    }));
    const result = probeWidgetHtml(MISSING_SLIDERS_HTML, { variables, presets: [] });

    expect(result.snapshots.length).toBeLessThanOrEqual(50);
  });

  it('stubs canvas browser globals so a chart widget is not reported as a script error', () => {
    const html = [
      '<div id="experiment"><canvas id="chart"></canvas></div>',
      '<script>',
      'function publishState(o) {',
      '  var root = document.getElementById("experiment");',
      '  var node = document.createElement("script");',
      '  node.setAttribute("data-maic-observation", "");',
      '  node.textContent = JSON.stringify(o);',
      '  root.appendChild(node);',
      '}',
      'var canvas = document.getElementById("chart");',
      'var ctx = canvas.getContext("2d");',
      'if (!(ctx instanceof CanvasRenderingContext2D)) throw new Error("bad context");',
      'var gradient = ctx.createLinearGradient(0, 0, 10, 10);',
      'gradient.addColorStop(0, "red");',
      'var data = new ImageData(1, 1);',
      'var path = new Path2D();',
      'var img = new Image();',
      'publishState({ summary: "canvas ok", ok: !!ctx && !!gradient && !!data && !!path && !!img });',
      '</script>',
    ].join('');

    const result = probeWidgetHtml(html, { variables: [], presets: [] });

    expect(result.errors).toEqual([]);
    expect(result.snapshots[0]?.published?.ok).toBe(true);
  });
});
