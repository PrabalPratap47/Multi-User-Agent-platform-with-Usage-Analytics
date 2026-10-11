import apiClient from './api.js';
import { CreateUserRequest, UserSummary } from '../types/index.js';

export const usersService = {
  /**
   * Admin-only. Returns 403 for a non-admin caller - enforced server-side,
   * this call just surfaces whatever the server decides.
   */
  async listAll(): Promise<UserSummary[]> {
    const response = await apiClient.get<{ data: UserSummary[] }>('/users');
    return response.data.data;
  },

  /** Admin-only (enforced server-side): create an account. */
  async create(user: CreateUserRequest): Promise<UserSummary> {
    const response = await apiClient.post<{ data: UserSummary }>('/users', user);
    return response.data.data;
  },

  /** Admin-only (enforced server-side): set a new password; the account's other sessions are signed out. */
  async changePassword(id: number, password: string): Promise<{ id: number; sessionsSignedOut: number }> {
    const response = await apiClient.put<{ data: { id: number; sessionsSignedOut: number } }>(`/users/${id}/password`, { password });
    return response.data.data;
  },

  /** Admin-only (enforced server-side): delete (deactivate) an account. */
  async remove(id: number): Promise<UserSummary> {
    const response = await apiClient.delete<{ data: UserSummary }>(`/users/${id}`);
    return response.data.data;
  },
};
