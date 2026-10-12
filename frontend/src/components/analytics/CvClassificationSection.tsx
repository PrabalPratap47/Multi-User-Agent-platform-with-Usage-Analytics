import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { categoryLabel } from '../../utils/categoryLabels.js';
import { DonutChart } from '../charts/DonutChart.js';
import { DECISION_COLORS } from '../charts/chartColors.js';
import { LoadingState, ErrorState, EmptyState, DataAsOf, SectionCard, ScrollableTable } from './AnalyticsPrimitives.js';

/**
 * Accepted / modified / rejected, counted once per reviewed CV by its
 * latest decision (all numbers come from the backend).
 */
export function DecisionOutcomesSection() {
  const { data, loading, error, reload } = useAsyncData(() => analyticsService.getFinalCategories(), []);

  return (
    <SectionCard title="Decision outcomes" description="Latest decision per reviewed CV. Pending CVs are not counted.">
      {loading && <LoadingState label="Loading decision outcomes..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && data && data.decidedCvCount === 0 && <EmptyState message="No CVs have been reviewed yet." />}
      {!loading && !error && data && data.decidedCvCount > 0 && (
        <DonutChart
          label="Decision outcomes"
          totalLabel={data.decidedCvCount === 1 ? 'reviewed CV' : 'reviewed CVs'}
          segments={[
            { key: 'ACCEPT', label: 'Accepted', value: data.acceptedCount, color: DECISION_COLORS.ACCEPT },
            { key: 'MODIFY', label: 'Modified', value: data.modifiedCount, color: DECISION_COLORS.MODIFY },
            { key: 'REJECT', label: 'Rejected', value: data.rejectedCount, color: DECISION_COLORS.REJECT },
          ]}
        />
      )}
    </SectionCard>
  );
}

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
                    <td className="py-2 pr-4 font-medium min-w-[9rem] break-words">{categoryLabel(row.category)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.totalDecisions}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-green-700">{row.accept}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-indigo-700">{row.modify}</td>
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
