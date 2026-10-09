import { useCallback, useState } from 'react';
import { useAuthStore } from '../store/authStore.js';
import { authService } from '../services/authService.js';
import { apiErrorMessage } from '../utils/apiError.js';

export function useAuth() {
  const { user, isAuthenticated, setAuth, logout: storeLogout, refreshToken } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        setIsLoading(true);
        setError(null);
        const result = await authService.login(email, password);
        setAuth(result.user, result.accessToken, result.refreshToken);
        return true;
      } catch (err) {
        // The server's own message ("Invalid email or password", the 429
        // lockout notice), not the HTTP client's "Request failed with status code 400".
        setError(apiErrorMessage(err, 'Login failed.'));
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [setAuth]
  );

  const logout = useCallback(async () => {
    try {
      // Revoke the refresh token server-side. The server scopes this to
      // whichever user the access token (sent automatically) identifies.
      await authService.logout(refreshToken);
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      storeLogout();
    }
  }, [storeLogout, refreshToken]);

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    login,
    logout,
  };
}
