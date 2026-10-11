import type { CvBatchFile } from '../types/index.js';

// Mirrors the backend limits (backend/src/services/cvBatchService.ts and
// utils/validators.ts) so bad files are caught before upload. The backend
// re-checks every rule; these only give earlier, clearer feedback.
export const MAX_CV_FILES = 20;
export const MIN_CV_CHARS = 10;
export const MAX_CV_CHARS = 50_000;
const MAX_CV_FILE_BYTES = MAX_CV_CHARS * 4; // UTF-8 upper bound for 50,000 characters
export const MAX_PDF_BYTES = 2 * 1024 * 1024; // backend/src/utils/pdfText.ts
// What one upload request may carry, below the backend's 10 MB JSON body limit (app.ts).
export const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;
export const ACCEPTED_CV_EXTENSIONS = '.txt,.pdf';
export const ACCEPTED_CV_MIME_TYPES = 'text/plain,application/pdf';
export const PDF_MIME_TYPE = 'application/pdf';

export type CheckedCvFile =
  | { ok: true; key: string; fileName: string; sizeBytes: number; uploadBytes: number; payload: CvBatchFile }
  | { ok: false; key: string; fileName: string; sizeBytes: number; reason: string };

function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  const controlChars = content.match(/[\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0;
  return controlChars / content.length > 0.05;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A PDF is checked for size and its file signature here; its text is
 * extracted and checked on the server, which reports scanned, encrypted
 * or damaged PDFs per file.
 */
async function checkPdfFile(file: File, base: { key: string; fileName: string; sizeBytes: number }): Promise<CheckedCvFile> {
  if (file.type !== '' && file.type !== PDF_MIME_TYPE) {
    return { ...base, ok: false, reason: 'The file is not a PDF.' };
  }
  if (file.size === 0) {
    return { ...base, ok: false, reason: 'The file is empty.' };
  }
  if (file.size > MAX_PDF_BYTES) {
    return { ...base, ok: false, reason: `The PDF is too large (limit ${formatBytes(MAX_PDF_BYTES)}).` };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ...base, ok: false, reason: 'The file could not be read.' };
  }
  // Like the server: the content must really be a PDF, whatever its name.
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
    return { ...base, ok: false, reason: 'The file is not a valid PDF (it may be a renamed file).' };
  }

  const content = toBase64(bytes);
  return { ...base, ok: true, uploadBytes: content.length, payload: { fileName: file.name, mimeType: PDF_MIME_TYPE, content } };
}

export async function checkCvFile(file: File, index: number): Promise<CheckedCvFile> {
  const base = { key: `${index}:${file.name}:${file.size}:${file.lastModified}`, fileName: file.name, sizeBytes: file.size };
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf')) return checkPdfFile(file, base);

  if (!name.endsWith('.txt') || (file.type !== '' && file.type !== 'text/plain')) {
    return { ...base, ok: false, reason: 'Only .txt and .pdf files are supported.' };
  }
  if (file.size === 0) {
    return { ...base, ok: false, reason: 'The file is empty.' };
  }
  if (file.size > MAX_CV_FILE_BYTES) {
    return { ...base, ok: false, reason: `The file is too large (limit ${MAX_CV_CHARS.toLocaleString()} characters).` };
  }

  let content: string;
  try {
    content = await file.text();
  } catch {
    return { ...base, ok: false, reason: 'The file could not be read.' };
  }

  if (content.trim().length < MIN_CV_CHARS) {
    return { ...base, ok: false, reason: `The file has fewer than ${MIN_CV_CHARS} characters of text.` };
  }
  if (content.length > MAX_CV_CHARS) {
    return {
      ...base,
      ok: false,
      reason: `The file has ${content.length.toLocaleString()} characters (limit ${MAX_CV_CHARS.toLocaleString()}).`,
    };
  }
  if (looksBinary(content) || content.trimStart().startsWith('%PDF-')) {
    return { ...base, ok: false, reason: 'The file does not look like plain text (it may be a renamed PDF or Word file).' };
  }

  return {
    ...base,
    ok: true,
    uploadBytes: new Blob([content]).size,
    payload: { fileName: file.name, mimeType: 'text/plain', content },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
