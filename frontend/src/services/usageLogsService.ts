import apiClient from './api.js';
import { UsageLogRecord } from '../types/index.js';

export const usageLogsService = {
  /**
   * The server scopes this to the caller's own records unless the caller
   * is an admin - there is no client-side filtering happening here.
   */
  async getMine(): Promise<UsageLogRecord[]> {
    const response = await apiClient.get<{ data: UsageLogRecord[] }>('/usage-logs');
    return response.data.data;
  },

  /**
   * Admin-only (or self). A non-admin requesting another user's id gets
   * a 403 from the server.
   */
  async getByUserId(userId: number): Promise<UsageLogRecord[]> {
    const response = await apiClient.get<{ data: UsageLogRecord[] }>(`/usage-logs/${userId}`);
    return response.data.data;
  },
};
