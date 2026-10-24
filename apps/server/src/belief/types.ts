import type { Claim, Intent, MossHit } from '@ahead/contracts';

export type CorpusDoc = {
  id: string;
  text: string;
  metadata: {
    type: 'calendar' | 'contact' | 'note' | 'email' | 'file';
    date: string;
    people: string;
    day?: string;
    time?: string;
    title?: string;
  };
};

export type RetrievedHit = MossHit & { metadata: Record<string, string> };

export interface Retriever {
  query(
    text: string,
    opts?: { k?: number; filter?: object },
  ): Promise<{ hits: RetrievedHit[]; latencyMs: number }>;
}

export type IntentResult = {
  intent: Intent;
  entities: Record<string, string>;
  claims: Claim[];
  confidence: number;
};

export interface IntentLlm {
  classify(input: {
    partial: string;
    topHits: MossHit[];
    final?: boolean;
  }): Promise<{ result: IntentResult; latencyMs: number }>;
}
