import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DroidMessageType, ToolConfirmationOutcome, type DroidStreamEvent } from '@factory/droid-sdk/node';
import { parseServerEvent, type ServerEvent } from '@ahead/contracts';
import { makeGuard } from './guard.js';
import { makePermissionHandler, runTurn, type PermissionHandler } from './turn.js';
import type { DroidLike } from './types.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahead-turn-')));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
const guard = makeGuard(ws);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// The runner logs tool names and paths; keep test output clean.
test.beforeEach((t) => {
  t.mock.method(console, 'log', () => undefined);
});

const ev = (e: Record<string, unknown>): DroidStreamEvent => e as unknown as DroidStreamEvent;
const call = (toolUseId: string, name: string, input: unknown): DroidStreamEvent =>
  ev({ type: DroidMessageType.ToolCall, toolUseId, name, input });
const toolResult = (toolUseId: string, toolName: string, isError = false): DroidStreamEvent =>
  ev({ type: DroidMessageType.ToolResult, toolUseId, toolName, isError, content: 'body' });
const result = (subtype: string): DroidStreamEvent => ev({ type: DroidMessageType.Result, subtype, text: '' });
const text = (t: string): DroidStreamEvent => ev({ type: DroidMessageType.AssistantTextDelta, text: t });

interface Fake extends DroidLike {
  calls: string[];
}
// `events` yield in order; `hang` makes the stream wait forever after the last event.
function fake(events: DroidStreamEvent[], opts: { hang?: boolean; throwAfter?: boolean } = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    stream() {
      return (async function* () {
        for (const e of events) yield e;
        if (opts.throwAfter) throw new Error('boom');
        if (opts.hang) await new Promise<never>(() => undefined);
      })();
    },
    async interrupt() {
      calls.push('interrupt');
    },
    async close() {
      calls.push('close');
    },
  };
}

function collect(): { events: ServerEvent[]; emit: (e: ServerEvent) => void } {
  const events: ServerEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}
function assertValid(events: ServerEvent[]): void {
  for (const e of events) assert.notEqual(parseServerEvent(JSON.stringify(e)), null, JSON.stringify(e));
}
type DroidEv = Extract<ServerEvent, { type: 'droid_event' }>;
const droid = (events: ServerEvent[]): DroidEv[] => events.filter((e): e is DroidEv => e.type === 'droid_event');

test('maps TodoWrite, Edit and ToolResult, and ends on Result success', async () => {
  const s = fake([
    call('1', 'TodoWrite', { todos: [{ content: 'find event' }, { content: 'move it' }] }),
    text('  moved it  '),
    call('2', 'Edit', { file_path: 'notes/calendar.json', old_str: 'a', new_str: 'b' }),
    toolResult('2', 'Edit'),
    result('success'),
  ]);
  const { events, emit } = collect();
  const r = await runTurn(s, 'go', { turnId: 't1', guard, emit });
  assert.equal(r.outcome, 'success');
  assert.equal(r.summary, 'moved it');
  assert.deepEqual(s.calls, []);
  const d = droid(events);
  assert.deepEqual(d.map((e) => e.kind), ['plan', 'tool', 'step']);
  assert.deepEqual(d[0]!.payload, { steps: ['find event', 'move it'] });
  assert.deepEqual(d[1]!.payload, { tool: 'Edit', path: 'notes/calendar.json' });
  assert.deepEqual(d[2]!.payload, { text: 'Edit ok' });
  assert.ok(d.every((e) => e.turnId === 't1' && typeof e.ts === 'number'));
  assertValid(events);
});

test('Result subtypes map to outcomes and keep the session open', async () => {
  for (const [sub, want] of [['interrupted', 'interrupted'], ['error_during_execution', 'error']] as const) {
    const s = fake([result(sub)]);
    const r = await runTurn(s, 'go', { turnId: 't', guard, emit: () => undefined });
    assert.equal(r.outcome, want);
    assert.deepEqual(s.calls, []);
  }
});

test('summary is capped at 500 chars', async () => {
  const r = await runTurn(fake([text('x'.repeat(900)), result('success')]), 'go', { turnId: 't', guard, emit: () => undefined });
  assert.equal(r.summary.length, 500);
});

test('Execute is denied once, interrupt then close, outcome aborted', async () => {
  const s = fake([call('1', 'Execute', { command: 'ls' }), result('interrupted')]);
  const { events, emit } = collect();
  const r = await runTurn(s, 'go', { turnId: 't1', guard, emit });
  assert.equal(r.outcome, 'aborted');
  assert.deepEqual(s.calls, ['interrupt', 'close']);
  const d = droid(events);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.kind, 'tool');
  assert.equal(d[0]!.denied, true);
  assert.deepEqual(d[0]!.payload, { tool: 'Execute', denied: true, reason: 'tool-not-allowed' });
  assertValid(events);
});

test('Read ../../.env is denied outside-workspace and aborts', async () => {
  const s = fake([call('1', 'Read', { file_path: '../../.env' }), result('interrupted')]);
  const { events, emit } = collect();
  const r = await runTurn(s, 'go', { turnId: 't1', guard, emit });
  assert.equal(r.outcome, 'aborted');
  assert.deepEqual(s.calls, ['interrupt', 'close']);
  const d = droid(events);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.denied, true);
  assert.equal((d[0]!.payload as { reason: string }).reason, 'outside-workspace');
  assertValid(events);
});

