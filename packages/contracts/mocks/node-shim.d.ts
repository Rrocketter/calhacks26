// Minimal ambient types so mocks compile without adding @types/node as a dependency.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
