import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { createPlanningAgent } from '../apps/api/src/agent.ts';
import { createResponsesModel, MODEL_ID, REASONING_EFFORT } from '../apps/api/src/model.ts';
import { PlanningService } from '../apps/api/src/planning-service.ts';
import { MemoryPlanningStore } from '../apps/api/src/planning-store.ts';
import { createPlanningTools } from '../apps/api/src/planning-tools.ts';

const syntheticUser = 'pikku-model-verification';
const verificationModel = 'gpt-6.1-terra';
const verificationEffort = 'high';
const timing = {
  appointmentStart: '2030-01-02T15:00:00+09:00',
  preparationMinutes: 15,
  travelMinutes: 30,
  bufferMinutes: 10,
} as const;
const TimingInput = z.strictObject({
  appointmentStart: z.literal(timing.appointmentStart),
  preparationMinutes: z.literal(timing.preparationMinutes),
  travelMinutes: z.literal(timing.travelMinutes),
  bufferMinutes: z.literal(timing.bufferMinutes),
});
const TimingResult = z.strictObject({
  ready: z.literal(true),
  departureAt: z.literal('2030-01-02T05:20:00.000Z'),
  preparationStartAt: z.literal('2030-01-02T05:05:00.000Z'),
});
const prompt = [
  'This is a synthetic verification. Use the calculate_timing function exactly once before answering.',
  'The appointment starts at 2030-01-02T15:00:00+09:00; preparation is 15 minutes, travel is 30 minutes, and buffer is 10 minutes.',
  'Use the function result to answer in Korean with the departure and preparation start times.',
].join(' ');

type FailureReason = 'request_configuration' | 'network' | 'http' | 'response_metadata' | 'tool_input' | 'tool_result' | 'tool_repeated' | 'tool_not_called' | 'final_answer_missing' | 'agent_output';
export type VerificationResult =
  | { status: 'verified'; requests: number; toolCalls: number }
  | { status: 'failed'; reason: FailureReason; requests: number; toolCalls: number; httpStatus?: number };

// Only the explicitly named project variable is read; never copy the file into process.env.
export function readProjectApiKey(projectRoot: string, processKey: string | undefined): string | undefined {
  if (processKey?.trim()) return processKey.trim();
  const root = realpathSync(projectRoot);
  const file = join(root, '.env.local');
  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('PROJECT_KEY_UNAVAILABLE');
  }
  try {
    const resolved = realpathSync(file);
    if (!resolved.startsWith(root + sep)) throw new Error();
    const value = parseEnv(readFileSync(resolved, 'utf8')).PIKKU_OPENAI_API_KEY;
    return value?.trim() || undefined;
  } catch {
    throw new Error('PROJECT_KEY_UNAVAILABLE');
  }
}

// A caller must supply the transport, making accidental live calls in tests avoidable.
export async function verifyModel(apiKey: string, fetcher: typeof fetch): Promise<VerificationResult> {
  let requests = 0;
  let toolCalls = 0;
  let httpStatus: number | undefined;
  let failure: FailureReason | undefined;
  const fail = (reason: FailureReason): never => { failure = reason; throw new Error('VERIFICATION_FAILED'); };

  const guardedFetch: typeof fetch = async (url, init) => {
    if (requests >= 2 || url !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST') return fail('request_configuration');
    let body: unknown;
    try { body = JSON.parse(String(init.body)); } catch { return fail('request_configuration'); }
    const request = z.object({
      model: z.literal(verificationModel),
      reasoning: z.object({ effort: z.literal(verificationEffort) }),
      store: z.literal(false),
      parallel_tool_calls: z.literal(false),
      tools: z.array(z.object({ type: z.literal('function'), name: z.literal('calculate_timing') })).length(1),
    }).passthrough().safeParse(body);
    if (!request.success) return fail('request_configuration');

    requests++;
    let response: Response;
    try { response = await fetcher(url, init); } catch { return fail('network'); }
    httpStatus = response.status;
    if (!response.ok) { failure = 'http'; return response; }
    try {
      const metadata = z.object({
        model: z.literal(verificationModel),
        reasoning: z.object({ effort: z.literal(verificationEffort) }),
      }).passthrough().safeParse(await response.clone().json());
      if (!metadata.success) return fail('response_metadata');
    } catch { return fail('response_metadata'); }
    return response;
  };

  try {
    if (MODEL_ID !== verificationModel || REASONING_EFFORT !== verificationEffort) return fail('request_configuration');
    const service = new PlanningService(new MemoryPlanningStore(), () => new Date('2029-12-31T00:00:00Z'));
    const baseline = await service.capture(syntheticUser, 'Asia/Seoul');
    const original = createPlanningTools(service, baseline).find(tool => tool.name === 'calculate_timing');
    if (!original) return fail('request_configuration');
    const tool = {
      ...original,
      async run(value: unknown, userId: string) {
        if (toolCalls !== 0) return fail('tool_repeated');
        if (userId !== syntheticUser || !TimingInput.safeParse(value).success) return fail('tool_input');
        toolCalls++;
        const result = await original.run(value, userId);
        if (!TimingResult.safeParse(result).success) return fail('tool_result');
        return result;
      },
    };
    const agent = createPlanningAgent({
      model: createResponsesModel(apiKey, guardedFetch),
      tools: [tool],
      validateProposal: async () => ['not_a_verification_answer'],
      maxSteps: 2,
    });
    const result = await agent.invoke({
      userId: syntheticUser,
      message: prompt,
      context: { now: '2029-12-31T00:00:00Z', timezone: 'Asia/Seoul' },
    });
    if (toolCalls !== 1) return fail('tool_not_called');
    if (requests !== 2 || result.decision?.kind !== 'answer') return fail('final_answer_missing');
    return { status: 'verified', requests, toolCalls };
  } catch {
    return { status: 'failed', reason: failure ?? 'agent_output', requests, toolCalls, ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
}

type CliDependencies = { readKey: () => string | undefined; fetcher: typeof fetch; write: (line: string) => void };
export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const report = (value: object) => dependencies.write(JSON.stringify(value));
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    report({ status: 'not_run', reason: 'opt_in_required', command: 'npm run verify:model -- --live' });
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--live') {
    report({ status: 'not_run', reason: 'invalid_arguments' });
    return 2;
  }
  let key: string | undefined;
  try { key = dependencies.readKey(); } catch { report({ status: 'not_run', reason: 'project_key_unavailable' }); return 2; }
  if (!key?.trim()) { report({ status: 'not_configured', requests: 0 }); return 2; }
  const result = await verifyModel(key, dependencies.fetcher);
  report({ ...result, model: verificationModel, reasoningEffort: verificationEffort });
  return result.status === 'verified' ? 0 : 1;
}

// Importing this file for tests never starts a verification.
if (process.argv[1] && resolve(process.argv[1]).endsWith(`${sep}scripts${sep}verify-model.ts`)) {
  const root = resolve(dirname(process.argv[1]), '..');
  void runCli(process.argv.slice(2), {
    readKey: () => readProjectApiKey(root, process.env.PIKKU_OPENAI_API_KEY),
    fetcher: globalThis.fetch,
    write: line => console.log(line),
  }).then(code => { process.exitCode = code; }).catch(() => {
    console.log(JSON.stringify({ status: 'failed', reason: 'verification_unavailable' }));
    process.exitCode = 1;
  });
}
