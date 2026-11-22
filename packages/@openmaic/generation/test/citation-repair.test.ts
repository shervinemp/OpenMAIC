import { describe, expect, it } from 'vitest';
import { repairCitationSupport, summarizeDepthFindings } from '@openmaic/generation';
import type { DepthReport } from '@openmaic/generation';

const RETRIEVAL = [
  'Retrieved from the source material:',
  '',
  '--- [source p.1] (page 1) ---',
  'Evaporation moves water molecules from the liquid phase into vapor when the surface is heated.',
  '',
  '--- [source p.2] (page 2) ---',
  'A B-tree index keeps keys sorted so point lookups touch only a few pages.',
].join('\n');

describe('repairCitationSupport', () => {
  it('re-attributes a misattributed claim to the source that actually supports it', () => {
    const text =
      '<p>Evaporation moves water molecules into vapor. [source p.2]</p>';

    const result = repairCitationSupport(text, RETRIEVAL);

    expect(result.repairs).toEqual([{ from: '[source p.2]', to: '[source p.1]' }]);
    expect(result.text).toContain('[source p.1]');
    expect(result.text).not.toContain('[source p.2]');
  });

  it('removes the marker only when no source supports the claim', () => {
    const text = '<p>Quantum chromodynamics explains quark confinement. [source p.1]</p>';

    const result = repairCitationSupport(text, RETRIEVAL);

    expect(result.repairs).toEqual([{ from: '[source p.1]', to: null }]);
    expect(result.text).not.toContain('[source');
    // Claim text is never rewritten.
    expect(result.text).toContain('Quantum chromodynamics explains quark confinement.');
  });

  it('leaves correctly grounded citations untouched', () => {
    const text = '<p>Evaporation moves water molecules into vapor. [source p.1]</p>';

    const result = repairCitationSupport(text, RETRIEVAL);

    expect(result.repairs).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('does not disturb a correctly grounded marker when another claim in the same text is misattributed', () => {
    const text = [
      '<p>Evaporation moves water molecules into vapor. [source p.1]</p>',
      '<p>Evaporation moves water molecules into vapor. [source p.2]</p>',
    ].join('\n');

    const result = repairCitationSupport(text, RETRIEVAL);

    expect(result.text).toContain('<p>Evaporation moves water molecules into vapor. [source p.1]</p>');
    expect(result.text).not.toContain('[source p.2]');
  });

  it('is a no-op without retrieval context', () => {
    const text = '<p>Unsupported claim. [source p.1]</p>';
    expect(repairCitationSupport(text, '')).toEqual({ text, repairs: [] });
  });
});

describe('summarizeDepthFindings', () => {
  const report = (findings: string[]): DepthReport => ({
    adequate: false,
    depthValidated: true,
    totalTextElements: 1,
    substantiveCount: 1,
    captionCount: 0,
    exampleCount: 0,
    findings,
  });

  it('adds actionable citation guidance when a finding is a citation mismatch', () => {
    const summary = summarizeDepthFindings(
      report(['the cited claim "X" shares no key terms with [source p.1]']),
    );
    expect(summary).toContain('replace the [source N] marker');
    expect(summary).toContain('remove that marker entirely');
    expect(summary).toContain('Never guess a different source number');
  });

  it('does not add citation guidance for unrelated findings', () => {
    const summary = summarizeDepthFindings(report(['needs at least one example']));
    expect(summary).not.toContain('[source N]');
  });
});
