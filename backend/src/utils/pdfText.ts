import { Worker } from 'node:worker_threads';
import type { PdfWorkerFailure, PdfWorkerResult } from './pdfTextWorker.js';

/**
 * Text extraction for PDF CVs. A PDF arrives base64-encoded in the same
 * JSON upload as .txt CVs; its text is extracted here and then goes through
 * exactly the same checks and classification workflow as a .txt CV.
 *
 * Only text-based PDFs are supported: there is no OCR. Parsing runs in a
 * worker thread (pdfTextWorker.ts) with a memory limit and a hard timeout,
 * so a damaged or hostile PDF fails only its own file.
 */

export const PDF_MIME_TYPE = 'application/pdf';
export const MAX_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const PDF_EXTRACTION_TIMEOUT_MS = 15_000;
const WORKER_MAX_OLD_GENERATION_MB = 256;
const WORKER_MAX_YOUNG_GENERATION_MB = 32;

let extractionTimeoutMs = PDF_EXTRACTION_TIMEOUT_MS;

/** Test hook (like the agents' __set...ForTesting): a short timeout exercises the time limit. */
export function __setPdfExtractionTimeoutForTesting(ms: number = PDF_EXTRACTION_TIMEOUT_MS): void {
  extractionTimeoutMs = ms;
}

// The compiled worker in production (dist/), the TypeScript source in dev and tests.
const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './pdfTextWorker.ts' : './pdfTextWorker.js', import.meta.url);

/** A PDF that cannot be used as a CV; the message is safe to show users. */
export class PdfExtractionError extends Error {
  name = 'PdfExtractionError';
}

const NO_TEXT_MESSAGE =
  'No readable text was found in this PDF. It may be a scanned image: text recognition (OCR) is not supported. Upload a text-based PDF or a .txt file.';

function failureMessage(reason: PdfWorkerFailure, maxChars: number): string {
  switch (reason) {
    case 'password':
      return 'The PDF is password-protected. Save a copy without a password and upload that.';
    case 'encrypted':
      return 'The PDF is encrypted. Save an unencrypted copy and upload that.';
    case 'invalid':
      return 'The PDF is damaged or not a valid PDF, so it could not be read.';
    case 'too_many_pages':
      return `The PDF has more than ${MAX_PDF_PAGES} pages (limit ${MAX_PDF_PAGES}).`;
    case 'too_long':
      return `The PDF contains more than ${maxChars.toLocaleString('en-US')} characters of text (limit ${maxChars.toLocaleString('en-US')}).`;
    case 'failed':
      return 'The PDF could not be read. It may be damaged or use unsupported features.';
  }
}

/** Decodes the uploaded base64 and checks size and the PDF file signature, before any parsing. */
export function decodePdfUpload(base64: string): Uint8Array {
  if (base64.length === 0) throw new PdfExtractionError('The PDF file is empty.');
  if (base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) {
    throw new PdfExtractionError(`The PDF is larger than the ${MAX_PDF_BYTES / (1024 * 1024)} MB limit.`);
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new PdfExtractionError('The PDF upload could not be decoded. Select the file again and retry.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new PdfExtractionError('The PDF file is empty.');
  // The file extension and MIME type come from the browser; the content must really be a PDF.
  if (!bytes.subarray(0, 1024).includes('%PDF-')) {
    throw new PdfExtractionError('The file is not a PDF (it has no PDF header). Upload a real PDF or a .txt file.');
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

function runWorker(data: Uint8Array, maxChars: number): Promise<PdfWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { data, maxPages: MAX_PDF_PAGES, maxChars },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB, maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB },
      // The parser's own console output is discarded, never logged.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();

    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
      void worker.terminate();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new PdfExtractionError(
              `Reading the PDF took longer than ${PDF_EXTRACTION_TIMEOUT_MS / 1000} seconds and was stopped. Try a simpler or smaller PDF.`
            )
          )
        ),
      extractionTimeoutMs
    );

    worker.once('message', (result: PdfWorkerResult) => settle(() => resolve(result)));
    worker.once('error', (error: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          new PdfExtractionError(
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'The PDF is too complex to process within the memory limit.'
              : failureMessage('failed', maxChars)
          )
        )
      )
    );
    worker.once('exit', () => settle(() => reject(new PdfExtractionError(failureMessage('failed', maxChars)))));
  });
}

/** Whitespace and control characters cleaned up the way a .txt CV would read. */
function normalizeText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
      .replace(/[^\S\n]+/g, ' ') // spaces, tabs, no-break spaces; not newlines
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Extracts the text of an uploaded PDF (base64). Throws PdfExtractionError
 * with a user-safe message for every unusable PDF. Never logs content.
 */
export async function extractPdfText(base64: string, limits: { minChars: number; maxChars: number }): Promise<string> {
  const result = await runWorker(decodePdfUpload(base64), limits.maxChars);
  if (!result.ok) throw new PdfExtractionError(failureMessage(result.reason, limits.maxChars));

  const text = normalizeText(result.text);
  if (text.length < limits.minChars) throw new PdfExtractionError(NO_TEXT_MESSAGE);
  if (text.length > limits.maxChars) throw new PdfExtractionError(failureMessage('too_long', limits.maxChars));
  return text;
}
