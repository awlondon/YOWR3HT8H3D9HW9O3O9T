export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal | null;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAIChatResult {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function normalizeErrorMessage(status: number | null, message: string): string {
  if (status === 401) return 'OpenAI rejected the API key. Use the 🔑 button to update it.';
  if (status === 403) return 'OpenAI denied access. Verify billing status or key permissions.';
  if (status === 429) return 'OpenAI rate limit exceeded. Try again shortly.';
  if (status && status >= 500) return 'OpenAI service is temporarily unavailable. Please retry.';
  return message || 'OpenAI request failed.';
}

export async function callOpenAIChat(
  messages: OpenAIChatMessage[],
  options: OpenAIChatOptions,
): Promise<OpenAIChatResult> {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('OpenAI chat requires at least one message');
  }
  if (!options?.apiKey) {
    throw new Error('Missing OpenAI API key');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryDelayMs = Math.max(100, options.retryDelayMs ?? 250);

  const body = {
    model: options.model,
    messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal ?? undefined,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('OpenAI chat error', {
          status: response.status,
          attempt,
          body: errorText,
        });
        if (RETRIABLE_STATUS.has(response.status) && attempt < maxRetries) {
          await delay(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        let parsedMessage = errorText;
        try {
          const parsed = JSON.parse(errorText);
          parsedMessage = parsed?.error?.message || errorText;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(normalizeErrorMessage(response.status, parsedMessage));
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      return { content, usage: data.usage };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw error;
      }
      console.error('OpenAI chat request failed', { attempt, error });
      if (attempt < maxRetries) {
        await delay(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
      throw new Error(normalizeErrorMessage(null, (error as Error).message));
    }
  }

  throw new Error('OpenAI chat failed after retries');
}
