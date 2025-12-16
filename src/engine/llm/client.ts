import { updateLlmDiagnostics } from '../../state/llmDiagnostics.js';

export interface LlmContext {
  hub: string;
  neighbors: string[];
  activeContexts: string[];
  rotationNotes: string;
  graphStats: { depth: number; nodes: number; branches: number };
}

export interface LlmRequirements {
  structuredResponseWords: { min: number; max: number };
  traceBullets: { min: number; max: number };
}

export interface LlmClientInfo {
  app: string;
  build: string;
  requestId: string;
}

export interface LlmCallRequest {
  prompt: string;
  context: LlmContext;
  requirements?: LlmRequirements;
  client?: LlmClientInfo;
  mode?: 'normal' | 'compress' | 'expand';
  messages?: Array<{ role: string; content: string }>;
  interpretationText?: string;
  rawText?: string;
}

export interface LlmCallResponse {
  emergent_trace?: string | string[];
  structured_response?: string;
  raw?: unknown;
  provider?: Record<string, unknown>;
  status?: number;
  endpoint?: string;
  lengthStatus?: 'ok' | 'length_violation';
  wordCount?: number;
}

export interface CallLlmOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const runtimeEnv = (import.meta as any)?.env ?? {};
const DEFAULT_LLM_ENDPOINT = '/api/llm';
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_REQUIREMENTS: LlmRequirements = {
  structuredResponseWords: { min: 30, max: 300 },
  traceBullets: { min: 4, max: 8 },
};

function ensureRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function resolveEndpoint(): string {
  const endpoint = (runtimeEnv.VITE_LLM_ENDPOINT as string | undefined) ?? DEFAULT_LLM_ENDPOINT;
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:' && trimmed.startsWith('/')) {
    throw new Error('When running from file://, VITE_LLM_ENDPOINT must be an absolute URL.');
  }
  return trimmed || DEFAULT_LLM_ENDPOINT;
}

function resolveUrl(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(endpoint, window.location.origin).toString();
  }
  return new URL(endpoint, 'http://localhost').toString();
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function redact(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/Bearer\s+[^\s]+/gi, 'Bearer ***');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const result = await promise;
    clearTimeout(timeout);
    return result;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function executeFetch(
  url: string,
  payload: unknown,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
}

function parseEmergentSections(text: string): { emergent_trace?: string | string[]; structured_response?: string } {
  const traceMatch = text.match(/Emergent Trace:\s*([\s\S]*?)\n\s*Structured Response:/i);
  const responseMatch = text.match(/Structured Response:\s*([\s\S]*)/i);
  const emergent = traceMatch?.[1]?.trim();
  const response = responseMatch?.[1]?.trim();
  return {
    emergent_trace: emergent?.length ? emergent.split(/\n+/).map(line => line.trim()).filter(Boolean) : undefined,
    structured_response: response || text,
  };
}

function countWords(text: string | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function buildMessages(request: LlmCallRequest, priorResponse?: string): Array<{ role: string; content: string }> {
  if (Array.isArray(request.messages) && request.messages.length) {
    return request.messages;
  }
  const requirements = request.requirements ?? DEFAULT_REQUIREMENTS;
  const systemPrompt = [
    'You synthesize answers from a localized semantic field graph context.',
    'Output TWO sections:',
    '1) Emergent Trace: 4–8 bullet points describing which provided context you used (no hidden reasoning).',
    '2) Structured Response: 30–300 words, coherent, relevant to the user prompt and the provided context.',
  ].join(' ');

  const userLines = [
    `Prompt: ${request.prompt}`,
    'CONVERGED TRACE CONTEXT (authoritative):',
    `Hub: ${request.context.hub}`,
    `Top neighbors: ${request.context.neighbors.join(', ') || 'n/a'}`,
    `Active contexts: ${request.context.activeContexts.join(' | ') || 'n/a'}`,
    `Rotation notes: ${request.context.rotationNotes || 'n/a'}`,
    `Stats: depth=${request.context.graphStats.depth}; nodes=${request.context.graphStats.nodes}; branches=${request.context.graphStats.branches}`,
  ];

  if (request.mode === 'compress') {
    userLines.push('Instruction: compress the structured response to 300 words or fewer.');
  } else if (request.mode === 'expand') {
    userLines.push('Instruction: expand the structured response to 30–300 words.');
  }

  if (priorResponse) {
    userLines.push('Previous response:', priorResponse);
  }

  userLines.push(
    `Constraints: emergent trace bullets ${requirements.traceBullets.min}-${requirements.traceBullets.max}; structured response ${requirements.structuredResponseWords.min}-${requirements.structuredResponseWords.max} words.`,
  );

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userLines.join('\n') },
  ];
}

function normalizeResponse(rawBody: string, contentType: string, url: string, status: number): any {
  if (contentType.includes('application/json')) {
    return JSON.parse(rawBody);
  }
  if (/Emergent Trace:/i.test(rawBody) || /Structured Response:/i.test(rawBody)) {
    console.warn('LLM backend returned plain text; parsing heuristically.');
    return parseEmergentSections(rawBody);
  }
  const error = new Error('Unexpected response format from LLM backend');
  (error as any).status = status || 500;
  (error as any).bodySnippet = rawBody.slice(0, 240);
  (error as any).endpoint = url;
  throw error;
}

