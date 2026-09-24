import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { parsePDF } from '@/lib/pdf/pdf-providers';

/** Minimal valid one-page PDF (Helvetica "Hello"), xref offsets computed. */
function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream, built below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 20 40 Td (Hello) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('local vision PDF OCR', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renders each page server-side and transcribes it through the configured endpoint', async () => {
    vi.stubEnv('LOCAL_VISION_OCR_MODEL', 'qwen2.5vl:7b');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: '# Hello' } }] }),
    })) as Mock;
    vi.stubGlobal('fetch', fetchMock);

    const result = await parsePDF(
      { providerId: 'local_vision', baseUrl: 'http://ocr.test/v1/' },
      minimalPdf(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ocr.test/v1/chat/completions');
    const payload = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    expect(payload.model).toBe('qwen2.5vl:7b');
    const image = payload.messages[0].content.find((part) => part.type === 'image_url');
    expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,.{100,}/);
    expect(result.text).toBe('[Page 1]\n\n# Hello');
    expect(result.metadata?.pageCount).toBe(1);
  });
});
