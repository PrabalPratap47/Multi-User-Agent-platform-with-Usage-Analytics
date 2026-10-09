import { useAsyncData } from '../../hooks/useAsyncData.js';
import { analyticsService } from '../../services/analyticsService.js';
import { StatCard, LoadingState, ErrorState, DataAsOf, SectionCard } from './AnalyticsPrimitives.js';

export function AgentUsageSection() {
  const { data, loading, error, reload } = useAsyncData(() => analyticsService.getRunCounts(), []);

  return (
    <SectionCard title="Agent Usage" description="Number of agent runs started in each time window (windows overlap - a run from today counts toward all three), and all-time runs by final status.">
      {loading && <LoadingState label="Loading agent usage..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard title="Last 24 Hours" value={data.last24h.toLocaleString()} />
            <StatCard title="Last 7 Days" value={data.last7d.toLocaleString()} />
            <StatCard title="Last 30 Days" value={data.last30d.toLocaleString()} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <StatCard title="Successful Runs" value={data.successful.toLocaleString()} subtitle="All time - run completed with status SUCCESS" />
            <StatCard
              title="Failed Runs"
              value={data.failed.toLocaleString()}
              subtitle="All time - run ended with status ERROR"
              tone={data.failed > 0 ? 'danger' : 'default'}
            />
          </div>
          {data.last30d === 0 && <p className="text-gray-500 italic mt-3">No agent runs in the last 30 days.</p>}
          <DataAsOf at={new Date()} />
        </>
      )}
    </SectionCard>
  );
}
