import { useEffect, useId, useRef, useState } from 'react';
import { cvService } from '../../services/cvService.js';
import { useAuthStore } from '../../store/authStore.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import type { CvDecisionRecord, CvRecommendation, DecisionType } from '../../types/index.js';
import { DecisionPanel } from './DecisionPanel.js';
import { CategoryChip, DecisionBadge, formatConfidence } from './cvUi.js';
import { categoryLabel } from '../../utils/categoryLabels.js';

function FinalDecision({ decision }: { decision: CvDecisionRecord }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge type={decision.decisionType} />
        <span className="text-gray-500">{new Date(decision.timestamp).toLocaleString()}</span>
      </div>
      {decision.decisionType === 'REJECT' ? (
        <p className="text-gray-700">No category accepted.</p>
      ) : (
        <p className="text-gray-700">
          Final category: <strong>{categoryLabel(decision.finalPrimaryCategory ?? '')}</strong>
          {decision.finalSecondaryCategories.length > 0 && <> (also: {decision.finalSecondaryCategories.map(categoryLabel).join(', ')})</>}
        </p>
      )}
      {decision.reason && (
        <p className="text-gray-700">
          Reason: <span className="italic">{decision.reason}</span>
        </p>
      )}
    </div>
  );
}

// Same green / indigo / red as the decision badges and charts; amber while pending.
const FINAL_PANEL_TONE: Record<DecisionType | 'PENDING', string> = {
  PENDING: 'border-amber-200 bg-amber-50/60',
  ACCEPT: 'border-green-200 bg-green-50/60',
  MODIFY: 'border-indigo-200 bg-indigo-50/60',
  REJECT: 'border-red-200 bg-red-50/60',
};
const STATUS_LINE: Record<DecisionType, { verb: string; className: string }> = {
  ACCEPT: { verb: 'Accepted', className: 'text-green-800' },
  MODIFY: { verb: 'Modified', className: 'text-indigo-800' },
  REJECT: { verb: 'Rejected', className: 'text-red-800' },
};

/**
 * The AI's 2-4 sentence feedback about this CV, ready to copy (e.g. into
 * Sentiment Analysis). Results classified before feedback existed show an
 * unavailable state - nothing is invented in its place.
 */
function CvFeedback({ feedback }: { feedback: string | null }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    if (!feedback) return;
    try {
      await navigator.clipboard.writeText(feedback);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <section aria-label="CV Feedback" className="mt-3 rounded-lg border border-violet-200 bg-violet-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-violet-900">CV Feedback</h4>
        {feedback && (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-violet-300 bg-white px-3 py-1 text-sm font-medium text-violet-800 hover:bg-violet-100"
          >
            {copyState === 'copied' ? 'Copied' : 'Copy feedback'}
          </button>
        )}
      </div>
      {feedback ? (
        <p className="mt-2 select-all text-sm leading-relaxed text-gray-900">{feedback}</p>
      ) : (
        <p className="mt-2 text-sm italic text-gray-600">Feedback is not available for this CV (it was classified before CV feedback was added).</p>
      )}
      {copyState === 'copied' && (
        <p role="status" className="mt-1 text-xs text-violet-800">
          Copied to the clipboard - paste it into Sentiment Analysis.
        </p>
      )}
      {copyState === 'failed' && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          Could not copy automatically. Select the text and copy it manually.
        </p>
      )}
    </section>
  );
}

