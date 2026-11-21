import { describe, expect, it, vi } from 'vitest';

import { generateWidgetContent } from '../src/scene-generator.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { WidgetProbeResult } from '../src/widget-sandbox.js';
import {
  buildBlindWidgetPrompt,
  createAiWidgetVerifier,
  deterministicWidgetIssues,
  formatObservationFeedback,
  summarizeWidgetIssues,
  verifyWidgetArtifact,
  verifyWidgetSafely,
  widgetClaims,
  type WidgetVerificationContext,
} from '../src/widget-verification.js';

const claims = {
  variables: [{ name: 'x', min: 0, max: 10, default: 5 }],
  presets: [{ name: 'Zero', variables: { x: 0 } }],
  expectedVariables: ['x'],
};

const shape = {
  widgetType: 'simulation',
  title: 'Vapor Exchange',
  description: 'Competing evaporation and condensation',
  keyPoints: ['net evaporation can be negative'],
  claims,
};

function snapshot(
  label: string,
  published: Record<string, unknown> | null,
  values: Record<string, number> = { x: 5 },
) {
  return { label, values, published, visibleText: { 'x-display': String(values.x ?? 5) } };
}

function context(overrides: Partial<WidgetVerificationContext> = {}): WidgetVerificationContext {
  return {
    ...shape,
    observations: [snapshot('default', { state: { x: 5 } })],
    scriptErrors: [],
    ...overrides,
  };
}

const WIDGET_HTML = `<!DOCTYPE html><html><body>
<div id="experiment">
<script type="application/json" id="widget-config">${JSON.stringify({
  type: 'simulation',
  ...claims,
})}</script>
<input type="range" id="x-slider" min="0" max="10" value="5">
<span id="x-display">5</span>
<script>
function publishState(o) {
  const root = document.getElementById('experiment');
  let node = root.querySelector('script[data-maic-observation]');
  if (!node) { node = document.createElement('script'); node.setAttribute('data-maic-observation',''); root.appendChild(node); }
  node.textContent = JSON.stringify(o);
}
function update() {
  const x = Number(document.getElementById('x-slider').value);
  document.getElementById('x-display').textContent = String(x);
  publishState({ summary: 'x=' + x, state: { x: x } });
}
document.getElementById('x-slider').addEventListener('input', update);
update();
</script>
</div></body></html>`;

const STATIC_WIDGET_HTML = `<!DOCTYPE html><html><body>
<div id="experiment">
<script type="application/json" id="widget-config">${JSON.stringify({
  type: 'simulation',
  ...claims,
})}</script>
<input type="range" id="x-slider" min="0" max="10" value="5">
<script>
function publishState(o) {
  const root = document.getElementById('experiment');
  let node = root.querySelector('script[data-maic-observation]');
  if (!node) { node = document.createElement('script'); node.setAttribute('data-maic-observation',''); root.appendChild(node); }
  node.textContent = JSON.stringify(o);
}
publishState({ state: { x: 5 } });
</script>
</div></body></html>`;

describe('widgetClaims', () => {
  it('reads only finite, well-formed variable and preset claims', () => {
    expect(
      widgetClaims({
        variables: [
          { name: 'temp', min: 0, max: 50, default: 20, unit: 'C' },
          { name: 'broken', min: 'a', max: 10 },
        ],
        presets: [
          { name: 'Rainy', variables: { temp: 8, humidity: 100 } },
          { name: 'Empty', variables: {} },
        ],
      }),
    ).toEqual({
      variables: [{ name: 'temp', min: 0, max: 50, default: 20 }],
      presets: [{ name: 'Rainy', variables: { temp: 8, humidity: 100 } }],
      expectedVariables: [],
    });
  });

  it('returns empty claims when no config is embedded, keeping outline promises', () => {
    expect(widgetClaims(undefined, ['temperature'], 'vapor exchange')).toEqual({
      variables: [],
      presets: [],
      expectedVariables: ['temperature'],
      expectedConcept: 'vapor exchange',
    });
  });
});

