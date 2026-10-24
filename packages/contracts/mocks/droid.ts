import type { ServerEvent } from '../src/index.js';

const DIFF = `--- a/calendar.json
+++ b/calendar.json
@@ -1,5 +1,5 @@
 {
   "id": "cal-priya",
   "title": "Meeting with Priya",
-  "start": "Friday 14:00"
+  "start": "Monday 09:00"
 }
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* mockDroidRun(turnId: string): AsyncGenerator<ServerEvent> {
  const steps: { kind: 'plan' | 'step' | 'diff' | 'result'; payload: unknown }[] = [
    { kind: 'plan', payload: { steps: ['Read calendar.json', 'Edit event', 'Verify'] } },
    { kind: 'step', payload: { n: 1, text: 'Read calendar.json' } },
    { kind: 'step', payload: { n: 2, text: 'Edit event' } },
    { kind: 'step', payload: { n: 3, text: 'Verify' } },
    { kind: 'diff', payload: { file: 'calendar.json', diff: DIFF } },
    { kind: 'result', payload: { ok: true, summary: 'Moved meeting with Priya to Monday 9:00 AM' } },
  ];
  const gap = 2000 / steps.length;
  for (const s of steps) {
    await sleep(gap);
    yield { type: 'droid_event', turnId, kind: s.kind, payload: s.payload, ts: Date.now() };
  }
}
