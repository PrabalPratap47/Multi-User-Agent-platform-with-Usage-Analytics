import OpenAI from 'openai';
import config from '../config/env.js';
import logger from '../config/logging.js';
import { UsageLogService } from './usageLogService.js';
import { AgentContext } from '../types/index.js';

export const MISSING_USAGE_ERROR_CODE = 'MISSING_USAGE_DATA';
const DEFAULT_MAX_TOKENS = 1024;

// ─────────────────────────────────────────────────────────────────
// Provider abstraction
//
// LLMService depends on this minimal, provider-agnostic shape (not the
// full OpenAI SDK surface), so tests can inject a plain object instead
// of mocking a module or hitting the network. createOpenAIClient()
// below is the only place that talks to the real `openai` SDK; the
// adaptation there is deliberately isolated to a single call site, so
// a future provider swap again only touches this one function.
// ─────────────────────────────────────────────────────────────────

export interface LLMProviderRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user'; content: string }>;
}

export interface LLMProviderResponse {
  content: Array<{ type: string; text?: string }>;
  model?: string;
  /** The provider's id for this response (OpenAI chat completion "id"). */
  id?: string;
  // Deliberately optional/loose - this is exactly the shape we must
  // defend against being absent or malformed (see "missing usage
  // fields" handling in call() below). Field names match OpenAI's
  // actual Chat Completions `usage` object
  // (https://platform.openai.com/docs/api-reference/chat/object) -
  // `prompt_tokens` / `completion_tokens` - not a generic/renamed
  // abstraction, so the extraction in call() below reads the real
  // field the provider returns.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface LLMProviderClient {
  messages: {
    create(params: LLMProviderRequest): Promise<LLMProviderResponse>;
  };
}

/**
 * Adapts the OpenAI Chat Completions API to the minimal
 * `LLMProviderClient` shape above. `request.system` (our own
 * `LLMCallParams.systemInstructions`, kept as a separate field so it
 * can never be interpolated with user content) becomes a `system`-role
 * message prepended to the OpenAI `messages` array - Chat Completions
 * has no separate top-level "system" parameter the way some other
 * providers do.
 *
 * Uses `max_completion_tokens`, the current (non-deprecated) parameter
 * name for capping response length - OpenAI deprecated `max_tokens` on
 * Chat Completions in September 2024 in favor of this name (`max_tokens`
 * still works for non-reasoning models like gpt-4o via backward
 * compatibility, but new code should use the current name).
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set in backend/.env.local');
    this.name = 'OPENAI_API_KEY_MISSING';
  }
}

export interface OpenAIClientOptions {
  /** Defaults to OPENAI_API_KEY from the environment. */
  apiKey?: string;
  /** Custom fetch, e.g. to record raw HTTP responses for the logging-accuracy audit. */
  fetch?: typeof fetch;
}

