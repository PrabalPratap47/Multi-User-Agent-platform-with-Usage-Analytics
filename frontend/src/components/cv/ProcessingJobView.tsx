import type { BatchItemState, BatchStatus } from '../../types/index.js';
import type { UploadProgress } from '../../services/cvService.js';
import { formatBytes } from '../../utils/cvFiles.js';
import type { RejectedFile } from './CvUploadPanel.js';
import { ProgressBar, StateBadge } from './cvUi.js';

export type CvJob =
  | {
      kind: 'single';
      fileName: string;
      state: BatchItemState;
      upload: UploadProgress | null;
      error: string | null;
      recommendationId: number | null;
      rejected: RejectedFile[];
    }
  | {
      kind: 'batch';
      fileNames: string[];
      phase: 'uploading' | 'tracking' | 'done' | 'upload-failed';
      upload: UploadProgress | null;
      batchId: string | null;
      status: BatchStatus | null;
      error: string | null;
      rejected: RejectedFile[];
    };

function UploadLine({ upload }: { upload: UploadProgress | null }) {
  if (!upload) return <p className="text-sm text-gray-600">Starting upload...</p>;
  const percent = upload.total ? Math.round((upload.loaded / upload.total) * 100) : null;
  const done = isUploadComplete(upload);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm text-gray-600">
        <span>{done ? 'Upload complete' : 'Uploading'}</span>
        <span className="tabular-nums">
          {formatBytes(upload.loaded)}
          {upload.total ? ` of ${formatBytes(upload.total)} (${percent}%)` : ''}
        </span>
      </div>
      <ProgressBar percent={percent} label="Upload progress" />
    </div>
  );
}

function ResultLink({ id }: { id: number }) {
  return (
    <a href={`#cv-result-${id}`} className="text-sm font-medium text-blue-700 underline hover:text-blue-900">
      View result
    </a>
  );
}

function Outcome({ completed, failed, total }: { completed: number; failed: number; total: number }) {
  if (completed === total) {
    return (
      <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800">
        All {total} CVs were classified.
      </p>
    );
  }
  if (failed === total) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
        None of the {total} CVs could be classified. See the reasons below.
      </p>
    );
  }
  return (
    <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
      Partially completed: {completed} of {total} CVs classified, {failed} failed. See the reasons below.
    </p>
  );
}

function RejectedList({ rejected }: { rejected: RejectedFile[] }) {
  if (rejected.length === 0) return null;
  return (
    <div className="text-sm">
      <p className="font-medium text-gray-700">Not uploaded ({rejected.length})</p>
      <ul className="mt-1 space-y-1">
        {rejected.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <StateBadge state="failed" />
            <span className="break-all text-gray-800">{r.fileName}</span>
            <span className="text-red-600">{r.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function isUploadComplete(upload: UploadProgress | null): boolean {
  return !!upload && upload.total !== null && upload.loaded >= upload.total;
}

export function ProcessingJobView({ job, onRetryTracking }: { job: CvJob; onRetryTracking: () => void }) {
  if (job.kind === 'single') {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={job.state} />
          <span className="break-all font-medium text-gray-800">{job.fileName}</span>
          {job.recommendationId !== null && <ResultLink id={job.recommendationId} />}
        </div>
        {job.state === 'processing' && (
          <>
            <UploadLine upload={job.upload} />
            {isUploadComplete(job.upload) && (
              <div className="space-y-1">
                <p className="text-sm text-gray-600">The AI is classifying this CV. This usually takes a few seconds.</p>
                <ProgressBar percent={null} label="Classification in progress" />
              </div>
            )}
          </>
        )}
        {job.state === 'failed' && job.error && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {job.error}
          </p>
        )}
        <RejectedList rejected={job.rejected} />
      </div>
    );
  }

  const status = job.status;
  return (
    <div className="space-y-3">
      {job.phase === 'uploading' && (
        <>
          <UploadLine upload={job.upload} />
          <p className="text-sm text-gray-500">Uploading {job.fileNames.length} files...</p>
        </>
      )}

      {job.phase === 'upload-failed' && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          Upload failed - no CVs were processed. {job.error}
        </p>
      )}

      {status && (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-sm text-gray-700">
              <span aria-live="polite">
                {status.completed + status.failed} of {status.total} finished
                {job.phase === 'tracking' && ' - updating live from the server'}
              </span>
              <span className="tabular-nums">{status.percentage}%</span>
            </div>
            <ProgressBar percent={status.percentage} label="Batch progress" />
            <p className="text-xs text-gray-600">
              Queued {status.queued} · Processing {status.processing} · Completed {status.completed} ·{' '}
              <span className={status.failed > 0 ? 'font-semibold text-red-700' : undefined}>Failed {status.failed}</span>
            </p>
          </div>

          {job.phase === 'done' && <Outcome completed={status.completed} failed={status.failed} total={status.total} />}

          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {status.items.map(item => (
              <li key={item.runId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <StateBadge state={item.state} />
                <span className="min-w-0 flex-1 break-all text-gray-800">{item.fileName ?? 'Unnamed file'}</span>
                {item.recommendationId !== null && <ResultLink id={item.recommendationId} />}
                {item.error && <span className="w-full text-red-700 sm:w-auto">{item.error}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {job.error && job.phase !== 'upload-failed' && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {job.error}{' '}
          <button type="button" onClick={onRetryTracking} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      <RejectedList rejected={job.rejected} />
    </div>
  );
}
