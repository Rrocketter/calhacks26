import type { DroidPayloadByKind, ServerEvent } from '../src/index.js';

// `git diff` of workspace-seed/calendar.json after moving evt-priya-q3 from
// Fri 2026-10-30 14:00 -07:00 to Mon 2026-11-02 09:00 (US/Pacific DST ends Nov 1, so -08:00).
const DIFF = `diff --git a/calendar.json b/calendar.json
index 8205574..e4ab07e 100644
--- a/calendar.json
+++ b/calendar.json
@@ -27,8 +27,8 @@
     {
       "id": "evt-priya-q3",
       "title": "Q3 deck review with Priya",
-      "start": "2026-10-30T14:00:00-07:00",
-      "end": "2026-10-30T15:00:00-07:00",
+      "start": "2026-11-02T09:00:00-08:00",
+      "end": "2026-11-02T10:00:00-08:00",
       "attendees": ["Priya Shah"],
       "location": "Conference Room B"
     },
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Step = { [K in keyof DroidPayloadByKind]: { kind: K; payload: DroidPayloadByKind[K]; denied?: boolean } }[keyof DroidPayloadByKind];

/**
 * Emits droid_event kinds plan, step x3, diff, result over about 2000 ms (payload types in
 * `@ahead/contracts` DroidPlanPayload etc.). `withDenied` adds one denied `tool` event after step 1.
 */
export async function* mockDroidRun(
  turnId: string,
  opts: { withDenied?: boolean } = {},
): AsyncGenerator<ServerEvent> {
  const denied: Step = {
    kind: 'tool',
    denied: true,
    payload: { tool: 'Read', path: '../../.env', denied: true, reason: 'outside-workspace' },
  };
  const steps: Step[] = [
    { kind: 'plan', payload: { steps: ['Read calendar.json', 'Edit event', 'Verify'] } },
    { kind: 'step', payload: { text: 'Read calendar.json' } },
    ...(opts.withDenied ? [denied] : []),
    { kind: 'step', payload: { text: 'Edit event' } },
    { kind: 'step', payload: { text: 'Verify' } },
    { kind: 'diff', payload: { file: 'calendar.json', diff: DIFF } },
    { kind: 'result', payload: { ok: true, summary: 'Moved Q3 deck review with Priya to Monday Nov 2, 9:00 AM' } },
  ];
  const gap = 2000 / steps.length;
  for (const s of steps) {
    await sleep(gap);
    yield {
      type: 'droid_event',
      turnId,
      kind: s.kind,
      payload: s.payload,
      ...(s.denied ? { denied: true } : {}),
      ts: Date.now(),
    };
  }
}
