import apiClient from './api.js';
import { ImportedLog, ExternalAgentStats, ExternalLogFileFormat } from '../types/index.js';

export const externalAgentLogsService = {
  /** Own imports for a user, all imports for an admin (enforced server-side). */
  async listLogs(): Promise<ImportedLog[]> {
    const res = await apiClient.get<{ data: ImportedLog[] }>('/import/logs');
    return res.data.data;
  },

  async getStats(): Promise<ExternalAgentStats> {
    const res = await apiClient.get<{ data: ExternalAgentStats }>('/import/stats');
    return res.data.data;
  },

  async importLog(params: {
    sourceAgentName: string;
    fileName: string;
    format: ExternalLogFileFormat;
    content: string;
    notes?: string;
  }): Promise<ImportedLog> {
    const res = await apiClient.post<{ data: ImportedLog }>('/import/logs', params);
    return res.data.data;
  },
};

/** .jsonl -> 'jsonl', anything else -> 'json' (matches the backend's two supported formats). */
export function detectFormatFromFileName(fileName: string): ExternalLogFileFormat {
  return fileName.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'json';
}
