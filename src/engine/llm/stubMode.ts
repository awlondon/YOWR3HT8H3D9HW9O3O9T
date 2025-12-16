export type StubMode = 'on' | 'off' | 'auto';

export function getStubMode(env: Record<string, any> = (import.meta as any)?.env ?? {}): {
  enabled: boolean;
  mode: StubMode;
  reason: string;
} {
  const mode = (env.VITE_ENABLE_LLM_STUB ?? 'auto') as StubMode;

  if (mode === 'on') return { enabled: true, mode, reason: 'env:on' };
  if (mode === 'off') return { enabled: false, mode, reason: 'env:off' };

  const endpoint = (env.VITE_LLM_ENDPOINT ?? '/api/llm').trim();
  const isDev = !!env.DEV;

  if (endpoint && endpoint !== '/api/llm') {
    return { enabled: false, mode, reason: 'auto:endpoint-configured' };
  }

  if (isDev) return { enabled: true, mode, reason: 'auto:dev-default' };

  return { enabled: false, mode, reason: 'auto:prod' };
}
