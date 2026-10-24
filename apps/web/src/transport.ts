import type { ClientEvent } from '@ahead/contracts';

export interface Transport {
  send(ev: ClientEvent): void;
  stop(): void;
}
