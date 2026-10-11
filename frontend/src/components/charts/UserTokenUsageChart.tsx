import { Bar, BarChart, CartesianGrid, Label, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TokensByUser, UserSummary } from '../../types/index.js';

interface Row {
  userId: number;
  email: string;
  label: string;
  input: number;
  output: number;
  total: number;
  unknownUsageCalls: number;
}

const shortLabel = (email: string) => (email.length > 24 ? `${email.slice(0, 23)}…` : email);

/**
 * Total tokens per user (input + output, summed server-side from internal
 * llm_usage_logs by user id). Every user gets a bar - users without any
 * recorded usage show 0. Numbers are as recorded: calls without provider
 * usage are counted as 0 and flagged, never estimated.
 */
export function UserTokenUsageChart({ users, usage }: { users: UserSummary[]; usage: TokensByUser[] }) {
  const byId = new Map(usage.map(u => [u.userId, u]));
  const rows: Row[] = users
    .map(u => {
      const used = byId.get(u.id);
      return {
        userId: u.id,
        email: u.email,
        label: shortLabel(u.email),
        input: used?.totalInputTokens ?? 0,
        output: used?.totalOutputTokens ?? 0,
        total: used?.totalTokens ?? 0,
        unknownUsageCalls: used?.callsWithUnknownUsage ?? 0,
      };
    })
    .sort((a, b) => b.total - a.total || a.userId - b.userId);
  const unknownCalls = rows.reduce((sum, r) => sum + r.unknownUsageCalls, 0);
  const description = rows.map(r => `${r.email}: ${r.total} tokens (${r.input} input, ${r.output} output)`).join('; ');

  return (
    <div className="space-y-2">
      <div style={{ height: Math.max(180, rows.length * 44 + 70) }} role="img" aria-label={`Total token usage per user: ${description}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, bottom: 28, left: 8 }}>
            <CartesianGrid horizontal={false} stroke="#e5e7eb" />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: '#4b5563' }} tickFormatter={(v: number) => v.toLocaleString()}>
              <Label value="Total tokens (input + output)" position="insideBottom" offset={-18} style={{ fontSize: 12, fill: '#374151' }} />
            </XAxis>
            <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 12, fill: '#374151' }} interval={0} />
            <Tooltip
              cursor={{ fill: '#eff6ff' }}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as Row | undefined) : undefined;
                if (!row) return null;
                return (
                  <div className="rounded-md bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">
                    <p className="font-semibold">{row.email}</p>
                    <p>Input tokens: {row.input.toLocaleString()}</p>
                    <p>Output tokens: {row.output.toLocaleString()}</p>
                    <p>Total tokens: {row.total.toLocaleString()}</p>
                    {row.unknownUsageCalls > 0 && <p className="mt-1 text-amber-300">{row.unknownUsageCalls} call(s) without usage data, counted as 0</p>}
                  </div>
                );
              }}
            />
            <Bar dataKey="total" name="Total tokens" fill="#2563eb" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              <LabelList dataKey="total" position="right" formatter={(v: number) => v.toLocaleString()} style={{ fontSize: 12, fill: '#111827' }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-gray-600">
        Recorded provider usage of every internal AI call (CV Classification, Sentiment Analysis, Skills Gap Analysis), grouped by user id. Demo
        seed data and imported external agent logs are not included.
        {unknownCalls > 0 && ` ${unknownCalls} call(s) had no usage data from the provider and are counted as 0.`}
      </p>
    </div>
  );
}
