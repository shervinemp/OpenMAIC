import { afterEach, describe, expect, it } from 'vitest';

import { withAgenticCallDiscipline, withAgenticOutputDiscipline } from '@/lib/ai/llm';

const original = process.env.OPENMAIC_AGENTIC_GATEWAY;

afterEach(() => {
  if (original === undefined) delete process.env.OPENMAIC_AGENTIC_GATEWAY;
  else process.env.OPENMAIC_AGENTIC_GATEWAY = original;
});

describe('agentic gateway output discipline', () => {
  it('leaves every system prompt untouched unless opted in', () => {
    delete process.env.OPENMAIC_AGENTIC_GATEWAY;
    expect(withAgenticOutputDiscipline('SYSTEM')).toBe('SYSTEM');
  });

  it('appends the artifact-only directive when opted in', () => {
    process.env.OPENMAIC_AGENTIC_GATEWAY = '1';
    const system = withAgenticOutputDiscipline('SYSTEM');
    expect(system).toContain('SYSTEM');
    expect(system).toContain('Do not call tools');
    expect(system).toContain('Do not create or edit files');
  });

  it('supplies the directive when there is no system prompt', () => {
    process.env.OPENMAIC_AGENTIC_GATEWAY = 'true';
    expect(withAgenticOutputDiscipline('')).toContain('return ONLY the requested artifact');
  });

  it('wraps a call params object explicitly at the generation boundary', () => {
    process.env.OPENMAIC_AGENTIC_GATEWAY = '1';
    const params = { model: 'x:y', prompt: 'hi', system: 'SYSTEM' };
    const result = withAgenticCallDiscipline(params);
    expect(result).not.toBe(params);
    expect(result.system).toContain('Do not call tools');
  });
});
