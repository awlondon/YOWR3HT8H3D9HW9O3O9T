export type CommandHandler = (args: string[], rawInput?: string) => void | Promise<void>;

function normalizeCommandName(name: string): string {
  if (!name) {
    throw new Error('Command name is required');
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Command name is required');
  }
  return trimmed.startsWith('/') ? trimmed.toLowerCase() : `/${trimmed.toLowerCase()}`;
}

const legacyCommandMap: Record<string, CommandHandler | undefined> = (() => {
  if (typeof window !== 'undefined' && window && typeof (window as any).COMMANDS === 'object') {
    return (window as any).COMMANDS as Record<string, CommandHandler | undefined>;
  }
  return Object.create(null);
})();

export class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();

  constructor(initialHandlers: Record<string, CommandHandler | undefined> = {}) {
    const entries = Object.entries(initialHandlers);
    for (const [name, handler] of entries) {
      if (typeof handler !== 'function') continue;
      const normalized = normalizeCommandName(name);
      this.handlers.set(normalized, handler);
    }
  }

  register(name: string, handler: CommandHandler): void {
    if (typeof handler !== 'function') return;
    const normalized = normalizeCommandName(name);
    this.handlers.set(normalized, handler);
    legacyCommandMap[normalized] = handler;
  }

  get(name: string): CommandHandler | undefined {
    try {
      const normalized = normalizeCommandName(name);
      const handler = this.handlers.get(normalized);
      if (handler) return handler;

      const legacyHandler = legacyCommandMap[normalized];
      if (typeof legacyHandler === 'function') {
        this.handlers.set(normalized, legacyHandler);
        return legacyHandler;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  has(name: string): boolean {
    return Boolean(this.get(name));
  }

  async execute(name: string, args: string[] = [], rawInput?: string): Promise<boolean> {
    const handler = this.get(name);
    if (!handler) return false;
    await handler(args, rawInput);
    return true;
  }

  entries(): Array<[string, CommandHandler]> {
    return Array.from(this.handlers.entries());
  }
}

export const commandRegistry = new CommandRegistry(legacyCommandMap);

export const legacyCommands = legacyCommandMap;

if (typeof window !== 'undefined' && window) {
  (window as any).COMMANDS = legacyCommandMap;
}
