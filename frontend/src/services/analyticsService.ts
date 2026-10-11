import apiClient from './api.js';
import {
  TokenSummary,
  TokensByUser,
  TokensByAgent,
  AgentRunCounts,
  AgentErrorRate,
  AgentLatency,
  CategoryAcceptanceRate,
  FinalCategoryBreakdown,
  TimeSavedEstimate,
  UsageCompleteness,
} from '../types/index.js';

/**
 * Thin wrapper over the backend analytics API - every number here is
 * calculated server-side (see backend/src/services/analyticsService.ts
 * and docs/ANALYTICS_API.md). This file does no arithmetic of its own;
 * it only calls the endpoint and returns the typed response.
 */
export const analyticsService = {
  async getSummary(): Promise<TokenSummary> {
    const res = await apiClient.get<{ data: TokenSummary }>('/analytics/summary');
    return res.data.data;
  },

  /** Admin-only on the backend - the caller should only invoke this for an admin user. */
  async getByUser(): Promise<TokensByUser[]> {
    const res = await apiClient.get<{ data: TokensByUser[] }>('/analytics/by-user');
    return res.data.data;
  },

  async getByAgent(): Promise<TokensByAgent[]> {
    const res = await apiClient.get<{ data: TokensByAgent[] }>('/analytics/by-agent');
    return res.data.data;
  },

  async getRunCounts(): Promise<AgentRunCounts> {
    const res = await apiClient.get<{ data: AgentRunCounts }>('/analytics/runs');
    return res.data.data;
  },

  async getErrorRates(): Promise<AgentErrorRate[]> {
    const res = await apiClient.get<{ data: AgentErrorRate[] }>('/analytics/errors');
    return res.data.data;
  },

  async getLatencies(): Promise<AgentLatency[]> {
    const res = await apiClient.get<{ data: AgentLatency[] }>('/analytics/latency');
    return res.data.data;
  },

  async getAcceptanceRates(): Promise<CategoryAcceptanceRate[]> {
    const res = await apiClient.get<{ data: CategoryAcceptanceRate[] }>('/analytics/acceptance-rate');
    return res.data.data;
  },

  /** Original AI recommendation vs final category, by each CV's latest decision. */
  async getFinalCategories(): Promise<FinalCategoryBreakdown> {
    const res = await apiClient.get<{ data: FinalCategoryBreakdown }>('/analytics/final-categories');
    return res.data.data;
  },

  async getTimeSaved(): Promise<TimeSavedEstimate> {
    const res = await apiClient.get<{ data: TimeSavedEstimate }>('/analytics/time-saved');
    return res.data.data;
  },

  /** Where the token/cost totals are incomplete (own scope; all users for an admin). */
  async getUsageCompleteness(): Promise<UsageCompleteness> {
    const res = await apiClient.get<{ data: UsageCompleteness }>('/analytics/usage-completeness');
    return res.data.data;
  },
};
