# Lane A: Voice Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mic in the browser → Cartesia Ink 2 over the server → `transcript_partial` / turn events back to a bare page, and a canned Sonic 3.6 reply (WebSocket TTS) played at turn end, with an interrupt path that pauses STT ingest for 1.5 s.

**Architecture:** One Node process serves a WebSocket at `/ws` (port 8787). Each browser connection gets a `VoiceSession` that owns one `InkClient` (Cartesia STT WebSocket) and one `SonicClient` (Cartesia TTS WebSocket), both opened at connect so they are warm. Ink messages go through a pure `TurnTracker` that assigns `turnId`s and maps to contract `ServerEvent`s. The browser captures 16 kHz PCM with an AudioWorklet and plays 24 kHz PCM through a scheduled AudioContext queue with a 30 ms `stopNow()`.

**Tech Stack:** Node 20 + TypeScript (tsx for dev, `node --test` for tests), `ws@8.22.0` (already a dependency), Vite 8 + React 19, `@ahead/contracts` (zod schema + mocks). No new dependencies.

**Spec:** `docs/lanes/voice.md` (the brief), `PLAN.md` sections 4 and 8, `docs/sdk-notes.md` (Ink 2 and Sonic sections).

## Global Constraints

- Do not edit `packages/contracts`. Only emit events that `ServerEventSchema` accepts. If something needs a schema change, stop and report it.
- Sonic goes over the WebSocket API (`wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`), model `sonic-3.6`, voice `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`, `language: "en"`, output `{container:"raw", encoding:"pcm_s16le", sample_rate:24000}`, a new `context_id` per reply. Never `/tts/bytes`.
- Ink: `wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14`, header `X-API-Key`. Binary raw PCM frames.
- Target time-to-first-audio (turn end → first Sonic chunk) under 400 ms.
- Log every external call with latency in the form `[ink] partial +88ms`, `[sonic] first chunk 212.4ms` (use `logLatency` from `apps/server/src/log.ts` where it fits). Never log headers or keys.
- Secrets come from `process.env` via `requireEnv` (`apps/server/src/env.ts`); dev scripts load `../../.env` with `--env-file`. Do not read or print `.env`.
- Mock lanes (`mockBeliefStream`) are used only when `AHEAD_MOCK_BELIEF=1`. Off by default; no fixture data in the default path.
- `pnpm -r build`, `pnpm -r lint` and `pnpm --filter @ahead/server test` must pass at the end of every task.
- TDD for `TurnTracker` and `VoiceSession` (pure logic). Audio plumbing (`InkClient`, `SonicClient`, browser audio) is verified manually.
- One commit per task, conventional-commit messages, never push.

## Review Focus

