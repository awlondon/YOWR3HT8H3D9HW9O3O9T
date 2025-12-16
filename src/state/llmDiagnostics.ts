export interface LlmDiagnosticsState {
  stubEnabled: boolean;
  stubReason: string;
  endpoint: string;
  lastStatus: number | null;
  lastError: string | null;
  requestId: string | null;
}

export const llmDiagnostics: LlmDiagnosticsState = {
  stubEnabled: false,
  stubReason: '',
  endpoint: '',
  lastStatus: null,
  lastError: null,
  requestId: null,
};

export function updateLlmDiagnostics(patch: Partial<LlmDiagnosticsState>): void {
  Object.assign(llmDiagnostics, patch);
}
