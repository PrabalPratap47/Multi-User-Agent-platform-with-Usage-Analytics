/**
 * Logging-accuracy comparison: raw provider usage (read from the actual
 * HTTP response body, independently of LLMService) versus the normalized
 * llm_usage_logs rows versus the dashboard totals. Pure functions, shared
 * by the audit script (runLoggingAccuracyAudit.ts) and the tests.
 */

/** One raw provider response as captured at the HTTP layer. */
export interface RawProviderCall {
  providerResponseId: string;
  httpStatus: number;
  model: string;
  /** usage.prompt_tokens exactly as returned; null if absent. */
  promptTokens: number | null;
  /** usage.completion_tokens exactly as returned; null if absent. */
  completionTokens: number | null;
  /** The usage object verbatim, for the report. */
  rawUsage: unknown;
}

/** The fields of an llm_usage_logs row this audit checks. */
export interface LoggedUsageRow {
  id: number;
  runId: string | null;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'SUCCESS' | 'ERROR';
  providerResponseId: string | null;
}

export interface DashboardTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface CallAudit {
  runId: string | null;
  agent: string | null;
  providerResponseId: string;
  rawModel: string;
  loggedModel: string | null;
  rawInputTokens: number | null;
  loggedInputTokens: number | null;
  inputDifference: number | null;
  rawOutputTokens: number | null;
  loggedOutputTokens: number | null;
  outputDifference: number | null;
  expectedStatus: 'SUCCESS';
  loggedStatus: 'SUCCESS' | 'ERROR' | null;
  pass: boolean;
  problems: string[];
}

export interface TotalsAudit {
  rawInputTotal: number;
  loggedInputTotal: number;
  dashboardInputTotal: number;
  rawOutputTotal: number;
  loggedOutputTotal: number;
  dashboardOutputTotal: number;
  inputDifference: number;
  outputDifference: number;
  dashboardInputDifference: number;
  dashboardOutputDifference: number;
  pass: boolean;
}

export interface LoggingAccuracyResult {
  calls: CallAudit[];
  /** Logged SUCCESS rows with no matching raw provider response (would mean tokens not from a real response). */
  unmatchedLoggedRows: LoggedUsageRow[];
  totals: TotalsAudit;
  pass: boolean;
}

export function isSuccessfulRawCall(raw: RawProviderCall): boolean {
  return raw.httpStatus >= 200 && raw.httpStatus < 300;
}

export function auditCall(raw: RawProviderCall, logged: LoggedUsageRow | undefined): CallAudit {
  const problems: string[] = [];
  if (raw.promptTokens === null || raw.completionTokens === null) {
    problems.push('raw response has no usable usage object - tokens cannot be verified');
  }
  if (!logged) {
    problems.push('no llm_usage_logs row has this providerResponseId');
  } else {
    if (raw.promptTokens !== null && logged.inputTokens !== raw.promptTokens) {
      problems.push(`input tokens differ: raw ${raw.promptTokens}, logged ${logged.inputTokens}`);
    }
    if (raw.completionTokens !== null && logged.outputTokens !== raw.completionTokens) {
      problems.push(`output tokens differ: raw ${raw.completionTokens}, logged ${logged.outputTokens}`);
    }
    if (logged.model !== raw.model) {
      problems.push(`model differs: raw "${raw.model}", logged "${logged.model}"`);
    }
    if (logged.status !== 'SUCCESS') {
      problems.push(`status differs: provider call succeeded, logged "${logged.status}"`);
    }
  }

  const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  return {
    runId: logged?.runId ?? null,
    agent: logged?.agentName ?? null,
    providerResponseId: raw.providerResponseId,
    rawModel: raw.model,
    loggedModel: logged?.model ?? null,
    rawInputTokens: raw.promptTokens,
    loggedInputTokens: logged?.inputTokens ?? null,
    inputDifference: diff(raw.promptTokens, logged?.inputTokens ?? null),
    rawOutputTokens: raw.completionTokens,
    loggedOutputTokens: logged?.outputTokens ?? null,
    outputDifference: diff(raw.completionTokens, logged?.outputTokens ?? null),
    expectedStatus: 'SUCCESS',
    loggedStatus: logged?.status ?? null,
    pass: problems.length === 0,
    problems,
  };
}

/**
 * rawCalls: every HTTP response captured during the audit.
 * loggedRows: every llm_usage_logs row in the audit's scope (including ERROR rows, which carry 0 tokens).
 * dashboard: the totals returned by GET /api/analytics/summary for the same scope.
 */
export function auditLoggingAccuracy(
  rawCalls: RawProviderCall[],
  loggedRows: LoggedUsageRow[],
  dashboard: DashboardTotals
): LoggingAccuracyResult {
  const successfulRaw = rawCalls.filter(isSuccessfulRawCall);
  const byResponseId = new Map(loggedRows.filter(r => r.providerResponseId).map(r => [r.providerResponseId as string, r]));
  const rawIds = new Set(successfulRaw.map(r => r.providerResponseId));

  const calls = successfulRaw.map(raw => auditCall(raw, byResponseId.get(raw.providerResponseId)));
  const unmatchedLoggedRows = loggedRows.filter(
    r => r.status === 'SUCCESS' && (!r.providerResponseId || !rawIds.has(r.providerResponseId))
  );

  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
  const rawInputTotal = sum(successfulRaw.map(r => r.promptTokens ?? 0));
  const rawOutputTotal = sum(successfulRaw.map(r => r.completionTokens ?? 0));
  const loggedInputTotal = sum(loggedRows.map(r => r.inputTokens));
  const loggedOutputTotal = sum(loggedRows.map(r => r.outputTokens));

  const totals: TotalsAudit = {
    rawInputTotal,
    loggedInputTotal,
    dashboardInputTotal: dashboard.totalInputTokens,
    rawOutputTotal,
    loggedOutputTotal,
    dashboardOutputTotal: dashboard.totalOutputTokens,
    inputDifference: loggedInputTotal - rawInputTotal,
    outputDifference: loggedOutputTotal - rawOutputTotal,
    dashboardInputDifference: dashboard.totalInputTokens - rawInputTotal,
    dashboardOutputDifference: dashboard.totalOutputTokens - rawOutputTotal,
    pass:
      rawInputTotal === loggedInputTotal &&
      loggedInputTotal === dashboard.totalInputTokens &&
      rawOutputTotal === loggedOutputTotal &&
      loggedOutputTotal === dashboard.totalOutputTokens,
  };

  return {
    calls,
    unmatchedLoggedRows,
    totals,
    pass: calls.length > 0 && calls.every(c => c.pass) && unmatchedLoggedRows.length === 0 && totals.pass,
  };
}
