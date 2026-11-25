import { describe, expect, it } from 'vitest';

import { stripSourceProvenance } from '@openmaic/generation';

describe('generation source-provenance gate', () => {
  it('removes unresolved source markers from every learner-facing string', () => {
    const content = {
      type: 'slide',
      content: {
        canvas: {
          elements: [{ type: 'text', content: '<p>Atomic writes [source 3] are durable.</p>' }],
        },
      },
      actions: [{ narration: 'See [source 12] for details.' }],
      questions: [
        { prompt: 'Why [source 7]?', analysis: 'Managed service [source p.154].' },
      ],
      html: '<button>Next [source 4]</button>',
    };

    stripSourceProvenance(content);

    expect(JSON.stringify(content)).not.toMatch(/\[source[^\]]{0,60}\]/i);
    expect(content.content.canvas.elements[0].content).toBe('<p>Atomic writes  are durable.</p>');
    expect(content.actions[0].narration).toBe('See  for details.');
  });

  it('leaves unrelated bracketed text untouched', () => {
    const content = { text: 'Use [shift] then [enter] to confirm.' };
    stripSourceProvenance(content);
    expect(content.text).toBe('Use [shift] then [enter] to confirm.');
  });
});
