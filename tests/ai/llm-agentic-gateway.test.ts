import { afterEach, describe, expect, it } from 'vitest';

import { withAgenticOutputDiscipline } from '@/lib/ai/llm';

const original = process.env.OPENMAIC_AGENTIC_GATEWAY;

afterEach(() => {
  if (original === undefined) delete process.env.OPENMAIC_AGENTIC_GATEWAY;
  else process.env.OPENMAIC_AGENTIC_GATEWAY = original;
});

describe('agentic gateway output discipline', () => {
  const params = (system: string) =>
    ({ model: 'x:y', prompt: 'hi', system }) as Parameters<typeof withAgenticOutputDiscipline>[0];

  it('leaves every call untouched unless opted in', () => {
    delete process.env.OPENMAIC_AGENTIC_GATEWAY;
    expect(withAgenticOutputDiscipline(params('SYSTEM')).system).toBe('SYSTEM');
  });

  it('appends the artifact-only directive when opted in', () => {
    process.env.OPENMAIC_AGENTIC_GATEWAY = '1';
    const result = withAgenticOutputDiscipline(params('SYSTEM'));
    expect(result.system).toContain('SYSTEM');
    expect(result.system).toContain('Do not call tools');
    expect(result.system).toContain('Do not create or edit files');
  });

  it('supplies the directive when there is no system prompt', () => {
    process.env.OPENMAIC_AGENTIC_GATEWAY = 'true';
    expect(withAgenticOutputDiscipline(params('')).system).toContain(
      'return ONLY the requested artifact',
    );
  });
});
