import { Fragment, useState } from 'react';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { agentRunsService } from '../services/agentRunsService.js';
import { usersService } from '../services/usersService.js';
import { AgentRunStatus, AgentRunSummary } from '../types/index.js';
import { USAGE_ISSUE_TEXT } from '../utils/usageIssues.js';
import { categoryLabel } from '../utils/categoryLabels.js';
import { EmptyState, ErrorState, LoadingState, SectionCard, ScrollableTable } from './analytics/AnalyticsPrimitives.js';

const PAGE_SIZE = 25;
const STATUSES: AgentRunStatus[] = ['PENDING', 'RUNNING', 'SUCCESS', 'ERROR'];

const STATUS_STYLES: Record<AgentRunStatus, { label: string; className: string }> = {
  PENDING: { label: 'Pending', className: 'bg-amber-50 text-amber-800 border-amber-200' },
  RUNNING: { label: 'Running', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  SUCCESS: { label: 'Succeeded', className: 'bg-green-50 text-green-700 border-green-200' },
  ERROR: { label: 'Failed', className: 'bg-red-50 text-red-700 border-red-200' },
};

const SELECT_CLASS =
  'mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const PAGER_BUTTON_CLASS =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed';

function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}>{label}</span>;
}

const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function resultSummary(run: AgentRunSummary): string {
  if (run.result?.type === 'cv_recommendation') return categoryLabel(run.result.primaryCategory);
  if (run.result?.type === 'sentiment_result') return `Sentiment: ${run.result.sentiment.toLowerCase()}`;
  if (run.status === 'ERROR') return run.errorMessage ?? 'Failed (no reason recorded)';
  return '—';
}

