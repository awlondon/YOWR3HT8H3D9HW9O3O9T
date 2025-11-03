export type CommandHandler = (args: string[], raw: string) => unknown | Promise<unknown>;

function normalizeCommand(name: string): string {
  if (!name) return '';
  return name.startsWith('/') ? name.toLowerCase() : `/${name.toLowerCase()}`;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandHandler>();

  constructor(initial?: Record<string, CommandHandler>) {
    if (initial) {
      for (const [name, handler] of Object.entries(initial)) {
        if (typeof handler === 'function') {
          this.commands.set(normalizeCommand(name), handler);
        }
      }
    }
    this.exposeGlobally();
  }

  register(name: string, handler: CommandHandler): void {
    if (!name || typeof handler !== 'function') return;
    const key = normalizeCommand(name);
    this.commands.set(key, handler);
    this.exposeGlobally();
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(normalizeCommand(name));
  }

  has(name: string): boolean {
    return this.commands.has(normalizeCommand(name));
  }

  list(): string[] {
    return Array.from(this.commands.keys()).sort();
  }

  exposeGlobally(): void {
    if (typeof window === 'undefined') return;
    const target = (window as any).COMMANDS || Object.create(null);
    for (const [name, handler] of this.commands.entries()) {
      target[name] = handler;
    }
    (window as any).COMMANDS = target;
  }
}

export const globalCommandRegistry = new CommandRegistry(
  typeof window !== 'undefined' ? (window as any).COMMANDS : undefined,
);
