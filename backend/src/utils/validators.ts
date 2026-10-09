import { z } from 'zod';

// CV Categories
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

// Zod schemas for validation
//
// NOTE: the CV Classification Agent's and Sentiment Agent's actual
// response schemas (CVClassificationResponseSchema, SentimentResponseSchema)
// live in agents/cvClassification/schema.ts and agents/sentiment/schema.ts,
// not here - they're agent-specific and tightly coupled to the prompts
// that produce them, whereas this file holds generic request-shape
// validation shared across controllers.

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

/**
 * True when text is mostly control characters - binary content (a PDF,
 * DOCX or image) sent as if it were plain text. Real text has very few.
 */
export function looksLikeBinaryText(content: string): boolean {
  if (content.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  const controlChars = content.match(/[\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0;
  return controlChars / content.length > 0.05;
}

/** File names are only ever stored as data, never used as paths; control characters are still refused. */
export const SafeFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .refine(name => !/[\u0000-\u001F\u007F]/.test(name), 'fileName must not contain control characters');

export const CVClassificationRequestSchema = z.object({
  cvContent: z
    .string()
    .min(10)
    .max(50000)
    // Same rule as batch upload and the UI: whitespace does not count toward the minimum.
    .refine(content => content.trim().length >= 10, 'cvContent must contain at least 10 characters of text')
    .refine(content => !looksLikeBinaryText(content), 'cvContent does not appear to be plain text'),
  fileName: SafeFileNameSchema.optional(),
  batchId: z.string().min(1).max(100).optional(),
});

export const SentimentRequestSchema = z.object({
  text: z.string().min(1).max(5000),
});

// Shape-level validation for the decision request. Business rules that
// need the ORIGINAL recommendation to check (MODIFY must actually choose
// something different; ACCEPT/REJECT's final category is computed
// server-side, never taken from the client) live in
// cvDecisionService.ts, which has that context loaded - this schema only
// validates what can be checked from the request body alone.
//
// reason is mandatory for MODIFY and REJECT, optional for ACCEPT. The
// database also enforces this via a CHECK constraint (see
// prisma/migrations/.../migration.sql) as a defense-in-depth safety net -
// this Zod check is what gives the caller a clean 400 instead of a raw DB
// constraint violation.
export const MAX_DECISION_REASON_LENGTH = 2000;

export const RecommendationDecisionSchema = z
  .object({
    decisionType: z.enum(['ACCEPT', 'MODIFY', 'REJECT']),
    // Only meaningful for MODIFY - omitted fields default to "unchanged
    // from the original" at the service layer. Ignored entirely for
    // ACCEPT/REJECT (the server computes the final category for those).
    finalPrimaryCategory: z.enum(CV_CATEGORIES).optional(),
    finalSecondaryCategories: z.array(z.enum(CV_CATEGORIES)).optional(),
    reason: z.string().trim().min(1).max(MAX_DECISION_REASON_LENGTH).optional(),
  })
  .refine(data => data.decisionType === 'ACCEPT' || !!data.reason, {
    message: 'reason is required for MODIFY and REJECT decisions',
    path: ['reason'],
  });

// Batch CV upload. Deliberately NOT a multipart/binary-file upload: this
// backend has no multipart-parsing dependency installed, and adding one
// (plus PDF/DOCX text extraction) could not be verified working in this
// environment. The frontend reads actual files selected via a real file
// picker (FileReader.readAsText()) and sends their name/type/content as
// JSON - "upload multiple files" from the user's perspective, without an
// unverified new runtime dependency. See docs/BATCH_CV_PROCESSING.md.
//
// Only the REQUEST shape (is `files` an array, within the count limit,
// with the right field types) is checked here. Per-file business rules
// (allowed MIME type, content length bounds) are checked independently
// for each file during processing (cvBatchService.ts) - a bad file must
// fail only that file, not the whole batch request.
export const MAX_BATCH_FILES = 20;

export const BatchCvFileSchema = z.object({
  fileName: SafeFileNameSchema,
  mimeType: z.string().min(1).max(100),
  content: z.string(),
});

export const BatchUploadSchema = z.object({
  files: z
    .array(BatchCvFileSchema)
    .min(1, 'at least one file is required')
    .max(MAX_BATCH_FILES, `a batch may contain at most ${MAX_BATCH_FILES} files`),
});

// External agent log import request. The per-RECORD schema
// (ExternalLogRecordSchema, with its deliberate leniency - most fields
// optional, extra fields allowed) lives in externalLogs/format.ts; this
// is just the request envelope (which file, which format, raw content).
export const ImportLogSchema = z.object({
  sourceAgentName: z.string().min(1).max(255),
  fileName: SafeFileNameSchema,
  format: z.enum(['json', 'jsonl']),
  content: z.string().min(1, 'file content must not be empty').max(2_000_000, 'file exceeds the 2MB import limit'),
  notes: z.string().max(1000).optional(),
});

// Validation functions
export function validateLogin(data: unknown) {
  return LoginSchema.parse(data);
}

export function validateCVClassificationRequest(data: unknown) {
  return CVClassificationRequestSchema.parse(data);
}

export function validateSentimentRequest(data: unknown) {
  return SentimentRequestSchema.parse(data);
}

export function validateRecommendationDecision(data: unknown) {
  return RecommendationDecisionSchema.parse(data);
}

export function validateBatchUpload(data: unknown) {
  return BatchUploadSchema.parse(data);
}

export function validateImportLog(data: unknown) {
  return ImportLogSchema.parse(data);
}

// GET /api/runs query. Query values arrive as strings (or arrays when a
// parameter repeats, which fails these schemas); strict digit patterns
// reject "1e3", "-1", " 5" and the like instead of coercing them.
export const RUN_LIST_DEFAULT_LIMIT = 25;
export const RUN_LIST_MAX_LIMIT = 100;
export const RUN_LIST_MAX_OFFSET = 1_000_000;

export const AgentRunListQuerySchema = z.object({
  userId: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'userId must be a positive integer')
    .transform(Number)
    .refine(n => n <= 2_147_483_647, 'userId is out of range')
    .optional(),
  agent: z.string().trim().min(1, 'agent must not be empty').max(100).optional(),
  status: z.enum(['PENDING', 'RUNNING', 'SUCCESS', 'ERROR']).optional(),
  /** "incomplete": only runs with missing or incomplete usage data (services/usageCompleteness.ts). */
  usage: z.enum(['incomplete']).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'limit must be an integer')
    .transform(Number)
    .refine(n => n >= 1 && n <= RUN_LIST_MAX_LIMIT, `limit must be between 1 and ${RUN_LIST_MAX_LIMIT}`)
    .optional(),
  offset: z
    .string()
    .regex(/^\d{1,7}$/, 'offset must be a non-negative integer')
    .transform(Number)
    .refine(n => n <= RUN_LIST_MAX_OFFSET, `offset must be at most ${RUN_LIST_MAX_OFFSET}`)
    .optional(),
});

export function validateAgentRunListQuery(data: unknown) {
  return AgentRunListQuerySchema.parse(data);
}