1. Ink sends `turn.update` with no prior `turn.start` (reconnect mid-utterance) → a turn is opened implicitly, never a partial with an empty `turnId`. Test in Task 1.
2. `turn.resume` or `turn.end` after the turn already ended → ignored, no event with a stale id. Test in Task 1.
3. `interject` arrives for a turn that has already ended → no speech, no ingest pause. Test in Task 2.
4. User starts a new turn while the previous reply is still playing → server cancels the Sonic context (late chunks dropped) and the browser calls `stopNow()`. Server half tested in Task 2; browser half checked manually in Task 5.
5. Ink or Sonic socket closes (idle timeout, network) → reopened on next use instead of the session dying silently; an `error` event reaches the page. Checked manually in Tasks 3 and 4.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/voice/turns.ts` | `TurnTracker`: raw Ink message → `ServerEvent[]`, owns the `turnId` lifecycle. Pure. |
| `apps/server/src/voice/session.ts` | `VoiceSession`: routes client events to Ink, Ink events to the page, speaks at turn end and on `interject`, ingest gate. Pure given injected deps. |
| `apps/server/src/voice/sonic-client.ts` | `SonicClient`: Cartesia TTS WebSocket, `speak` / `cancelActive`, drops late chunks, TTFA metric. |
| `apps/server/src/voice/ink-client.ts` | `InkClient`: Cartesia STT WebSocket, `sendPcm`, lazy reconnect, cadence log. |
| `apps/server/src/index.ts` | HTTP + `WebSocketServer` on `/ws`, one `VoiceSession` per connection. |
| `apps/server/scripts/smoke-voice.ts` | Headless end-to-end check: streams the fixture WAV through `/ws`, prints events, cadence, TTFA. |
| `apps/web/public/pcm-capture-worklet.js` | AudioWorklet processor posting Float32 mic frames. |
| `apps/web/src/audio/capture.ts` | Mic → 16 kHz Int16 → 100 ms `audio_chunk` frames. |
| `apps/web/src/audio/playback.ts` | `PcmPlayer`: scheduled 24 kHz queue, `stopNow()` with 30 ms gain ramp. |
| `apps/web/src/App.tsx` | Bare page: Start button, live partial, finalized turns, event log, TTFA readout. |

---

### Task 1: TurnTracker (Ink message → contract events)

**Files:**
- Create: `apps/server/src/voice/turns.ts`
- Test: `apps/server/src/voice/turns.test.ts`
- Modify: `apps/server/package.json` (`test` script: add `src/voice/*.test.ts`), `apps/server/tsconfig.build.json` (exclude `src/**/*.test.ts` from the build)

**Interfaces:**
- Produces:
  ```ts
  export type InkMessage = { type: string; transcript?: string; title?: string; message?: string };
  export class TurnTracker {
    constructor(newId?: () => string);           // default: () => 't-' + crypto.randomUUID().slice(0, 8)
    handle(msg: InkMessage, ts: number): ServerEvent[];
    get turnId(): string | null;                 // current open turn, null between turns
  }
  ```

Mapping (ts is passed through as the event `ts`):

| Ink `type` | Emits |
|---|---|
| `turn.start` | new id; `turn_start` |
| `turn.update` | `transcript_partial {text: transcript}` (every update, no dedupe; Lane B diffs) |
| `turn.eager_end` | `turn_eager_end {text: transcript}` |
| `turn.resume` | `turn_resume` (same id) |
| `turn.end` | `transcript_final {text: transcript}` then `turn_end`; id becomes null |
| `error` | `error {message: "<title> <message>", source: "ink"}` |
| anything else (`connected`, …) | `[]` |

`turn.update` / `turn.eager_end` with no open turn opens one implicitly (emit `turn_start` first). `turn.resume` / `turn.end` with no open turn return `[]`.

- [ ] **Step 1: Write the failing tests** in `turns.test.ts` (`node:test` + `node:assert/strict`, ids from a counter `() => 't' + n++`):
  - `maps a full turn`: start, update "Draft a", eager_end "Draft a message.", end "Draft a message." → types `[turn_start, transcript_partial, turn_eager_end, transcript_final, turn_end]`, all with `turnId: 't0'`, final `text === 'Draft a message.'`, and `tracker.turnId === null` afterwards.
  - `resume keeps the same id`: start, eager_end, resume, update, end → every event has `turnId 't0'`; second turn after it gets `'t1'`.
  - `update without start opens a turn`: update "hi" → `[turn_start t0, transcript_partial t0 "hi"]`.
  - `stale resume and end are ignored`: fresh tracker, resume → `[]`; end → `[]`.
  - `every emitted event passes ServerEventSchema`: run the full-turn sequence plus an `error` message; `ServerEventSchema.safeParse(e).success` for each.
  - `ignores connected`: `{type:'connected'}` → `[]`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @ahead/server test` → fails with module not found for `turns.js`.
