import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

function percentOf(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
}

/**
 * Doughnut chart with the total in the middle and a legend listing every
 * segment's count and percentage (zero segments stay in the legend). The
 * caller handles the empty case; counts come from the caller as-is.
 */
export function DonutChart({ segments, totalLabel, label }: { segments: DonutSegment[]; totalLabel: string; label: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const drawn = segments.filter(s => s.value > 0);
  const description = segments.map(s => `${s.label} ${s.value} (${percentOf(s.value, total)})`).join(', ');

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-10">
      <div className="relative h-44 w-44 shrink-0" role="img" aria-label={`${label}: ${description}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={drawn}
              dataKey="value"
              nameKey="label"
              innerRadius="64%"
              outerRadius="100%"
              paddingAngle={drawn.length > 1 ? 2 : 0}
              cornerRadius={4}
              stroke="none"
              isAnimationActive={false}
            >
              {drawn.map(s => (
                <Cell key={s.key} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                const item = active ? payload?.[0]?.payload : undefined;
                if (!item) return null;
                return (
                  <div className="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                    {item.label}: {item.value} ({percentOf(item.value, total)})
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums text-gray-900">{total}</span>
          <span className="text-xs text-gray-600">{totalLabel}</span>
        </div>
      </div>
      <ul className="w-full max-w-xs space-y-2 text-sm" aria-label={`${label} legend`}>
        {segments.map(s => (
          <li key={s.key} className="flex items-center gap-3">
            <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="flex-1 text-gray-800">{s.label}</span>
            <span className="font-semibold tabular-nums text-gray-900">{s.value}</span>
            <span className="w-14 text-right tabular-nums text-gray-600">{percentOf(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
