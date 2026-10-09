import { z } from 'zod';

/**
 * The documented external agent log format. Full human-readable
 * documentation lives in docs/EXTERNAL_LOG_FORMAT.md - this file is the
 * actual runtime validator and parser that document describes.
 *
 * Design principle throughout: "do not assume the external agent uses
 * exactly the same internal database format." Only `timestamp` and
 * `agentName` are required - everything else (userId, model, token
 * counts, latency, status, cost) is optional, because a genuinely
 * foreign system may simply not report some of them. Extra fields the
 * schema doesn't recognize are allowed (`.passthrough()`), not rejected -
 * we don't control a foreign system's schema and have no business
 * rejecting a record just because it also contains fields we don't use.
 * This is a deliberate contrast with this platform's OWN agent output
 * schemas (CVClassificationResponseSchema, SentimentResponseSchema),
 * which are `.strict()` because we wrote the prompt that produces them
 * and have no reason to ever see an unexpected field there.
 */
export const ExternalLogRecordSchema = z
  .object({
    timestamp: z.string().min(1, 'timestamp is required'),
    userId: z.union([z.string(), z.number()]).optional(),
    agentName: z.string().min(1, 'agentName is required'),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    status: z.string().optional(),
    estimatedCost: z.number().nonnegative().optional(),
  })
  .passthrough();

export type ExternalLogRecord = z.infer<typeof ExternalLogRecordSchema>;

export interface NormalizedExternalRecord {
  timestamp: Date;
  externalUserId: string | null;
  agentName: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  rawStatus: string | null;
  isError: boolean;
  estimatedCost: number | null;
  rawRecord: Record<string, unknown>;
}

export interface RecordParseError {
  index: number;
  reason: string;
}

export interface ParsedExternalLogFile {
  normalized: NormalizedExternalRecord[];
  errors: RecordParseError[];
  totalRecords: number;
}

// Status strings outside this list fall through to the substring
// heuristic below, not an immediate rejection - see classifyStatus().
const ERROR_STATUS_TERMS = new Set([
  'error', 'failed', 'failure', 'fail', 'timeout', 'timed_out', 'exception',
  '400', '401', '403', '404', '429', '500', '502', '503', '504',
]);
const SUCCESS_STATUS_TERMS = new Set([
  'success', 'succeeded', 'ok', '200', '201', '202', 'completed', 'complete', 'done',
]);

/**
 * Normalizes a foreign status string into our own isError boolean.
 * Documented explicitly (see docs/EXTERNAL_LOG_FORMAT.md) because this
 * is a heuristic, not a guarantee: an unrecognized status defaults to
 * "not an error" unless it contains a recognizable error-like substring.
 */
export function classifyStatus(rawStatus: string | undefined): boolean {
  if (!rawStatus) return false;
  const normalized = rawStatus.trim().toLowerCase();
  if (ERROR_STATUS_TERMS.has(normalized)) return true;
  if (SUCCESS_STATUS_TERMS.has(normalized)) return false;
  return normalized.includes('err') || normalized.includes('fail') || normalized.includes('exception');
}

function normalizeRecord(record: ExternalLogRecord): NormalizedExternalRecord {
  const timestamp = new Date(record.timestamp);

  return {
    timestamp,
    externalUserId: record.userId !== undefined ? String(record.userId) : null,
    agentName: record.agentName,
    model: record.model ?? null,
    inputTokens: record.inputTokens ?? null,
    outputTokens: record.outputTokens ?? null,
    latencyMs: record.latencyMs ?? null,
    rawStatus: record.status ?? null,
    isError: classifyStatus(record.status),
    estimatedCost: record.estimatedCost ?? null,
    rawRecord: record as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown, index: number): NormalizedExternalRecord | RecordParseError {
  const result = ExternalLogRecordSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { index, reason: issues.join('; ') };
  }

  const timestamp = new Date(result.data.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return { index, reason: `timestamp "${result.data.timestamp}" could not be parsed as a date` };
  }

  return normalizeRecord(result.data);
}

/** Parses a `.json` file's content: must be a top-level JSON array of record objects. */
export function parseJsonLogFile(content: string): ParsedExternalLogFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      normalized: [],
      errors: [{ index: -1, reason: `File is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
      totalRecords: 0,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      normalized: [],
      errors: [{ index: -1, reason: 'A .json log file must contain a top-level array of record objects' }],
      totalRecords: 0,
    };
  }

  const normalized: NormalizedExternalRecord[] = [];
  const errors: RecordParseError[] = [];

  parsed.forEach((raw, index) => {
    const result = validateAndNormalize(raw, index);
    if ('reason' in result) errors.push(result);
    else normalized.push(result);
  });

  return { normalized, errors, totalRecords: parsed.length };
}

/** Parses a `.jsonl` file's content: one JSON object per non-empty line. */
export function parseJsonlLogFile(content: string): ParsedExternalLogFile {
  const lines = content.split('\n').map(line => line.trim());
  const nonEmptyLines = lines
    .map((line, lineNumber) => ({ line, lineNumber }))
    .filter(entry => entry.line.length > 0);

  const normalized: NormalizedExternalRecord[] = [];
  const errors: RecordParseError[] = [];

  for (const { line, lineNumber } of nonEmptyLines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      errors.push({
        index: lineNumber,
        reason: `Line ${lineNumber + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const result = validateAndNormalize(raw, lineNumber);
    if ('reason' in result) errors.push(result);
    else normalized.push(result);
  }

  return { normalized, errors, totalRecords: nonEmptyLines.length };
}

export type ExternalLogFileFormat = 'json' | 'jsonl';

export function parseExternalLogFile(content: string, format: ExternalLogFileFormat): ParsedExternalLogFile {
  return format === 'jsonl' ? parseJsonlLogFile(content) : parseJsonLogFile(content);
}
