import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { StatCard, LoadingState, ErrorState, DataAsOf, SectionCard } from './AnalyticsPrimitives.js';
import { UsageCompletenessNotice } from './UsageCompletenessNotice.js';

export function OverviewSection() {
  const summary = useAsyncData(() => analyticsService.getSummary(), []);
  const timeSaved = useAsyncData(() => analyticsService.getTimeSaved(), []);
  const completeness = useAsyncData(() => analyticsService.getUsageCompleteness(), []);

  const loading = summary.loading || timeSaved.loading || completeness.loading;
  const error = summary.error ?? timeSaved.error ?? completeness.error;
  // Until completeness is known, the totals are not labelled either way.
  const incomplete = completeness.data ? !completeness.data.complete : false;
  const tokenNote = incomplete ? 'Recorded usage only - incomplete, see below' : undefined;

  return (
    <SectionCard title="Overview" description="Token usage and cost across every LLM call, calculated server-side from llm_usage_logs.">
      {loading && <LoadingState label="Loading overview..." />}
      {!loading && error && (
        <ErrorState
          message={error}
          onRetry={() => {
            summary.reload();
            timeSaved.reload();
            completeness.reload();
          }}
        />
      )}
      {!loading && !error && summary.data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Total Input Tokens" value={summary.data.totalInputTokens.toLocaleString()} subtitle={tokenNote} />
            <StatCard title="Total Output Tokens" value={summary.data.totalOutputTokens.toLocaleString()} subtitle={tokenNote} />
            <StatCard title="Total Tokens" value={summary.data.totalTokens.toLocaleString()} subtitle={tokenNote} />
            <StatCard
              title="Estimated Cost"
              value={`$${summary.data.estimatedCost.toFixed(4)}`}
              subtitle={incomplete ? 'Known costs only - incomplete, see below' : undefined}
            />
            <StatCard
              title="Time Saved (est.)"
              value={timeSaved.data ? `${timeSaved.data.estimatedTimeSavedHours.toFixed(2)} hrs` : '—'}
              subtitle="Estimated, not measured - see methodology below"
            />
          </div>
          {completeness.data && <UsageCompletenessNotice data={completeness.data} />}
          {timeSaved.data && (
            <details className="mt-4 text-sm text-gray-600">
              <summary className="cursor-pointer font-medium text-gray-700">
                How is &quot;time saved&quot; calculated? (methodology: {timeSaved.data.methodology})
              </summary>
              <ul className="list-disc list-inside mt-2 space-y-1">
                {timeSaved.data.assumptions.map((assumption, i) => (
                  <li key={i}>{assumption}</li>
                ))}
                <li>
                  Baseline: {timeSaved.data.baselineManualReviewMinutesPerCv} min/CV (assumed) · Measured automated
                  latency: {timeSaved.data.measuredAverageAutomatedLatencyMs} ms · Completed CVs:{' '}
                  {timeSaved.data.completedCvCount}
                </li>
              </ul>
            </details>
          )}
          <DataAsOf at={new Date()} />
        </>
      )}
      {!loading && !error && summary.data && summary.data.callCount === 0 && (
        <p className="text-gray-500 italic mt-2">No LLM calls recorded yet.</p>
      )}
    </SectionCard>
  );
}
