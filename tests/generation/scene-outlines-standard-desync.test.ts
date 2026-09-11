import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ImageMapping, PdfImage } from '@/lib/types/generation';

const streamLLMMock = vi.hoisted(() => vi.fn());
const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const resolveVisionImagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
  callLLM: callLLMMock,

}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: resolveVisionImagesMock,
}));

function readStreamBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (): Promise<void> =>
    reader!.read().then(({ done, value }) => {
      if (done) return;
      if (value) text += decoder.decode(value, { stream: true });
      return pump();
    });
  return pump().then(() => text);
}

/**
 * The outline route must rebuild its prompt text from the SAME RESOLVED set
 * the attachments use (RFC #1153 part 2, N3): server-backed transport passes
 * asset ids, and an id the server cannot resolve is dropped from the resolved
 * vision set before prompt assembly — so a dropped image drops its text
 * mention together with its attachment. The property re-lands on the
 * syllabus-first surface: ordinary contract courses go through `callLLM`
 * (Phase A), so the pin is on the syllabus call's user prompt.
 */
describe('scene-outlines route - syllabus prompt parity on a dropped image (N3)', () => {
  beforeEach(() => {
    streamLLMMock.mockReset();
    callLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveVisionImagesMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: { vision: true } },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
    });
    // Later calls (unit outlines, review gates) may legitimately fail;
    // the property is asserted on the FIRST (syllabus) call's prompt.
    callLLMMock.mockRejectedValue(new Error('syllabus call asserted; stop the stream'));
  });

  test('drops an unresolvable image from the syllabus prompt text', async () => {
    vi.resetModules();
    const dataUrlFor = (bytes: string) =>
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    // The pre-resolution drops img_2 (its id does not resolve server-side);
    // img_1 resolves to bytes.
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images
        .filter((image) => image.src !== 'ast_gone')
        .map((image) => ({ ...image, src: dataUrlFor(`outline-bytes-${image.id}`) })),
    );
    // A contract-shaped syllabus lets the chain proceed past the syllabus
    // call; later calls reject so the stream stops cleanly.
    callLLMMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Safety Checklist',
          units: [
            {
              title: 'Safety Checklist',
              objectives: ['Inspect the device', 'Calibrate safely'],
              lessons: [
                { title: 'Inspect', objectives: ['Inspect'] },
                { title: 'Calibrate', objectives: ['Calibrate'] },
              ],
            },
          ],
          audience: 'field engineers',
          objectives: ['Inspect the device', 'Calibrate safely'],
        }),
      })
      .mockRejectedValue(new Error('syllabus call asserted; stop the stream'));

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        pdfImages: [
          { id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 },
          { id: 'img_2', src: '', pageNumber: 2, width: 200, height: 100 },
        ],
        imageMapping: { img_1: 'ast_ok', img_2: 'ast_gone' },
      }),
    );
    await readStreamBody(response);

    // The resolver received BOTH mapped images (it is the resolver that
    // decides which survive); the syllabus prompt is built from the same
    // resolved set, so img_2's mention is gone together with its attachment.
    expect(resolveVisionImagesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'img_1' }),
        expect.objectContaining({ id: 'img_2' }),
      ]),
      expect.anything(),
    );
    expect(callLLMMock.mock.calls.length).toBeGreaterThan(0);
    // N3 pins every LLM-served prompt in the chain (syllabus + unit calls):
    // prompts built from `availableImagesText` never re-introduce the
    // unresolvable image, and the surviving image keeps its attachment
    // promise. The syllabus prompt is structure-only and carries no image
    // list; the per-unit outline calls do.
    const prompts = callLLMMock.mock.calls.map(
      (call) => (call[0] as { prompt?: string }).prompt ?? '',
    );
    expect(prompts.some((prompt) => prompt.includes('img_1'))).toBe(true);
    for (const prompt of prompts) {
      expect(prompt).not.toContain('img_2');
    }
    const bearer = prompts.find((prompt) => prompt.includes('img_1'))!;
    expect(bearer).toContain('[see attached]');
  });
});

function mockRequest(body: {
  pdfImages: Array<Pick<PdfImage, 'id' | 'src' | 'pageNumber' | 'width' | 'height'>>;
  imageMapping: ImageMapping;
}) {
  return {
    json: async () => ({
      requirements: { requirement: 'Teach a safety checklist course.' },
      pdfText: 'Inspect the device before calibration.',
      pdfImages: body.pdfImages,
      imageMapping: body.imageMapping,
      researchContext: '',
    }),
    headers: {
      get: () => null,
    },
  } as unknown as Parameters<
    typeof import('@/app/api/generate/scene-outlines-stream/route').POST
  >[0];
}
