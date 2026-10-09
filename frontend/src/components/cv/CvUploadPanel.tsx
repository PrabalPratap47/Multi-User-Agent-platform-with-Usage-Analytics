import { useRef, useState, type ChangeEvent } from 'react';
import type { CvBatchFile } from '../../types/index.js';
import { ACCEPTED_CV_EXTENSIONS, MAX_CV_CHARS, MAX_CV_FILES, checkCvFile, formatBytes, type CheckedCvFile } from '../../utils/cvFiles.js';

export interface RejectedFile {
  fileName: string;
  reason: string;
}

export function CvUploadPanel({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (files: CvBatchFile[], rejected: RejectedFile[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<CheckedCvFile[]>([]);
  const [checking, setChecking] = useState(false);

  const valid = checked.filter((f): f is Extract<CheckedCvFile, { ok: true }> => f.ok);
  const invalid = checked.filter((f): f is Extract<CheckedCvFile, { ok: false }> => !f.ok);
  const tooMany = valid.length > MAX_CV_FILES;

  const handleChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setChecking(true);
    try {
      setChecked(await Promise.all(files.map((file, i) => checkCvFile(file, i))));
    } finally {
      setChecking(false);
    }
  };

  const reset = () => {
    setChecked([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const submit = () => {
    if (valid.length === 0 || tooMany) return;
    onSubmit(
      valid.map(f => f.payload),
      invalid.map(f => ({ fileName: f.fileName, reason: f.reason }))
    );
    reset();
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="cv-files" className="block text-sm font-medium text-gray-700">
          Select one or more CV files
        </label>
        <input
          id="cv-files"
          ref={inputRef}
          type="file"
          multiple
          accept={`${ACCEPTED_CV_EXTENSIONS},text/plain`}
          onChange={handleChange}
          disabled={busy}
          className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
        />
        <p className="mt-1 text-xs text-gray-500">
          Plain-text .txt files, up to {MAX_CV_CHARS.toLocaleString()} characters each, at most {MAX_CV_FILES} files per upload.
          One file is classified immediately; several are processed as a batch.
        </p>
      </div>

      {checking && (
        <p role="status" className="text-sm text-gray-500">
          Checking files...
        </p>
      )}

      {checked.length > 0 && !checking && (
        <div className="rounded-md border border-gray-200">
          <ul className="divide-y divide-gray-100">
            {checked.map(f => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 break-all text-gray-800">
                  {f.fileName} <span className="text-gray-500">({formatBytes(f.sizeBytes)})</span>
                </span>
                {f.ok ? (
                  <span className="text-green-700">Ready</span>
                ) : (
                  <span className="text-red-600">Will not be uploaded: {f.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tooMany && (
        <p role="alert" className="text-sm text-red-600">
          {valid.length} valid files selected - at most {MAX_CV_FILES} can be uploaded at once. Select fewer files.
        </p>
      )}
      {checked.length > 0 && valid.length === 0 && !checking && (
        <p role="alert" className="text-sm text-red-600">
          None of the selected files can be uploaded. Fix the problems above and choose the files again.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || checking || valid.length === 0 || tooMany}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {valid.length <= 1 ? 'Classify CV' : `Classify ${valid.length} CVs`}
        </button>
        {checked.length > 0 && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
