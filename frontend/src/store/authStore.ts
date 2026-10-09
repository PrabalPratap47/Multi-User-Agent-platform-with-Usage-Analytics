import { create } from 'zustand';
import { User } from '../types/index.js';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isHydrated: boolean;

  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  logout: () => void;

  // Restore from localStorage
  hydrate: () => void;
}

function persist(state: { user: User | null; accessToken: string | null; refreshToken: string | null }) {
  try {
    localStorage.setItem('auth', JSON.stringify(state));
  } catch {
    // localStorage can throw in private browsing / storage-blocked contexts;
    // the app still works for the current tab via in-memory Zustand state.
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isHydrated: false,

  setAuth: (user, accessToken, refreshToken) => {
    persist({ user, accessToken, refreshToken });
    set({ user, accessToken, refreshToken, isAuthenticated: true });
  },

  setTokens: (accessToken, refreshToken) => {
    const { user } = get();
    persist({ user, accessToken, refreshToken });
    set({ accessToken, refreshToken });
  },

  setUser: user => {
    const { accessToken, refreshToken } = get();
    persist({ user, accessToken, refreshToken });
    set({ user });
  },

  logout: () => {
    try {
      localStorage.removeItem('auth');
    } catch {
      // ignore - see persist()
    }
    set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  },

  hydrate: () => {
    try {
      const stored = localStorage.getItem('auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        set({
          user: parsed.user ?? null,
          accessToken: parsed.accessToken ?? null,
          refreshToken: parsed.refreshToken ?? null,
          isAuthenticated: !!parsed.user,
        });
      }
    } catch (error) {
      console.error('Failed to hydrate auth state', error);
    } finally {
      set({ isHydrated: true });
    }
  },
}));

// Hydrate on startup. This only restores whatever was in localStorage -
// App.tsx is responsible for then validating the token against
// GET /api/auth/me before treating the session as trustworthy.
useAuthStore.getState().hydrate();