/** What the AI proposed, with its confidence. Never changed by a decision. */
function OriginalRecommendationPanel({ recommendation }: { recommendation: CvRecommendation }) {
  return (
    <section aria-label="Original AI recommendation" className="rounded-lg border border-blue-100 bg-blue-50/50 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-900">Original AI recommendation</h4>
      <p className="mt-1 text-lg font-bold text-gray-900">{categoryLabel(recommendation.primaryCategory)}</p>
      <p className="mt-1">
        <span className="inline-flex rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800">
          Confidence {formatConfidence(recommendation.confidenceScore)}
        </span>
      </p>
      <p className="mt-3 text-xs font-medium text-gray-600">Secondary categories</p>
      {recommendation.secondaryCategories.length === 0 ? (
        <p className="text-sm italic text-gray-600">None</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {recommendation.secondaryCategories.map(c => (
            <CategoryChip key={c} name={c} confidence={recommendation.confidenceScores?.[c]} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The latest decision, kept apart from the original recommendation. Reads
 * only the stored decision: a REJECT has no final category, and a category
 * the user chose never shows the AI's confidence.
 */
function FinalDecisionPanel({ decision }: { decision: CvDecisionRecord | undefined }) {
  const status = decision ? STATUS_LINE[decision.decisionType] : undefined;
  return (
    <section aria-label="Final decision" className={`rounded-lg border p-4 ${FINAL_PANEL_TONE[decision?.decisionType ?? 'PENDING']}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">Final decision</h4>
      {!decision || !status ? (
        <p className="mt-1 text-sm text-gray-700">Awaiting your decision. Accept, modify or reject the recommendation below.</p>
      ) : (
        <>
          <p className="mt-1 text-lg font-bold text-gray-900">
            {decision.decisionType === 'REJECT' || !decision.finalPrimaryCategory ? 'No category accepted' : categoryLabel(decision.finalPrimaryCategory)}
          </p>
          {decision.finalSecondaryCategories.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {decision.finalSecondaryCategories.map(c => (
                <CategoryChip key={c} name={c} />
              ))}
            </div>
          )}
          <p className={`mt-2 text-xs font-semibold ${status.className}`}>
            {status.verb} · {new Date(decision.timestamp).toLocaleString()}
          </p>
          {decision.reason && (
            <p className="mt-2 text-sm text-gray-700">
              <span className="font-medium">Reason:</span> <span className="italic">{decision.reason}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** One line for the collapsed record: what the AI proposed and, once decided, the final category (never a confidence for it). */
function collapsedSummary(recommendation: CvRecommendation, latest: CvDecisionRecord | undefined): string {
  const original = `AI recommendation: ${categoryLabel(recommendation.primaryCategory)}`;
  if (!latest) return `${original} · Awaiting your decision`;
  if (latest.decisionType === 'REJECT' || !latest.finalPrimaryCategory) return `${original} · Final: none (rejected)`;
  return `${original} · Final: ${categoryLabel(latest.finalPrimaryCategory)}`;
}

export function RecommendationCard({
  recommendation,
  highlighted,
  onDecided,
  onDeleted,
}: {
  recommendation: CvRecommendation;
  highlighted?: boolean;
  onDecided: () => void;
  onDeleted: () => void;
}) {
  const [decisions, setDecisions] = useState<CvDecisionRecord[]>(recommendation.decisions ?? []);
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  // Compact by default; a CV just processed in this session opens so it can be reviewed.
  const [expanded, setExpanded] = useState(!!highlighted);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const idPrefix = useId();
  // Deleting is admin only (also enforced by the server).
  const canDelete = useAuthStore(state => state.user?.role === 'admin');

  useEffect(() => {
    setDecisions(recommendation.decisions ?? []);
  }, [recommendation.decisions]);

  useEffect(() => {
    if (highlighted) setExpanded(true);
  }, [highlighted]);

  const latest = decisions[0];
  const scores = Object.entries(recommendation.confidenceScores ?? {}).sort((a, b) => b[1] - a[1]);
  const title = recommendation.cvDocument?.fileName || `CV #${recommendation.cvDocumentId}`;
  const bodyId = `${idPrefix}-details`;

  const handleDecided = (decision: CvDecisionRecord) => {
    setDecisions(current => [decision, ...current]);
    setEditing(false);
    setConfirmation(`Decision saved: ${decision.decisionType}. The original AI recommendation is unchanged.`);
    onDecided();
  };

  const openDeleteDialog = () => {
    setDeleteError(null);
    deleteDialog.current?.showModal();
  };

  // The record is removed only after the server confirms the deletion.
  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await cvService.deleteDocument(recommendation.cvDocumentId);
      deleteDialog.current?.close();
      setDeleted(true);
      onDeleted();
    } catch (err) {
      setDeleteError(apiErrorMessage(err, 'The CV could not be deleted. Nothing was removed.'));
    } finally {
      setDeleting(false);
    }
  };

  if (deleted) return null;

  return (
    <article
      id={`cv-result-${recommendation.id}`}
      className={`scroll-mt-32 rounded-lg border bg-white p-4 shadow-sm sm:p-5 ${highlighted ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200'}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-[12rem] flex-1">
          <h3 className="font-semibold text-gray-900">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded(open => !open)}
              className="flex max-w-full items-start gap-2 text-left hover:text-blue-800"
            >
              <span aria-hidden="true" className={`mt-0.5 inline-block text-xs text-gray-600 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                ▶
              </span>
              <span className="min-w-0 break-words">{title}</span>
            </button>
          </h3>
          <p className="ml-5 text-xs text-gray-500">
            Result #{recommendation.id} · classified {new Date(recommendation.createdAt).toLocaleString()}
          </p>
          <p className="ml-5 mt-1 break-words text-sm text-gray-700">{collapsedSummary(recommendation, latest)}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <DecisionBadge type={latest?.decisionType ?? 'PENDING'} />
          {canDelete && (
            <button
              type="button"
              onClick={openDeleteDialog}
              aria-label={`Delete ${title}`}
              className="rounded-md border border-red-200 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {canDelete && (
        <dialog
          ref={deleteDialog}
          aria-labelledby={`${idPrefix}-delete-title`}
          onCancel={e => {
            if (deleting) e.preventDefault();
          }}
          className="w-[calc(100%-2rem)] max-w-md rounded-lg p-0 shadow-xl backdrop:bg-gray-900/50"
        >
          <div className="space-y-3 p-5">
            <h4 id={`${idPrefix}-delete-title`} className="text-lg font-semibold text-gray-900">
              Delete this CV permanently?
            </h4>
            <p className="text-sm text-gray-700">
              <strong className="break-all">{title}</strong> (Result #{recommendation.id}) will be permanently deleted: its stored CV
              text, the original AI recommendation and{' '}
              {decisions.length === 0 ? 'no decisions' : decisions.length === 1 ? 'its 1 decision' : `all ${decisions.length} decisions`}.
              This cannot be undone.
            </p>
            <p className="text-sm text-gray-600">Token usage and cost records for its processing are kept.</p>
            {deleteError && (
              <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                {deleteError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => deleteDialog.current?.close()}
                disabled={deleting}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </dialog>
      )}

      <div id={bodyId} hidden={!expanded}>
        {recommendation.runId && (
          <p className="mt-3">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
              <span className="font-semibold">Run ID</span>
              <span className="break-all font-mono">{recommendation.runId}</span>
            </span>
          </p>
        )}

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <OriginalRecommendationPanel recommendation={recommendation} />
          <FinalDecisionPanel decision={latest} />
        </div>

        <CvFeedback feedback={recommendation.feedback ?? null} />

        <div className="mt-4 space-y-4">
          <details className="rounded-md border border-gray-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">Confidence for every category (0-1)</summary>
            <ul className="mt-2 space-y-1">
              {scores.map(([category, value]) => (
                <li key={category} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-sm">
                  <span className="truncate text-gray-700" title={categoryLabel(category)}>
                    {categoryLabel(category)}
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-gray-200">
                    <span className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.round(value * 100)}%` }} />
                  </span>
                  <span className="tabular-nums text-gray-600">{formatConfidence(value)}</span>
                </li>
              ))}
            </ul>
          </details>

          <div>
            <p className="text-sm font-medium text-gray-700">Rationale and evidence from the CV</p>
            <ul className="mt-2 space-y-2">
              {recommendation.rationale.map((entry, i) => (
                <li key={i} className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="font-medium text-gray-800">
                    Why {categoryLabel(entry.category)}
                    {entry.category === recommendation.primaryCategory && <span className="ml-1 text-xs text-blue-700">(primary)</span>}
                  </p>
                  <blockquote className="mt-1 border-l-4 border-gray-300 pl-3 italic text-gray-700">“{entry.evidence}”</blockquote>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <section className="mt-5 space-y-3 border-t border-gray-100 pt-4" aria-label="Decision">
          {confirmation && (
            <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800">
              {confirmation}
            </p>
          )}

          {latest && !editing && (
            <div>
              {decisions.length > 1 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600">Earlier decisions ({decisions.length - 1})</summary>
                  <ul className="mt-2 space-y-2 border-l-2 border-gray-200 pl-3">
                    {decisions.slice(1).map(d => (
                      <li key={d.id}>
                        <FinalDecision decision={d} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setConfirmation(null);
                }}
                className="mt-3 text-sm font-medium text-blue-700 underline hover:text-blue-900"
              >
                Change decision
              </button>
            </div>
          )}

          {(!latest || editing) && (
            <DecisionPanel
              key={decisions.length}
              recommendation={recommendation}
              onDecided={handleDecided}
              onCancel={latest ? () => setEditing(false) : undefined}
            />
          )}
        </section>
      </div>
    </article>
  );
}
