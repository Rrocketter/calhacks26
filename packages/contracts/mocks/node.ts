// Node-only mock helpers. The browser-safe mocks live in ./index.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InkFixture } from './ink.js';

export * from './index.js';

export function loadFixture(name: string): InkFixture {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as InkFixture;
}