function buildPayload(request: LlmCallRequest): Record<string, unknown> {
  const requirements = request.requirements ?? DEFAULT_REQUIREMENTS;
  return {
    prompt: request.prompt,
    context: request.context,
    requirements,
    client: request.client,
    mode: request.mode ?? 'normal',
    messages: buildMessages(request),
  };
}

function applyLengthAdjustment(
  request: LlmCallRequest,
  target: 'compress' | 'expand',
  structuredResponse: string,
): LlmCallRequest {
  return {
    ...request,
    mode: target,
    messages: buildMessages(request, structuredResponse).concat({
      role: 'user',
      content: target === 'compress' ? 'Compress to <= 300 words.' : 'Expand to 30–300 words.',
    }),
  };
}

export async function callLLM(
  request: LlmCallRequest,
  options: CallLlmOptions = {},
): Promise<LlmCallResponse> {
  const endpoint = resolveEndpoint();
  const url = resolveUrl(endpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const clientInfo: LlmClientInfo = request.client ?? {
    app: 'hlsf-cognition-engine',
    build: runtimeEnv.VITE_APP_BUILD || runtimeEnv.VITE_COMMIT_SHA || 'dev',
    requestId: ensureRequestId(),
  };

  updateLlmDiagnostics({ endpoint: url, stubEnabled: false, stubReason: '', requestId: clientInfo.requestId });

  const payload = buildPayload({ ...request, client: clientInfo });
  let attempt = 0;
  let lastError: any = null;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const controller = new AbortController();
      const response = await withTimeout(
        executeFetch(url, payload, undefined, fetchImpl, controller.signal),
        timeoutMs,
        controller,
      );

      const contentType = response.headers.get('content-type') || '';
      const rawBody = await response.text();

      if (!response.ok) {
        if (attempt < maxAttempts && isTransientStatus(response.status)) {
          await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, attempt - 1)));
          continue;
        }
        const error = new Error(`LLM backend failed (HTTP ${response.status})`);
        (error as any).status = response.status;
        (error as any).bodySnippet = rawBody.slice(0, 240);
        (error as any).endpoint = url;
        throw error;
      }

      const parsed = normalizeResponse(rawBody, contentType, url, response.status);
      const emergentTrace = parsed?.emergent_trace;
      const structuredResponse = parsed?.structured_response ?? parsed?.articulatedResponse ?? parsed?.response;
      const wordCount = countWords(structuredResponse);
      let lengthStatus: LlmCallResponse['lengthStatus'] = 'ok';

      if (wordCount > DEFAULT_REQUIREMENTS.structuredResponseWords.max ||
          wordCount < DEFAULT_REQUIREMENTS.structuredResponseWords.min) {
        lengthStatus = 'length_violation';
        if (request.mode !== 'compress' && request.mode !== 'expand') {
          const target = wordCount > 300 ? 'compress' : 'expand';
          const adjusted = applyLengthAdjustment({ ...request, client: clientInfo }, target, structuredResponse);
          return callLLM(adjusted, { ...options, timeoutMs });
        }
      }

      const result: LlmCallResponse = {
        emergent_trace: emergentTrace,
        structured_response: structuredResponse,
        provider: parsed?.provider,
        raw: parsed,
        status: response.status,
        endpoint: url,
        lengthStatus,
        wordCount,
      };

      updateLlmDiagnostics({ lastStatus: response.status ?? null, lastError: null });

      if (runtimeEnv.DEV) {
        console.debug('LLM call', {
          endpoint: url,
          requestId: clientInfo.requestId,
          status: response.status,
          lengthStatus,
          wordCount,
        });
      }

      return result;
    } catch (error: any) {
      lastError = error;
      if (error?.name === 'AbortError') {
        const abortErr = new Error('LLM backend failed (timeout)');
        (abortErr as any).endpoint = url;
        updateLlmDiagnostics({ lastError: abortErr.message, lastStatus: null });
        throw abortErr;
      }
      if (attempt >= maxAttempts || !isTransientStatus(error?.status)) {
        const err = new Error(error?.message || 'LLM backend failed');
        (err as any).status = error?.status;
        (err as any).endpoint = error?.endpoint || url;
        (err as any).bodySnippet = error?.bodySnippet ? redact(error.bodySnippet) : error?.body;
        updateLlmDiagnostics({ lastError: err.message, lastStatus: error?.status ?? null });
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, attempt - 1)));
    }
  }

  const err = new Error(lastError?.message || 'LLM backend failed');
  (err as any).status = lastError?.status;
  (err as any).endpoint = lastError?.endpoint || url;
  (err as any).bodySnippet = lastError?.bodySnippet;
  updateLlmDiagnostics({ lastError: err.message, lastStatus: lastError?.status ?? null });
  throw err;
}

export { DEFAULT_REQUIREMENTS };