- [ ] **Step 3: Implement `TurnTracker`** per the table.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @ahead/server test`, then `pnpm -r build && pnpm -r lint`.
- [ ] **Step 5: Commit** — `feat(voice): turn tracker maps Ink events to contract events`

---

### Task 2: VoiceSession (routing, turn-end reply, interject, ingest gate)

**Files:**
- Create: `apps/server/src/voice/session.ts`
- Test: `apps/server/src/voice/session.test.ts`

**Interfaces:**
- Consumes: `TurnTracker`, `InkMessage` (Task 1); `mockBeliefStream` from `@ahead/contracts/mocks`; `ClientEvent`, `ServerEvent` from `@ahead/contracts`.
- Produces:
  ```ts
  export interface InkSink { sendPcm(pcm: Buffer): void; }
  export interface Speaker {
    speak(text: string, opts: { interrupt: boolean; turnId: string }): string; // returns contextId
    cancelActive(): void;                                                       // no-op if nothing playing
  }
  export const TURN_END_REPLY = 'Got it, I heard you.';
  export const INGEST_PAUSE_MS = 1500;
  export class VoiceSession {
    constructor(deps: {
      send: (e: ServerEvent) => void;
      ink: InkSink;
      speaker: Speaker;
      now?: () => number;            // default Date.now
      mockBelief?: boolean;          // default false; index.ts passes process.env.AHEAD_MOCK_BELIEF === '1'
      mockSpeed?: number;            // passed to mockBeliefStream, default 1
    });
    handleClient(ev: ClientEvent): void;
    handleInk(msg: InkMessage): void;
    handleInterject(turnId: string, text: string): void;
  }
  ```

Behavior:
- `audio_chunk`: if `sampleRate !== 16000` send `error {source:'voice'}` once per session and drop; if `now() < pausedUntil` drop (do not send zeros, so Ink does not count it as silence); else `ink.sendPcm(Buffer.from(pcm, 'base64'))`. Other client events: ignore (Lanes C/D own them).
- `handleInk`: forward every event from `tracker.handle(msg, now())` to `send`. On `turn_start`: `speaker.cancelActive()` (user barge-in over a reply); if `mockBelief`, start `mockBeliefStream(turnId, {speed: mockSpeed})` and forward every event it yields, except call `handleInterject` for `interject` events. On `turn_end`: `speaker.speak(TURN_END_REPLY, {interrupt:false, turnId})`.
- `handleInterject(turnId, text)`: ignore unless `turnId === tracker.turnId`; ignore if this turn already interjected (max one per turn, PLAN.md). Otherwise `send(interject)`, `speaker.speak(text, {interrupt:true, turnId})`, `pausedUntil = now() + INGEST_PAUSE_MS`. Lane B will call this directly after integration.
- A mock stream whose turn has ended stops forwarding (check `tracker.turnId` before each forward).

- [ ] **Step 1: Write the failing tests** with a fake `InkSink` (records buffers), fake `Speaker` (records calls, returns `'c' + n`), a settable clock, `send` pushing into an array:
  - `forwards audio when open`: `audio_chunk` 16000 → one `sendPcm` call whose bytes equal the decoded base64.
  - `rejects wrong sample rate`: 48000 → no `sendPcm`, one `error` event; a second bad chunk adds no second error.
  - `turn end speaks the canned reply`: Ink start/update/end → `speak` called once with `TURN_END_REPLY`, `{interrupt:false, turnId:<that turn>}`.
  - `interject pauses ingest for 1500 ms`: open turn, `handleInterject(id, 'x')` at t=1000 → `interject` event sent, `speak('x', {interrupt:true, turnId:id})`; audio at t=2499 dropped; audio at t=2500 forwarded.
  - `interject for an ended turn is ignored`: turn ends, then `handleInterject(oldId, 'x')` → no speak, no interject event, audio still forwarded.
  - `one interjection per turn`: two `handleInterject` calls in one turn → one speak with `interrupt:true`.
  - `new turn cancels the active reply`: turn 1 ends, turn 2 `turn.start` → `cancelActive` called.
  - `mock belief drives the interject path`: `mockBelief:true, mockSpeed:50`, real `Date.now` clock; Ink `turn.start`, await ~150 ms → sent events include `moss_hits`, `belief_update`, exactly one `interject` with `DEMO_INTERJECTION`, and speaker got `{interrupt:true}`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @ahead/server test` → module not found for `session.js`.
