import axios from 'axios';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/authStore.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const apiClient = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach the current access token to every request. This is the ONLY
// place the frontend injects identity - it is never read from a form
// field or hardcoded, only from the token issued at login.
apiClient.interceptors.request.use(config => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

let refreshPromise: Promise<string> | null = null;

async function performRefresh(): Promise<string> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  // Deliberately a raw axios call (not apiClient) so it can't recurse
  // back into this same response interceptor.
  const response = await axios.post<{ data: { accessToken: string; refreshToken: string } }>(
    `${API_URL}/api/auth/refresh`,
    { refreshToken }
  );

  const { accessToken, refreshToken: newRefreshToken } = response.data.data;
  useAuthStore.getState().setTokens(accessToken, newRefreshToken);
  return accessToken;
}

// On a 401, try exactly once to refresh the access token and replay the
// original request. If that fails too (refresh token also invalid/expired/
// revoked), the session is genuinely over - log out and send the user to
// the login screen.
apiClient.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableConfig | undefined;
    const url = originalRequest?.url || '';
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh');

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;

      try {
        refreshPromise = refreshPromise || performRefresh();
        const newAccessToken = await refreshPromise;
        refreshPromise = null;

        originalRequest.headers = originalRequest.headers ?? {};
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch {
        refreshPromise = null;
        useAuthStore.getState().logout();
        window.location.href = '/';
        return Promise.reject(error);
      }
    }

    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/';
    }

    return Promise.reject(error);
  }
);

export default apiClient;