function RunDetails({ run, id }: { run: AgentRunSummary; id: string }) {
  const rows: Array<[string, string]> = [
    ['Run ID', run.id],
    ['Started', formatTime(run.startedAt)],
    ['Completed', formatTime(run.completedAt)],
    ['Batch ID', run.batchId ?? '— (single request)'],
    ['CV document', run.cvDocumentId !== null ? `#${run.cvDocumentId}${run.cvFileName ? ` (${run.cvFileName})` : ''}` : '—'],
    ['Result', run.result ? `${run.result.type === 'cv_recommendation' ? 'CV recommendation' : 'Sentiment result'} #${run.result.id}` : '—'],
    ['AI calls logged', String(run.llmCallsLogged)],
  ];
  if (run.status === 'ERROR') rows.push(['Failure reason', run.errorMessage ?? 'No reason recorded']);
  rows.push([
    'Usage data',
    run.usageIssues.length > 0 ? `Incomplete. ${run.usageIssues.map(issue => USAGE_ISSUE_TEXT[issue]).join(' ')}` : 'Complete',
  ]);
  if (run.isSeedData) rows.push(['Data', 'Seed demo data (excluded from analytics)']);

  return (
    <dl id={id} className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm py-2">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="font-medium text-gray-600">{label}</dt>
          <dd className="text-gray-800 break-all">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function AgentRunsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<AgentRunStatus | undefined>(undefined);
  const [usage, setUsage] = useState<'incomplete' | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: page, loading, error, reload } = useAsyncData(
    () => agentRunsService.list({ userId: isAdmin ? userId : undefined, agent, status, usage, limit: PAGE_SIZE, offset }),
    [userId, agent, status, usage, offset]
  );
  // Admin-only user list for the filter; a non-admin never requests it.
  const { data: users } = useAsyncData(() => (isAdmin ? usersService.listAll() : Promise.resolve([])), [isAdmin]);

  // Every filter change starts again from the first page.
  const applyFilter = (apply: () => void) => {
    apply();
    setOffset(0);
    setExpanded(null);
  };
  const filtered = userId !== undefined || agent !== undefined || status !== undefined || usage !== undefined;
  const agentOptions = page?.agents ?? [];
  const columnCount = isAdmin ? 7 : 6;

  return (
    <SectionCard
      title={isAdmin ? 'Agent runs (all users)' : 'My agent runs'}
      description={
        isAdmin
          ? 'Every agent run from every user, newest first. Shows run metadata only - CV text, feedback text, prompts and tokens stay in their own views.'
          : 'Your own agent runs, newest first. Scoped server-side to your account - the backend never returns another user’s runs here.'
      }
    >
      <div className={`grid gap-3 mb-4 ${isAdmin ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
        {isAdmin && (
          <div>
            <label htmlFor="runs-filter-user" className="block text-sm font-medium text-gray-700">User</label>
            <select
              id="runs-filter-user"
              value={userId ?? ''}
              onChange={e => applyFilter(() => setUserId(e.target.value ? Number(e.target.value) : undefined))}
              className={SELECT_CLASS}
            >
              <option value="">All users</option>
              {(users ?? []).map(u => (
                <option key={u.id} value={u.id}>{u.email}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="runs-filter-agent" className="block text-sm font-medium text-gray-700">Agent</label>
          <select
            id="runs-filter-agent"
            value={agent ?? ''}
            onChange={e => applyFilter(() => setAgent(e.target.value || undefined))}
            className={SELECT_CLASS}
          >
            <option value="">All agents</option>
            {agentOptions.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="runs-filter-status" className="block text-sm font-medium text-gray-700">Status</label>
          <select
            id="runs-filter-status"
            value={status ?? ''}
            onChange={e => applyFilter(() => setStatus((e.target.value || undefined) as AgentRunStatus | undefined))}
            className={SELECT_CLASS}
          >
            <option value="">All statuses</option>
            {STATUSES.map(s => (
              <option key={s} value={s}>{STATUS_STYLES[s].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="runs-filter-usage" className="block text-sm font-medium text-gray-700">Usage data</label>
          <select
            id="runs-filter-usage"
            value={usage ?? ''}
            onChange={e => applyFilter(() => setUsage(e.target.value === 'incomplete' ? 'incomplete' : undefined))}
            className={SELECT_CLASS}
          >
            <option value="">All runs</option>
            <option value="incomplete">Incomplete only</option>
          </select>
        </div>
      </div>

      {loading && <LoadingState label="Loading agent runs..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && page && page.runs.length === 0 && (
        <EmptyState message={filtered ? 'No agent runs match these filters.' : 'No agent runs yet.'} />
      )}
      {!loading && !error && page && page.runs.length > 0 && (
        <>
          <ScrollableTable label="Agent runs">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th scope="col" className="py-2 pr-4 whitespace-nowrap">Created</th>
                  {isAdmin && <th scope="col" className="py-2 pr-4">User</th>}
                  <th scope="col" className="py-2 pr-4">Agent</th>
                  <th scope="col" className="py-2 pr-4">Status</th>
                  <th scope="col" className="py-2 pr-4">Source</th>
                  <th scope="col" className="py-2 pr-4">Result</th>
                  {/* `relative`: keeps the sr-only text inside the table's scroll box (it is absolutely positioned). */}
                  <th scope="col" className="py-2 relative"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {page.runs.map(run => {
                  const open = expanded === run.id;
                  const detailsId = `run-details-${run.id}`;
                  return (
                    <Fragment key={run.id}>
                      <tr className="border-b border-gray-100 align-top">
                        <td className="py-2 pr-4 whitespace-nowrap">{formatTime(run.createdAt)}</td>
                        {isAdmin && <td className="py-2 pr-4 break-all min-w-[10rem]">{run.user.email}</td>}
                        <td className="py-2 pr-4 min-w-[10rem]">{run.agentName}</td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            <RunStatusBadge status={run.status} />
                            {run.usageIssues.length > 0 && (
                              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 whitespace-nowrap">Usage incomplete</span>
                            )}
                            {run.isSeedData && (
                              <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-600 whitespace-nowrap">Demo data</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">{run.batchId ? 'Batch' : 'Single'}</td>
                        <td className={`py-2 pr-4 min-w-[12rem] ${run.status === 'ERROR' && !run.result ? 'text-red-700' : ''}`}>{resultSummary(run)}</td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : run.id)}
                            aria-expanded={open}
                            aria-controls={open ? detailsId : undefined}
                            className="relative text-sm font-medium text-blue-700 underline hover:text-blue-900 whitespace-nowrap"
                          >
                            {open ? 'Hide' : 'Details'}
                            <span className="sr-only"> for run {run.id}</span>
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-gray-100 bg-gray-50">
                          <td colSpan={columnCount} className="px-2">
                            <RunDetails run={run} id={detailsId} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </ScrollableTable>

          <nav aria-label="Agent runs pages" className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-600" aria-live="polite">
              Showing {page.offset + 1}–{page.offset + page.runs.length} of {page.total}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={PAGER_BUTTON_CLASS}
                disabled={page.offset === 0}
                onClick={() => { setOffset(Math.max(0, page.offset - PAGE_SIZE)); setExpanded(null); }}
              >
                Previous
              </button>
              <button
                type="button"
                className={PAGER_BUTTON_CLASS}
                disabled={page.offset + page.runs.length >= page.total}
                onClick={() => { setOffset(page.offset + PAGE_SIZE); setExpanded(null); }}
              >
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </SectionCard>
  );
}
