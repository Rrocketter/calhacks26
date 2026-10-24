export function logLatency(source: string, label: string, ms: number): void {
  console.log(`[${source}] ${label} ${ms.toFixed(1)}ms`);
}
