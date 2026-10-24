import fs from 'node:fs';
import path from 'node:path';
import type { CorpusDoc } from '../src/belief/types.js';

/** What each seed file under workspace-seed/files/ is, for its corpus doc. */
const SUMMARIES: Record<string, { summary: string; people: string }> = {
  'q3-deck': { summary: 'Q3 deck with the roadmap slide for the board. Reviewed with Priya Shah.', people: 'Priya Shah' },
  'budget-2026': { summary: 'Last year draft of the 2026 budget. Kept by Sam Rivera.', people: 'Sam Rivera' },
  'seti-slides': { summary: 'SETI research slides: signal search update for the Tuesday SETI Research Meeting.', people: '' },
};

/**
 * One corpus doc per seed file. Both corpora carry them (synthetic gen-corpus and the Google
 * import), since the workspace always holds workspace-seed/files/.
 */
export function seedFileDocs(seedDir: string): CorpusDoc[] {
  const filesDir = path.join(seedDir, 'files');
  return fs
    .readdirSync(filesDir)
    .sort()
    .map((f) => {
      const stem = f.replace(/\.(xlsx\.txt|pdf)$/, '');
      const body = f.endsWith('.txt') ? fs.readFileSync(path.join(filesDir, f), 'utf8').trim() : '';
      const info = SUMMARIES[stem] ?? { summary: `File ${f}.`, people: '' };
      return {
        id: `file-${stem}`,
        text: `File files/${f}. ${info.summary}${body ? ` Contents: ${body}` : ''}`,
        metadata: { type: 'file' as const, date: '2026-10-20', people: info.people, title: f },
      };
    });
}