- [ ] **Step 3: Implement `VoiceSession`.**
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @ahead/server test`, then `pnpm -r build && pnpm -r lint`.
- [ ] **Step 5: Commit** — `feat(voice): voice session routes turns, reply and interject`

---

### Task 3: SonicClient (TTS WebSocket) + TTFA measurement

**Files:**
- Create: `apps/server/src/voice/sonic-client.ts`, `apps/server/scripts/smoke-sonic-ws.ts`
- Modify: `apps/server/package.json` (script `smoke:sonic-ws`: `node --env-file=../../.env --import tsx scripts/smoke-sonic-ws.ts`), `docs/sdk-notes.md` (Sonic WebSocket section)

**Interfaces:**
- Consumes: `Speaker` (Task 2) — `SonicClient` implements it.
- Produces:
  ```ts
  export class SonicClient implements Speaker {
    constructor(opts: { apiKey: string; send: (e: ServerEvent) => void });
    connect(): Promise<void>;   // opens the socket now so the first reply skips the handshake
    speak(text: string, opts: { interrupt: boolean; turnId: string }): string;
    cancelActive(): void;
    close(): void;
  }
  ```

Approach (audio plumbing, no TDD):
- Before writing, check the Cartesia TTS WebSocket docs (context7 `cartesia`, or docs.cartesia.ai) for exact message shapes and auth; sdk-notes says these are untested live. Start with header `X-API-Key` (same as Ink) and `cartesia_version` in the query.
- `speak`: `contextId = crypto.randomUUID()`. If `interrupt` or a context is active, `cancelActive()` first. Send `{model_id, transcript, voice, language:'en', context_id, output_format, continue:false}`. If the socket is not open, connect then send (queue the request).
- Incoming `chunk` for the active context → `send({type:'tts_audio_chunk', turnId, contextId, pcm: data, sampleRate:24000, done:false})`. On first chunk of a context: `logLatency('sonic', 'first chunk', ms)` and `send({type:'metric', source:'sonic', label:'ttfa', ms})`, where ms is measured from the `speak()` call. `done` for the active context → one `tts_audio_chunk` with `pcm:''`, `done:true`, then clear active. Chunks/done for any other context id → drop.
- `cancelActive`: send `{context_id, cancel:true}`, mark it dropped, clear active.
- `error` messages → `send({type:'error', source:'sonic', message})`, log `[sonic] error ...`. Socket `close` → mark closed; next `speak` reconnects.
- `smoke-sonic-ws.ts`: connect, then speak the 90-char `DEMO_INTERJECTION` and the short `TURN_END_REPLY` 3 times each (wait for `done` between), print first-chunk ms per run, total bytes and audio seconds, and write the last reply to `var/spikes/sonic-ws.raw`. Also time one cancel: speak, cancel after the first chunk, count chunks that arrive afterwards for that context (they must not be forwarded).

- [ ] **Step 1: Implement `SonicClient`** and the smoke script.
- [ ] **Step 2: Run** `pnpm --filter @ahead/server smoke:sonic-ws`. Expected: 6 first-chunk lines, all requests `done`, zero forwarded chunks after cancel. Play the raw file to confirm it is speech: `ffplay -f s16le -ar 24000 -ac 1 var/spikes/sonic-ws.raw` (or `sox`), or convert and `afplay`. If p50 first-chunk is ≥ 400 ms, try the documented latency options (for example a smaller `max_buffer_delay_ms`) and record what changed.
- [ ] **Step 3: Record in `docs/sdk-notes.md`** under "Cartesia Sonic → WebSocket": the message shapes that actually worked, auth method, first-chunk ms per run (warm socket), cancel behavior observed, and any difference from docs. Replace "These WebSocket details come from the docs and are untested live" with the measured status.
- [ ] **Step 4: Checks** — `pnpm -r build && pnpm -r lint && pnpm --filter @ahead/server test` pass.
- [ ] **Step 5: Commit** — `feat(voice): Sonic WebSocket client with cancel and TTFA metric`

---

### Task 4: InkClient + server entry + headless smoke

**Files:**
- Create: `apps/server/src/voice/ink-client.ts`, `apps/server/scripts/smoke-voice.ts`
- Modify: `apps/server/src/index.ts` (replace the scaffold log), `apps/server/package.json` (scripts `dev`: `node --env-file=../../.env --import tsx src/index.ts`, `smoke:voice`: `node --import tsx scripts/smoke-voice.ts`), `docs/sdk-notes.md` (Ink section)

**Interfaces:**
- Consumes: `InkMessage` (Task 1), `InkSink`, `VoiceSession` (Task 2), `SonicClient` (Task 3).
- Produces:
  ```ts
  export class InkClient implements InkSink {
    constructor(opts: { apiKey: string; onMessage: (m: InkMessage) => void; onError: (msg: string) => void });
    connect(): Promise<void>;
    sendPcm(pcm: Buffer): void;  // reconnects lazily if closed; frames sent while connecting are queued
    close(): void;
  }
  ```
  Server: `PORT` env (default `8787`), WebSocket path `/ws`. Each connection: create `SonicClient`, `InkClient`, `VoiceSession`; call `connect()` on both; parse frames with `parseClientEvent` (invalid → `error` event); on socket close, close both clients.

Approach:
- `InkClient` mirrors `apps/server/scripts/spike-ink.ts` (URL, header, JSON text messages). It does not send `{"type":"close"}` between turns; one socket serves many turns. If Ink closes the socket after `turn.end` or on idle, the next `sendPcm` reopens it. Log each `turn.update` as `[ink] partial +<ms since previous update>ms` and `turn.end` as `[ink] turn.end`.
- `smoke-voice.ts`: read `scripts/fixtures/demo-utterance-1.wav` (reuse the WAV parsing from `spike-ink.ts`; copy the function, the spike stays untouched), connect to `ws://localhost:${PORT}/ws`, send 100 ms `audio_chunk` frames in real time then 2.5 s of zero frames, then keep listening until the first `tts_audio_chunk` with `done:true` or 15 s. Print each event type with `+ms`, then a summary: partial count, partial gap mean/max, `turn_end` → first `tts_audio_chunk` ms (client-observed TTFA), and the server `metric ttfa` value. Exit 1 if no `transcript_final` or no audio.

