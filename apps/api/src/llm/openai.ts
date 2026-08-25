import OpenAI from 'openai';
import { env } from '../config/env.js';
import type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';

/**
 * OpenAI adapter — the counterpart of the Anthropic one. Forced function
 * calling: the model MUST call the single declared function, so output is
 * machine-readable JSON per schema. The runner still Zod-validates; on schema
 * failure it retries once, then escalates.
 *
 * Uses the Responses API, not Chat Completions. Reasoning models refuse
 * function tools on /v1/chat/completions unless reasoning is switched off
 * ("Function tools with reasoning_effort are not supported ... set
 * reasoning_effort to 'none'"), and paying for a reasoning model to then
 * disable its reasoning is the wrong trade. /v1/responses supports both
 * together, and non-reasoning models take the identical call, so one code
 * path covers every OpenAI model.
 *
 * Tools are non-strict on purpose. Strict Structured Outputs rejects most of
 * what our contracts are built from: the slot fills are a `z.record()` (open
 * `additionalProperties`) and the action catalog is a discriminated union — so
 * the strict path would reject the very schemas it is meant to enforce.
 * Non-strict accepts them, and the Zod gate in the runner is the real
 * enforcement either way.
 */
export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      // only override when set — an undefined baseURL is not the same as none
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
    });
  }

  async completeStructured(
    args: StructuredCallArgs,
    jsonSchema: Record<string, unknown>,
  ): Promise<StructuredCallResult> {
    const model = env.OPENAI_MODEL;
    const started = Date.now();
    const response = await this.client.responses.create({
      model,
      // A reasoning model bills its private reasoning against this budget, so
      // the Anthropic adapter's 1024 would be spent thinking and the answer
      // truncated before the tool call is emitted.
      max_output_tokens: args.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      instructions: args.system,
      input: JSON.stringify(args.input, null, 2),
      tools: [
        {
          type: 'function',
          name: args.schemaName,
          description: `Return the ${args.schemaName} result.`,
          parameters: toFunctionParameters(jsonSchema),
          strict: false,
        },
      ],
      tool_choice: { type: 'function', name: args.schemaName },
    });
    const latencyMs = Date.now() - started;
    const call = response.output.find(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
        item.type === 'function_call' && item.name === args.schemaName,
    );
    return {
      raw: call ? parseArguments(call.arguments) : null,
      // the response names the dated snapshot the alias resolved to, which is
      // what agent_decisions.model should record — an alias is not a version
      modelId: response.model || model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs,
    };
  }
}

/** Reasoning tokens come out of the same budget as the answer — see the call site. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Tool arguments arrive as a JSON *string* the model wrote, so they can be
 * malformed — or absent entirely when the response stopped at the token
 * budget mid-reasoning. Returning null puts that on the same path as any
 * other bad output: the runner's Zod parse fails, it retries once, then
 * escalates to a human. Throwing here would instead fail the queue job and
 * lose that path.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** `$schema` is a dialect marker zod-to-json-schema adds; the tools API has no use for it. */
function toFunctionParameters(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...jsonSchema };
  delete parameters.$schema;
  return parameters;
}
