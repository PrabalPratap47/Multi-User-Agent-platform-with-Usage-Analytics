import type { CvBatchFile } from '../types/index.js';

// Mirrors the backend limits (backend/src/services/cvBatchService.ts and
// utils/validators.ts) so bad files are caught before upload. The backend
// re-checks every rule; these only give earlier, clearer feedback.
export const MAX_CV_FILES = 20;
export const MIN_CV_CHARS = 10;
export const MAX_CV_CHARS = 50_000;
const MAX_CV_FILE_BYTES = MAX_CV_CHARS * 4; // UTF-8 upper bound for 50,000 characters
export const ACCEPTED_CV_EXTENSIONS = '.txt';

export type CheckedCvFile =
  | { ok: true; key: string; fileName: string; sizeBytes: number; payload: CvBatchFile }
  | { ok: false; key: string; fileName: string; sizeBytes: number; reason: string };

function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  const controlChars = content.match(/[\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0;
  return controlChars / content.length > 0.05;
}

export async function checkCvFile(file: File, index: number): Promise<CheckedCvFile> {
  const base = { key: `${index}:${file.name}:${file.size}:${file.lastModified}`, fileName: file.name, sizeBytes: file.size };
  const isTxt = file.name.toLowerCase().endsWith('.txt');

  if (!isTxt || (file.type !== '' && file.type !== 'text/plain')) {
    return { ...base, ok: false, reason: 'Only plain-text .txt files are supported.' };
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
  if (looksBinary(content)) {
    return { ...base, ok: false, reason: 'The file does not look like plain text (it may be a renamed PDF or Word file).' };
  }

  return { ...base, ok: true, payload: { fileName: file.name, mimeType: 'text/plain', content } };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
