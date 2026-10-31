import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ModelPort } from './agent.ts';
import { PLANNING_PROMPT } from './planning-prompt.ts';
import { changeSet } from './planning-schemas.ts';

export const MODEL_ID = 'gpt-6.1-terra';
export const REASONING_EFFORT = 'high';

const allowedTools = new Set(['read_schedule', 'read_memory', 'calculate_timing', 'validate_changes',
  'search_places', 'estimate_travel', 'get_weather', 'get_subway_arrivals',
  'list_calendars', 'read_calendar_events', 'list_contact_requests', 'read_contact_replies']);
const serverFields = new Set(['userId', 'authenticatedUserId', 'scope', 'authorization', 'permissions', 'coordinationTarget']);

const FinalDecision = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('question'), text: z.string().min(1), missingFields: z.array(z.string()).default([]) }),
  z.strictObject({ kind: z.literal('proposal'), reason: z.string(), changeSet, evidenceRefs: z.array(z.string()) }),
]);
const Response = z.object({
  status: z.literal('completed'),
  error: z.unknown().optional(),
  incomplete_details: z.unknown().optional(),
  output: z.array(z.object({ type: z.string(), status: z.unknown().optional() }).passthrough()),
}).passthrough();
const FunctionCall = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
}).passthrough();
const Message = z.object({
  type: z.literal('message'),
  role: z.literal('assistant').optional(),
  content: z.array(z.object({ type: z.literal('output_text'), text: z.string() }).passthrough()).length(1),
}).passthrough();
const ObjectSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

type ToolDescription = Parameters<ModelPort['decide']>[0]['tools'][number];

function prepareTools(tools: ToolDescription[]) {
  const validators = new Map<string, z.ZodType>();
  const functions = tools.map(tool => {
    if (!allowedTools.has(tool.name) || validators.has(tool.name)) throw new Error('MODEL_TOOL_NOT_ALLOWED');
    try {
      const parameters = ObjectSchema.parse(tool.inputSchema);
      if (Object.keys(parameters.properties ?? {}).some(key => serverFields.has(key))) throw new Error();
      // The server still validates using the original Zod tool schema before execution.
      const validator = z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]);
      validators.set(tool.name, validator);
      // Some registered schemas have optional fields, so do not silently rewrite them to strict mode.
      return { type: 'function' as const, name: tool.name, description: tool.description, parameters, strict: false };
    } catch {
      throw new Error('MODEL_TOOL_SCHEMA_INVALID');
    }
  });
  return { functions, validators };
}

type ProviderTrace = Readonly<{ callId: string; outputItems: string }>;

function parseOutput(value: unknown, validators: Map<string, z.ZodType>, remember: (trace: ProviderTrace, name: string) => void): unknown {
  try {
    const response = Response.parse(value);
    if (response.error != null || response.incomplete_details != null) throw new Error();
    if (response.output.some(item => item.status != null && item.status !== 'completed')) throw new Error();
    const actions = response.output.filter(item => item.type !== 'reasoning');
    if (actions.length !== 1) throw new Error();
    const action = actions[0];
    if (action.type === 'function_call') {
      if (response.output.some(item => item.type === 'reasoning' &&
        (typeof item.encrypted_content !== 'string' || !item.encrypted_content))) throw new Error();
      const call = FunctionCall.parse(action);
      const validator = validators.get(call.name);
      if (!validator) throw new Error();
      const input: unknown = JSON.parse(call.arguments);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      if (Object.keys(input).some(key => serverFields.has(key)) || !validator.safeParse(input).success) throw new Error();
      const providerTrace = Object.freeze({ callId: call.call_id, outputItems: JSON.stringify(response.output) });
      remember(providerTrace, call.name);
      return { kind: 'tool_call', name: call.name, input, providerTrace };
    }
    const message = Message.parse(action);
    return FinalDecision.parse(JSON.parse(message.content[0].text));
  } catch {
    throw new Error('MODEL_OUTPUT_INVALID');
  }
}

export function createResponsesModel(apiKey: string, fetcher: typeof fetch = fetch): ModelPort {
  if (!apiKey.trim()) throw new Error('A project API key is required');
  // Weak keys verify provenance without retaining transcripts beyond the graph run.
  const trustedTraces = new WeakMap<object, { scope: string; name: string }>();
  return {
    async decide(input) {
      const { functions, validators } = prepareTools(input.tools);
      let scope: string;
      const items: unknown[] = [
        { role: 'developer', content: PLANNING_PROMPT },
        { role: 'user', content: JSON.stringify({ message: input.message, context: input.context }) },
      ];
      try {
        scope = createHash('sha256').update(JSON.stringify([input.userId, input.message, input.context, input.tools])).digest('hex');
        const callIds = new Set<string>();
        for (const observation of input.observations) {
          const trace = observation.providerTrace;
          if (!trace || typeof trace !== 'object') throw new Error();
          const trusted = trustedTraces.get(trace);
          if (!trusted || trusted.scope !== scope || trusted.name !== observation.name) throw new Error();
          const stored = trace as ProviderTrace;
          if (callIds.has(stored.callId)) throw new Error();
          callIds.add(stored.callId);
          const outputs: unknown = JSON.parse(stored.outputItems);
          if (!Array.isArray(outputs)) throw new Error();
          const call = FunctionCall.parse(outputs.find(item => item?.type === 'function_call' && item.call_id === stored.callId));
          if (call.name !== observation.name || !isDeepStrictEqual(JSON.parse(call.arguments), observation.input)) throw new Error();
          items.push(...outputs, { type: 'function_call_output', call_id: stored.callId, output: JSON.stringify(observation.result) ?? 'null' });
        }
      } catch {
        throw new Error('MODEL_CONTINUATION_INVALID');
      }
      let response: globalThis.Response;
      try {
        response = await fetcher('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            model: MODEL_ID,
            reasoning: { effort: REASONING_EFFORT },
            store: false,
            include: ['reasoning.encrypted_content'],
            max_output_tokens: 4096,
            parallel_tool_calls: false,
            tools: functions,
            text: { format: { type: 'json_object' } },
            input: items,
          }),
        });
      } catch {
        throw new Error('MODEL_REQUEST_FAILED');
      }
      if (!response.ok) throw new Error('MODEL_REQUEST_FAILED');
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error('MODEL_OUTPUT_INVALID');
      }
      return parseOutput(value, validators, (trace, name) => trustedTraces.set(trace, { scope, name }));
    },
  };
}
