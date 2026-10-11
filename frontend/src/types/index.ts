// Frontend types - mirror of backend types for type safety

export type Role = 'admin' | 'user';
export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface User {
  id: number;
  email: string;
  role: Role;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

// ── CV processing: mirrors backend/src/services/cv*.ts responses ──

// Same list and order as CV_CATEGORIES in backend/src/utils/validators.ts.
export const CV_CATEGORIES = [
  'PSS',
  'DCS',
  'Front-End Developer',
  'Back-End Developer',
  'Web Automation',
  'Mobile Automation',
  'AI Engineer',
  'Chatbot Application Tester',
  'Other',
] as const;
export type CvCategory = (typeof CV_CATEGORIES)[number];

export type DecisionType = 'ACCEPT' | 'MODIFY' | 'REJECT';

export interface CvRationaleEntry {
  category: string;
  /** A quote/paraphrase from the CV supporting this category. */
  evidence: string;
}

export interface CvDecisionRecord {
  id: number;
  recommendationId: number;
  cvDocumentId: number;
  agentRunId: string | null;
  decisionType: DecisionType;
  finalPrimaryCategory: string | null;
  finalSecondaryCategories: string[];
  reason: string | null;
  timestamp: string;
}

/** The original AI recommendation. Never modified; decisions reference it. */
export interface CvRecommendation {
  id: number;
  cvDocumentId: number;
  runId: string | null;
  primaryCategory: string;
  secondaryCategories: string[];
  /** Confidence (0-1) for primaryCategory. */
  confidenceScore: number;
  /** Confidence (0-1) for every category. */
  confidenceScores: Record<string, number>;
  rationale: CvRationaleEntry[];
  /** 2-4 sentences of feedback about the CV; null for results classified before feedback existed. */
  feedback?: string | null;
  createdAt: string;
  /** Present on GET /cv/results(/:id); absent on the immediate POST /cv/classify response. */
  cvDocument?: { fileName: string | null; batchId: string | null };
  /** Newest first. Present on GET /cv/results(/:id). */
  decisions?: CvDecisionRecord[];
}

export interface CvDecisionRequest {
  decisionType: DecisionType;
  finalPrimaryCategory?: string;
  finalSecondaryCategories?: string[];
  reason?: string;
}

export type BatchItemState = 'queued' | 'processing' | 'completed' | 'failed';

export interface BatchItemStatus {
  runId: string;
  documentId: number | null;
  fileName: string | null;
  state: BatchItemState;
  recommendationId: number | null;
  error: string | null;
}

/** Read live from the batch's AgentRun rows on every request - never estimated. */
export interface BatchStatus {
  batchId: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  percentage: number;
  items: BatchItemStatus[];
}

export interface BatchSubmitResult {
  batchId: string;
  totalCount: number;
  createdAt: string;
}

// ── Feedback sentiment: mirrors backend/src/services/sentimentService.ts ──

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface SentimentResult {
  id: number;
  runId: string | null;
  userId: number;
  inputText: string;
  sentiment: SentimentLabel;
  /** 0-1 */
  confidence: number;
  rationale: string;
  createdAt: string;
  /** Owner's email. Present on GET /sentiment/results(/:id); absent on the POST /sentiment/analyze response. */
  user?: { email: string };
}

/** Same limit as SentimentRequestSchema in backend/src/utils/validators.ts. */
export const MAX_FEEDBACK_CHARS = 5000;

export interface CvBatchFile {
  fileName: string;
  mimeType: string;
  /** A .txt file's text, or a PDF's bytes base64-encoded (mimeType application/pdf). */
  content: string;
}

// Mirrors backend/src/services/analyticsService.ts exactly - the
// frontend never recomputes any of these, only displays what the
// backend already calculated. See docs/ANALYTICS_API.md.
export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  callCount: number;
}

/** GET /api/analytics/usage-completeness - where the token/cost totals are known to be incomplete. */
export interface UsageCompletenessCounts {
  callsWithUnknownUsage: number;
  callsWithUnknownCost: number;
  successfulRunsWithoutUsageLog: number;
  interruptedRuns: number;
  affectedRuns: number;
}

export interface UsageCompleteness extends UsageCompletenessCounts {
  complete: boolean;
  /** Admin, all-users scope only. */
  byUser?: Array<UsageCompletenessCounts & { userId: number; email: string }>;
}

export type UsageIssue = 'USAGE_UNKNOWN' | 'COST_UNKNOWN' | 'NO_USAGE_LOGGED' | 'INTERRUPTED';

export interface TokensByUser {
  userId: number;
  email: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** totalInputTokens + totalOutputTokens, computed server-side. */
  totalTokens: number;
  estimatedCost: number;
  callCount: number;
  /** Calls whose provider sent no usage data (recorded as 0 tokens, never estimated). */
  callsWithUnknownUsage: number;
}

export interface TokensByAgent {
  agentId: number;
  agentName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** totalInputTokens + totalOutputTokens, computed server-side. */
  totalTokens: number;
  estimatedCost: number;
  callCount: number;
  /** Calls whose provider sent no usage data (recorded as 0 tokens, never estimated). */
  callsWithUnknownUsage: number;
}

export interface AgentRunCounts {
  last24h: number;
  last7d: number;
  last30d: number;
  /** All-time runs with final status SUCCESS. */
  successful: number;
  /** All-time runs with final status ERROR. */
  failed: number;
}

export interface AgentErrorRate {
  agentId: number;
  agentName: string;
  totalCalls: number;
  errorCalls: number;
  errorRate: number;
}

