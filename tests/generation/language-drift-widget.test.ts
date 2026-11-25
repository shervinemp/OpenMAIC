import { describe, expect, it } from 'vitest';

import { collectLearnerText, detectLanguageDrift } from '@openmaic/generation';

const englishDirective = 'Teach the entire course in English. Use English labels and explanations.';

describe('language drift on interactive widgets', () => {
  it('samples learner-visible HTML text but not script or style code', () => {
    const widget = {
      html:
        '<style>.btn{color:red}</style><script>const label = "not learner text";</script>' +
        '<div><button>上一步</button><button>下一步</button><p>请根据流程图选择正确的节点并观察每一步的变化，然后继续回答后面的问题。</p></div>',
    };
    const text = collectLearnerText(widget);
    expect(text).toContain('上一步');
    expect(text).toContain('请根据流程图');
    expect(text).not.toContain('not learner text');
    expect(text).not.toContain('color:red');
  });

  it('detects drift when the widget prose is in the wrong language', () => {
    const widget = {
      html: `<div>${'上一步 下一步 请根据流程图选择正确的节点并观察每一步的变化。 '.repeat(6)}</div>`,
    };
    expect(detectLanguageDrift(collectLearnerText(widget), englishDirective)).not.toBeNull();
  });

  it('does not flag an English widget', () => {
    const widget = {
      html: `<div>${'Previous Next Choose the correct node in the flow and observe how each step changes the result. '.repeat(4)}</div>`,
    };
    expect(detectLanguageDrift(collectLearnerText(widget), englishDirective)).toBeNull();
  });
});
