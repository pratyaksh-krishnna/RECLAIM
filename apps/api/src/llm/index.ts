import { env } from '../config/env.js';
import { AnthropicLlmClient } from './anthropic.js';
import { OpenAiLlmClient } from './openai.js';
import type { LlmClient } from './client.js';

/**
 * The only LLM client in the system. Agent reasoning is always a real model
 * call — there is no stub, mock, or heuristic fallback.
 *
 * Which provider answers is an env choice (LLM_PROVIDER). Nothing downstream
 * of this seam can tell the difference: every call is forced-structured and
 * Zod-validated by the runner, so a provider swap cannot widen what an agent
 * is able to say.
 */
export function getLlmClient(): LlmClient {
  switch (env.LLM_PROVIDER) {
    case 'openai':
      return new OpenAiLlmClient();
    case 'anthropic':
      return new AnthropicLlmClient();
  }
}
export type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';
