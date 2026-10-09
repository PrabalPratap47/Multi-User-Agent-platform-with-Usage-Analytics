import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { LoadingState, ErrorState, EmptyState, DataAsOf, SectionCard, ScrollableTable } from './AnalyticsPrimitives.js';

function TokenTable({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ label: string; totalInputTokens: number; totalOutputTokens: number; estimatedCost: number; callCount: number }>;
}) {
  if (rows.length === 0) return <EmptyState message="No usage recorded yet." />;

  return (
    <ScrollableTable label={label}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-gray-200 text-gray-600">
            <th scope="col" className="py-2 pr-4">Name</th>
            <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Input Tokens</th>
            <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Output Tokens</th>
            <th scope="col" className="py-2 pr-4 text-right">Cost</th>
            <th scope="col" className="py-2 text-right">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className="border-b border-gray-100">
              <td className="py-2 pr-4 font-medium min-w-[10rem] break-words">{row.label}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{row.totalInputTokens.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{row.totalOutputTokens.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right tabular-nums">${row.estimatedCost.toFixed(4)}</td>
              <td className="py-2 text-right tabular-nums">{row.callCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  );
}

export function TokenConsumptionSection({ isAdmin }: { isAdmin: boolean }) {
  const byAgent = useAsyncData(() => analyticsService.getByAgent(), []);
  // Only fetched for an admin - a non-admin would get a 403 from the
  // backend anyway (it's admin-only there too), but there's no reason to
  // even attempt the call for a user who can never see this section.
  const byUser = useAsyncData(() => (isAdmin ? analyticsService.getByUser() : Promise.resolve([])), [isAdmin]);

  return (
    <SectionCard title="Token Consumption" description="Totals calculated server-side from llm_usage_logs, grouped by user and by agent.">
      {isAdmin && (
        <div className="mb-6">
          <h3 className="font-semibold text-gray-700 mb-2">By User (all users - admin view)</h3>
          {byUser.loading && <LoadingState label="Loading per-user breakdown..." />}
          {!byUser.loading && byUser.error && <ErrorState message={byUser.error} onRetry={byUser.reload} />}
          {!byUser.loading && !byUser.error && byUser.data && (
            <TokenTable
              label="Token consumption by user"
              rows={byUser.data.map(u => ({
                label: u.email,
                totalInputTokens: u.totalInputTokens,
                totalOutputTokens: u.totalOutputTokens,
                estimatedCost: u.estimatedCost,
                callCount: u.callCount,
              }))}
            />
          )}
        </div>
      )}

      <div>
        <h3 className="font-semibold text-gray-700 mb-2">By Agent{!isAdmin && ' (your usage only)'}</h3>
        {byAgent.loading && <LoadingState label="Loading per-agent breakdown..." />}
        {!byAgent.loading && byAgent.error && <ErrorState message={byAgent.error} onRetry={byAgent.reload} />}
        {!byAgent.loading && !byAgent.error && byAgent.data && (
          <TokenTable
            label="Token consumption by agent"
            rows={byAgent.data.map(a => ({
              label: a.agentName,
              totalInputTokens: a.totalInputTokens,
              totalOutputTokens: a.totalOutputTokens,
              estimatedCost: a.estimatedCost,
              callCount: a.callCount,
            }))}
          />
        )}
      </div>
      <DataAsOf at={new Date()} />
    </SectionCard>
  );
}
