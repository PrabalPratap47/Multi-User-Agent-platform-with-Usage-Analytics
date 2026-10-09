import { describe, it, expect } from 'vitest';
import {
  auditCall,
  auditLoggingAccuracy,
  type LoggedUsageRow,
  type RawProviderCall,
} from '../src/evaluation/loggingAccuracy.js';

function raw(overrides: Partial<RawProviderCall> = {}): RawProviderCall {
  return {
    providerResponseId: 'chatcmpl-1',
    httpStatus: 200,
    model: 'gpt-4o-2024-08-06',
    promptTokens: 812,
    completionTokens: 143,
    rawUsage: { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955 },
    ...overrides,
  };
}

function logged(overrides: Partial<LoggedUsageRow> = {}): LoggedUsageRow {
  return {
    id: 1,
    runId: 'run-1',
    agentName: 'CV Classification Agent',
    model: 'gpt-4o-2024-08-06',
    inputTokens: 812,
    outputTokens: 143,
    status: 'SUCCESS',
    providerResponseId: 'chatcmpl-1',
    ...overrides,
  };
}

describe('auditCall - per-call comparison', () => {
  it('passes with zero differences when the logged row matches the raw response exactly', () => {
    const result = auditCall(raw(), logged());
    expect(result).toMatchObject({ pass: true, inputDifference: 0, outputDifference: 0, problems: [] });
  });

  it('FAILS when raw input tokens != logged input tokens', () => {
    const result = auditCall(raw(), logged({ inputTokens: 811 }));
    expect(result.pass).toBe(false);
    expect(result.inputDifference).toBe(-1);
    expect(result.problems.join()).toMatch(/input tokens differ/);
  });

  it('FAILS when raw output tokens != logged output tokens', () => {
    const result = auditCall(raw(), logged({ outputTokens: 144 }));
    expect(result.pass).toBe(false);
    expect(result.outputDifference).toBe(1);
    expect(result.problems.join()).toMatch(/output tokens differ/);
  });

  it('FAILS when the logged model differs from the model the provider reported', () => {
    const result = auditCall(raw(), logged({ model: 'gpt-4o' }));
    expect(result.pass).toBe(false);
    expect(result.problems.join()).toMatch(/model differs/);
  });

  it('FAILS when a successful provider call is logged as ERROR', () => {
    const result = auditCall(raw(), logged({ status: 'ERROR' }));
    expect(result.pass).toBe(false);
    expect(result.problems.join()).toMatch(/status differs/);
  });

  it('FAILS when no log row exists for the raw response', () => {
    const result = auditCall(raw(), undefined);
    expect(result.pass).toBe(false);
    expect(result.problems.join()).toMatch(/no llm_usage_logs row/);
  });

  it('FAILS when the raw response carried no usable usage object', () => {
    const result = auditCall(raw({ promptTokens: null, completionTokens: null, rawUsage: null }), logged({ inputTokens: 0, outputTokens: 0 }));
    expect(result.pass).toBe(false);
    expect(result.problems.join()).toMatch(/cannot be verified/);
  });
});

describe('auditLoggingAccuracy - totals and coverage', () => {
  const raws = [raw(), raw({ providerResponseId: 'chatcmpl-2', promptTokens: 300, completionTokens: 40 })];
  const rows = [logged(), logged({ id: 2, providerResponseId: 'chatcmpl-2', inputTokens: 300, outputTokens: 40, agentName: 'Sentiment Analysis Agent' })];

  it('passes when raw sum = logged sum = dashboard total for both input and output', () => {
    const result = auditLoggingAccuracy(raws, rows, { totalInputTokens: 1112, totalOutputTokens: 183 });
    expect(result.pass).toBe(true);
    expect(result.totals).toMatchObject({ rawInputTotal: 1112, loggedInputTotal: 1112, dashboardInputTotal: 1112, rawOutputTotal: 183, loggedOutputTotal: 183, dashboardOutputTotal: 183 });
  });

  it('FAILS when the dashboard input total differs from the raw total', () => {
    const result = auditLoggingAccuracy(raws, rows, { totalInputTokens: 1113, totalOutputTokens: 183 });
    expect(result.pass).toBe(false);
    expect(result.totals.dashboardInputDifference).toBe(1);
  });

  it('FAILS when the dashboard output total differs from the raw total', () => {
    const result = auditLoggingAccuracy(raws, rows, { totalInputTokens: 1112, totalOutputTokens: 182 });
    expect(result.pass).toBe(false);
    expect(result.totals.dashboardOutputDifference).toBe(-1);
  });

  it('FAILS when a logged SUCCESS row has no matching raw provider response', () => {
    const extra = logged({ id: 3, providerResponseId: 'chatcmpl-ghost', inputTokens: 0, outputTokens: 0 });
    const result = auditLoggingAccuracy(raws, [...rows, extra], { totalInputTokens: 1112, totalOutputTokens: 183 });
    expect(result.pass).toBe(false);
    expect(result.unmatchedLoggedRows.map(r => r.id)).toEqual([3]);
  });

  it('ignores non-2xx raw responses (no usage to compare) but counts their 0-token ERROR rows in the logged total', () => {
    const failedRaw = raw({ providerResponseId: 'no-id-http-401-2', httpStatus: 401, model: '', promptTokens: null, completionTokens: null });
    const errorRow = logged({ id: 4, status: 'ERROR', providerResponseId: null, inputTokens: 0, outputTokens: 0 });
    const result = auditLoggingAccuracy([...raws, failedRaw], [...rows, errorRow], { totalInputTokens: 1112, totalOutputTokens: 183 });
    expect(result.calls).toHaveLength(2);
    expect(result.pass).toBe(true);
  });

  it('FAILS when there are no successful calls to audit', () => {
    expect(auditLoggingAccuracy([], [], { totalInputTokens: 0, totalOutputTokens: 0 }).pass).toBe(false);
  });
});
