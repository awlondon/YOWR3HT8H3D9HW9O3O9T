import { getStubMode } from './llm/stubMode.js';
import {
  type CallLlmOptions,
  type LlmCallRequest,
  type LlmCallResponse,
  callLLM,
  resolveEndpoint,
} from './llm/client.js';

export { callLLM, resolveEndpoint };
export type { LlmCallRequest, LlmCallResponse, CallLlmOptions };

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
    const stubInfo = getStubMode();
    const endpoint = resolveEndpoint();
    if (!stubInfo.enabled) {
      return 'LLM articulation stub was called but stub mode is disabled.';
    }
    return `Stub mode is ON (reason: ${stubInfo.reason}). Set VITE_ENABLE_LLM_STUB=off and restart. Endpoint: ${endpoint}.`;
  }
}
