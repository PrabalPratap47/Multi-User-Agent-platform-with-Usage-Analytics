import { useEffect, useState, useCallback } from 'react';
import { apiErrorMessage } from '../utils/apiError.js';

export interface AsyncDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Generic fetch-on-mount hook used throughout the analytics dashboard -
 * every section needs the same {loading, error, data} handling, so it's
 * centralized here rather than repeated per section.
 */
export function useAsyncData<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken(token => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcher()
      .then(result => {
        if (!cancelled) setData(result);
      })
      .catch(err => {
        if (cancelled) return;
        if (err?.response?.status === 403) {
          setError('Forbidden: you do not have access to this data.');
        } else {
          // Server message when there is one; a readable "could not reach the server" otherwise.
          setError(apiErrorMessage(err, 'Failed to load data.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, ...deps]);

  return { data, loading, error, reload };
}
