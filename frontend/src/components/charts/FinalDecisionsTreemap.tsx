import { ResponsiveContainer, Treemap } from 'recharts';
import { CV_CATEGORIES, type CvCategory, type CvRecommendation } from '../../types/index.js';
import { categoryLabel } from '../../utils/categoryLabels.js';
import { CATEGORY_COLORS } from './chartColors.js';

/**
 * Final decisions per category: each CV counts once, by its latest decision
 * (decisions arrive newest first), under its persisted final category. ACCEPT
 * counts under the accepted category, MODIFY under the chosen one; pending
 * CVs and REJECT (no final category) are not counted. Original AI
 * predictions are never used.
 */
export function finalDecisionCounts(results: CvRecommendation[]): Record<CvCategory, number> {
  const counts = Object.fromEntries(CV_CATEGORIES.map(c => [c, 0])) as Record<CvCategory, number>;
  for (const result of results) {
    const latest = result.decisions?.[0];
    const final = latest && latest.decisionType !== 'REJECT' ? latest.finalPrimaryCategory : null;
    if (final && final in counts) counts[final as CvCategory] += 1;
  }
  return counts;
}

// Recharts clones <Tile /> with each node's layout and data.
interface TileProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  depth?: number;
  label?: string;
  color?: string;
  value?: number;
}

const GAP = 3;

function fitLabel(label: string, width: number): string {
  const maxChars = Math.floor((width - 20) / 7.2);
  if (maxChars < 4) return '';
  return label.length <= maxChars ? label : `${label.slice(0, maxChars - 1)}…`;
}

/** One rounded tile with its category and count; small tiles show the count only; the legend below lists every domain with its count. */
function Tile({ x = 0, y = 0, width = 0, height = 0, depth = 0, label = '', color, value = 0 }: TileProps) {
  if (depth !== 1) return null;
  const w = Math.max(width - GAP * 2, 0);
  const h = Math.max(height - GAP * 2, 0);
  const left = x + GAP;
  const top = y + GAP;
  const name = fitLabel(label, w);
  return (
    <g>
      <rect x={left} y={top} width={w} height={h} rx={10} ry={10} fill={color} />
      {h >= 52 && name ? (
        <>
          <text x={left + 10} y={top + 22} fill="#ffffff" fontSize={13} fontWeight={600}>
            {name}
          </text>
          <text x={left + 10} y={top + 48} fill="#ffffff" fontSize={22} fontWeight={700}>
            {value}
          </text>
        </>
      ) : (
        w >= 24 &&
        h >= 22 && (
          <text x={left + w / 2} y={top + h / 2 + 5} fill="#ffffff" fontSize={14} fontWeight={700} textAnchor="middle">
            {value}
          </text>
        )
      )}
    </g>
  );
}

export function FinalDecisionsTreemap({ results }: { results: CvRecommendation[] }) {
  const counts = finalDecisionCounts(results);
  const total = CV_CATEGORIES.reduce((sum, c) => sum + counts[c], 0);
  const tiles = CV_CATEGORIES.filter(c => counts[c] > 0).map(c => ({ name: c, label: categoryLabel(c), size: counts[c], color: CATEGORY_COLORS[c] }));
  const description = CV_CATEGORIES.map(c => `${categoryLabel(c)} ${counts[c]}`).join(', ');

  return (
    <div className="space-y-4">
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-600">
          No final decisions yet. Accept or modify a recommendation below and it will appear here.
        </p>
      ) : (
        <div className="h-64 sm:h-72" role="img" aria-label={`Final decisions by domain: ${description}`}>
          <ResponsiveContainer width="100%" height="100%">
            <Treemap data={tiles} dataKey="size" nameKey="label" aspectRatio={4 / 3} isAnimationActive={false} content={<Tile />} />
          </ResponsiveContainer>
        </div>
      )}

      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3" aria-label="Final decisions per domain">
        {CV_CATEGORIES.map(c => (
          <li key={c} className="flex items-center gap-2">
            <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded ${counts[c] === 0 ? 'opacity-40' : ''}`} style={{ backgroundColor: CATEGORY_COLORS[c] }} />
            <span className={`flex-1 ${counts[c] === 0 ? 'text-gray-600' : 'text-gray-800'}`}>{categoryLabel(c)}</span>
            <span className={`tabular-nums ${counts[c] === 0 ? 'text-gray-600' : 'font-semibold text-gray-900'}`}>{counts[c]}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-600">
        {total} CV{total === 1 ? '' : 's'} with a final category. Each CV counts once, by its latest decision; pending and rejected CVs are
        not counted.
      </p>
    </div>
  );
}
