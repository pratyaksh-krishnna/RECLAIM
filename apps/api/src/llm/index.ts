import { env } from '../config/env.js';
import { AnthropicLlmClient } from './anthropic.js';
import type { LlmClient } from './client.js';
import { StubLlmClient } from './stub.js';

export function getLlmClient(): LlmClient {
  return env.LLM_MODE === 'live' ? new AnthropicLlmClient() : new StubLlmClient();
}
export type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';
