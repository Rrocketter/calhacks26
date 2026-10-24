import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@ahead/contracts';
import { MockSocket, type ReplayOpts } from './socket';
import { hudReducer, initialHud, words } from '../hud/state';

const FAST: ReplayOpts = { speed: 50, autoConfirmMs: 20 };
// The droid mock ignores `speed` (about 2 s of real sleeps), so drive time with fake timers.
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await wait(10);
  expect(cond()).toBe(true);
};
const settle = async (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  await until(() => done);
};
const states = (evs: ServerEvent[]) =>
  evs.flatMap((e) => (e.type === 'state_change' ? [e.state] : []));
const idx = (evs: ServerEvent[], pred: (e: ServerEvent) => boolean) => evs.findIndex(pred);

const replay = async (opts: ReplayOpts = FAST) => {
  const evs: ServerEvent[] = [];
  const sock = new MockSocket((e) => evs.push(e), opts);
  await settle(sock.play());
  return evs;
};

describe('MockSocket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('replays the full happy path in order', async () => {
    const evs = await replay();
    expect(states(evs)).toEqual(['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED', 'COMMITTED']);
    expect(evs.filter((e) => e.type === 'error')).toEqual([]);
    expect(evs.filter((e) => e.type === 'interject')).toHaveLength(1);

    const inter = idx(evs, (e) => e.type === 'interject');
    const partials = evs.slice(0, inter).filter((e) => e.type === 'transcript_partial');
    const lastPartial = partials[partials.length - 1];
    expect(lastPartial?.type === 'transcript_partial' && lastPartial.text).toContain('Thursday');

    const eager = idx(evs, (e) => e.type === 'turn_eager_end');
    expect(eager).toBeGreaterThan(-1);
    expect(idx(evs, (e) => e.type === 'state_change' && e.state === 'STAGED')).toBeGreaterThan(eager);
    expect(idx(evs, (e) => e.type === 'droid_event' && e.kind === 'diff')).toBeGreaterThan(eager);
    expect(evs).toContainEqual({ type: 'metric', source: 'sonic', label: 'ttfa', ms: 180 });
  });

  it('drives the hud to COMMITTED with Thursday highlighted', async () => {
    const hud = (await replay()).reduce(hudReducer, initialHud());
    expect(hud.state).toBe('COMMITTED');
    expect(hud.moss.count).toBeGreaterThan(0);
    const last = hud.finals.at(-1);
    expect(last && last.highlight !== null && words(last.text)[last.highlight]).toMatch(/^Thursday/);
  });

  it('captions the interject, the staged prompt and the ack, like the server', async () => {
    const replies = (await replay()).flatMap((e) => (e.type === 'assistant_reply' ? [[e.kind, e.text]] : []));
    expect(replies.map(([k]) => k)).toEqual(['interject', 'prompt', 'ack']);
    expect(replies.slice(1)).toEqual([['prompt', 'Apply?'], ['ack', 'Done.']]);
  });

  it('auto-confirms by default when autoConfirmMs is omitted', async () => {
    const evs = await replay({ speed: 50 });
    expect(states(evs).at(-1)).toBe('COMMITTED');
  });

  it('holds the interject until the transcript shows its trigger word', async () => {
    const evs = await replay({ ...FAST, beliefOffsetMs: 0 });
    const inter = idx(evs, (e) => e.type === 'interject');
    expect(inter).toBeGreaterThan(-1);
    const partials = evs.slice(0, inter).filter((e) => e.type === 'transcript_partial');
    const last = partials[partials.length - 1];
    expect(last?.type === 'transcript_partial' && last.text).toContain('Thursday');
    expect(evs.filter((e) => e.type === 'interject')).toHaveLength(1);
  });

  it('surfaces one denied tool event', async () => {
    const evs = await replay({ ...FAST, denied: true });
    const tools = evs.filter((e) => e.type === 'droid_event' && e.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ denied: true });
  });

  it('failed result carries failed:true and does not roll back', async () => {
    const evs = await replay({ ...FAST, failed: true });
    const res = evs.find((e) => e.type === 'droid_event' && e.kind === 'result');
    expect(res?.type === 'droid_event' && (res.payload as { failed?: boolean }).failed).toBe(true);
    expect(states(evs)).not.toContain('ROLLED_BACK');
  });

  it('confirm_action apply:false after STAGED rolls back', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: null });
    const done = sock.play();
    await until(() => states(evs).includes('STAGED'));
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: false });
    await settle(done);
    expect(states(evs).at(-1)).toBe('ROLLED_BACK');
  });

  it('discard in SPECULATING rolls back and silences later droid events', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: null });
    const done = sock.play();
    await until(() => states(evs).includes('SPECULATING'));
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: false });
    await settle(done);
    await wait(5000);
    const at = idx(evs, (e) => e.type === 'state_change' && e.state === 'ROLLED_BACK');
    expect(at).toBeGreaterThan(-1);
    expect(states(evs).at(-1)).toBe('ROLLED_BACK');
    expect(states(evs)).not.toContain('STAGED');
    expect(evs.slice(at + 1).filter((e) => e.type === 'droid_event')).toEqual([]);
  });

  it('apply in SPECULATING commits once STAGED', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: null });
    const done = sock.play();
    await until(() => states(evs).includes('SPECULATING'));
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: true });
    await settle(done);
    expect(states(evs).slice(-2)).toEqual(['STAGED', 'COMMITTED']);
  });

  it('confirm before SPECULATING is ignored', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: null });
    const done = sock.play();
    await until(() => states(evs).includes('LISTENING'));
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: false });
    await settle(done);
    expect(states(evs)).toEqual(['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED']);
  });

  it('emits at most one terminal state', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: 5000 });
    const done = sock.play();
    await until(() => states(evs).includes('STAGED'));
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: false });
    sock.send({ type: 'confirm_action', turnId: 'demo-1', apply: true });
    await settle(done);
    await wait(500);
    const terminal = states(evs).filter((s) => s === 'COMMITTED' || s === 'ROLLED_BACK');
    expect(terminal).toEqual(['ROLLED_BACK']);
  });

  it('stop() delivers no further events', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: 20 });
    const done = sock.play();
    await wait(1500);
    sock.stop();
    await settle(done);
    const n = evs.length;
    expect(n).toBeGreaterThan(0);
    await wait(5000);
    expect(evs.length).toBe(n);
  });

  it('a second play() cancels the first without interleaving', async () => {
    const evs: ServerEvent[] = [];
    const sock = new MockSocket((e) => evs.push(e), { speed: 50, autoConfirmMs: 20 });
    const first = sock.play();
    await wait(30);
    const before = evs.filter((e) => e.type === 'turn_start').length;
    expect(before).toBe(1);
    const second = sock.play();
    await settle(Promise.all([first, second]).then(() => undefined));
    // Only the second run's turn_start arrives after the second play() began.
    expect(evs.filter((e) => e.type === 'turn_start')).toHaveLength(2);
    const last = evs.map((e) => e.type).lastIndexOf('turn_start');
    expect(evs.slice(last).filter((e) => e.type === 'turn_start')).toHaveLength(1);
    expect(states(evs.slice(last))).toEqual(['LISTENING', 'BELIEF_FORMING', 'SPECULATING', 'STAGED', 'COMMITTED']);
  });
});
