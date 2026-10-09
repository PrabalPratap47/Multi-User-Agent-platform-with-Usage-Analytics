import apiClient from './api.js';
import { AgentRunFilters, AgentRunPage } from '../types/index.js';

export const agentRunsService = {
  /**
   * The server scopes this to the caller's own runs unless the caller is
   * an admin; `userId` only narrows an admin's view and is ignored for
   * everyone else. No client-side filtering happens here.
   */
  async list(filters: AgentRunFilters): Promise<AgentRunPage> {
    const response = await apiClient.get<{ data: AgentRunPage }>('/runs', { params: filters });
    return response.data.data;
  },
};
