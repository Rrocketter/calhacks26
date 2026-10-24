import { CLOUD_SIM_MS, type RetrievalMode } from '@ahead/contracts';
import { logLatency } from '../log.js';
import type { RetrievedHit, Retriever } from '../belief/types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retrieval A/B for one connection. `moss` queries in process. `cloud-sim` returns the same Moss
 * results after `delayMs` (a cloud vector DB round trip), so only latency differs; the reported
 * latencyMs includes the delay. Labelled cloud-sim everywhere: it is a comparison, not a backend.
 */
export class SwitchableRetriever implements Retriever {
  mode: RetrievalMode = 'moss';

  constructor(
    private readonly inner: Retriever,
    readonly delayMs: number = CLOUD_SIM_MS,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async query(
    text: string,
    opts?: { k?: number; filter?: object },
  ): Promise<{ hits: RetrievedHit[]; latencyMs: number }> {
    if (this.mode === 'moss') return this.inner.query(text, opts);
    const start = performance.now();
    await this.wait(this.delayMs);
    const { hits } = await this.inner.query(text, opts);
    const latencyMs = performance.now() - start;
    logLatency('cloud-sim', 'query', latencyMs);
    return { hits, latencyMs };
  }
}
