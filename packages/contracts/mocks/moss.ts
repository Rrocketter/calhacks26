import type { MossHit } from '../src/index.js';

const DOCS: { docId: string; text: string }[] = [
  { docId: 'cal-priya', text: 'Meeting with Priya, Friday 2:00 PM' },
  { docId: 'contact-priya', text: 'Priya Sharma, contact, priya@example.com' },
  { docId: 'file-q3-deck', text: 'files/q3-deck.pdf Q3 deck' },
];

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export class MockMoss {
  async query(
    text: string,
    opts: { k?: number } = {},
  ): Promise<{ hits: MossHit[]; latencyMs: number }> {
    const q = new Set(words(text));
    const hits = DOCS.map((d) => {
      const dw = words(d.text);
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
