import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  tone?: 'default' | 'warning' | 'danger';
}

export function StatCard({ title, value, subtitle, tone = 'default' }: StatCardProps) {
  const toneClasses =
    tone === 'danger'
      ? 'from-red-50 to-red-100 border-red-200'
      : tone === 'warning'
        ? 'from-amber-50 to-amber-100 border-amber-200'
        : 'from-blue-50 to-blue-100 border-blue-200';

  return (
    <div className={`bg-gradient-to-br ${toneClasses} rounded-lg p-4 border`}>
      <p className="text-gray-600 text-sm font-medium">{title}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1 break-words">{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-gray-500 py-6">
      <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
      <p className="font-medium">Couldn&apos;t load this data</p>
      <p className="text-sm mt-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 text-sm font-medium text-red-700 underline hover:text-red-900"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Wide tables scroll inside their card instead of widening the page. When the
 * table really is wider than the card, the wrapper becomes a focusable, named
 * region (so keyboard users can scroll it) and says that it scrolls.
 */
export function ScrollableTable({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div>
      <div
        ref={ref}
        className="overflow-x-auto"
        {...(overflowing ? { role: 'region', 'aria-label': `${label} (scrolls sideways)`, tabIndex: 0 } : {})}
      >
        {children}
      </div>
      {overflowing && <p className="mt-1 text-xs text-gray-500">Scroll sideways to see every column.</p>}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="text-gray-500 italic py-6 text-center">{message}</p>;
}

/** Honest freshness label - this is the moment the BROWSER fetched the data, not a server-generated timestamp. */
export function DataAsOf({ at }: { at: Date }) {
  return (
    <p className="text-xs text-gray-500 mt-2">
      Data as of {at.toLocaleString()} (your local time, refreshed on page load)
    </p>
  );
}

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="bg-white shadow rounded-lg p-4 sm:p-6">
      <h2 id={headingId} className="text-lg font-bold text-gray-800">{title}</h2>
      {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}
