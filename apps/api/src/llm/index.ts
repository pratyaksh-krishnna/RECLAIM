import { AnthropicLlmClient } from './anthropic.js';
import type { LlmClient } from './client.js';

/**
 * The only LLM client in the system. Agent reasoning is always a real
 * Anthropic model call — there is no stub, mock, or heuristic fallback.
 */
export function getLlmClient(): LlmClient {
  return new AnthropicLlmClient();
}
export type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';
