import type { CommandHandler, CommandRegistry } from '../../commands/commandRegistry';
import type { VectorConfig } from '../../vector/types';
import {
  DEFAULT_VECTOR_CONFIG,
  attachKnowledgeBase,
  embedAndStore,
  ensureEmbedding as ensureVector,
  hybrid,
  initVector,
  shutdownVector,
  similar,
  status as vectorStatus,
  trainPairs,
} from '../../vector';
import type { KBStore } from '../../kb';

export interface VectorCommandLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface VectorCommandContext {
  ensureToken(text: string): Promise<number>;
  getKnowledgeBase(): Promise<KBStore>;
}

function parseValue(raw: string): unknown {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  return raw;
}

function parseConfig(tokens: string[]): VectorConfig {
  const config: VectorConfig = {
    ...DEFAULT_VECTOR_CONFIG,
    index: { ...DEFAULT_VECTOR_CONFIG.index },
  };
  for (const token of tokens) {
    const [key, ...rest] = token.split('=');
    if (!key) continue;
    const value = rest.join('=');
    switch (key.toLowerCase()) {
      case 'provider':
        config.provider = value as VectorConfig['provider'];
        break;
      case 'dim':
        config.dim = Number.parseInt(value, 10) || config.dim;
        break;
      case 'device':
        config.device = value as VectorConfig['device'];
        break;
      case 'quantize8':
        config.quantize8 = /^true$/i.test(value);
        break;
      case 'normalize':
        config.normalize = /^true$/i.test(value);
        break;
      case 'batchsize':
        config.batchSize = Number.parseInt(value, 10) || config.batchSize;
        break;
      case 'index.type':
        config.index.type = value as VectorConfig['index']['type'];
        break;
      default:
        (config as Record<string, unknown>)[key] = parseValue(value);
        break;
    }
  }
  return config;
}

function parseTrainArgs(args: string[]): { pairs: Array<[string, string]>; epochs: number } {
  const pairs: Array<[string, string]> = [];
  let epochs = 1;
  const tokens = [...args];
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].toLowerCase().startsWith('epochs=')) {
      const raw = tokens.splice(i, 1)[0];
      const value = Number.parseInt(raw.split('=')[1] ?? '1', 10);
      if (Number.isFinite(value) && value > 0) epochs = value;
    }
  }
  for (let i = 0; i < tokens.length; i += 2) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a || !b) break;
    pairs.push([a, b]);
  }
  return { pairs, epochs };
}

export function registerVectorCommand(
  registry: CommandRegistry,
  logger: VectorCommandLogger,
  context: VectorCommandContext,
): void {
  const handler: CommandHandler = async (args = []) => {
    const [subcommand, ...rest] = args;
    const action = (subcommand ?? '').toLowerCase();

    try {
      switch (action) {
        case 'init': {
          const config = parseConfig(rest);
          const kb = await context.getKnowledgeBase();
          attachKnowledgeBase(kb);
          await shutdownVector();
          await initVector(config, { kb });
          logger.info(`Vector subsystem initialised (${config.provider}/${config.dim})`);
          break;
        }
        case 'embed': {
          const text = rest.join(' ').replace(/^"|"$/g, '');
          if (!text) {
            logger.info('Usage: /vector embed "token text"');
            return;
          }
          const kb = await context.getKnowledgeBase();
          attachKnowledgeBase(kb);
          if (!vectorStatus().configured) {
            await initVector(DEFAULT_VECTOR_CONFIG, { kb });
          }
          const id = await context.ensureToken(text);
          await embedAndStore(id, text);
          logger.info(`Embedded token ${id}`);
          break;
        }
        case 'ensure': {
          const text = rest.join(' ').replace(/^"|"$/g, '');
          if (!text) {
            logger.info('Usage: /vector ensure "token text"');
            return;
          }
          const kb = await context.getKnowledgeBase();
          attachKnowledgeBase(kb);
          if (!vectorStatus().configured) {
            await initVector(DEFAULT_VECTOR_CONFIG, { kb });
          }
          const id = await context.ensureToken(text);
          await ensureVector(id, text);
          logger.info(`Ensured embedding for token ${id}`);
          break;
        }
        case 'similar': {
          if (!vectorStatus().configured) {
            logger.error('Vector subsystem not initialised. Run /vector init first.');
            return;
          }
          const id = Number.parseInt(rest[0] ?? '', 10);
          const topK = Number.parseInt(rest[1] ?? '10', 10);
          if (!Number.isFinite(id)) {
            logger.info('Usage: /vector similar <tokenId> [k]');
            return;
          }
          const kb = await context.getKnowledgeBase();
          attachKnowledgeBase(kb);
          const results = await similar(id, Number.isFinite(topK) ? topK : 10);
          logger.info(JSON.stringify(results));
          break;
        }
        case 'hybrid': {
          if (!vectorStatus().configured) {
            logger.error('Vector subsystem not initialised. Run /vector init first.');
            return;
          }
          const id = Number.parseInt(rest[0] ?? '', 10);
          const topK = Number.parseInt(rest[1] ?? '10', 10);
          if (!Number.isFinite(id)) {
            logger.info('Usage: /vector hybrid <tokenId> [k]');
            return;
          }
          const kb = await context.getKnowledgeBase();
          attachKnowledgeBase(kb);
          const results = await hybrid({ tokenId: id, topK: Number.isFinite(topK) ? topK : 10 });
          logger.info(JSON.stringify(results));
          break;
        }
        case 'train': {
          if (!vectorStatus().configured) {
            logger.error('Vector subsystem not initialised. Run /vector init first.');
            return;
          }
          const { pairs, epochs } = parseTrainArgs(rest);
          if (!pairs.length) {
            logger.info('Usage: /vector train epochs=1 <tokenA> <tokenB> [<tokenC> <tokenD> ...]');
            return;
          }
          await trainPairs(pairs, epochs);
          logger.info(`Training scheduled for ${pairs.length} pairs (epochs=${epochs})`);
          break;
        }
        case 'status': {
          logger.info(JSON.stringify(vectorStatus()));
          break;
        }
        case 'shutdown': {
          await shutdownVector();
          logger.info('Vector subsystem shut down.');
          break;
        }
        default: {
          logger.info('Usage: /vector init|embed|ensure|similar|hybrid|train|status|shutdown');
        }
      }
    } catch (error: any) {
      logger.error(`Vector command failed: ${error?.message ?? error}`);
    }
  };

  registry.register('/vector', handler);
}