test('ApplyPatch bodies naming outside paths are denied', async () => {
  const patch = '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch';
  for (const key of ['patch', 'input']) {
    const s = fake([call('1', 'ApplyPatch', { [key]: patch }), result('interrupted')]);
    const { events, emit } = collect();
    const r = await runTurn(s, 'go', { turnId: 't1', guard, emit });
    assert.equal(r.outcome, 'aborted', key);
    assert.equal((droid(events)[0]!.payload as { reason: string }).reason, 'outside-workspace');
  }
  const ok = fake([call('1', 'ApplyPatch', { patch: '*** Add File: notes/a.md\n+x' }), result('success')]);
  assert.equal((await runTurn(ok, 'go', { turnId: 't', guard, emit: () => undefined })).outcome, 'success');
});

test('every offending call is emitted, interrupt once, no normal tool event', async () => {
  const s = fake([
    call('1', 'Execute', { command: 'ls' }),
    call('2', 'Read', { file_path: '/etc/passwd' }),
    call('3', 'Edit', { file_path: 'notes/a.md' }),
    result('interrupted'),
  ]);
  const { events, emit } = collect();
  const r = await runTurn(s, 'go', { turnId: 't1', guard, emit });
  assert.equal(r.outcome, 'aborted');
  assert.deepEqual(s.calls, ['interrupt', 'close']);
  const d = droid(events);
  assert.equal(d.length, 3);
  assert.ok(d.slice(0, 2).every((e) => e.denied === true));
  assertValid(events);
});

test('close is called after graceMs when no Result arrives', async () => {
  const s = fake([call('1', 'Execute', {})], { hang: true });
  const t = performance.now();
  const r = await runTurn(s, 'go', { turnId: 't', guard, emit: () => undefined, graceMs: 60 });
  assert.equal(r.outcome, 'aborted');
  assert.deepEqual(s.calls, ['interrupt', 'close']);
  assert.ok(performance.now() - t >= 50);
});

test('a stream that throws gives outcome error and does not throw', async () => {
  const s = fake([text('hi')], { throwAfter: true });
  const r = await runTurn(s, 'go', { turnId: 't', guard, emit: () => undefined });
  assert.equal(r.outcome, 'error');
});

test('close errors after an abort are swallowed', async () => {
  const s = fake([call('1', 'Execute', {}), result('interrupted')]);
  s.close = async () => {
    throw new Error('x');
  };
  const r = await runTurn(s, 'go', { turnId: 't', guard, emit: () => undefined });
  assert.equal(r.outcome, 'aborted');
});

// ---- permission handler ----
type Params = Parameters<PermissionHandler>[0];
function params(type: string, input: Record<string, unknown>, details: Record<string, unknown> = {}, name = 'Create'): Params {
  return {
    options: [{ value: ToolConfirmationOutcome.ProceedOnce }, { value: ToolConfirmationOutcome.Cancel }],
    toolUses: [{ confirmationType: type, details: { type, ...details }, toolUse: { name, input } }],
  } as unknown as Params;
}

test('permission handler: create inside proceeds, no event', () => {
  const { events, emit } = collect();
  const h = makePermissionHandler(guard, () => 't1', emit);
  const out = h(params('create', { file_path: 'notes/x.md', content: 'hi' }, { filePath: 'notes/x.md' }));
  assert.equal(out, ToolConfirmationOutcome.ProceedOnce);
  assert.equal(events.length, 0);
});

test('permission handler: create ../x cancels with a denied event', () => {
  const { events, emit } = collect();
  const h = makePermissionHandler(guard, () => 't1', emit);
  const out = h(params('create', { file_path: '../x' }, { filePath: '../x' }));
  assert.equal(out, ToolConfirmationOutcome.Cancel);
  const d = droid(events);
  assert.equal(d.length, 1);
  assert.ok(d[0]!.denied === true && d[0]!.turnId === 't1');
  assert.equal((d[0]!.payload as { reason: string }).reason, 'outside-workspace');
  assertValid(events);
});

test('permission handler: sandbox_violation cancels with sandbox-<violationType>', () => {
  const { events, emit } = collect();
  const h = makePermissionHandler(guard, () => 't1', emit);
  const out = h(params('sandbox_violation', {}, { violationType: 'filesystem-read' }, 'Read'));
  assert.equal(out, ToolConfirmationOutcome.Cancel);
  assert.equal((droid(events)[0]!.payload as { reason: string }).reason, 'sandbox-filesystem-read');
  assertValid(events);
});

test('permission handler: apply_patch body outside cancels; handler errors cancel', () => {
  const { events, emit } = collect();
  const h = makePermissionHandler(guard, () => 't1', emit);
  const out = h(params('apply_patch', { patch: '*** Add File: ../y' }, { patchContent: '*** Add File: ../y' }, 'ApplyPatch'));
  assert.equal(out, ToolConfirmationOutcome.Cancel);
  assert.equal(events.length, 1);
  assert.equal(h({} as unknown as Params), ToolConfirmationOutcome.Cancel);
});
