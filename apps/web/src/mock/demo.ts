import type { Belief, Claim, DroidPayloadByKind, MossHit, ServerEvent } from '@ahead/contracts';
import type { InkFixture } from '@ahead/contracts/mocks';

// Mock mode plays PLAN.md section 5, utterance 1, the way the demo runs live. Web only:
// the contracts mocks (and the server tests built on them) stay on the older Priya script.

const UTTERANCE = "Draft a message to Esha saying I'll present the VQE results at Tuesday's group meeting.";
export const DEMO_INTERJECTION = 'Heads up, the VQE meeting is Monday at 8:30, not Tuesday. Say Monday?';
const MESSAGE = "I'll present the VQE results at Monday's group meeting.";

// One partial per word, 250 ms apart from 1000 ms, then eager end and the final.
const ws = UTTERANCE.replace(/\.$/, '').split(' ');
export const DEMO_FIXTURE: InkFixture = {
  turnId: 'demo-1',
  partials: [
    ...ws.map((_, i) => ({ atMs: 1000 + i * 250, text: ws.slice(0, i + 1).join(' ') })),
    { atMs: 1000 + ws.length * 250, text: UTTERANCE, eager: true },
    { atMs: 1200 + ws.length * 250, text: UTTERANCE, final: true },
  ],
};

const DOCS: Record<string, string> = {
  'g-evt-vqe-group': 'Calendar event: VQE group meeting, Monday 2026-10-26 8:30 AM to 9:30 AM, Campbell Hall 131',
  'contact-esha': 'Contact Esha Telang, esha.telang@example.com. Runs the VQE group meeting.',
  'mail-esha-vqe': 'Email from Esha Telang: can you present your VQE results at group meeting this week?',
};
const hit = (docId: string, score: number): MossHit => ({ docId, score, snippet: DOCS[docId]! });

const DAY_CLAIM: Claim = { field: 'day', said: 'Tuesday', known: 'Monday', docId: 'g-evt-vqe-group' };

type Step = { atMs: number; query: string; hits: MossHit[]; belief: Omit<Belief, 'topHits'>; interject?: boolean };

// Timed from the belief start (socket.ts BELIEF_OFFSET_MS after turn_start) against DEMO_FIXTURE:
// locks after "present", and the claim plus interject land just after "Tuesday's" (4000 ms).
const STEPS: Step[] = [
  { atMs: 500, query: 'Draft a', hits: [], belief: { intent: 'unknown', entities: {}, claims: [], confidence: 0.1, latencyMs: { moss: 1.8 } } },
  {
    atMs: 1500,
    query: 'Draft a message to Esha',
    hits: [hit('contact-esha', 0.84), hit('mail-esha-vqe', 0.57)],
    belief: { intent: 'draft_message', entities: { person: 'Esha Telang' }, claims: [], confidence: 0.58, latencyMs: { moss: 2.1, llm: 360 } },
  },
  {
    atMs: 2300,
    query: "Draft a message to Esha saying I'll present",
    hits: [hit('contact-esha', 0.8), hit('mail-esha-vqe', 0.71)],
    belief: { intent: 'draft_message', entities: { person: 'Esha Telang' }, claims: [], confidence: 0.79, latencyMs: { moss: 2.0, llm: 384 } },
  },
  {
    atMs: 3500,
    query: "VQE results at Tuesday's group meeting",
    hits: [hit('g-evt-vqe-group', 0.93), hit('mail-esha-vqe', 0.74), hit('contact-esha', 0.62)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Esha Telang', day: 'monday', superseded_day: 'tuesday' },
      claims: [DAY_CLAIM],
      confidence: 0.87,
      latencyMs: { moss: 2.3, llm: 402 },
    },
    interject: true,
  },
  {
    atMs: 4000,
    query: UTTERANCE,
    hits: [hit('g-evt-vqe-group', 0.9), hit('contact-esha', 0.7), hit('mail-esha-vqe', 0.66)],
    belief: {
      intent: 'draft_message',
      entities: { person: 'Esha Telang', day: 'monday', superseded_day: 'tuesday', message: MESSAGE },
      claims: [DAY_CLAIM],
      confidence: 0.91,
      latencyMs: { moss: 2.2 },
    },
  },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Same shape as the contracts mockBeliefStream: per step `moss_hits` then `belief_update`, plus one `interject`. */
export async function* demoBeliefStream(turnId: string, opts: { speed?: number } = {}): AsyncGenerator<ServerEvent> {
  const speed = opts.speed ?? 1;
  let prev = 0;
  for (const s of STEPS) {
    await sleep(Math.max(0, (s.atMs - prev) / speed));
    prev = s.atMs;
    yield { type: 'moss_hits', turnId, query: s.query, hits: s.hits, latencyMs: s.belief.latencyMs.moss };
    yield { type: 'belief_update', turnId, belief: { ...s.belief, topHits: s.hits } };
    if (s.interject) yield { type: 'interject', turnId, text: DEMO_INTERJECTION };
  }
}

// `git diff main..spec/<turnId>` for the new outbox file.
const DIFF = `diff --git a/messages/outbox/esha.md b/messages/outbox/esha.md
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/messages/outbox/esha.md
@@ -0,0 +1,3 @@
+To: Esha Telang
+
+${MESSAGE}
`;

type Step2 = { [K in keyof DroidPayloadByKind]: { kind: K; payload: DroidPayloadByKind[K]; denied?: boolean } }[keyof DroidPayloadByKind];

/** Droid stand-in over about 2 s, like the contracts mockDroidRun; `withDenied` adds one denied Read. */
export async function* demoDroidRun(turnId: string, opts: { withDenied?: boolean } = {}): AsyncGenerator<ServerEvent> {
  const steps: Step2[] = [
    { kind: 'plan', payload: { steps: ['Read contacts.json', 'Write messages/outbox/esha.md', 'Verify'] } },
    { kind: 'step', payload: { text: 'Read contacts.json' } },
    { kind: 'tool', payload: { tool: 'Read', path: 'contacts.json', denied: false } },
    ...(opts.withDenied
      ? [{ kind: 'tool', denied: true, payload: { tool: 'Read', path: '../../.env', denied: true, reason: 'outside-workspace' } } as Step2]
      : []),
    { kind: 'step', payload: { text: 'Write messages/outbox/esha.md' } },
    { kind: 'step', payload: { text: 'Verify' } },
    { kind: 'diff', payload: { file: 'messages/outbox/esha.md', diff: DIFF } },
    { kind: 'result', payload: { ok: true, summary: 'Drafted messages/outbox/esha.md to Esha Telang' } },
  ];
  const gap = 2000 / steps.length;
  for (const s of steps) {
    await sleep(gap);
    yield { type: 'droid_event', turnId, kind: s.kind, payload: s.payload, ...(s.denied ? { denied: true } : {}), ts: Date.now() };
  }
}
