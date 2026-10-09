import { AgentContext } from '../types/index.js';
import { llmService, LLMService } from '../services/llmService.js';

/**
 * Base class for all agents.
 *
 * Subclasses MUST call the LLM through `this.llm.call(...)`
 * (see services/llmService.ts) rather than importing the provider SDK
 * directly - that is the only code path that extracts real token usage
 * and logs it to llm_usage_logs. There is no supported way for a
 * subclass to reach the provider without going through it.
 */
export abstract class Agent {
  abstract name: string;
  abstract version: string;

  constructor(protected readonly llm: LLMService = llmService) {}

  /**
   * Execute the agent's task.
   * @param runId The AgentRun this invocation belongs to, if one has
   *   already been created by the caller - passed through to every
   *   LLM call so retries/repairs within one execute() share a run.
   */
  abstract execute(
    input: string,
    context: AgentContext,
    runId?: string
  ): Promise<unknown>;
}
