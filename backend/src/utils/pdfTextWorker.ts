import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Runs in its own worker thread, started by pdfText.ts: PDF parsing never
 * runs on the server's main thread, so a malformed or hostile PDF can be
 * stopped by the worker's memory limit or a timeout without affecting
 * anything else. Only text is read: no rendering, no scripts, no network.
 *
 * Kept self-contained (no relative imports, type-only TypeScript) so Node
 * can load it directly in tests as well as compiled in production.
 */

export interface PdfWorkerInput {
  data: Uint8Array;
  maxPages: number;
  maxChars: number;
}

export type PdfWorkerFailure = 'password' | 'encrypted' | 'invalid' | 'too_many_pages' | 'too_long' | 'failed';

export type PdfWorkerResult = { ok: true; text: string } | { ok: false; reason: PdfWorkerFailure };

// Local font/CMap data, read from disk by PDF.js (it needs "/" separators and a trailing "/").
const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replace(/\\/g, '/');

async function extract({ data, maxPages, maxChars }: PdfWorkerInput): Promise<PdfWorkerResult> {
  const task = getDocument({
    // PDF.js 6 never compiles code from a PDF (it has no eval/Function path),
    // and JavaScript in a PDF only runs in a viewer's scripting sandbox, not here.
    data,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
    cMapUrl: `${pdfjsDir}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsDir}/standard_fonts/`,
  });
  try {
    const doc = await task.promise;
    const { info } = await doc.getMetadata();
    // Opened without a password, but still encrypted (owner restrictions).
    if (info && (info as Record<string, unknown>).EncryptFilterName) return { ok: false, reason: 'encrypted' };
    if (doc.numPages > maxPages) return { ok: false, reason: 'too_many_pages' };

    let text = '';
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      text += '\n';
      page.cleanup();
      // Raw text, before whitespace cleanup; the exact limit is checked by the caller.
      if (text.length > maxChars * 2) return { ok: false, reason: 'too_long' };
    }
    return { ok: true, text };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') return { ok: false, reason: 'password' };
    if (name === 'InvalidPDFException') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'failed' };
  } finally {
    await task.destroy();
  }
}

void extract(workerData as PdfWorkerInput).then(result => parentPort?.postMessage(result));
