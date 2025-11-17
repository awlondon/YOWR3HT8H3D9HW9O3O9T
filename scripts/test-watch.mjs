#!/usr/bin/env node
import { spawn } from 'node:child_process';

const children = new Set();

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.add(child);
  child.on('exit', () => {
    children.delete(child);
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill('SIGINT');
    } catch (err) {
      console.warn('Failed to stop child process', err);
    }
  }
  process.exitCode = process.exitCode ?? code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => shutdown(process.exitCode ?? 0));

spawnProcess('tsc', ['--project', 'tsconfig.test.json', '--watch', '--preserveWatchOutput']);
spawnProcess('node', ['--test', '--watch', 'build/test'], {
  env: { ...process.env, NODE_OPTIONS: '--experimental-test-watcher' },
});