export interface AgentLatency {
  agentId: number;
  agentName: string;
  averageLatencyMs: number;
  callCount: number;
}

export interface CategoryAcceptanceRate {
  category: string;
  totalDecisions: number;
  accept: number;
  modify: number;
  reject: number;
  acceptanceRate: number;
}

export interface CategoryFinalCounts {
  category: string;
  originalCount: number;
  finalCount: number;
}

export interface FinalCategoryBreakdown {
  decidedCvCount: number;
  acceptedCount: number;
  modifiedCount: number;
  rejectedCount: number;
  categories: CategoryFinalCounts[];
}

export interface TimeSavedEstimate {
  methodology: 'ESTIMATED';
  baselineManualReviewMinutesPerCv: number;
  measuredAverageAutomatedLatencyMs: number;
  completedCvCount: number;
  estimatedTimeSavedHours: number;
  assumptions: string[];
}

export type ExternalLogFileFormat = 'json' | 'jsonl';

export interface ParseError {
  index: number;
  reason: string;
}

// Mirrors backend ExternalAgentLog (the import "batch") exactly.
export interface ImportedLog {
  id: number;
  userId: number;
  sourceAgentName: string;
  fileName: string;
  fileFormat: ExternalLogFileFormat;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  parseErrors: ParseError[];
  importTimestamp: string;
  notes?: string;
}

export interface ExternalAgentStatsByAgent {
  agentName: string;
  records: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  errors: number;
  averageLatencyMs: number;
}

// Mirrors ExternalAgentLogService.getStats() - deliberately a completely
// separate shape/source from TokenSummary (internal metrics), never
// combined with it. See docs/EXTERNAL_LOG_FORMAT.md.
export interface ExternalAgentStats {
  totalRecords: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  runs: number;
  errors: number;
  averageLatencyMs: number;
  byAgent: ExternalAgentStatsByAgent[];
}

export interface UserSummary {
  id: number;
  /** Full name (null for accounts created before names were recorded). */
  name: string | null;
  email: string;
  role: Role;
  createdAt: string;
  /** Deleted accounts are deactivated, not removed: they keep their history but cannot log in. */
  status: 'active' | 'deactivated';
  deactivatedAt: string | null;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
  role: Role;
}

export interface UsageLogRecord {
  id: number;
  userId: number;
  agentId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'SUCCESS' | 'ERROR';
  estimatedCost: number | null;
  createdAt: string;
  agent?: { name: string };
}

export type AgentRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR';

/** One row of GET /api/runs - run metadata only, never CV/feedback text or tokens. */
export interface AgentRunSummary {
  id: string;
  status: AgentRunStatus;
  agentName: string;
  user: { id: number; email: string };
  batchId: string | null;
  cvDocumentId: number | null;
  cvFileName: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  result:
    | { type: 'cv_recommendation'; id: number; primaryCategory: string }
    | { type: 'sentiment_result'; id: number; sentiment: string }
    | null;
  llmCallsLogged: number;
  isSeedData: boolean;
  /** Missing or incomplete usage data for this run; empty when complete. */
  usageIssues: UsageIssue[];
}

export interface AgentRunPage {
  runs: AgentRunSummary[];
  total: number;
  limit: number;
  offset: number;
  agents: string[];
}

export interface AgentRunFilters {
  userId?: number;
  agent?: string;
  status?: AgentRunStatus;
  usage?: 'incomplete';
  limit?: number;
  offset?: number;
}

// ── CV Skills Extraction & Gap Analysis (mirrors backend/src/agents/skillsGap/schema.ts) ──
export type SkillsGapRole =
  | 'Front-End Developer'
  | 'Back-End Developer'
  | 'Web Automation Engineer'
  | 'Mobile Automation Engineer'
  | 'AI Engineer'
  | 'Chatbot Application Tester'
  | 'PSS'
  | 'DCS';
export type GapPriority = 'High' | 'Medium' | 'Low';

export interface SkillsGapRoleInfo {
  /** Stable id (e.g. "PSS"), sent to the API. */
  role: SkillsGapRole;
  /** Full name shown in the UI (e.g. "Passenger Service System"). */
  label: string;
  summary: string;
  skills: Array<{ name: string; importance: 'high' | 'medium' | 'low'; description: string; gapPriority: GapPriority }>;
}

export interface SkillsGapGap {
  skill: string;
  status: 'not_demonstrated';
  priority: GapPriority;
  whyItMatters: string;
  whatToUnderstand: string;
  topics: string[];
  practicalExercise: string;
  miniProject: string | null;
  completionCriterion: string;
  estimatedLearningTime: { minHours: number; maxHours: number; isApproximate: true };
}

export interface SkillsGapResult {
  targetRole: SkillsGapRole;
  overallSummary: string;
  demonstratedSkills: Array<{ skill: string; status: 'demonstrated'; evidence: string }>;
  partiallyDemonstratedSkills: Array<{ skill: string; status: 'partially_demonstrated'; evidence: string; missingEvidence: string }>;
  potentialGaps: SkillsGapGap[];
  learningRoadmap: Array<{ stage: number; title: string; objective: string; topics: string[]; practicalTask: string; completionCriteria: string }>;
  estimatedPreparationTime: { minWeeks: number; maxWeeks: number; hoursPerWeekAssumed: number; isApproximate: true; note: string };
  limitations: string[];
}

export interface SkillsGapAnalysis {
  id: number;
  userId: number;
  targetRole: SkillsGapRole;
  cvFileName: string | null;
  createdAt: string;
  result: SkillsGapResult;
  /** Owner, shown to an admin. */
  user?: { email: string };
}
