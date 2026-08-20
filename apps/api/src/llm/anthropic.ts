import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';

/**
 * Anthropic adapter with forced tool use: the model MUST call the single
 * declared tool, so output is machine-readable JSON per schema. The runner
 * still Zod-validates; on schema failure it retries once, then escalates.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly mode = 'live' as const;
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  private modelFor(cls: 'small' | 'mid'): string {
    return cls === 'small' ? env.LLM_SMALL_MODEL : env.LLM_MID_MODEL;
  }

  async completeStructured(
    args: StructuredCallArgs,
    jsonSchema: Record<string, unknown>,
  ): Promise<StructuredCallResult> {
    const model = this.modelFor(args.modelClass);
    const started = Date.now();
    const response = await this.client.messages.create({
      model,
      max_tokens: args.maxTokens ?? 1024,
      system: args.system,
      messages: [{ role: 'user', content: JSON.stringify(args.input, null, 2) }],
      tools: [
        {
          name: args.schemaName,
          description: `Return the ${args.schemaName} result.`,
          input_schema: jsonSchema as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: args.schemaName },
    });
    const latencyMs = Date.now() - started;
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    return {
      raw: toolUse?.input ?? null,
      modelId: model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs,
    };
  }
}
