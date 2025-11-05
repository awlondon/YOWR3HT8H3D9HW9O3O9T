import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from './commandRegistry.js';

(globalThis as any).window = (globalThis as any).window || {};

test('CommandRegistry normalizes commands and executes handlers', async () => {
  const calls: string[] = [];
  const registry = new CommandRegistry();
  registry.register('/Example', async (args) => {
    calls.push(args.join(','));
  });
  const handler = registry.get('/example');
  assert.ok(handler, 'handler should be registered under normalized key');
  await handler?.(['one', 'two'], '/example one two');
  assert.deepStrictEqual(calls, ['one,two']);
});

test('CommandRegistry exposes commands globally', () => {
  const registry = new CommandRegistry();
  registry.register('test', () => undefined);
  const globalCommands = (globalThis as any).window?.COMMANDS;
  assert.ok(globalCommands, 'global COMMANDS object should exist');
  assert.strictEqual(typeof globalCommands['/test'], 'function');
});
