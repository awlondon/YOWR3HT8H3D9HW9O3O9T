#!/usr/bin/env node
// Ensure local installs of @typescript-eslint treat the repository's TypeScript version as supported.
// eslint-disable-next-line import/no-extraneous-dependencies
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const targetFile = path.resolve(
  repoRoot,
  'node_modules',
  '@typescript-eslint',
  'typescript-estree',
  'dist',
  'parseSettings',
  'warnAboutTSVersion.js',
);
const supportedRange = '>=4.7.4 <5.10.0';

let content;
try {
  content = readFileSync(targetFile, 'utf8');
} catch (error) {
  if (error && error.code === 'ENOENT') {
    process.exit(0);
  }
  throw error;
}

const pattern = />=4\.7\.4 <5\.6\.0/;
if (!pattern.test(content)) {
  process.exit(0);
}

const updated = content.replace(pattern, supportedRange);
writeFileSync(targetFile, updated, 'utf8');
