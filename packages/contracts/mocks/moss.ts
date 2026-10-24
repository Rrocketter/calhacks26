import type { MossHit } from '../src/index.js';

/** Mock corpus. docIds and facts come from workspace-seed (calendar.json, contacts.json, files/). */
export const MOCK_MOSS_DOCS: readonly { docId: string; text: string }[] = [
  {
    docId: 'evt-priya-q3',
    text: 'Calendar event: Q3 deck review with Priya Shah, Friday 2026-10-30 2 PM to 3 PM, Conference Room B',
  },
  {
    docId: 'contact-priya',
    text: 'Contact Priya Shah, priya.shah@example.com, +1-415-555-0142. Head of product. Owns the Q3 deck review.',
  },
  { docId: 'file-q3-deck', text: 'File files/q3-deck.pdf: Q3 Deck' },
];

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export class MockMoss {
  async query(
    text: string,
    opts: { k?: number } = {},
  ): Promise<{ hits: MossHit[]; latencyMs: number }> {
    const q = new Set(words(text));
    const hits = MOCK_MOSS_DOCS.map((d) => {
      const dw = [...new Set(words(d.text))];
      const overlap = dw.filter((w) => q.has(w)).length;
      return { docId: d.docId, score: overlap / Math.max(1, dw.length), snippet: d.text, overlap };
    })
      .filter((h) => h.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.score - a.score)
      .slice(0, opts.k ?? 3)
      .map(({ docId, score, snippet }) => ({ docId, score, snippet }));
    return { hits, latencyMs: 3 };
  }
}
