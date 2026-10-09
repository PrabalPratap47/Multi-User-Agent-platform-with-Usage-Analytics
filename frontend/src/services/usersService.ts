import apiClient from './api.js';
import { UserSummary } from '../types/index.js';

export const usersService = {
  /**
   * Admin-only. Returns 403 for a non-admin caller - enforced server-side,
   * this call just surfaces whatever the server decides.
   */
  async listAll(): Promise<UserSummary[]> {
    const response = await apiClient.get<{ data: UserSummary[] }>('/users');
    return response.data.data;
  },
};
