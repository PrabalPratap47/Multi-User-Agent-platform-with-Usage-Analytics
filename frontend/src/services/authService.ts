import apiClient from './api.js';
import { LoginResponse, User } from '../types/index.js';

export const authService = {
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await apiClient.post<{ data: LoginResponse }>('/auth/login', {
      email,
      password,
    });
    return response.data.data;
  },

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const response = await apiClient.post<{ data: { accessToken: string; refreshToken: string } }>(
      '/auth/refresh',
      { refreshToken }
    );
    return response.data.data;
  },

  /**
   * Revokes the current refresh token server-side. The server identifies
   * the caller from the access token in the Authorization header (added
   * automatically by the apiClient interceptor) - this call never needs
   * to and never does send a userId.
   */
  async logout(refreshToken: string | null): Promise<void> {
    await apiClient.post('/auth/logout', refreshToken ? { refreshToken } : {});
  },

  /**
   * Fetches the caller's own profile as resolved by the server from the
   * access token. Used to validate a token restored from localStorage
   * before trusting it, and to detect role changes server-side.
   */
  async getCurrentUser(): Promise<User> {
    const response = await apiClient.get<{ data: User }>('/auth/me');
    return response.data.data;
  },
};
