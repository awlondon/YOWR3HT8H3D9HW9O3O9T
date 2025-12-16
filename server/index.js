import http from 'node:http';
import { parse as parseUrl } from 'node:url';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const systemPrompt =
  'You are synthesizing an answer from a localized semantic field graph. Provide an emergent trace and a structured response.';

let port = Number(process.env.PORT) || 3001;
let model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
let temperature = Number.isFinite(Number(process.env.LLM_TEMPERATURE))
  ? Number(process.env.LLM_TEMPERATURE)
  : 0.4;
let apiKey = process.env.OPENAI_API_KEY || '';

function refreshConfigFromEnv() {
  port = Number(process.env.PORT) || port;
  model = process.env.OPENAI_MODEL || model;
  temperature = Number.isFinite(Number(process.env.LLM_TEMPERATURE))
    ? Number(process.env.LLM_TEMPERATURE)
    : temperature;
  apiKey = process.env.OPENAI_API_KEY || apiKey;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

async function handleLlmRequest(req, res) {
  try {
    const payload = (await readJsonBody(req)) || {};
    const prompt = (payload?.prompt || payload?.rawText || '').toString().trim();
    const context = (payload?.context || '').toString().trim();

    if (!prompt && !context) {
      sendJson(res, 400, { error: 'Missing prompt or context for LLM request.' });
      return;
    }

    if (!apiKey) {
      sendJson(res, 500, { error: 'Missing OPENAI_API_KEY' });
      return;
    }

    const messages = Array.isArray(payload?.messages) && payload.messages.length
      ? payload.messages
      : [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [prompt, context].filter(Boolean).join('\n\n') },
        ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: 900,
      }),
    });

    if (!response.ok) {
      let errorText = '';
      try {
        const errorJson = await response.json();
        errorText = errorJson?.error?.message || errorJson?.error || JSON.stringify(errorJson);
      } catch {
        errorText = await response.text().catch(() => '');
      }
      sendJson(res, 502, {
        error: {
          message: 'Upstream LLM failed',
          upstream_status: response.status,
          upstream_body_snippet: (errorText || '').slice(0, 240),
        },
      });
      return;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const emergentTraceMatch = content.match(/Emergent Trace:\s*([\s\S]*?)\n\s*Structured Response:/i);
    const structuredMatch = content.match(/Structured Response:\s*([\s\S]*)/i);
    const emergent_trace = emergentTraceMatch?.[1]?.trim() || payload?.emergent_trace;
    const structured_response = structuredMatch?.[1]?.trim() || payload?.structured_response || content;

    sendJson(res, 200, {
      emergent_trace,
      structured_response,
      provider: { model: data?.model, usage: data?.usage },
    });
  } catch (error) {
    sendJson(res, 500, {
      error: { message: error?.response?.data || error?.message || String(error) },
    });
  }
}

async function maybeLoadEnvFile() {
  try {
    const envPath = join(__dirname, '..', '.env');
    const contents = await readFile(envPath, 'utf8');
    contents
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .forEach(line => {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').trim();
        if (key && !(key in process.env)) {
          process.env[key] = value;
        }
      });
  } catch {
    // Optional .env file missing; ignore.
  }

  refreshConfigFromEnv();
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const { pathname } = parseUrl(req.url || '');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
      res.end();
      return;
    }

    if (pathname === '/api/llm' && req.method === 'POST') {
      await handleLlmRequest(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, () => {
    console.log(`LLM backend listening on http://localhost:${port}`);
  });
}

await maybeLoadEnvFile();
createServer();