describe('deterministicWidgetIssues', () => {
  it('requires deterministic checks to run before any model verifier', async () => {
    const verifier = vi.fn(async () => [{ code: 'claim-mismatch', message: 'unused' }]);
    const { issues } = await verifyWidgetArtifact(STATIC_WIDGET_HTML, shape, verifier);
    expect(issues.some((issue) => issue.code === 'dead-control')).toBe(true);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('flags script errors, non-finite values, missing observations and inert presets', () => {
    const result: WidgetProbeResult = {
      snapshots: [
        snapshot('default', { state: { x: 5 } }),
        // The preset claims to change x but produces exactly the default state.
        snapshot('preset:Zero', { state: { x: 5 } }),
        snapshot('var:x=min', { state: { rate: Number.NaN } }, { x: 0 }),
      ],
      errors: ['ReferenceError: boom'],
    };
    const codes = deterministicWidgetIssues(result, claims).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(['script-error', 'non-finite-state', 'inert-preset']),
    );
  });

  it('reports a widget that never publishes an observation', () => {
    const result: WidgetProbeResult = {
      snapshots: [snapshot('default', null)],
      errors: [],
    };
    expect(deterministicWidgetIssues(result, claims).map((issue) => issue.code)).toContain(
      'no-observation',
    );
  });

  it('enforces the outline promise that a control must exist', () => {
    const result: WidgetProbeResult = {
      snapshots: [snapshot('default', { state: { x: 5 } })],
      errors: [],
    };
    const codes = deterministicWidgetIssues(result, {
      ...claims,
      expectedVariables: ['wind speed'],
    }).map((issue) => issue.code);
    expect(codes).toContain('outline-variable-missing');
  });

  it('accepts a differently named control when the outline wording overlaps', () => {
    const result: WidgetProbeResult = {
      snapshots: [snapshot('default', { state: { temp: 20 } })],
      errors: [],
    };
    const codes = deterministicWidgetIssues(result, {
      variables: [{ name: 'temp', min: 0, max: 50, default: 20 }],
      presets: [],
      expectedVariables: ['temperature'],
    }).map((issue) => issue.code);
    expect(codes).not.toContain('outline-variable-missing');
  });

  it('does not call a control dead when it changes only a text summary', () => {
    const result: WidgetProbeResult = {
      snapshots: [
        { label: 'var:x=min', values: { x: 0 }, published: { summary: 'x=0' }, visibleText: {} },
        { label: 'var:x=max', values: { x: 10 }, published: { summary: 'x=10' }, visibleText: {} },
      ],
      errors: [],
    };
    expect(deterministicWidgetIssues(result, claims).map((issue) => issue.code)).not.toContain(
      'dead-control',
    );
  });
});

describe('blind widget verifier', () => {
  it('projects claims and observations but never the HTML source', () => {
    const { system, user } = buildBlindWidgetPrompt(context());
    expect(system).toMatch(/do NOT receive its source code/i);
    expect(system).toContain('stays identical across every preset');
    expect(user).toContain('Zero');
    expect(user).toContain('can be negative');
    expect(user).not.toContain('<!DOCTYPE');
    expect(user).not.toContain('computeNetEvaporation');
  });

  it('parses a JSON verdict and fails open on garbage or a throwing verifier', async () => {
    const aiCall = vi.fn(
      async () =>
        '[{"code":"claim-mismatch","message":"Condensation preset never produces condensation"}]',
    );
    expect(await createAiWidgetVerifier(aiCall)(context())).toEqual([
      {
        code: 'claim-mismatch',
        message: 'Condensation preset never produces condensation',
      },
    ]);

    const garbage = vi.fn(async () => 'No JSON here');
    expect(await createAiWidgetVerifier(garbage)(context())).toEqual([]);

    const throwing = vi.fn(async () => {
      throw new Error('verifier down');
    });
    const warn = vi.fn();
    expect(await verifyWidgetSafely(throwing, context(), { warn })).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('feeds a well-formed disagreement back into the widget generation loop', async () => {
    const verifier = vi
      .fn()
      .mockResolvedValueOnce([{ code: 'claim-mismatch', message: 'Rainy preset cannot condense' }])
      .mockResolvedValueOnce([]);
    const aiCall = vi.fn(async (_system: string, _user: string): Promise<string> => WIDGET_HTML);
    const outline = {
      id: 'scene_vapor',
      title: 'Vapor Exchange',
      description: 'Competing processes',
      keyPoints: [],
      type: 'interactive',
      widgetType: 'simulation',
      widgetOutline: { concept: 'vapor exchange' },
    } as unknown as SceneOutline;

    const content = await generateWidgetContent(outline, aiCall, 'Teach in English.', {
      verifyWidgetClaims: verifier,
    });

    expect(verifier).toHaveBeenCalledTimes(2);
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(content?.widgetType).toBe('simulation');
    expect(aiCall.mock.calls[1][1]).toContain('Rainy preset cannot condense');
    // Corrective feedback now carries the probe rows, not just the verdict.
    expect(aiCall.mock.calls[1][1]).toContain('Observed behaviour from the probe runs');
    expect(summarizeWidgetIssues([{ code: 'x', message: 'y' }])).toContain('[x] y');
  });

  it('keeps the cleanest widget across attempts instead of the final regression', async () => {
    const makeWidget = (variant: string) =>
      WIDGET_HTML.replace('id="experiment"', `id="experiment" data-variant="${variant}"`);
    const responses = [makeWidget('A'), makeWidget('B'), makeWidget('C')];
    const aiCall = vi.fn(
      async (_system: string, _user: string): Promise<string> =>
        responses.shift() ?? makeWidget('C'),
    );
    const verifier = vi
      .fn()
      .mockResolvedValueOnce([
        { code: 'e1', message: 'defect one' },
        { code: 'e2', message: 'defect two' },
      ])
      .mockResolvedValueOnce([{ code: 'e3', message: 'one defect left' }])
      .mockResolvedValueOnce([
        { code: 'e4', message: 'regression four' },
        { code: 'e5', message: 'regression five' },
      ]);
    const outline = {
      id: 'scene_vapor_best',
      title: 'Vapor Exchange',
      description: 'Competing processes',
      keyPoints: [],
      type: 'interactive',
      widgetType: 'simulation',
      widgetOutline: { concept: 'vapor exchange' },
    } as unknown as SceneOutline;

    const content = await generateWidgetContent(outline, aiCall, 'Teach in English.', {
      verifyWidgetClaims: verifier,
    });

    expect(verifier).toHaveBeenCalledTimes(3);
    // Attempt B had the fewest findings; the final attempt regressed.
    expect(content?.html).toContain('data-variant="B"');
    expect(content?.html).not.toContain('data-variant="C"');
    expect(aiCall.mock.calls[1][1]).toContain('defect one');
    expect(aiCall.mock.calls[2][1]).toContain('one defect left');
  });
});

describe('formatObservationFeedback', () => {
  it('renders probe rows with inputs, published state and visible text', () => {
    const feedback = formatObservationFeedback([
      {
        label: 'preset:Rainy',
        values: { humidity: 100 },
        published: { state: { phase: 'ready' } },
        visibleText: { status: 'ready' },
      },
    ]);
    expect(feedback).toContain('Observed behaviour from the probe runs');
    expect(feedback).toContain('preset:Rainy');
    expect(feedback).toContain('humidity');
    expect(feedback).toContain('phase');
    expect(feedback).toContain('status');
  });
});