- [ ] **Step 1: Implement `InkClient`, the server entry, and the smoke script.**
- [ ] **Step 2: Run the server** `pnpm --filter @ahead/server dev` (background), then `pnpm --filter @ahead/server smoke:voice`. Expected: `turn_start`, ~17 `transcript_partial`, `turn_eager_end`, `transcript_final` with "Draft a message to Priya saying, I'll see her Thursday at 2 for the Q3 deck review.", `turn_end`, then `tts_audio_chunk`s ending `done:true`. Run the smoke twice on the same server to prove a second connection works, and once more with `AHEAD_MOCK_BELIEF=1` on the server to see `moss_hits`/`belief_update`/`interject` and an interrupting `tts_audio_chunk` stream mid-turn.
- [ ] **Step 3: Check multi-turn on one Ink socket**: run the smoke with the WAV sent twice in one connection (flag `--twice`) and confirm two `turn_start`s with different ids. Record whether Ink kept the socket open between turns.
- [ ] **Step 4: Record in `docs/sdk-notes.md`** (Ink section, new "Live server path" subsection): partial cadence through the server (mean/max gap), TTFA (server metric and client-observed) for 3 runs, whether the Ink socket survives across turns and idle behavior seen.
- [ ] **Step 5: Checks** — `pnpm -r build && pnpm -r lint && pnpm --filter @ahead/server test`.
- [ ] **Step 6: Commit** — `feat(voice): Ink client, /ws server and headless voice smoke`

