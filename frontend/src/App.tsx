import { useEffect, useState } from 'react';
import { useAuthStore } from './store/authStore.js';
import { authService } from './services/authService.js';
import { LoginForm } from './components/LoginForm.js';
import { Dashboard } from './components/Dashboard.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';

export function App() {
  const { isAuthenticated, accessToken, setUser, logout } = useAuthStore();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // A token restored from localStorage might be expired, revoked, or
    // simply stale (e.g. the user's role changed server-side since the
    // last login). Validate it against the server before trusting it -
    // GET /api/auth/me resolves identity purely from the token itself.
    if (!accessToken) {
      setIsReady(true);
      return;
    }

    authService
      .getCurrentUser()
      .then(user => setUser(user))
      .catch(() => logout())
      .finally(() => setIsReady(true));
    // Only re-run if the token identity changes (e.g. fresh login) -
    // not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center" role="status" aria-live="polite">
          <p className="text-xl text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {isAuthenticated ? (
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      ) : (
        <LoginForm />
      )}
    </div>
  );
}
