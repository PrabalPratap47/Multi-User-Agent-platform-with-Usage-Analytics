import { Fragment, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useAsyncData } from '../../hooks/useAsyncData.js';
import { externalAgentLogsService, detectFormatFromFileName } from '../../services/externalAgentLogsService.js';
import { useAuthStore } from '../../store/authStore.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { StatCard, LoadingState, ErrorState, EmptyState, DataAsOf, SectionCard, ScrollableTable } from './AnalyticsPrimitives.js';
import type { ImportedLog } from '../../types/index.js';

export function ExternalAgentLogsTab() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const stats = useAsyncData(() => externalAgentLogsService.getStats(), []);
  const imports = useAsyncData(() => externalAgentLogsService.listLogs(), []);

  const reloadAll = () => {
    stats.reload();
    imports.reload();
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="External Agent Logs"
        description={
          (isAdmin
            ? 'Aggregated across every imported file, from all users. '
            : 'Aggregated across your imported files. ') +
          'Computed entirely from imported records - this never includes, and never affects, this platform\'s own internal usage metrics.'
        }
      >
        {stats.loading && <LoadingState label="Loading stats..." />}
        {!stats.loading && stats.error && <ErrorState message={stats.error} onRetry={stats.reload} />}
        {!stats.loading && !stats.error && stats.data && stats.data.totalRecords === 0 && (
          <EmptyState message="No external agent logs have been imported yet. Use the form below to import one." />
        )}
        {!stats.loading && !stats.error && stats.data && stats.data.totalRecords > 0 && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatCard title="Total Records" value={stats.data.totalRecords.toLocaleString()} />
              <StatCard title="Input Tokens" value={stats.data.totalInputTokens.toLocaleString()} />
              <StatCard title="Output Tokens" value={stats.data.totalOutputTokens.toLocaleString()} />
              <StatCard title="Cost" value={`$${stats.data.estimatedCost.toFixed(4)}`} />
              <StatCard title="Runs" value={stats.data.runs.toLocaleString()} />
              <StatCard
                title="Errors"
                value={stats.data.errors.toLocaleString()}
                tone={stats.data.errors > 0 ? 'danger' : 'default'}
              />
            </div>
            <StatCard title="Average Latency" value={`${stats.data.averageLatencyMs} ms`} />

            {stats.data.byAgent.length > 0 && (
              <div className="mt-6">
                <h3 className="font-semibold text-gray-700 mb-2">Per-Agent Breakdown</h3>
                <ScrollableTable label="External logs per agent">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-200 text-gray-600">
                        <th scope="col" className="py-2 pr-4">Agent</th>
                        <th scope="col" className="py-2 pr-4 text-right">Records</th>
                        <th scope="col" className="py-2 pr-4 text-right">Input</th>
                        <th scope="col" className="py-2 pr-4 text-right">Output</th>
                        <th scope="col" className="py-2 pr-4 text-right">Cost</th>
                        <th scope="col" className="py-2 pr-4 text-right">Errors</th>
                        <th scope="col" className="py-2 text-right whitespace-nowrap">Avg Latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.data.byAgent.map(row => (
                        <tr key={row.agentName} className="border-b border-gray-100">
                          <td className="py-2 pr-4 font-medium min-w-[10rem] break-words">{row.agentName}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.records}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.totalInputTokens.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.totalOutputTokens.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">${row.estimatedCost.toFixed(4)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{row.errors}</td>
                          <td className="py-2 text-right tabular-nums whitespace-nowrap">{row.averageLatencyMs} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollableTable>
              </div>
            )}
            <DataAsOf at={new Date()} />
          </>
        )}
      </SectionCard>

      <SectionCard title="Import History" description="Each row is one uploaded file.">
        {imports.loading && <LoadingState label="Loading import history..." />}
        {!imports.loading && imports.error && <ErrorState message={imports.error} onRetry={imports.reload} />}
        {!imports.loading && !imports.error && imports.data && imports.data.length === 0 && (
          <EmptyState message="No files imported yet." />
        )}
        {!imports.loading && !imports.error && imports.data && imports.data.length > 0 && (
          <ImportHistoryTable imports={imports.data} />
        )}
      </SectionCard>

      <ImportLogForm onImported={reloadAll} />
    </div>
  );
}

