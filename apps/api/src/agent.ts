import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { formDraft } from './chat-context.ts';

export const phoneRequestDecision = z.strictObject({ kind: z.literal('phone_request'), text: z.string().trim().min(1).max(2000),
  itemId: z.string().trim().min(1).max(200), expectedRevision: z.number().int().positive().safe() });
export const callReviewDecision = z.strictObject({ kind: z.literal('call_review'), text: z.string().trim().min(1).max(2000),
  location: z.string().trim().min(1).max(200).nullable() });
export const reminderRequestDecision = z.strictObject({ kind: z.literal('reminder_request'), text: z.string().trim().min(1).max(2000),
  itemId: z.string().trim().min(1).max(200), expectedRevision: z.number().int().positive().safe(),
  minutesBefore: z.number().int().min(0).max(1440), basis: z.enum(['event_start', 'departure']),
  destinationPlaceId: z.string().trim().min(1).max(100).optional() });
export const chatSuggestions = z.array(z.strictObject({
  label: z.string().max(60).refine(value => !!value.trim()),
  message: z.string().max(500).refine(value => !!value.trim()),
})).min(1).max(2);
const Decision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: z.string().min(1), suggestions: chatSuggestions.optional() }),
  z.object({ kind: z.literal('question'), text: z.string().min(1), missingFields: z.array(z.string()).default([]), suggestions: chatSuggestions.optional() }),
  z.object({ kind: z.literal('draft'), text: z.string().min(1), draft: formDraft }).strict(),
  z.object({ kind: z.literal('proposal'), reason: z.string(), changeSet: z.object({ changes: z.array(z.unknown()), timingConstraints: z.array(z.unknown()).optional() }), evidenceRefs: z.array(z.string()) }),
  phoneRequestDecision, callReviewDecision, reminderRequestDecision,
  z.object({ kind: z.literal('tool_call'), name: z.string(), input: z.unknown(), providerTrace: z.unknown().optional() }),
]);
export type AgentDecision = z.infer<typeof Decision>;
export type Observation = { name: string; input?: unknown; result: unknown; providerTrace?: unknown };
export type AgentInput = { userId: string; message: string; context: Record<string, unknown> };
// Only model and read-only tool failures carry this tag; proposal validation remains separate.
export class AgentExecutionFailure extends Error {}
export interface ModelPort {
  decide(input: AgentInput & {
    observations: Observation[];
    tools: { name: string; description: string; inputSchema: unknown }[];
  }, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export type AgentMetrics = { modelCalls: number; modelMs: number; toolCalls: number; toolMs: number; modelActiveAt?: number; toolActiveAt?: number };
// Only read/calculation tools are exposed to the reasoning loop.
// Approved mutations belong to a separate application service.
export interface ReadTool {
  name: string;
  description: string;
  input: z.ZodType;
  run(input: unknown, userId: string): Promise<unknown>;
}
export function createPlanningAgent(options: {
  model: ModelPort;
  tools: ReadTool[];
  validateProposal: (decision: Extract<AgentDecision, { kind: 'proposal' }>, userId: string) => Promise<string[]>;
  maxSteps?: number;
  signal?: AbortSignal;
  metrics?: AgentMetrics;
}) {
  const tools = new Map(options.tools.map(tool => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error('Duplicate tool name');
  const maxSteps = options.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('Invalid step limit');
  const State = new StateSchema({
    userId: z.string(), message: z.string(), context: z.record(z.string(), z.unknown()),
    observations: z.array(z.object({ name: z.string(), input: z.unknown().optional(), result: z.unknown(), providerTrace: z.unknown().optional() })).default([]),
    decision: Decision.nullable().default(null), steps: z.number().default(0),
    validationErrors: z.array(z.string()).default([]),
  });
  return new StateGraph(State)
    .addNode('reason', async state => {
      if (state.steps >= maxSteps) throw new AgentExecutionFailure('AGENT_STEP_LIMIT');
      try {
        options.signal?.throwIfAborted();
        const started = performance.now();
        if (options.metrics) { options.metrics.modelCalls++; options.metrics.modelActiveAt = started; }
        let output: unknown;
        try { output = await options.model.decide({
          userId: state.userId, message: state.message, context: state.context,
          observations: state.observations,
          tools: options.tools.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) })),
        }, { signal: options.signal }); } finally { if (options.metrics) { options.metrics.modelMs += performance.now() - started; delete options.metrics.modelActiveAt; } }
        options.signal?.throwIfAborted();
        const decision = Decision.parse(output);
        return { decision, steps: state.steps + 1 };
      } catch { throw new AgentExecutionFailure('AGENT_MODEL_FAILURE'); }
    })
    .addNode('read_tool', async state => {
      try {
        options.signal?.throwIfAborted();
        const decision = state.decision;
        if (decision?.kind !== 'tool_call') throw new Error('Unexpected tool transition');
        const tool = tools.get(decision.name);
        if (!tool) throw new Error('TOOL_NOT_ALLOWED');
        const input = tool.input.parse(decision.input);
        const started = performance.now();
        if (options.metrics) { options.metrics.toolCalls++; options.metrics.toolActiveAt = started; }
        let result: unknown;
        try { result = await tool.run(input, state.userId); }
        finally { if (options.metrics) { options.metrics.toolMs += performance.now() - started; delete options.metrics.toolActiveAt; } }
        options.signal?.throwIfAborted();
        return { observations: [...state.observations, { name: tool.name, input, result,
          ...(decision.providerTrace === undefined ? {} : { providerTrace: decision.providerTrace }) }] };
      } catch { throw new AgentExecutionFailure('AGENT_READ_FAILURE'); }
    })
    .addNode('validate', async state => {
      if (state.decision?.kind !== 'proposal') throw new Error('Unexpected proposal transition');
      options.signal?.throwIfAborted();
      const validationErrors = await options.validateProposal(state.decision, state.userId);
      options.signal?.throwIfAborted();
      return { validationErrors };
    })
    .addEdge(START, 'reason')
    .addConditionalEdges('reason', state => state.decision?.kind === 'tool_call' ? 'read_tool' : state.decision?.kind === 'proposal' ? 'validate' : END)
    .addEdge('read_tool', 'reason')
    .addEdge('validate', END)
    .compile();
}
