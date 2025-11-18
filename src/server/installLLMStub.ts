const DEFAULT_LATENCY_MS = 120;

interface LlmStubOptions {
  enabled?: boolean;
  latencyMs?: number;
}

declare global {
  interface Window {
    __HLSF_LLM_STUB_INSTALLED__?: boolean;
  }
}

export function installLLMStub(options: LlmStubOptions = {}): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return;
  }
  if (window.__HLSF_LLM_STUB_INSTALLED__) {
    return;
  }
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveUrl(input);
    if (url && url.pathname === '/api/llm') {
      return handleStubRequest(init, options.latencyMs ?? DEFAULT_LATENCY_MS);
    }
    return originalFetch(input, init);
  };
  window.__HLSF_LLM_STUB_INSTALLED__ = true;
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  if (typeof input === 'string') {
    return new URL(input, window.location.origin);
  }
  if (input instanceof URL) {
    return input;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new URL(input.url);
  }
  return null;
}

async function handleStubRequest(init: RequestInit | undefined, latencyMs: number): Promise<Response> {
  const payload = await readJsonBody(init?.body);
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const content = synthesizeStubContent(messages);
  const responsePayload = {
    model: 'offline-hlsf-stub',
    temperature: 0.2,
    choices: [
      {
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
    usage: {
      promptTokens: Math.round((JSON.stringify(messages).length || 0) / 4),
      completionTokens: content.split(/\s+/).length,
    },
  };
  if (latencyMs > 0) {
    await new Promise(resolve => setTimeout(resolve, latencyMs));
  }
  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJsonBody(body: BodyInit | null | undefined): Promise<any> {
  if (!body) return {};
  if (typeof body === 'string') {
    return safeParse(body);
  }
  try {
    const text = await new Response(body).text();
    return safeParse(text);
  } catch (error) {
    console.warn('LLM stub failed to read request body:', error);
    return {};
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

interface ChatMessage {
  role: string;
  content?: string;
}

const AXIS_LABELS = ['horizontal', 'longitudinal', 'sagittal'] as const;
type AxisLabel = (typeof AXIS_LABELS)[number];

export function synthesizeStubContent(messages: ChatMessage[]): string {
  const userMessage = [...messages].reverse().find(message => message.role === 'user');
  const prompt = extractPrompt(userMessage?.content ?? '');
  const thoughts = extractThoughts(userMessage?.content ?? '');
  const axis = AXIS_LABELS[thoughts.axisIndex];
  const summary = thoughts.lines.length
    ? thoughts.lines.map(line => line.replace(/^[-•]\s*/, '').trim()).filter(Boolean).slice(0, 4)
    : [];
  const axisInsights = buildAxisSentences(userMessage?.content ?? '');
  const detailSections = [];
  if (summary.length) {
    detailSections.push(`Key rotation notes: ${summary.join('; ')}.`);
  }
  if (axisInsights.length) {
    detailSections.push(axisInsights.join(' '));
  }
  const body = detailSections.length
    ? detailSections.join(' ')
    : 'No internal rotation notes were provided, so this stub synthesizes a concise response.';
  return [
    '[offline stub] integrating rotation previews.',
    `Prompt focus: ${prompt || 'unspecified intent'}.`,
    `${capitalize(axis)} axis emphasis.`,
    body,
  ]
    .filter(Boolean)
    .join(' ');
}

export function extractPrompt(content: string): string {
  const match = content.match(/Prompt:\s*\n?([^]+?)(?:\n\n|$)/);
  if (match) {
    return match[1].split('\n')[0].trim();
  }
  const withoutReference = content.replace(/Reference answer:[\s\S]+$/i, '').trim();
  if (withoutReference) {
    return withoutReference.split('\n')[0].trim().slice(0, 140);
  }
  const focusMatch = content.match(/Prompt focus:\s*([^\n]+)/i);
  if (focusMatch) {
    return focusMatch[1].trim();
  }
  return content.trim().slice(0, 140);
}

function extractThoughts(content: string): { lines: string[]; axisIndex: number } {
  const match = content.match(/Internal thought summaries[^`]*```([\s\S]+?)```/);
  if (!match) {
    const axisLines = deriveAxisSummaryLines(content);
    if (axisLines.length) {
      return { lines: axisLines, axisIndex: axisLines.length % AXIS_LABELS.length };
    }
    return { lines: [], axisIndex: 0 };
  }
  const lines = match[1].split(/\n+/).map(line => line.trim()).filter(Boolean);
  const axisIndex = lines.length % AXIS_LABELS.length;
  return { lines, axisIndex };
}

function deriveAxisSummaryLines(content: string): string[] {
  return deriveAxisSummaries(content).map(entry => `${capitalize(entry.axis)} axis intersections: ${entry.summary}`);
}

interface AxisSummary {
  axis: AxisLabel;
  summary: string;
}

function deriveAxisSummaries(content: string): AxisSummary[] {
  const buckets: Record<AxisLabel, string[]> = {
    horizontal: [],
    longitudinal: [],
    sagittal: [],
  };
  const lines = content.split(/\n+/);
  let currentAxis: AxisLabel | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.toLowerCase();
    const axisMatch = AXIS_LABELS.find(label => normalized.startsWith(label));
    if (axisMatch) {
      currentAxis = axisMatch;
      const detail = extractAxisDetail(line);
      if (detail) {
        buckets[currentAxis].push(detail);
      }
      continue;
    }
    if (currentAxis && /^\d+\./.test(line)) {
      buckets[currentAxis].push(line);
    }
  }
  return AXIS_LABELS.map(axis => {
    const summary = summarizeAxisDetails(buckets[axis]);
    return summary ? { axis, summary } : null;
  }).filter((entry): entry is AxisSummary => Boolean(entry));
}

function extractAxisDetail(line: string): string {
  const parts = line.split(':');
  if (parts.length > 1) {
    return parts.slice(1).join(':').trim();
  }
  const dashIndex = line.indexOf('-');
  if (dashIndex >= 0) {
    return line.slice(dashIndex + 1).trim();
  }
  return line.trim();
}

function summarizeAxisDetails(lines: string[]): string | null {
  const segments: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, ' ').replace(/→/g, ' → ').trim();
    if (!normalized) continue;
    const numbered = extractNumberedSegments(normalized);
    if (numbered.length) {
      for (const segment of numbered) {
        segments.push(segment);
        if (segments.length === 3) break;
      }
    } else {
      segments.push(normalized);
    }
    if (segments.length === 3) break;
  }
  if (!segments.length) {
    return null;
  }
  return segments.join('; ');
}

function extractNumberedSegments(detail: string): string[] {
  const results: string[] = [];
  const re = /(?:\d+\.\s*)([\s\S]+?)(?=\d+\.|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(detail))) {
    const fragment = match[1].trim();
    if (fragment) {
      results.push(fragment.replace(/\s*→\s*/g, ' → '));
    }
  }
  return results;
}

function buildAxisSentences(content: string): string[] {
  return deriveAxisSummaries(content).map(entry => `${capitalize(entry.axis)} axis intersections: ${entry.summary}.`);
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

