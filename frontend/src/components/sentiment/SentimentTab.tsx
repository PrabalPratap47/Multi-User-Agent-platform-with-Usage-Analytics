import { useState, type FormEvent } from 'react';
import { sentimentService } from '../../services/sentimentService.js';
import { useAsyncData } from '../../hooks/useAsyncData.js';
import { useAuthStore } from '../../store/authStore.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { MAX_FEEDBACK_CHARS, type SentimentLabel, type SentimentResult } from '../../types/index.js';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../analytics/AnalyticsPrimitives.js';
import { ProgressBar, formatConfidence } from '../cv/cvUi.js';

const SENTIMENT_STYLES: Record<SentimentLabel, { label: string; className: string; bar: string }> = {
  POSITIVE: { label: 'Positive', className: 'bg-green-50 text-green-800 border-green-200', bar: 'bg-green-500' },
  NEUTRAL: { label: 'Neutral', className: 'bg-gray-100 text-gray-700 border-gray-300', bar: 'bg-gray-500' },
  NEGATIVE: { label: 'Negative', className: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-500' },
};

function SentimentBadge({ sentiment, large }: { sentiment: SentimentLabel; large?: boolean }) {
  const { label, className } = SENTIMENT_STYLES[sentiment];
  return (
    <span className={`inline-block rounded-full border font-semibold ${large ? 'px-3 py-1 text-base' : 'px-2 py-0.5 text-xs'} ${className}`}>
      {label}
    </span>
  );
}

function ConfidenceBar({ result }: { result: SentimentResult }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-gray-600">Confidence {formatConfidence(result.confidence)}</p>
      <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
        <div className={`h-full rounded-full ${SENTIMENT_STYLES[result.sentiment].bar}`} style={{ width: `${Math.round(result.confidence * 100)}%` }} />
      </div>
    </div>
  );
}

function LatestResult({ result }: { result: SentimentResult }) {
  return (
    <div role="status" aria-label="Sentiment result" className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <SentimentBadge sentiment={result.sentiment} large />
        <span className="text-xs text-gray-500">Result #{result.id} · saved {new Date(result.createdAt).toLocaleString()}</span>
      </div>
      <ConfidenceBar result={result} />
      <div>
        <p className="text-sm font-medium text-gray-700">Rationale</p>
        <p className="mt-1 text-sm text-gray-800">{result.rationale}</p>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600">Analyzed feedback</summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-gray-700">{result.inputText}</p>
      </details>
    </div>
  );
}

function AnalyzeForm({ onAnalyzed }: { onAnalyzed: (result: SentimentResult) => void }) {
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [latest, setLatest] = useState<SentimentResult | null>(null);

  const tooLong = text.length > MAX_FEEDBACK_CHARS;
  const validationError = !text.trim()
    ? 'Enter some feedback to analyze.'
    : tooLong
      ? `Feedback is too long: ${text.length.toLocaleString()} of ${MAX_FEEDBACK_CHARS.toLocaleString()} characters.`
      : null;
  const shownError = attempted || tooLong ? validationError : null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    setApiError(null);
    if (validationError) return;

    setSubmitting(true);
    try {
      const result = await sentimentService.analyze(text.trim());
      setLatest(result);
      setText('');
      setAttempted(false);
      onAnalyzed(result);
    } catch (err) {
      setApiError(apiErrorMessage(err, 'Sentiment analysis failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <div>
          <label htmlFor="feedback-text" className="block text-sm font-medium text-gray-700">
            Feedback text
          </label>
          <textarea
            id="feedback-text"
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={submitting}
            rows={5}
            aria-invalid={!!shownError}
            aria-describedby="feedback-help"
            placeholder="Paste a customer review, survey answer or support message..."
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 ${
              shownError ? 'border-red-400' : 'border-gray-300'
            }`}
          />
          <div id="feedback-help" className="mt-1 flex flex-wrap justify-between gap-2 text-xs">
            <span className={shownError ? 'text-red-600' : 'text-gray-500'}>{shownError ?? 'Plain text, one piece of feedback at a time.'}</span>
            <span className={`tabular-nums ${tooLong ? 'text-red-600' : 'text-gray-500'}`}>
              {text.length.toLocaleString()} / {MAX_FEEDBACK_CHARS.toLocaleString()}
            </span>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting || tooLong}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Analyzing...' : 'Analyze sentiment'}
        </button>
      </form>

      {submitting && (
        <div className="space-y-1">
          <p className="text-sm text-gray-600">The AI is analyzing this feedback. This usually takes a few seconds.</p>
          <ProgressBar percent={null} label="Sentiment analysis in progress" />
        </div>
      )}

      {apiError && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {apiError}
        </p>
      )}

      {latest && !submitting && <LatestResult result={latest} />}
    </div>
  );
}

function HistoryItem({ result, showOwner }: { result: SentimentResult; showOwner: boolean }) {
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <SentimentBadge sentiment={result.sentiment} />
        <span className="text-sm text-gray-600">{formatConfidence(result.confidence)}</span>
        <span className="text-xs text-gray-500">
          #{result.id} · {new Date(result.createdAt).toLocaleString()}
          {showOwner && result.user && <> · {result.user.email}</>}
        </span>
      </div>
      <p className="line-clamp-2 break-words text-sm text-gray-800" title={result.inputText}>
        “{result.inputText}”
      </p>
      <p className="text-sm text-gray-600">
        <span className="font-medium">Rationale:</span> {result.rationale}
      </p>
    </li>
  );
}

export function SentimentTab() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin');
  const [version, setVersion] = useState(0);
  const history = useAsyncData(() => sentimentService.listResults(), [version]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Analyze feedback"
        description="The AI labels the feedback Positive, Neutral or Negative, with a confidence score and a short rationale. Every result is saved to your account."
      >
        <AnalyzeForm onAnalyzed={() => setVersion(v => v + 1)} />
      </SectionCard>

      <SectionCard
        title={isAdmin ? 'All users’ sentiment results' : 'Your sentiment results'}
        description={isAdmin ? 'As an admin you see every user’s results, newest first.' : 'Newest first.'}
      >
        {history.loading && !history.data && <LoadingState label="Loading results..." />}
        {history.error && <ErrorState message={history.error} onRetry={history.reload} />}
        {history.data && history.data.length === 0 && (
          <EmptyState message="No feedback has been analyzed yet. Enter some feedback above to get started." />
        )}
        {history.data && history.data.length > 0 && (
          <>
            <p className="text-sm text-gray-600">
              {history.data.length} result{history.data.length === 1 ? '' : 's'}
              {history.loading && <span className="ml-2 text-gray-500">Refreshing...</span>}
            </p>
            <ul className="divide-y divide-gray-100">
              {history.data.map(result => (
                <HistoryItem key={result.id} result={result} showOwner={isAdmin} />
              ))}
            </ul>
          </>
        )}
      </SectionCard>
    </div>
  );
}
