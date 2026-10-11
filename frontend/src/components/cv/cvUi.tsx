import type { BatchItemState, DecisionType } from '../../types/index.js';
import { categoryLabel } from '../../utils/categoryLabels.js';

/** Confidence is stored as 0-1; shown as a percentage with the raw value alongside. */
export function formatConfidence(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value * 100)}% (${value.toFixed(2)})`;
}

/**
 * percent = null renders an indeterminate bar: used whenever there is no
 * real measured fraction to show (e.g. waiting on the AI), so no number is
 * ever invented.
 */
export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
    >
      {percent === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-400" />
      ) : (
        <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      )}
    </div>
  );
}

const STATE_STYLES: Record<BatchItemState, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'bg-gray-100 text-gray-700 border-gray-300' },
  processing: { label: 'Processing', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  completed: { label: 'Completed', className: 'bg-green-50 text-green-700 border-green-200' },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-700 border-red-200' },
};

export function StateBadge({ state }: { state: BatchItemState }) {
  const { label, className } = STATE_STYLES[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {state === 'processing' && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
      )}
      {label}
    </span>
  );
}

const DECISION_STYLES: Record<DecisionType | 'PENDING', { label: string; className: string }> = {
  PENDING: { label: 'Awaiting review', className: 'bg-amber-50 text-amber-800 border-amber-200' },
  ACCEPT: { label: 'Accepted', className: 'bg-green-50 text-green-700 border-green-200' },
  MODIFY: { label: 'Modified', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  REJECT: { label: 'Rejected', className: 'bg-red-50 text-red-700 border-red-200' },
};

export function DecisionBadge({ type }: { type: DecisionType | 'PENDING' }) {
  const { label, className } = DECISION_STYLES[type];
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

export function CategoryChip({ name, confidence }: { name: string; confidence?: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-sm text-gray-800">
      {categoryLabel(name)}
      {confidence !== undefined && <span className="text-xs text-gray-500">{formatConfidence(confidence)}</span>}
    </span>
  );
}
