import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { LoadingState, ErrorState, EmptyState, DataAsOf, SectionCard, ScrollableTable } from './AnalyticsPrimitives.js';

export function CvClassificationSection() {
  const { data, loading, error, reload } = useAsyncData(() => analyticsService.getAcceptanceRates(), []);

  return (
    <SectionCard
      title="CV Classification"
      description="Recommendation acceptance rate per category, grouped by the agent's original proposed category. ACCEPT counts toward the rate; MODIFY and REJECT do not, but are shown separately."
    >
      {loading && <LoadingState label="Loading acceptance rates..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && data && data.length === 0 && (
        <EmptyState message="No classification decisions recorded yet." />
      )}
      {!loading && !error && data && data.length > 0 && (
        <>
          <ScrollableTable label="CV acceptance rates">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th scope="col" className="py-2 pr-4">Category</th>
                  <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Total Decisions</th>
                  <th scope="col" className="py-2 pr-4 text-right">Accept</th>
                  <th scope="col" className="py-2 pr-4 text-right">Modify</th>
                  <th scope="col" className="py-2 pr-4 text-right">Reject</th>
                  <th scope="col" className="py-2 text-right whitespace-nowrap">Acceptance Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.map(row => (
                  <tr key={row.category} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium min-w-[9rem] break-words">{row.category}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.totalDecisions}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-green-700">{row.accept}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-amber-700">{row.modify}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-red-700">{row.reject}</td>
                    <td className="py-2 text-right tabular-nums font-medium">{(row.acceptanceRate * 100).toFixed(1)}%</td>
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
