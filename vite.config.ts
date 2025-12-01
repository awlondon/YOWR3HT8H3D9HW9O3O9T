import { defineConfig, type PluginOption } from 'vite';
import type { IncomingMessage } from 'node:http';

import { synthesizeStubContent } from './src/server/installLLMStub.js';

const llmStubMode = String(process.env.VITE_ENABLE_LLM_STUB ?? 'auto').toLowerCase();
const devStubEnabled = llmStubMode !== 'off' && llmStubMode !== 'false';

function llmStubMiddleware(): PluginOption {
  return {
    name: 'hlsf-llm-stub',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/llm')) {
          next();
          return;
        }

        try {
          const payload = await readJsonBody(req);
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
              completionTokens: content.split(/\s+/).filter(Boolean).length,
            },
            endpoint: 'vite-dev-stub',
          };

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(responsePayload));
        } catch (error) {
          console.error('LLM stub middleware failed:', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'LLM stub failed' }));
        }
      });
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export default defineConfig(({ command }) => {
  const useStub = devStubEnabled && command === 'serve';

  return {
    base: './',
    server: {
      host: true,
      port: 5173,
      proxy: useStub
        ? undefined
        : {
            '/api': 'http://localhost:3001',
          },
    },
    plugins: useStub ? [llmStubMiddleware()] : [],
  };
});
