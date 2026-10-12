import apiClient from './api.js';
import { UsageLogPage, UsageLogRecord } from '../types/index.js';

export const usageLogsService = {
  /**
   * One page, newest first. The server scopes this to the caller's own
   * records unless the caller is an admin - there is no client-side
   * filtering happening here.
   */
  async getMine(page: { limit: number; offset: number }): Promise<UsageLogPage> {
    const response = await apiClient.get<{ data: UsageLogRecord[]; meta: { total: number; limit: number; offset: number } }>('/usage-logs', {
      params: page,
    });
    return { logs: response.data.data, ...response.data.meta };
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
