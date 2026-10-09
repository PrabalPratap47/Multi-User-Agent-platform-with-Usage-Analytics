import { UsageCompleteness } from '../../types/index.js';
import { ScrollableTable } from './AnalyticsPrimitives.js';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Says whether the token/cost totals above are complete. Every number comes
 * from GET /api/analytics/usage-completeness; nothing is estimated here.
 */
export function UsageCompletenessNotice({ data }: { data: UsageCompleteness }) {
  if (data.complete) {
    return (
      <p className="text-sm text-gray-600 mt-3">
        Usage data complete: every recorded AI call has provider token counts and a known price, and no run is missing its usage log.
      </p>
    );
  }

  const items: string[] = [];
  if (data.callsWithUnknownUsage > 0) {
    items.push(`${plural(data.callsWithUnknownUsage, 'AI call', 'AI calls')} without provider token counts: counted as 0 tokens and $0, real usage unknown.`);
  }
  if (data.callsWithUnknownCost > 0) {
    items.push(`${plural(data.callsWithUnknownCost, 'AI call', 'AI calls')} on a model without a configured price: tokens counted, cost missing from Estimated Cost.`);
  }
  if (data.successfulRunsWithoutUsageLog > 0) {
    items.push(`${plural(data.successfulRunsWithoutUsageLog, 'successful run', 'successful runs')} whose usage log could not be saved: their AI calls are missing from every total.`);
  }
  if (data.interruptedRuns > 0) {
    items.push(`${plural(data.interruptedRuns, 'run', 'runs')} interrupted by a backend restart: an AI call may have been cut off, usage unknown.`);
  }

  return (
    <div role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">Totals are incomplete: they include only the usage that was recorded.</p>
      <ul className="list-disc list-inside mt-2 space-y-1">
        {items.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2">
        {plural(data.affectedRuns, 'run is', 'runs are')} affected. To see them, open <strong>AGENT RUNS</strong> and set <strong>Usage data</strong> to <strong>Incomplete only</strong>.
      </p>
      {data.byUser && data.byUser.length > 0 && (
        <div className="mt-3">
          <ScrollableTable label="Incomplete usage by user">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-amber-300">
                  <th scope="col" className="py-1 pr-4">User</th>
                  <th scope="col" className="py-1 pr-4 text-right whitespace-nowrap">Unknown usage</th>
                  <th scope="col" className="py-1 pr-4 text-right whitespace-nowrap">Unknown cost</th>
                  <th scope="col" className="py-1 pr-4 text-right whitespace-nowrap">No usage log</th>
                  <th scope="col" className="py-1 pr-4 text-right">Interrupted</th>
                  <th scope="col" className="py-1 text-right whitespace-nowrap">Affected runs</th>
                </tr>
              </thead>
              <tbody>
                {data.byUser.map(u => (
                  <tr key={u.userId} className="border-b border-amber-200">
                    <td className="py-1 pr-4 break-all min-w-[10rem]">{u.email}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{u.callsWithUnknownUsage}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{u.callsWithUnknownCost}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{u.successfulRunsWithoutUsageLog}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{u.interruptedRuns}</td>
                    <td className="py-1 text-right tabular-nums">{u.affectedRuns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        </div>
      )}
    </div>
  );
}
