import { useState } from 'react';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { usageLogsService } from '../services/usageLogsService.js';
import { EmptyState, ErrorState, LoadingState, Pager, SectionCard, ScrollableTable } from './analytics/AnalyticsPrimitives.js';

const PAGE_SIZE = 25;

export function MyUsageLogs({ isAdmin }: { isAdmin: boolean }) {
  const [offset, setOffset] = useState(0);
  const { data: page, loading, error, reload } = useAsyncData(() => usageLogsService.getMine({ limit: PAGE_SIZE, offset }), [offset]);

  return (
    <SectionCard
      title={isAdmin ? 'Usage records (all users)' : 'My usage records'}
      description={
        isAdmin
          ? 'One row per AI call, from every user, newest first - as an admin the backend returns all records.'
          : 'One row per AI call, newest first. This list is scoped server-side to your own account - the backend never returns another user’s records here, regardless of what the client asks for.'
      }
    >
      {loading && <LoadingState label="Loading your usage logs..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && page && page.total === 0 && <EmptyState message="No usage logs yet." />}
      {!loading && !error && page && page.logs.length > 0 && (
        <>
          <ScrollableTable label="Usage records">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th scope="col" className="py-2 pr-4">Agent</th>
                  <th scope="col" className="py-2 pr-4">Model</th>
                  <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Input tokens</th>
                  <th scope="col" className="py-2 pr-4 text-right whitespace-nowrap">Output tokens</th>
                  <th scope="col" className="py-2 pr-4 text-right">Latency</th>
                  <th scope="col" className="py-2 pr-4">Status</th>
                  <th scope="col" className="py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {page.logs.map(log => (
                  <tr key={log.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4 min-w-[10rem]">{log.agent?.name ?? log.agentId}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{log.model}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{log.inputTokens}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{log.outputTokens}</td>
                    <td className="py-2 pr-4 text-right tabular-nums whitespace-nowrap">{log.latencyMs}ms</td>
                    <td className="py-2 pr-4">
                      <span className={`font-medium ${log.status === 'SUCCESS' ? 'text-green-700' : 'text-red-700'}`}>{log.status}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{log.estimatedCost ? `$${log.estimatedCost.toFixed(4)}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
          <Pager label="Usage records pages" offset={page.offset} shown={page.logs.length} total={page.total} pageSize={PAGE_SIZE} onChange={setOffset} />
        </>
      )}
    </SectionCard>
  );
}
