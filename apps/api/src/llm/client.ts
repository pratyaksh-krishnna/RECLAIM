import type { z } from 'zod';

/**
 * Thin LLM provider abstraction. Every call is forced-structured: the caller
 * supplies a Zod schema; the provider must return JSON for that schema, which
 * the RUNNER validates with Zod. Free-text parsing of LLM output is forbidden
 * everywhere in this codebase.
 */
export type ModelClass = 'small' | 'mid';

export interface StructuredCallArgs {
  modelClass: ModelClass;
  schemaName: string;
  system: string;
  /** structured input; serialized as the user message, passed to stubs directly */
  input: unknown;
  maxTokens?: number;
}

export interface StructuredCallResult {
  /** raw candidate output — ALWAYS Zod-parse before use */
  raw: unknown;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LlmClient {
  readonly mode: 'stub' | 'live';
  completeStructured(args: StructuredCallArgs, jsonSchema: Record<string, unknown>): Promise<StructuredCallResult>;
}

export interface StructuredSchema<T> {
  name: string;
  zod: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
}