export function createOpenAIClient(options: OpenAIClientOptions = {}): LLMProviderClient {
  // Built on first call, not at import: the SDK throws on an empty key, and
  // the app (dashboards, auth) must still start before a key is configured.
  let openai: OpenAI | null = null;

  return {
    messages: {
      async create(request: LLMProviderRequest): Promise<LLMProviderResponse> {
        if (!openai) {
          const apiKey = (options.apiKey ?? config.OPENAI_API_KEY).trim();
          if (!apiKey) {
            throw new MissingApiKeyError();
          }
          openai = new OpenAI({ apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
        }

        const response = await openai.chat.completions.create({
          model: request.model,
          max_completion_tokens: request.max_tokens,
          messages: [
            ...(request.system
              ? [{ role: 'system' as const, content: request.system }]
              : []),
            ...request.messages,
          ],
        });

        const choice = response.choices[0];
        const text = choice?.message?.content;

        return {
          content: typeof text === 'string' ? [{ type: 'text', text }] : [],
          model: response.model,
          id: response.id,
          usage: response.usage
            ? {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
              }
            : undefined,
        };
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────

export interface LLMCallParams {
  /** System prompt - the agent's fixed instructions, never user input. */
  systemInstructions: string;
  /** The (already-escaped/sanitized) user-provided content. */
  userContent: string;
  /** Which agent is calling - used for logging and Agent lookup. */
  agentName: string;
  /** The authenticated caller - identity for the usage log, never a client-supplied id. */
  context: AgentContext;
  /** The AgentRun this call belongs to, if one exists yet. Optional - see docs/USAGE_LOGGING.md. */
  runId?: string;
  model?: string;
  maxTokens?: number;
}

export interface LLMUsageMetadata {
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
  status: 'success' | 'error';
  runId?: string;
  /** True when the provider omitted usage data - tokens above are 0, NOT estimated. */
  usageDataMissing?: boolean;
  /**
   * Whether this call's llm_usage_logs row was actually written. false means
   * the call is missing from usage analytics (a USAGE_LOG_WRITE_FAILED event
   * was logged); the provider status above is unaffected.
   */
  usageLogPersisted: boolean;
}

export interface LLMCallResult {
  responseText: string;
  usage: LLMUsageMetadata;
}

export class LLMServiceError extends Error {
  constructor(
    message: string,
    public readonly usage: LLMUsageMetadata,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LLMServiceError';
  }
}

// ─────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────

export class LLMService {
  private readonly client: LLMProviderClient;

  constructor(client?: LLMProviderClient) {
    this.client = client ?? createOpenAIClient();
  }

  /**
   * Calls the configured LLM provider, persists a usage_logs row
   * regardless of outcome, and returns the parsed response text plus the
   * actual usage metadata. If that row cannot be written, the call's
   * result is still returned (never re-requested, so never billed twice)
   * with `usage.usageLogPersisted: false`. See docs/USAGE_LOGGING.md for
   * the full design and the rules this method enforces.
   */
  async call(params: LLMCallParams): Promise<LLMCallResult> {
    const model = params.model ?? config.OPENAI_MODEL;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timestamp = new Date();
    const startedAt = performance.now();

    let response: LLMProviderResponse;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: params.systemInstructions,
        messages: [{ role: 'user', content: params.userContent }],
      });
    } catch (error) {
      return this.handleProviderError(error, { params, model, timestamp, startedAt });
    }

    const latencyMs = Math.round(performance.now() - startedAt);

    // Extract token usage ONLY from the provider's official usage field
    // (OpenAI Chat Completions: response.usage.prompt_tokens /
    // response.usage.completion_tokens). Never fall back to character
    // counts, word counts, prompt length, or an estimated tokenizer - if
    // the field is missing or malformed, that is recorded as a
    // data-integrity flag (usageDataMissing / the MISSING_USAGE_DATA
    // error code), not papered over with a guess.
    const rawInputTokens = response.usage?.prompt_tokens;
    const rawOutputTokens = response.usage?.completion_tokens;
    const hasCompleteUsage = typeof rawInputTokens === 'number' && typeof rawOutputTokens === 'number';
    const usageDataMissing = !hasCompleteUsage;

    // A partial usage object counts as missing: one real count stored next
    // to a placeholder 0 would look like genuine data.
    const inputTokens = hasCompleteUsage ? rawInputTokens : 0;
    const outputTokens = hasCompleteUsage ? rawOutputTokens : 0;
    const actualModel = response.model ?? model;
    const responseText = extractText(response);

    const logResult = await UsageLogService.logCall({
      timestamp,
      runId: params.runId,
      userId: params.context.userId,
      agentName: params.agentName,
      model: actualModel,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latencyMs,
      status: 'success',
      providerResponseId: response.id,
      errorCode: usageDataMissing ? MISSING_USAGE_ERROR_CODE : undefined,
      errorMessage: usageDataMissing
        ? 'Provider response did not include usage data; token counts recorded as 0, not estimated.'
        : undefined,
    });

    if (usageDataMissing) {
      logger.warn('LLM response missing usage data - tokens recorded as 0, not estimated', {
        agent: params.agentName,
        userId: params.context.userId,
        runId: params.runId,
      });
    }

    return {
      responseText,
      usage: {
        inputTokens,
        outputTokens,
        model: actualModel,
        latencyMs,
        status: 'success',
        runId: params.runId,
        usageDataMissing: usageDataMissing || undefined,
        usageLogPersisted: logResult.persisted,
      },
    };
  }

  /**
   * Shared failure path: compute latency, log what we know (status
   * ERROR, 0 tokens - a failed call has no usage data to report, and we
   * do not estimate one), then surface the failure to the caller as an
   * LLMServiceError. The log write happens before the throw, so a
   * provider failure keeps its audit trail; if that write itself fails,
   * the error's `usage.usageLogPersisted` is false.
   */
  private async handleProviderError(
    error: unknown,
    ctx: { params: LLMCallParams; model: string; timestamp: Date; startedAt: number }
  ): Promise<never> {
    const { params, model, timestamp, startedAt } = ctx;
    const latencyMs = Math.round(performance.now() - startedAt);
    const { code, message } = describeProviderError(error);

    const logResult = await UsageLogService.logCall({
      timestamp,
      runId: params.runId,
      userId: params.context.userId,
      agentName: params.agentName,
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs,
      status: 'error',
      errorCode: code,
      errorMessage: message,
    });

    const usage: LLMUsageMetadata = {
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs,
      status: 'error',
      runId: params.runId,
      usageLogPersisted: logResult.persisted,
    };

    logger.error('LLM call failed', {
      agent: params.agentName,
      userId: params.context.userId,
      runId: params.runId,
      errorCode: code,
      error: message,
    });

    throw new LLMServiceError(`LLM call failed: ${message}`, usage, error);
  }
}

function extractText(response: LLMProviderResponse): string {
  return response.content
    .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

// OpenAI's 401 message echoes a masked key ("Incorrect API key provided:
// sk-proj-****abcd"); strip anything key-shaped before it reaches logs or the DB.
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_*-]{4,}/g;

export function redactApiKeys(text: string): string {
  return text.replace(API_KEY_PATTERN, 'sk-[REDACTED]');
}

/** User-facing reason for a failed provider call (its message is already key-redacted). */
export function providerFailureMessage(error: LLMServiceError): string {
  return `The AI provider request failed: ${error.message.replace(/^LLM call failed: /, '')}`;
}

function describeProviderError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { status?: number; name?: string; message?: string };
    const code = candidate.status ? `HTTP_${candidate.status}` : candidate.name || 'UNKNOWN_ERROR';
    const message = redactApiKeys(candidate.message || 'Unknown error calling LLM provider');
    return { code, message };
  }
  return { code: 'UNKNOWN_ERROR', message: redactApiKeys(String(error)) };
}

// Default singleton for agent code to import directly. Tests construct
// their own `new LLMService(mockClient)` instead of using this.
export const llmService = new LLMService();
