import http from 'node:http';
import { parse as parseUrl } from 'node:url';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const systemPrompt =
  'You are an interpretation layer for an HLSF cognition engine. Turn adjacency graphs and latent tokens into clear, grammatical English.';

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
    if (!apiKey) {
      sendJson(res, 500, {
        error: 'LLM backend failed',
        details: 'OPENAI_API_KEY is not configured on the backend server.',
      });
      return;
    }

    const payload = await readJsonBody(req);
    const prompt = payload.prompt || payload.hlsfSummary || '';
    const messages = Array.isArray(payload.messages) && payload.messages.length
      ? payload.messages
      : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt || 'Summarize this graph.' },
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
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      sendJson(res, response.status, {
        error: 'LLM backend failed',
        details: errorText || `HTTP ${response.status}`,
      });
      return;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    sendJson(res, 200, {
      articulatedResponse: content,
      model: data?.model,
      usage: data?.usage,
    });
  } catch (error) {
    console.error('LLM backend error:', error);
    sendJson(res, 500, { error: 'LLM backend failed', details: error?.message || 'Unknown error' });
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
