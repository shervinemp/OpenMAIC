/**
 * PDF Parsing Provider Implementation
 *
 * Factory pattern for routing PDF parsing requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - unpdf: Built-in Node.js PDF parser with text and image extraction
 * - MinerU: Advanced commercial service with OCR, formula, and table extraction
 *   (https://mineru.ai or self-hosted)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to PDFProviderId in lib/pdf/types.ts
 *    Example: | 'tesseract-ocr'
 *
 * 2. Add provider configuration to lib/pdf/constants.ts
 *    Example:
 *    'tesseract-ocr': {
 *      id: 'tesseract-ocr',
 *      name: 'Tesseract OCR',
 *      requiresApiKey: false,
 *      icon: '/tesseract.svg',
 *      features: ['text', 'images', 'ocr']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function parseWithXxx(config, pdfBuffer): Promise<ParsedPdfContent>
 *    - Accept PDF as Buffer
 *    - Extract text, images, tables, formulas as needed
 *    - Return unified format:
 *      {
 *        text: string,               // Markdown or plain text
 *        images: string[],           // Base64 data URLs
 *        metadata: {
 *          pageCount: number,
 *          parser: string,
 *          ...                       // Provider-specific metadata
 *        }
 *      }
 *
 *    Example:
 *    async function parseWithTesseractOCR(
 *      config: PDFParserConfig,
 *      pdfBuffer: Buffer
 *    ): Promise<ParsedPdfContent> {
 *      const { createWorker } = await import('tesseract.js');
 *
 *      // Convert PDF pages to images
 *      const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
 *      // ... logic ...
 *      return { text, images, metadata };
 *    }
 *
 * 4. Add case to parsePDF() switch statement
 *    Example:
 *    case 'tesseract-ocr':
 *      return await parseWithTesseractOCR(config, pdfBuffer);
 */

import { createLogger } from '@/lib/logger';
import { PDF_PROVIDERS } from './constants';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const log = createLogger('PDFParser');

/**
 * Parse PDF using unpdf (built-in Node.js extraction)
 * Extracts raw text and attempts to extract images embedded in the PDF
 */
async function parseWithUnpdf(pdfBuffer: Buffer): Promise<ParsedPdfContent> {
  log.info(`Parsing PDF with unpdf (${pdfBuffer.length} bytes)`);

  const { extractText, getDocumentProxy } = await import('unpdf');

  // Convert buffer to Uint8Array for unpdf
  const pdfData = new Uint8Array(pdfBuffer);

  // Extract text
  const { text, totalPages } = await extractText(pdfData);

  // Note: unpdf doesn't have a reliable built-in image extractor that outputs base64 out-of-the-box
  // for all PDF image formats without relying on canvas in node.
  // For standard usage, we'll return the text and an empty image array.
  // A complete implementation would iterate pages, extract image objects, and convert to base64.

  const pdf = await getDocumentProxy(pdfData);
  const info = await pdf.getMetadata();

  return {
    text: Array.isArray(text) ? text.join('\n').trim() : '',
    images: [],
    metadata: {
      pageCount: totalPages,
      parser: 'unpdf',
      info: info.info,
    },
  };
}

/**
 * Parse PDF using MinerU API
 * Advanced commercial API that performs OCR, table extraction, and formula recognition
 */
async function parseWithMinerU(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
): Promise<ParsedPdfContent> {
  const baseUrl = config.baseUrl || 'https://api.mineru.ai';
  log.info(`Parsing PDF with MinerU at ${baseUrl} (${pdfBuffer.length} bytes)`);

  const formData = new FormData();
  // Using Blob instead of File for node-fetch compatibility
  const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
  formData.append('file', blob, 'document.pdf');
  formData.append('extract_image', 'true');
  formData.append('extract_table', 'true');
  formData.append('extract_formula', 'true');

  const response = await fetch(`${baseUrl}/v1/extract`, {
    method: 'POST',
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`MinerU API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.code !== 0 && data.code !== 200) {
    throw new Error(`MinerU API returned error code ${data.code}: ${data.message || 'Unknown'}`);
  }

  // MinerU response structure varies by version, adapting to generic markdown response
  const text = data.data?.markdown || data.data?.text || '';
  const images = data.data?.images || [];

  return {
    text: text.trim(),
    images,
    metadata: {
      pageCount: data.data?.page_count || 0,
      parser: 'mineru',
      taskId: data.data?.task_id,
    },
  };
}

/**
 * Main entry point for PDF parsing
 * Routes to the appropriate provider implementation based on config
 */
export async function parsePDF(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
): Promise<ParsedPdfContent> {
  const provider = PDF_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown PDF provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for PDF provider: ${config.providerId}`);
  }

  const startTime = Date.now();

  let result: ParsedPdfContent;

  switch (config.providerId) {
    case 'unpdf':
      result = await parseWithUnpdf(pdfBuffer);
      break;

    case 'mineru':
      result = await parseWithMinerU(config, pdfBuffer);
      break;

    case 'local_vision':
      result = await parseWithLocalVision(config, pdfBuffer);
      break;

    default:
      throw new Error(`Unsupported PDF provider: ${config.providerId}`);
  }

  const duration = Date.now() - startTime;
  log.info(
    `Successfully parsed PDF with ${config.providerId}: ${result.metadata?.pageCount ?? '?'} pages, ${result.text.length} chars, ${result.images.length} images (${duration}ms)`,
  );

  return result;
}

/**
 * Local Vision API implementation
 *
 * Uses a local OpenAI-compatible endpoint (like vLLM or Ollama running Qwen2-VL)
 * to perform OCR and layout analysis on PDF pages.
 */
async function parseWithLocalVision(
  config: PDFParserConfig,
  pdfBuffer: Buffer
): Promise<ParsedPdfContent> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const numPages = pdf.numPages;

  let fullText = '';
  const allImages: string[] = [];
  const baseUrl = config.baseUrl || 'http://127.0.0.1:11434/v1';

  for (let i = 1; i <= numPages; i++) {
    // page is intentionally unused if only OCR is used
    await pdf.getPage(i);
    const imageArrayBuffer = await renderPageAsImage(new Uint8Array(pdfBuffer), i, { scale: 2 });
    const base64Image = Buffer.from(imageArrayBuffer).toString('base64');
    const imageUrl = `data:image/png;base64,${base64Image}`;

    const payload = {
      model: "qwen2-vl",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe the text in this document image accurately. Preserve the layout, headings, paragraphs, and list structures using Markdown. If there are tables or formulas, transcribe them into Markdown tables or LaTeX blocks respectively." },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Local Vision OCR error: ${response.statusText}`);
    }

    const data = await response.json();
    const pageText = data.choices?.[0]?.message?.content || '';
    fullText += `\n\n--- Page ${i} ---\n\n${pageText}`;

    // Optionally extract native images from the page using unpdf alongside the OCR
    // ...
  }

  return {
    text: fullText.trim(),
    images: allImages,
    metadata: {
      pageCount: numPages,
      parser: 'local_vision'
    }
  };
}
