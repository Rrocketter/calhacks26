import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@ahead/contracts';

export type InkMessage = { type: string; transcript?: string; title?: string; message?: string };

export class TurnTracker {
  private id: string | null = null;

  constructor(private readonly newId: () => string = () => 't-' + randomUUID().slice(0, 8)) {}

  get turnId(): string | null {
    return this.id;
  }

  handle(msg: InkMessage, ts: number): ServerEvent[] {
    const text = msg.transcript ?? '';
    switch (msg.type) {
      case 'turn.start':
        this.id = this.newId();
        return [{ type: 'turn_start', turnId: this.id, ts }];
      case 'turn.update': {
        const events = this.ensureTurn(ts);
        events.push({ type: 'transcript_partial', turnId: this.id!, text, ts });
        return events;
      }
      case 'turn.eager_end': {
        const events = this.ensureTurn(ts);
        events.push({ type: 'turn_eager_end', turnId: this.id!, text, ts });
        return events;
      }
      case 'turn.resume':
        if (this.id === null) return [];
        return [{ type: 'turn_resume', turnId: this.id, ts }];
      case 'turn.end': {
        if (this.id === null) return [];
        const turnId = this.id;
        this.id = null;
        return [
          { type: 'transcript_final', turnId, text, ts },
          { type: 'turn_end', turnId, ts },
        ];
      }
      case 'error':
        return [
          { type: 'error', message: `${msg.title ?? ''} ${msg.message ?? ''}`.trim(), source: 'ink' },
        ];
      default:
        return [];
    }
  }

  private ensureTurn(ts: number): ServerEvent[] {
    if (this.id !== null) return [];
    this.id = this.newId();
    return [{ type: 'turn_start', turnId: this.id, ts }];
  }
}
