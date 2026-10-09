import { useCallback } from 'react';

/**
 * Simple navigation hook using window.location
 * For a real app, you'd use React Router
 */
export function useNavigate() {
  return useCallback((path: string) => {
    window.location.href = path;
  }, []);
}
