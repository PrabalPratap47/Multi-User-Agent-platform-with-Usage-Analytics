import { useCallback, useEffect, useRef, useState } from 'react';
import { cvService } from '../../services/cvService.js';
import { useAsyncData } from '../../hooks/useAsyncData.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import type { CvBatchFile } from '../../types/index.js';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../analytics/AnalyticsPrimitives.js';
import { CvUploadPanel, type RejectedFile } from './CvUploadPanel.js';
import { ProcessingJobView, type CvJob } from './ProcessingJobView.js';
import { RecommendationCard } from './RecommendationCard.js';

const POLL_INTERVAL_MS = 1500;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const STORED_BATCH_KEY = 'cvProcessing.batch';

interface StoredBatch {
  batchId: string;
  fileNames: string[];
  rejected: RejectedFile[];
}

// Lets a batch keep being tracked after switching dashboard tabs. Only the
// batch id is stored; its progress is always re-read from the server.
function loadStoredBatch(): StoredBatch | null {
  try {
    const raw = sessionStorage.getItem(STORED_BATCH_KEY);
    return raw ? (JSON.parse(raw) as StoredBatch) : null;
  } catch {
    return null;
  }
}

function storeBatch(batch: StoredBatch | null) {
  try {
    if (batch) sessionStorage.setItem(STORED_BATCH_KEY, JSON.stringify(batch));
    else sessionStorage.removeItem(STORED_BATCH_KEY);
  } catch {
    // Storage unavailable: tracking still works until the tab is left.
  }
}

function initialJob(): CvJob | null {
  const stored = loadStoredBatch();
  if (!stored) return null;
  return {
    kind: 'batch',
    fileNames: stored.fileNames,
    phase: 'tracking',
    upload: null,
    batchId: stored.batchId,
    status: null,
    error: null,
    rejected: stored.rejected,
  };
}

export function CvProcessingTab() {
  const [job, setJob] = useState<CvJob | null>(initialJob);
  const [resultsVersion, setResultsVersion] = useState(0);
  const [highlightIds, setHighlightIds] = useState<number[]>([]);
  const [trackingAttempt, setTrackingAttempt] = useState(0);
  const seenRecommendationIds = useRef<Set<number>>(new Set());

  const results = useAsyncData(() => cvService.listResults(), [resultsVersion]);
  const refreshResults = useCallback(() => setResultsVersion(v => v + 1), []);

  const busy = job !== null && ((job.kind === 'single' && job.state === 'processing') || (job.kind === 'batch' && (job.phase === 'uploading' || job.phase === 'tracking')));

  const startSingle = async (file: CvBatchFile, rejected: RejectedFile[]) => {
    setJob({ kind: 'single', fileName: file.fileName, state: 'processing', upload: null, error: null, recommendationId: null, rejected });
    try {
      const recommendation = await cvService.classify({ cvContent: file.content, fileName: file.fileName }, upload =>
        setJob(j => (j?.kind === 'single' ? { ...j, upload } : j))
      );
      setJob(j => (j?.kind === 'single' ? { ...j, state: 'completed', recommendationId: recommendation.id } : j));
      setHighlightIds([recommendation.id]);
      refreshResults();
    } catch (err) {
      setJob(j => (j?.kind === 'single' ? { ...j, state: 'failed', error: apiErrorMessage(err, 'Classification failed.') } : j));
    }
  };

  const startBatch = async (files: CvBatchFile[], rejected: RejectedFile[]) => {
    const fileNames = files.map(f => f.fileName);
    seenRecommendationIds.current = new Set();
    setJob({ kind: 'batch', fileNames, phase: 'uploading', upload: null, batchId: null, status: null, error: null, rejected });
    try {
      const { batchId } = await cvService.submitBatch(files, upload => setJob(j => (j?.kind === 'batch' ? { ...j, upload } : j)));
      storeBatch({ batchId, fileNames, rejected });
      setJob(j => (j?.kind === 'batch' ? { ...j, phase: 'tracking', batchId } : j));
    } catch (err) {
      setJob(j => (j?.kind === 'batch' ? { ...j, phase: 'upload-failed', error: apiErrorMessage(err, 'The upload failed.') } : j));
    }
  };

  const handleSubmit = (files: CvBatchFile[], rejected: RejectedFile[]) => {
    setHighlightIds([]);
    storeBatch(null);
    if (files.length === 1) void startSingle(files[0], rejected);
    else void startBatch(files, rejected);
  };

  // Poll the real batch status until every file is completed or failed.
  const batchId = job?.kind === 'batch' && job.phase === 'tracking' ? job.batchId : null;
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const poll = async () => {
      try {
        const status = await cvService.getBatchStatus(batchId);
        if (cancelled) return;
        failures = 0;

        const newIds = status.items
          .map(item => item.recommendationId)
          .filter((id): id is number => id !== null && !seenRecommendationIds.current.has(id));
        if (newIds.length > 0) {
          newIds.forEach(id => seenRecommendationIds.current.add(id));
          setHighlightIds(current => [...current, ...newIds]);
          refreshResults();
        }

        const finished = status.queued + status.processing === 0;
        setJob(j => (j?.kind === 'batch' && j.batchId === batchId ? { ...j, status, error: null, phase: finished ? 'done' : 'tracking' } : j));
        if (!finished) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setJob(j =>
            j?.kind === 'batch' && j.batchId === batchId
              ? { ...j, error: `Lost contact with the server while tracking progress: ${apiErrorMessage(err)}` }
              : j
          );
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, trackingAttempt, refreshResults]);

  const retryTracking = () => {
    setJob(j => (j?.kind === 'batch' ? { ...j, error: null } : j));
    setTrackingAttempt(n => n + 1);
  };

  const dismissJob = () => {
    storeBatch(null);
    setJob(null);
  };

  const pendingReview = results.data?.filter(r => !r.decisions?.length).length ?? 0;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Upload CVs"
        description="Each CV is classified by the AI into one primary category plus optional secondary categories. You then accept, modify or reject the recommendation."
      >
        <CvUploadPanel busy={busy} onSubmit={handleSubmit} />
      </SectionCard>

      {job && (
        <SectionCard title={job.kind === 'single' ? 'Processing' : 'Batch processing'}>
          <ProcessingJobView job={job} onRetryTracking={retryTracking} />
          {!busy && (
            <button type="button" onClick={dismissJob} className="mt-3 text-sm text-gray-600 underline hover:text-gray-800">
              Dismiss
            </button>
          )}
        </SectionCard>
      )}

      <SectionCard
        title="Classification results"
        description="Newest first. The original AI recommendation is always kept; your decision is stored separately."
      >
        {results.loading && !results.data && <LoadingState label="Loading results..." />}
        {results.error && <ErrorState message={results.error} onRetry={results.reload} />}
        {results.data && results.data.length === 0 && <EmptyState message="No CVs have been classified yet. Upload a CV above to get started." />}
        {results.data && results.data.length > 0 && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {results.data.length} result{results.data.length === 1 ? '' : 's'} · {pendingReview} awaiting review
              {results.loading && <span className="ml-2 text-gray-500">Refreshing...</span>}
            </p>
            {results.data.map(rec => (
              <RecommendationCard key={rec.id} recommendation={rec} highlighted={highlightIds.includes(rec.id)} onDecided={refreshResults} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
