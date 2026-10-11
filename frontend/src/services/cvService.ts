import type { AxiosProgressEvent } from 'axios';
import apiClient from './api.js';
import type {
  BatchStatus,
  BatchSubmitResult,
  CvBatchFile,
  CvDecisionRecord,
  CvDecisionRequest,
  CvRecommendation,
} from '../types/index.js';

/** Bytes sent so far, as reported by the browser for the real request body. */
export interface UploadProgress {
  loaded: number;
  total: number | null;
}

function uploadProgressHandler(onProgress?: (progress: UploadProgress) => void) {
  return (event: AxiosProgressEvent) => onProgress?.({ loaded: event.loaded, total: event.total ?? null });
}

// Identity is never sent: every request is authorized by the session token
// that api.ts attaches, and the backend derives the user from it.
export const cvService = {
  /** Upload + classify one CV (a .txt file's text or a base64 PDF). Resolves when classification has finished. */
  async classify(
    params: { cvContent: string; fileName: string } | { pdfBase64: string; fileName: string },
    onUploadProgress?: (progress: UploadProgress) => void
  ): Promise<CvRecommendation> {
    const res = await apiClient.post<{ data: CvRecommendation }>('/cv/classify', params, {
      onUploadProgress: uploadProgressHandler(onUploadProgress),
    });
    return res.data.data;
  },

  /** Upload several CVs. Resolves once they are queued; processing continues server-side. */
  async submitBatch(
    files: CvBatchFile[],
    onUploadProgress?: (progress: UploadProgress) => void
  ): Promise<BatchSubmitResult> {
    const res = await apiClient.post<{ data: BatchSubmitResult }>('/cv/batch', { files }, {
      onUploadProgress: uploadProgressHandler(onUploadProgress),
    });
    return res.data.data;
  },

  async getBatchStatus(batchId: string): Promise<BatchStatus> {
    const res = await apiClient.get<{ data: BatchStatus }>(`/cv/batch/${encodeURIComponent(batchId)}/status`);
    return res.data.data;
  },

  /** Own results for a user, all results for an admin (enforced server-side). */
  async listResults(): Promise<CvRecommendation[]> {
    const res = await apiClient.get<{ data: CvRecommendation[] }>('/cv/results');
    return res.data.data;
  },

  /** Permanently deletes one CV document with its recommendations and decisions (owner or admin, enforced server-side). */
  async deleteDocument(documentId: number): Promise<void> {
    await apiClient.delete(`/cv/documents/${documentId}`);
  },

  async makeDecision(recommendationId: number, decision: CvDecisionRequest): Promise<CvDecisionRecord> {
    const res = await apiClient.post<{ data: CvDecisionRecord }>(`/cv/results/${recommendationId}/decision`, decision);
    return res.data.data;
  },
};
