import { useState } from 'react';
import { useAuthStore } from '../store/authStore.js';

interface NavbarProps {
  onLogout: () => Promise<void> | void;
}

export function Navbar({ onLogout }: NavbarProps) {
  const { user } = useAuthStore();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <header className="bg-blue-600 text-white shadow-lg">
      <nav aria-label="Account" className="max-w-7xl mx-auto px-4 py-3 sm:py-4 flex flex-wrap justify-between items-center gap-x-4 gap-y-2">
        <div className="text-lg sm:text-2xl font-bold">Multi-User Agent Platform</div>

        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate">{user?.email}</span>
            <span className="shrink-0 rounded bg-blue-700 px-2 py-0.5 text-xs font-semibold uppercase">{user?.role}</span>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="shrink-0 px-4 py-2 bg-blue-700 hover:bg-blue-800 rounded-md transition disabled:opacity-75"
          >
            {loggingOut ? 'Logging out...' : 'Logout'}
          </button>
        </div>
      </nav>
    </header>
  );
}
