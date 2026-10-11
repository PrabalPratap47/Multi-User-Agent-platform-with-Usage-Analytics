// Shared types for backend API

export type Role = 'admin' | 'user';

// Mirrors the Prisma DecisionType/RunStatus enums exactly (uppercase) - the
// task description specifies these values verbatim ("ACCEPT / MODIFY /
// REJECT"), so there's no lowercase API convention to translate to/from,
// unlike Role or Sentiment below.
export type DecisionType = 'ACCEPT' | 'MODIFY' | 'REJECT';

export type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR';

// These stay lowercase at the API boundary (matching the LLM's own JSON
// output contract in agents/sentiment/schema.ts and the Zod schemas in
// validators.ts); the Prisma enums are uppercase, converted explicitly
// wherever a value crosses that boundary - see authService.toPayload for
// the equivalent pattern used for Role.
export type Sentiment = 'positive' | 'neutral' | 'negative';

export type LogStatus = 'success' | 'error';

// User
export interface UserPayload {
  id: number;
  email: string;
  role: Role;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserPayload;
}

export interface RegisterRequest {
  email: string;
  password: string;
  role?: Role;
}

// LLM Usage
export interface LLMUsageLog {
  id: number;
  timestamp: Date;
  runId?: string; // the agent run this call belongs to
  userId: number;
  agentId: number;
  agentName: string; // denormalized snapshot at call time
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: LogStatus;
  errorCode?: string;
  errorMessage?: string;
  estimatedCost?: number;
  isSeedData: boolean;
  createdAt: Date;
}

export interface LLMUsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  callCount: number;
  errorCount: number;
  averageLatency: number;
}

// CV Classification
export interface CVClassificationRequest {
  cvContent: string;
  fileName?: string;
  batchId?: string;
}

export interface CVClassificationRationaleEntry {
  category: string;
  evidence: string;
}

// The agent's required output shape. The authoritative, validated version
// of this lives as a Zod schema in agents/cvClassification/schema.ts
// (CVClassificationResponseSchema) - this interface is kept in sync with
// it by hand for use in code that doesn't need Zod's runtime validation,
// just the shape.
export interface CVClassificationResponse {
  primaryCategory: string;
  secondaryCategories: string[];
  confidence: Record<string, number>;
  rationale: CVClassificationRationaleEntry[];
}

// The uploaded CV - immutable input, independent of any classification.
export interface CVDocument {
  id: number;
  userId: number;
  batchId?: string;
  fileName?: string;
  content: string;
  createdAt: Date;
}

// The LLM's classification OUTPUT for a CVDocument - the "original
// recommendation". Written once, never mutated.
export interface CVRecommendation {
  id: number;
  cvDocumentId: number;
  runId?: string;
  userId: number;
  agentId: number;
  primaryCategory: string;
  secondaryCategories: string[];
  confidenceScore: number;
  confidenceScores: Record<string, number>;
  rationale: CVClassificationRationaleEntry[];
  createdAt: Date;
}

// The human decision on a recommendation. Separate, append-only table -
// the original recommendation above is never overwritten by this.
export interface RecommendationDecision {
  id: number;
  recommendationId: number; // the original recommendation
  cvDocumentId: number; // denormalized - the CV
  agentRunId?: string; // denormalized - the agent run that produced the original recommendation
  userId: number; // authenticated user who made the decision
  decisionType: DecisionType;
  finalPrimaryCategory?: string; // null for REJECT; required for ACCEPT/MODIFY
  finalSecondaryCategories: string[];
  reason?: string; // mandatory for MODIFY/REJECT, enforced by Zod + a DB CHECK constraint
  timestamp: Date;
}

export interface RecommendationDecisionRequest {
  decisionType: DecisionType;
  // MODIFY only - omitted fields default to "unchanged from the
  // original" server-side. Ignored for ACCEPT/REJECT.
  finalPrimaryCategory?: string;
  finalSecondaryCategories?: string[];
  reason?: string;
}

export interface BatchCvFile {
  fileName: string;
  mimeType: string;
  content: string;
}

export interface BatchUploadRequest {
  files: BatchCvFile[];
}

export interface BatchUploadResponse {
  batchId: string;
  totalCount: number;
  createdAt: Date;
}

// Read live from each file's AgentRun row - never estimated/faked.
export interface BatchStatusResponse {
  batchId: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  percentage: number;
}

// Sentiment Analysis
export interface SentimentRequest {
  text: string;
}

// The agent's required output shape. The authoritative, validated version
// of this lives as a Zod schema in agents/sentiment/schema.ts
// (SentimentResponseSchema) - this interface is kept in sync with it by
// hand for use in code that doesn't need Zod's runtime validation.
export interface SentimentResponse {
  sentiment: Sentiment;
  confidence: number;
  rationale: string;
}

export interface SentimentResult {
  id: number;
  runId?: string;
  userId: number;
  agentId: number;
  inputText: string;
  sentiment: Sentiment;
  confidence: number;
  rationale: string;
  createdAt: Date;
}

// Analytics
export interface AnalyticsSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  agentRunsLast24h: number;
  agentRunsLast7d: number;
  agentRunsLast30d: number;
  errorRate: number;
  averageLatency: number;
}

export interface TokenStats {
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AgentStats {
  agentId: number;
  agentName: string;
  runCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorRate: number;
  averageLatency: number;
}

export interface UserStats {
  userId: number;
  email: string;
  runCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  errorRate: number;
}

export interface AcceptanceRateStats {
  category: string;
  totalClassifications: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptanceRate: number;
}

export interface EvaluationMetrics {
  precisionByCategory: Record<string, number>;
  recallByCategory: Record<string, number>;
  loggingAccuracy: number;
  timeSavedHours: number;
}

// External agent log imports
export interface ExternalAgentLog {
  id: number;
  userId: number;
  sourceAgentName: string;
  fileName: string;
  logData: Record<string, unknown>;
  recordCount?: number;
  importTimestamp: Date;
  notes?: string;
}

export interface ImportRequest {
  file: Buffer;
  fileName: string;
  sourceAgentName: string;
  notes?: string;
}

// API Response Wrapper
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Error Response
export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

// Agent Context
export interface AgentContext {
  userId: number;
  userEmail: string;
  userRole: Role;
}