---

### Task 5: Browser capture, playback and bare page

**Files:**
- Create: `apps/web/public/pcm-capture-worklet.js`, `apps/web/src/audio/capture.ts`, `apps/web/src/audio/playback.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/vite.config.ts` (proxy `/ws` → `ws://localhost:8787`, `ws: true`), `docs/sdk-notes.md`

**Interfaces:**
- Consumes: the `/ws` server (Task 4), `ServerEvent`, `parseServerEvent`, `ClientEvent` from `@ahead/contracts`.
- Produces:
  ```ts
  // capture.ts
  export function startCapture(onChunk: (ev: Extract<ClientEvent, { type: 'audio_chunk' }>) => void): Promise<() => void>; // returns stop()
  // playback.ts
  export class PcmPlayer {
    enqueue(contextId: string, pcmBase64: string, sampleRate: number): void;
    stopNow(): void;               // gain → 0 over 30 ms, stop all scheduled sources, reset queue
    onFirstAudio?: (contextId: string) => void;  // fires when a context's first buffer is scheduled
  }
  ```

Approach (manual verification):
- Worklet: `/* global registerProcessor, AudioWorkletProcessor */` at top (eslint has no browser-worklet globals). `process()` posts a copy of `inputs[0][0]` to the port.
- Capture: `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, channelCount:1}})`, `new AudioContext({sampleRate:16000})`, load `/pcm-capture-worklet.js`. Convert Float32 → Int16 (clamp), accumulate 1600 samples (100 ms), base64, emit `{type:'audio_chunk', pcm, sampleRate:16000, seq}`.
- Playback: one `AudioContext` (default rate), a `GainNode` to destination. `enqueue`: decode base64 → Int16 → `AudioBuffer` at `sampleRate`; if `contextId` differs from the current one, `stopNow()` first; schedule at `max(ctx.currentTime, nextStart)`. Empty pcm (the `done` chunk) is skipped. `stopNow()`: `gain.linearRampToValueAtTime(0, t + 0.03)`, stop sources at `t + 0.03`, then restore gain to 1 for the next context.
- App: Start button (AudioContext needs a user gesture) opens `ws://<host>/ws`, starts capture, creates the player. Shows the current partial (large), finalized turns above, the current `turnId`, a scrolling log of event types with `+ms`, and TTFA = `turn_end` arrival → `onFirstAudio` for the reply's context, plus the server `metric ttfa`. On `turn_start`, call `player.stopNow()` (barge-in over a reply). Keep styles inline and minimal; Lane D owns the real HUD.

- [ ] **Step 1: Implement worklet, capture, playback, page, proxy.**
- [ ] **Step 2: Checks** — `pnpm -r build && pnpm -r lint`.
- [ ] **Step 3: Manual run** — server `pnpm --filter @ahead/server dev`, web `pnpm --filter @ahead/web dev`, open the page in Chrome, click Start, say "Move my Friday meeting with Priya to Monday morning." Expected: partials grow word by word, a finalized line appears at turn end, the canned reply is heard. Do 3 utterances. Then restart the server with `AHEAD_MOCK_BELIEF=1`, speak utterance 1, and confirm the interjection plays over you and transcription of your continued sentence resumes in the same turn after 1.5 s. Speak again while a reply is playing and confirm it cuts out within ~30 ms.
- [ ] **Step 4: Record in `docs/sdk-notes.md`** (new "Lane A live measurements" under Ink/Sonic): browser partial cadence, browser-observed TTFA for the 3 utterances, interjection behavior and any echo/self-transcription seen.
- [ ] **Step 5: Commit** — `feat(web): mic capture, PCM playback and bare voice page`
