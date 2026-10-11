import apiClient from './api.js';
import type { SentimentResult } from '../types/index.js';

// Only the feedback text is sent. The backend attributes the result to the
// user in the session token that api.ts attaches.
export const sentimentService = {
  async analyze(text: string): Promise<SentimentResult> {
    const res = await apiClient.post<{ data: SentimentResult }>('/sentiment/analyze', { text });
    return res.data.data;
  },

  /** Permanently deletes one result (owner or admin, enforced server-side). */
  async deleteResult(id: number): Promise<void> {
    await apiClient.delete(`/sentiment/results/${id}`);
  },

  /** Own results for a user, every user's results for an admin (enforced server-side). */
  async listResults(): Promise<SentimentResult[]> {
    const res = await apiClient.get<{ data: SentimentResult[] }>('/sentiment/results');
    return res.data.data;
  },
};