function ImportHistoryTable({ imports }: { imports: ImportedLog[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <ScrollableTable label="Import history">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-gray-200 text-gray-600">
            <th scope="col" className="py-2 pr-4 whitespace-nowrap">Source Agent</th>
            <th scope="col" className="py-2 pr-4">File</th>
            <th scope="col" className="py-2 pr-4">Format</th>
            <th scope="col" className="py-2 pr-4 whitespace-nowrap">Valid / Total</th>
            <th scope="col" className="py-2 pr-4">Imported</th>
            <th scope="col" className="py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {imports.map(log => (
            <Fragment key={log.id}>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-4 font-medium min-w-[9rem] break-words">{log.sourceAgentName}</td>
                <td className="py-2 pr-4 break-all">{log.fileName}</td>
                <td className="py-2 pr-4 uppercase text-xs">{log.fileFormat}</td>
                <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                  {log.validRecords} / {log.totalRecords}
                  {log.invalidRecords > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      aria-expanded={expandedId === log.id}
                      className="ml-2 text-red-700 underline text-xs"
                    >
                      {log.invalidRecords} error{log.invalidRecords === 1 ? '' : 's'}
                    </button>
                  )}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">{new Date(log.importTimestamp).toLocaleString()}</td>
                <td className="py-2 text-gray-500">{log.notes ?? '—'}</td>
              </tr>
              {expandedId === log.id && log.parseErrors.length > 0 && (
                <tr className="bg-red-50">
                  <td colSpan={6} className="py-2 px-4">
                    <p className="font-medium text-red-700 mb-1">Rejected records:</p>
                    <ul className="list-disc list-inside text-red-700 space-y-0.5">
                      {log.parseErrors.map((err, i) => (
                        <li key={i}>
                          {err.index === -1 ? 'File' : `Record ${err.index + 1}`}: {err.reason}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  );
}

function ImportLogForm({ onImported }: { onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sourceAgentName, setSourceAgentName] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setLastResult(null);

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setFormError('Choose a .json or .jsonl file first.');
      return;
    }

    setSubmitting(true);
    try {
      const content = await file.text();
      const format = detectFormatFromFileName(file.name);

      const result = await externalAgentLogsService.importLog({
        sourceAgentName,
        fileName: file.name,
        format,
        content,
        notes: notes || undefined,
      });

      setLastResult(
        `Imported ${result.validRecords} of ${result.totalRecords} record(s)` +
          (result.invalidRecords > 0 ? ` - ${result.invalidRecords} rejected (see Import History below).` : '.')
      );
      setSourceAgentName('');
      setNotes('');
      setSelectedFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onImported();
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Failed to import log file.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SectionCard
      title="Import a Log File"
      description="Upload a .json (array of records) or .jsonl (one record per line) file. See docs/EXTERNAL_LOG_FORMAT.md for the full format."
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        {formError && <ErrorState message={formError} />}
        {lastResult && <p role="status" className="text-green-800 bg-green-50 border border-green-200 rounded p-2 text-sm">{lastResult}</p>}

        <div>
          <label htmlFor="import-source-agent" className="block text-sm font-medium text-gray-700 mb-1">Source agent name</label>
          <input
            id="import-source-agent"
            value={sourceAgentName}
            onChange={e => setSourceAgentName(e.target.value)}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Legacy Screening Bot"
          />
        </div>

        <div>
          <label htmlFor="import-log-file" className="block text-sm font-medium text-gray-700 mb-1">Log file (.json or .jsonl)</label>
          <input
            id="import-log-file"
            ref={fileInputRef}
            type="file"
            accept=".json,.jsonl,application/json"
            onChange={e => setSelectedFileName(e.target.files?.[0]?.name ?? null)}
            required
            disabled={submitting}
            className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
          />
          {selectedFileName && (
            <p className="text-xs text-gray-500 mt-1">
              Selected: {selectedFileName} (detected format:{' '}
              {detectFormatFromFileName(selectedFileName).toUpperCase()})
            </p>
          )}
        </div>

        <div>
          <label htmlFor="import-notes" className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
          <input
            id="import-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-md disabled:opacity-50"
        >
          {submitting ? 'Importing...' : 'Import'}
        </button>
      </form>
    </SectionCard>
  );
}
