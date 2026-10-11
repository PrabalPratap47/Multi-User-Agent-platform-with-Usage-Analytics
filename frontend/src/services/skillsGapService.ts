import apiClient from './api.js';
import type { SkillsGapAnalysis, SkillsGapRole, SkillsGapRoleInfo } from '../types/index.js';

// Identity is never sent: the backend attributes the analysis to the session's user.
export const skillsGapService = {
  async getRoles(): Promise<SkillsGapRoleInfo[]> {
    const res = await apiClient.get<{ data: SkillsGapRoleInfo[] }>('/skills-gap/roles');
    return res.data.data;
  },

  /** Analyze one CV (a .txt file's text or a base64 PDF) for a target role. Resolves when the analysis is saved. */
  async analyze(params: { targetRole: SkillsGapRole; fileName: string } & ({ cvContent: string } | { pdfBase64: string })): Promise<SkillsGapAnalysis> {
    const res = await apiClient.post<{ data: SkillsGapAnalysis }>('/skills-gap/analyze', params);
    return res.data.data;
  },

  /** Permanently deletes one saved analysis (admin only, enforced server-side). */
  async remove(id: number): Promise<void> {
    await apiClient.delete(`/skills-gap/analyses/${id}`);
  },

  /** Own analyses for a user, every user's for an admin (enforced server-side). */
  async list(): Promise<SkillsGapAnalysis[]> {
    const res = await apiClient.get<{ data: SkillsGapAnalysis[] }>('/skills-gap/analyses');
    return res.data.data;
  },
};
