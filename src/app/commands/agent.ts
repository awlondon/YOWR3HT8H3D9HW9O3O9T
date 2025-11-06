import type { CommandHandler, CommandRegistry } from '../../commands/commandRegistry';
import type { AgentKernel } from '../../agent';
import type { AgentConfig, AgentEnergyPolicy } from '../../agent/types';

export type AgentCommandLogger = {
  info: (line: string) => void;
  error: (line: string) => void;
};

function parseValue(raw: string): unknown {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^(true|false)$/i.test(trimmed)) {
    return /^true$/i.test(trimmed);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (/^-?\d*\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  return trimmed;
}

function buildConfigPatch(tokens: string[], current: AgentConfig): Partial<AgentConfig> | null {
  if (!tokens.length) return null;
  const patch: Partial<AgentConfig> = {};
  const energyPatch: Partial<AgentEnergyPolicy> = {};

  for (const token of tokens) {
    if (!token) continue;
    const [key, ...rest] = token.split('=');
    if (!key) continue;
    const valueRaw = rest.join('=');
    const parsed = parseValue(valueRaw);
    if (key.startsWith('energy.')) {
      const energyKey = key.slice('energy.'.length) as keyof AgentEnergyPolicy;
      if (energyKey) {
        (energyPatch as Record<string, unknown>)[energyKey] = parsed;
      }
      continue;
    }
    (patch as Record<string, unknown>)[key] = parsed;
  }

  if (Object.keys(energyPatch).length > 0) {
    patch.energy = { ...current.energy, ...energyPatch };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function registerAgentCommands(
  registry: CommandRegistry,
  agent: AgentKernel,
  logger: AgentCommandLogger,
): void {
  const handler: CommandHandler = async (args = []) => {
    const [subcommand, ...rest] = args;
    const action = (subcommand ?? '').toLowerCase();

    try {
      switch (action) {
        case 'start': {
          agent.start();
          logger.info('Agent started.');
          break;
        }
        case 'stop': {
          agent.stop();
          logger.info('Agent stopped.');
          break;
        }
        case 'once': {
          await agent.once().catch(err => {
            logger.error(`Agent run failed: ${err?.message ?? err}`);
          });
          break;
        }
        case 'status': {
          const status = agent.status;
          logger.info(`Status: ${JSON.stringify({
            enabled: status.enabled,
            mode: status.mode,
            intervalMs: status.cfg.intervalMs,
            strategy: status.cfg.strategy,
            autoExecute: status.cfg.autoExecute,
          })}`);
          break;
        }
        case 'config': {
          const patch = buildConfigPatch(rest, agent.status.cfg);
          if (!patch) {
            logger.info('Usage: /agent config key=value [energy.maxRunsPerHour=60]');
            return;
          }
          agent.updateConfig(patch);
          logger.info('Agent configuration updated.');
          break;
        }
        case '': {
          logger.info('Usage: /agent start|stop|status|once|config key=value');
          break;
        }
        default: {
          logger.error(`Unknown agent action: ${action || '(empty)'}`);
        }
      }
    } catch (error: any) {
      logger.error(`Agent command failed: ${error?.message ?? error}`);
    }
  };

  registry.register('/agent', handler);
}
