export interface LlmCallRequest {
  prompt: string;
  messages?: Array<{ role: string; content: string }>;
  endpoint?: string;
  apiKey?: string;
  interpretationText?: string;
  rawText?: string;
  contextBlock?: string;
  mode?: 'normal' | 'compress' | 'expand';
}

export interface LlmCallResponse {
  emergent_trace?: string | string[];
  structured_response?: string;
  raw?: unknown;
  provider?: Record<string, unknown>;
  status?: number;
  endpoint?: string;
  lengthStatus?: 'ok' | 'length_violation';
}

export class StubLLMClient {
  private abortController = new AbortController();

  async call(request: LlmCallRequest, options?: CallLlmOptions): Promise<LlmCallResponse> {
    return callLLM(request, options);
  }

  shouldAbort(): boolean {
    return this.abortController.signal.aborted;
  }

  async expandAdjacency(_thought?: unknown, _depth?: number, _maxDepth?: number): Promise<{ nodes: any[]; edges: any[] }> {
    return { nodes: [], edges: [] };
  }

  async articulateResponse(..._args: unknown[]): Promise<string> {
    return 'LLM articulation is unavailable in stub mode.';
  }
}

const runtimeEnv = (import.meta as any)?.env ?? {};
const DEFAULT_LLM_ENDPOINT = '/api/llm';
const REQUEST_TIMEOUT_MS = 30000;

export function resolveEndpoint(): string {
  const endpoint = (runtimeEnv.VITE_LLM_ENDPOINT as string | undefined) ?? DEFAULT_LLM_ENDPOINT;
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:' && trimmed.startsWith('/')) {
    throw new Error('LLM endpoint must be absolute when using file:// builds.');
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
  const traceMatch = text.match(/Emergent Thought Trace:\s*([\s\S]*?)\n\s*Structured Response:/i);
  const responseMatch = text.match(/Structured Response:\s*([\s\S]*)/i);
  const emergent = traceMatch?.[1]?.trim();
  const response = responseMatch?.[1]?.trim();
  return {
    emergent_trace: emergent?.length ? emergent.split(/\n+/).map(line => line.trim()).filter(Boolean) : undefined,
    structured_response: response,
  };
}

function countWords(text: string | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function buildLengthAdjustedPrompt(request: LlmCallRequest, target: 'compress' | 'expand'): LlmCallRequest {
  const directive =
    target === 'compress'
      ? 'Your previous response exceeded 300 words. Compress the structured response to 300 words or fewer while preserving key points.'
      : 'Your previous response was under 30 words. Expand the structured response to at least 30 words with 2–3 concrete points.';
  return {
    ...request,
    mode: target,
    prompt: `${request.prompt}\n\n${directive}`,
    contextBlock: request.contextBlock,
  };
}

export interface CallLlmOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function callLLM(
  request: LlmCallRequest,
  options: CallLlmOptions = {},
): Promise<LlmCallResponse> {
  const endpoint = resolveEndpoint();
  const url = resolveUrl(request.endpoint || endpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let attempt = 0;
  let lastError: any = null;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const controller = new AbortController();
      const response = await withTimeout(
        executeFetch(
          url,
          {
            messages: request.messages,
            prompt: request.prompt,
            interpretationText: request.interpretationText,
            rawText: request.rawText,
            context: request.contextBlock,
            mode: request.mode,
          },
          request.apiKey,
          fetchImpl,
          controller.signal,
        ),
        timeoutMs,
        controller,
      );

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        if (attempt < maxAttempts && isTransientStatus(response.status)) {
          const delay = 200 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        const error = new Error(`LLM backend failed (HTTP ${response.status})`);
        (error as any).status = response.status;
        (error as any).bodySnippet = bodyText.slice(0, 240);
        (error as any).endpoint = url;
        throw error;
      }

      const contentType = response.headers.get('content-type') || '';
      const rawBody = await response.text();
      let parsed: any = null;
      if (contentType.includes('application/json')) {
        parsed = JSON.parse(rawBody);
      } else if (/Emergent Thought Trace:/i.test(rawBody) || /Structured Response:/i.test(rawBody)) {
        parsed = parseEmergentSections(rawBody);
      } else {
        const error = new Error('Unexpected response format from LLM backend');
        (error as any).status = response.status || 500;
        (error as any).bodySnippet = rawBody.slice(0, 240);
        (error as any).endpoint = url;
        throw error;
      }

      const emergentTrace = parsed?.emergent_trace;
      const structuredResponse = parsed?.structured_response ?? parsed?.articulatedResponse ?? parsed?.response;
      const wordCount = countWords(structuredResponse);
      let lengthStatus: LlmCallResponse['lengthStatus'] = 'ok';
      let finalResponse = structuredResponse as string;

      if (wordCount > 300 || wordCount < 30) {
        lengthStatus = 'length_violation';
        const targetMode = wordCount > 300 ? 'compress' : 'expand';
        if (attempt < maxAttempts) {
          const adjustedRequest = buildLengthAdjustedPrompt(request, targetMode);
          request = adjustedRequest;
          attempt = 0;
          continue;
        }
      }

      return {
        emergent_trace: emergentTrace,
        structured_response: finalResponse,
        provider: parsed?.provider,
        raw: parsed,
        status: response.status,
        endpoint: url,
        lengthStatus,
      };
    } catch (error: any) {
      lastError = error;
      if (error?.name === 'AbortError') {
        const abortErr = new Error('LLM backend failed (timeout)');
        (abortErr as any).endpoint = url;
        throw abortErr;
      }
      if (attempt >= maxAttempts || !isTransientStatus(error?.status)) {
        const err = new Error(error?.message || 'LLM backend failed');
        (err as any).status = error?.status;
        (err as any).endpoint = error?.endpoint || url;
        (err as any).bodySnippet = error?.bodySnippet
          ? redact(error.bodySnippet)
          : error?.body
            ? redact(error.body)
            : undefined;
        throw err;
      }
      const delay = 200 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const err = new Error(lastError?.message || 'LLM backend failed');
  (err as any).status = lastError?.status;
  (err as any).endpoint = lastError?.endpoint || resolveUrl(endpoint);
  (err as any).bodySnippet = lastError?.bodySnippet;
  throw err;
}
