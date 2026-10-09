import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { LoadingState, ErrorState, EmptyState, DataAsOf, SectionCard, ScrollableTable } from './AnalyticsPrimitives.js';

export function PerformanceSection() {
  const errors = useAsyncData(() => analyticsService.getErrorRates(), []);
  const latency = useAsyncData(() => analyticsService.getLatencies(), []);

  const loading = errors.loading || latency.loading;
  const error = errors.error ?? latency.error;

  // Merge the two by agentId so each row shows both metrics together.
  const merged =
    errors.data && latency.data
      ? errors.data.map(e => {
          const latencyRow = latency.data!.find(l => l.agentId === e.agentId);
          return {
            agentId: e.agentId,
            agentName: e.agentName,
            totalCalls: e.totalCalls,
            errorCalls: e.errorCalls,
            errorRate: e.errorRate,
            averageLatencyMs: latencyRow?.averageLatencyMs ?? null,
          };
        })
      : null;

  return (
    <SectionCard title="Performance" description="Error rate and average latency per agent, from llm_usage_logs.">
      {loading && <LoadingState label="Loading performance metrics..." />}
      {!loading && error && (
        <ErrorState
          message={error}
          onRetry={() => {
            errors.reload();
            latency.reload();
          }}
        />
      )}
      {!loading && !error && merged && merged.length === 0 && (
        <EmptyState message="No agent calls recorded yet." />
      )}
      {!loading && !error && merged && merged.length > 0 && (
        <>
          <ScrollableTable label="Performance by agent">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th scope="col" className="py-2 pr-4">Agent</th>
                  <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Total Calls</th>
                  <th scope="col" className="py-2 pr-4 text-right">Errors</th>
                  <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Error Rate</th>
                  <th scope="col" className="py-2 text-right whitespace-nowrap">Avg Latency</th>
                </tr>
              </thead>
              <tbody>
                {merged.map(row => (
                  <tr key={row.agentId} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium min-w-[10rem] break-words">{row.agentName}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.totalCalls.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.errorCalls.toLocaleString()}</td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${row.errorRate > 0.1 ? 'text-red-700 font-semibold' : ''}`}>
                      {(row.errorRate * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{row.averageLatencyMs !== null ? `${row.averageLatencyMs} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
          <DataAsOf at={new Date()} />
        </>
      )}
    </SectionCard>
  );
}
