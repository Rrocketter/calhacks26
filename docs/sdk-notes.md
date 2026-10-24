# SDK notes

Numbers are measured output from the spike scripts, not estimates. Earlier runs are kept as recorded; each SDK ends with a "Final verification run" line from Task 10.

## Summary for lanes

- Moss: load `ahead-corpus` and the `ahead-memory` session at server startup (3-index cap, no other names). Queries are in-process, about 2 ms p50. Never call `loadIndex` on the request path (2 to 20 s).
- Ink 2: `turn.update` is cumulative, one about every 250 ms. `turn.eager_end` = finalize speculation, `turn.resume` = un-finalize (same turn), `turn.end` = close. Normalize numbers and punctuation before intent matching.
- Sonic: use the WebSocket for the product (`/tts/bytes` is spike-only, TTFB 370 to 550 ms), model `sonic-3.6`, new `context_id` per reply. Cancel only stops ungenerated audio, so also drop late chunks and flush playback.
- Droid: the workspace lives outside the repo (`~/.ahead/workspace`, `AHEAD_WORKSPACE` override), and Lane C must refuse a workspace located under the repo (`reset:workspace` already refuses; the executor does not exist yet).
- Droid sandbox: per-session settings file, denyRead `$HOME` + repo + secret dirs, `allowRead` the workspace (undocumented key, fails closed), denyWrite `.git`. Verify `session.settings.sandbox.enabled` before the first prompt.
- Droid tools: exact allowlist `Create, Edit, Read, TodoWrite, ToolSearch`. Read/LS bypass the permission handler, so the sandbox is the control.
- Droid watchdog: abort on any tool outside the allowlist or any path outside the workspace, emit `droid_event` with `denied:true`, `interrupt()` then `close()`. It is detection plus a fast stop, not the control.
- Droid behavior: a denied call (`Cancel`) ends the turn, and `Off` autonomy removes write tools until `updateSettings({enabledToolIds})`.
- Droid child env: the SDK spawns the CLI with `{...process.env, ...env}`, so every server secret reaches the child unless removed. Pass `env` with the allowlist `FACTORY_API_KEY, PATH, HOME, TMPDIR, LANG, USER, SHELL` and every other key set to `undefined` (spawn drops undefined values). See `droidChildEnv()` in `apps/server/scripts/spike-droid.ts`.

## Differences from PLAN.md (as of Lane 0)

Commits 8c312ea and 2511e9f updated PLAN.md for the items marked "absorbed". Checked against the current PLAN.md text.

| Spike finding | PLAN.md |
| --- | --- |
| Sonic latest model is `sonic-3.6`, not 3.5 | absorbed |
| Ink 2 has no word-level partials, only cumulative `turn.update` | absorbed |
| `turn.eager_end` / `turn.resume` drive two-phase speculation | absorbed (contracts events in 1571198) |
| Moss package is `@moss-js/moss`, free plan caps at 3 indexes | not in PLAN.md, see Moss section |
| Droid has no plan event, plans are `TodoWrite` calls | not in PLAN.md, see Droid section |
| Read/LS bypass the permission handler, so confinement is sandbox + watchdog | partly absorbed (line 92 covers workspace location, disabled tools, watchdog; the sandbox is not mentioned) |
| Autonomy `Off` removes write tools, re-enable with `updateSettings` | not in PLAN.md, see Droid section |
| Cancel from the handler ends the turn | not in PLAN.md, see Droid section |
| TypeScript 6.0.3 and vitest 4.1.12 pins | not in PLAN.md (toolchain detail, see package.json) |
| Workspace moved to `~/.ahead/workspace` | absorbed |

## Moss

- Package: `@moss-js/moss@1.21.0` (pinned with `-E`). ESM only. Native N-API binding comes from the optional dependency `@moss-js/moss-core-darwin-arm64` (0.36.0), so it runs on arm64 with no Rosetta. If you see "Cannot find native binding", check that pnpm installed optional deps.
- Run: `pnpm -r build` first (contracts dist), then `pnpm --filter @ahead/server spike:moss`. The script sets `MOSS_DISABLE_TELEMETRY=1`.
- Calls used: `new MossClient(projectId, projectKey)`, `listIndexes()`, `deleteIndex(name)`, `createIndex(name, docs, {modelId: 'moss-minilm'})`, `loadIndex(name)`, `query(name, text, {topK})`, `close()` in `finally`.
- Docs are `{id, text, metadata}`; metadata values must be strings.
- `createIndex` on an existing name throws "Index already exists", so list and delete first.
- `loadIndex` must be called before `query` (queries run locally; there is no cloud query fallback). Source: the SDK's own error when querying an unloaded index in 1.21.0: `NOT_FOUND Index "nope" is not loaded. Call loadIndex("nope") or loadIndexes([...]) before querying; queries run locally and there is no cloud query fallback.`

### Measured (10 docs, 20 timed queries)

| Step | Cold (first run) | Warm (second run) |
| --- | --- | --- |
| createIndex (upload + cloud build + poll) | 3820.6 ms | 3326.3 ms |
| loadIndex | 19866.4 ms | 2172.6 ms |
| warmup query | 2.1 ms | 1.9 ms |
| query wall-clock p50 | 2.0 ms | 1.9 ms |
| query wall-clock p95 | 2.4 ms | 2.4 ms |
| SDK `timeTakenInMs` p50 / p95 | 0 / 0 | 0 / 0 |

SDK `timeTakenInMs` is integer ms (sub-ms rounds to 0), so wall-clock around the call is the number to use.

Model cache location: unknown. The 1.21.0 types only expose `cachePath` (optional, for persisting downloaded index data) on the load options, with no documented default. Where the embedding model is stored was not found in the SDK types. The cold-to-warm drop in loadIndex (19.9 s to 2.2 s) suggests something is cached between runs, but the location is not confirmed.

Top hits:
- "draft a message to Priya" -> `evt-priya-q3` (score 0.036)
- "meeting with Priya Thursday" -> `evt-priya-q3` (score 0.351)
- "q3 deck" -> `contact-priya` (score 1.000), not the file doc. The contact doc text says "owns the Q3 deck review", so it matches "q3 deck" about as well as the file doc does; the file doc is not clearly the better semantic match.
- "what time is my Priya meeting" -> `evt-priya-q3` (score 0.353)

### Quirks

- `loadIndex` took about 20 s on the cold first run and 2.2 s on the warm second run. The cause of the cold cost (possibly an embedding model download) is unconfirmed, see Model cache above. Call `loadIndex` at server startup, never on the request path.
- Queries are in-process and fast (about 2 ms) once loaded, well under the 10 ms target.
- Scores are not comparable across queries (a 1.000 top score for "q3 deck" still ranked the contact above the file). Do not threshold on raw score without tuning. Short queries like "q3 deck" may favor the contact doc; consider `alpha` tuning or richer doc text in the corpus.
- `timeTakenInMs` is integer-resolution, so measure latency with `performance.now()` around the call.

**Final verification run (Task 10):** createIndex 6618.6 ms, loadIndex 4401.4 ms (index already built earlier, model cached), warmup query 5.0 ms, query p50 2.0 ms, p95 2.2 ms, SDK `timeTakenInMs` 0 / 0. Same top hits as before.

### ahead-corpus (Lane B)

382 docs from `gen:corpus`, built by `pnpm --filter @ahead/server build:index` (createIndex 5499 ms, loadIndex 2427 ms warm). Query wall-clock p50 1.9 ms, p95 2.5 ms (20 queries, k=3).

Top-3 by `alpha` (hybrid weight, lower = more keyword):

| Query | 0.3 | 0.5 | 0.7 |
| --- | --- | --- | --- |
| draft a message to priya | `contact-priya` at 3 | not in top 3 (rank 4) | not in top 5 |
| priya thursday | `evt-priya-q3` at 1 | `evt-priya-q3` at 1 | `evt-priya-q3` at 2 |
| what time is my priya meeting | `evt-priya-q3` at 3 | `evt-priya-q3` at 3 | not in top 5 |

`MossIndex` uses `alpha: 0.3`. The note `note-2026-10-20-q3-planning` often ranks first for Priya queries, so rely on rank within top 3, not top 1.

### Index names (rule)

- The free plan allows 3 indexes total. The project also holds `product-search-context` (not ours; leave it alone), so only 2 slots are ours.
- Our names are `ahead-corpus` (Lane B owns it) and `ahead-memory` (conversation memory), both exported from `MOSS_INDEX` in `@ahead/contracts`. `ahead-spike` was deleted on 2026-10-24 to make room for `ahead-memory`; `spike:moss` recreates it, so delete `ahead-memory` first if you need to run it.
- No lane creates any other index.

### Conversation memory (`ahead-memory`, 2026-10-24)

- **Incremental upsert exists.** `client.session(name)` returns a `SessionIndex` whose `addDocs(docs, {upsert})` embeds and indexes in process (upsert is the default), and `query` sees the doc at once. No rebuild of a second index is needed. `pnpm --filter @ahead/server spike:memory` measures it.
- **`pushIndex` only creates.** With the project at the 3-index cap, `pushIndex` on an index that already exists fails with "The project's usage limit has been reached; billing must be updated" (`UNAUTHORIZED`), even from a fresh session. Replacing seems to need a temporary extra slot. The first push (creating the index) works. After that, cloud `client.addDocs(name, docs, {upsert: true})` works; it polls until the server rebuild finishes.
- **`session.loadIndex` of a missing index** resolves to 0 docs, no error. The store checks `getIndex` first and skips the load when the index is absent.
- **Scores are not comparable across indexes.** For "what did I tell priya", the 2-doc memory index scored 0.48 to 0.64 and the corpus 0.07 to 0.39. Merging by score would let memory push the corpus out. `MossIndex.query` keeps the corpus top 3 (the interject's strong-hit ranks), then up to 2 memory hits with `minScore` 0.3, then the rest of the corpus, capped at k.
- **What is written** (`apps/server/src/moss/memory.ts`, orchestrator):
  - After each turn end: `memory-<turnId>` with the final transcript, a one-line belief summary and the outcome (`committed`, `rolled back`, `lookup`, `staged`, `no action`). It is upserted when a staged turn commits or rolls back. Bare yes/no turns write nothing.
  - After each COMMITTED: `memory-<turnId>-artifact` with the added lines of the turn's last diff per file (the draft text) or "changed X to Y" (the calendar edit).
  - Metadata `{type: 'memory', date, people, outcome}`. Memory snippets are 400 chars (corpus 160) so a lookup answer sees the committed text. The HUD tags `memory-` hits "memory" and always shows them in the Moss panel.
- **Measured:**

  | Step | Time |
  | --- | --- |
  | `client.session()` at startup | 1.0 to 2.0 s (20.8 s once) |
  | `session.loadIndex` at startup, 0 docs / 11 docs | 0.6 s / 7.3 s (one slow run; corpus `loadIndex` was 18.7 s in the same run) |
  | in-process `addDocs` (upsert), per doc | 7 to 47 ms |
  | memory `query` | 3 to 10 ms, run in parallel with the corpus query |
  | first `pushIndex` (creates the index) | 1.6 to 2.6 s, off the hot path |
  | cloud `addDocs` upsert (rebuild), 1 doc | 2.9 to 3.9 s (10 s once), off the hot path |

- **DEMO_MODE check:** `demo:run demo-utterance-1 --confirm=spoken`, then `memory:check` (fixture `demo-lookup-priya`, "What did I tell Priya?"). PASS in 2 of 2 runs: the final belief was `lookup` with `memory-<turn>-artifact` in its hits, first memory hit 0.8 s into the turn. The spoken answer: "You told Priya Shah in a message on October 24 that you'd see her Friday, October 30 at 2 to go over the Q3 deck." With memory populated, utterance 1 still interjects at about 3.1 s.
- Memory persists across server restarts. To start clean, delete the `ahead-memory` index.

## Cartesia Sonic (TTS)

**`/tts/bytes` is spike-only. It proves the key and gives a rough time-to-first-byte, but Lane A must use the Sonic WebSocket for real time-to-first-audio.**

- Spike endpoint: `POST https://api.cartesia.ai/tts/bytes` with `Authorization: Bearer <key>`, `Cartesia-Version: 2026-08-14`, `Content-Type: application/json`.
- Model `sonic-3.6`, voice Skylar `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`, `language: "en"`, output `{container:"wav", encoding:"pcm_s16le", sample_rate:24000}`. Model and voice are constants at the top of `apps/server/scripts/spike-sonic.ts`.
- Run: `pnpm --filter @ahead/server spike:sonic`. Output goes to `var/spikes/sonic.wav` (gitignored).

### Measured (run 1, 90-character interjection line)

| Metric | Value |
| --- | --- |
| First byte | 547.9 ms |
| Total | 926.6 ms |
| Audio | 5.60 s (268878 bytes, mono 24 kHz s16le) |

`file` reports RIFF WAVE, 16 bit, mono 24000 Hz.

### Quirks

- `voice` as a plain string id worked, no `{id}` wrapper needed.
- Send `language` only, not `locale`.
- The body is a WAV with a 44-byte header, so duration is (bytes - 44) / (24000 * 2).
- Non-2xx: the spike prints `[sonic] error <status> <body>` and exits 1. Never print request headers (they hold the key).
- Valid model ids: `sonic-3.6` (latest), `sonic-3.5`, `sonic-3`.

**Final verification run (Task 10):** first byte 369.4 ms, total 1119.5 ms, 276558 bytes (5.76 s). First byte varies by about 180 ms between runs (547.9 vs 369.4), so quote a range.

### WebSocket (what Lane A should use)

Verified live with `pnpm --filter @ahead/server smoke:sonic-ws` (client: `apps/server/src/voice/sonic-client.ts`).

- Endpoint: `wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`. Auth header `X-API-Key` works (same as Ink).
- Request that worked: `{model_id:"sonic-3.6", transcript, voice, language:"en", context_id, output_format:{container:"raw", encoding:"pcm_s16le", sample_rate:24000}, continue:false}`. `voice` as a plain id string, no `{id}` wrapper.
- Responses seen: `chunk {data: base64, context_id, done:false}` and `done {context_id, done:true}`. Each message carries `context_id`, so filter on it. `error` has `message`, `context_id`, `done:true`; not triggered in the smoke run.
- Use a new `context_id` per reply. One socket handles many sequential contexts.
- Cancel: `{context_id, cancel:true}`. Docs say it only halts generation that has not started. Observed: cancel sent right after the first chunk of a 5.6 s line; 1 more chunk arrived afterwards (dropped by the client, 0 forwarded), then nothing for 3 s. Still drop by `context_id` client-side and flush browser playback.

Measured (warm socket, first chunk measured from the `speak()` call):

| Run | First chunk | Audio |
| --- | --- | --- |
| cold: connect (346.1 ms) + speak | 470.0 ms | 1.60 s ("Got it, I heard you.") |
| warm demo line #1 | 74.2 ms | 5.76 s |
| warm demo line #2 | 73.8 ms | 5.60 s |
| warm demo line #3 | 73.4 ms | 5.60 s |
| warm turn-end reply #1 | 73.4 ms | 1.60 s |
| warm turn-end reply #2 | 88.7 ms | 1.52 s |
| warm turn-end reply #3 | 72.9 ms | 1.52 s |

- Warm p50 73.6 ms (min 72.9, max 88.7), well under the 400 ms target. No latency options needed, so `max_buffer_delay_ms` was not touched.
- The cold request pays the handshake. Call `SonicClient.connect()` at session start so the first reply is warm.
- Compare `/tts/bytes`: 369 to 548 ms first byte. The WebSocket is about 5x faster warm.
- Output check: `var/spikes/sonic-ws.raw` converted to WAV is 1.52 s, peak 29902, RMS 3168 (non-silent, speech-level). No one listened to it in this run.
- No differences from the docs found, apart from the cancel behavior above.

## Cartesia Ink 2 (STT)

Spike: `pnpm --filter @ahead/server spike:ink` streams `apps/server/scripts/fixtures/demo-utterance-1.wav` (made with macOS `say`, 16 kHz mono s16, 4.78 s) in real time.

- Endpoint: `wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14`.
- Auth: header `X-API-Key` worked on the first try. No need for `Authorization: Bearer`.
- Send raw PCM (no WAV header) as binary frames of 3200 bytes every 100 ms, then 2.5 s of zero frames, then text `{"type":"close"}`. The server flushes and closes with code 1000.
- Ink 2 has no word-level partials. `turn.update` carries the cumulative transcript, which maps to our `transcript_partial` event.

### Measured (run 1, times relative to first audio byte)

| Metric | Value |
| --- | --- |
| `connected` | +1 ms |
| `turn.start` | +463 ms |
| First `turn.update` | +1439 ms ("Draft a") |
| Updates in turn | 17 |
| Gap between updates | mean 246 ms, max 720 ms |
| `turn.end` after last speech frame | 1124 ms |
| `turn.eager_end` to `turn.end` gap | 345 ms |

Final transcript: `Draft a message to Priya saying, I'll see her Thursday at 2 for the Q3 deck review.`

### Quirks

- Spoken "two" comes back as "2", and a comma appears after "saying". Do not match on exact strings; normalize before intent matching.
- Bursts of near-identical updates happen (for example +3204, +3219, +3236 ms). Do not debounce at Ink's ~250 ms cadence (PLAN.md section 8): query on every update and skip updates whose text did not change (diff only).
- The final `turn.update` and `turn.eager_end` arrived in the same millisecond (+5380 ms), and `turn.end` followed 345 ms later. The final update adds a trailing period.
- `say` writes a WAV that `file` describes only as "RIFF data, WAVE audio", so the spike's parser walks chunks to find `fmt ` and `data`.
- Errors print as `[ink] error <title> <message>`. Headers and keys are never printed.

**Final verification run (Task 10):** `turn.start` +343 ms, first `turn.update` +1377 ms, 17 updates, gap mean 252 ms and max 569 ms (run 1 had max 720 ms), `turn.end` 959 ms after the last speech frame (run 1: 1124 ms), `turn.eager_end` to `turn.end` 145 ms (run 1: 345 ms). Transcript identical. The eager_end gap varies a lot, so do not hardcode it.

### Turn events

- `turn.start` is always the first event in a turn.
- `turn.update.transcript` is cumulative within the turn and never revised.
- `turn.eager_end` fires when the end-of-turn probability crosses `turn_eager_end_threshold` (default 0.6). It carries the transcript so far.
- It is always followed by exactly one of `turn.resume` (the user kept talking, the same turn continues, more `turn.update` follow) or `turn.end` (turn closed, final transcript).
- AHEAD uses `turn.eager_end` as the "finalize speculation" signal. It must treat `turn.resume` as "un-finalize, keep speculating", not as a new turn.
- In the spike run `turn.eager_end` appeared once and `turn.end` followed 345 ms later. `turn.resume` did not appear (the fixture has no mid-utterance pause), so its handling is untested live.

### Live server path

Run: `pnpm --filter @ahead/server dev` (background), then `pnpm --filter @ahead/server smoke:voice` (`-- --twice` for two turns on one socket). Client: `apps/server/src/voice/ink-client.ts`. The smoke streams the fixture as 100 ms `audio_chunk`s, then zero frames like a live mic.

| Run | Partials | Gap mean / max | TTFA server (`metric ttfa`) | TTFA client (`turn_end` to first chunk) |
| --- | --- | --- | --- | --- |
| 1 | 17 | 251 / 737 ms | 84.9 ms | 84 ms |
| 2 | 17 | 252 / 593 ms | 72.1 ms | 74 ms |
| 3 | 17 | 252 / 599 ms | 68.4 ms | 68 ms |
| `--twice` turn 1 | 17 | 251 / 607 ms | 76.1 ms | 76 ms |
| `--twice` turn 2 | 15 | 245 / 594 ms | 77.6 ms | 78 ms |
| after 60 s idle | 17 | 251 / 608 ms | 95.4 ms | 97 ms |

- Through the server, cadence matches the direct spike (about 250 ms). TTFA is 68 to 97 ms, well under the 400 ms target, because both Cartesia sockets are opened at connection time (`[ink] connect` 90 to 170 ms, `[sonic] connect` 90 to 190 ms).
- Transcript identical to the spike in every normal run. `turn.end` came about 185 ms after `turn.eager_end`.
- One Ink socket serves many turns. No `{"type":"close"}` is needed between turns; Ink did not close after `turn.end`. Two turns on one connection got different turn ids.
- Idle: both sockets stayed open through 60 s with no frames sent at all. The lazy reconnect in `InkClient.sendPcm` was never triggered, so it is untested live.
- `--twice` must wait out the reply before sending again. Sending right after `done` drops the first ~2 s of turn 2 (mic muted while the 1.6 s reply plays + 300 ms tail, `[voice] dropped 20 mic frames`).
- Mute window seen: turn-end reply `mute until` +1615 to +1909 ms after its `done`; the mock interjection +5580 / +5929 ms (dropped 60 / 64 mic frames).

**Mock belief run (`AHEAD_MOCK_BELIEF=1`, `smoke:voice -- --mock`):**
- Ink finding (before the fix, 2/2 runs): when the interjection mute cut the user off mid-sentence ("...Thursday at"), `turn.end` came 5.6 s after the last partial. That is Ink's `end_timeout_ms` (default 5600 ms, query param `turn_end_timeout_ms`, range 640 to 11200): the cut-off sentence never drops the turn likelihood below `end_threshold`. Then, not in the docs, Ink sent `turn.start` again 8 ms later with only zeros flowing and no `turn.update` after it. The phantom turn cancelled the turn-end reply before its first chunk and restarted the mock stream (a second interjection).
- Fix: `VoiceSession` ignores a bare `turn.start`. Barge-in (cancel the active reply) and the mock stream start on the first non-empty `transcript_partial`, and `TURN_END_REPLY` is spoken only when `transcript_final` is non-empty. Treat `turn.start` as a hint, never as proof the user is talking.
- After the fix (1 run): mock stream starts at the first partial (+1.35 s), `interject` at +3.86 s (one only), first interjection chunk 80.3 ms later. Mute until +5343 ms, 58 mic frames dropped. Final transcript stops at "...Thursday at 2 for the Q3" (the starting point moved 1 s later, so more audio got through). This time Ink ended the turn normally, 785 ms after `turn.eager_end`, so the timeout path did not run. Reply TTFA 79.5 ms server, 81 ms client, `done:true`.

## Factory Droid SDK

**CANARY READ BYPASSED HANDLER.** Droid's `Read` and `LS` tools read files outside the workspace without ever calling the permission handler. The handler only scopes writes. Without the sandbox, treat everything the server process can read as readable by the model. See Confinement for the fix.

- Package: `@factory/droid-sdk@0.10.0` (pinned with `-E`), imported from `@factory/droid-sdk/node`. No postinstall build script, so pnpm did not block anything.
- `createSession` spawns the local `droid` CLI (`~/.local/bin/droid`, v0.249.0) as `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` and passes `FACTORY_API_KEY` from `process.env`.
- Options used: `cwd: WORKSPACE_DIR`, `modelId: 'claude-haiku-5-5'` (accepted, no fallback needed), `autonomyLevel: AutonomyLevel.Off`, `permissionHandler`, `abortSignal` (180 s watchdog), and a longer `disabledToolIds` list (see Confinement; the Task 9 spike used only Execute, Script, FetchUrl, WebSearch).
- Script: `pnpm --filter @ahead/server spike:droid` (`apps/server/scripts/spike-droid.ts`). It leaves `notes/spike.md` uncommitted in the runtime workspace, so run `pnpm reset:workspace` afterwards.
- **The child env is merged, not replaced.** In `dist/node.mjs` the spawn env is `{...sanitizeSpawnEnv({...process.env, ...config.env}), ...config.trustedEnv}` (ProcessManager, about line 3378), `sanitizeSpawnEnv` is a no-op (about line 561), and `createTransport` adds `FACTORY_API_KEY` and `FACTORY_UPSTREAM_*` on top of `options.env`. So `env: {PATH, ...}` alone still forwards the Cartesia, Moss and Anthropic keys that `--env-file` loaded. Setting every other key to `undefined` removes it, because `child_process.spawn` skips undefined values (checked with `/usr/bin/env` on Node 20.19.4). `listModels` takes the same `env`. Run 2026-10-23 with the allowlisted env: every verdict line matched the final verification run below, `createSession` 562 to 876 ms.

### Quirks

- **No dedicated plan event.** Plans arrive as `tool_call` name `TodoWrite` (or, in spec mode, an `ExitSpecMode` permission request with `details.plan`). Source: research in the SDK `.d.ts` files, not observed live. Lane C maps TodoWrite to droid_event kind:'plan'.
- **At `AutonomyLevel.Off` the CLI removes Create/Edit/ApplyPatch.** `session.listTools()` shows them `allowed=false`, and the model reports "no tool can create or write files". At `low` they come back. To keep Off and still route writes through the handler, call `session.updateSettings({ enabledToolIds: ['Create','Edit','ApplyPatch'] })` right after `createSession`. `enabledToolIds` is not in the 0.10.0 TypeScript type for `updateSettings`, so it needs a cast, but the CLI accepts it (listTools then shows `Create=true Edit=true`, settings show them in `enabledToolIds`). Took 10 to 17 ms.
- **Returning `Cancel` ends the whole turn.** After the outside write was denied, the turn finished with `result success` and the remaining step never ran. The spike sends step 3 as a second `session.stream()` turn on the same session. AHEAD's executor should expect a denial to stop the plan.
- `permissionHandler` fired once per write with `confirmationType`/`details.type = 'create'` and an absolute `details.filePath`. The only options to return are values from `params.options`; we return `proceed_once` or `cancel`, and a `permission_resolved` event follows within 1 ms.
- Tools still allowed at Off with our disabled list: Read, LS, Grep, Glob, Task, Skill, ToolSearch, TodoWrite, ConnectApp, ListAutomations, ReadAutomation, ListAutomationTemplates, StageSettingsChanges. None of them asked for permission. `Task` (subagents) and `Skill` are now disabled, see Confinement.
- Droid masked the secret-shaped values in the canary before they reached the model. The Read result was 101 bytes (the file size), contained the key name `FAKE_KEY`, contained a mask run, and did not contain the 32-hex canary value. The model answered "The read succeeded. The file is 101 bytes." This masking is Droid's own behavior and should not be relied on: file names, non-secret text, and directory listings outside the workspace are fully visible (an `LS` of the repo root returned 1526 bytes).
- The model calls `ToolSearch` when it can't find a tool; it returned a 24-byte error each time.

### Permission handler behavior observed

Note: this table and the Task 9 verdict and latency below are from the old layout (`var/workspace`). The workspace is now `~/.ahead/workspace` (override `AHEAD_WORKSPACE`), outside the repo.

| Tool | Reached handler | Outcome |
|---|---|---|
| Create `var/workspace/notes/spike.md` | yes (`create`) | allow, file written |
| Create `var/outside-spike.txt` | yes (`create`) | deny, tool_result error (39 bytes), file absent |
| Read `<repo>/.env.canary` | **no** | succeeded, 101 bytes, values masked |
| LS `<repo>` | **no** | succeeded, 1526 bytes |

### Verdict (run 3, final script)

```
model: claude-haiku-5-5
handler saw types: create
tools called: Create,Read,ToolSearch,LS
write-inside: ok
write-outside: denied
canary-read: handler-saw=no succeeded=yes bytes=101
canary leaked to model: no
git -C var/workspace status --short:   (old layout, pre-move run)
?? notes/spike.md
```

Run 1 (before re-enabling write tools) gave the same canary result: `handler-saw=no succeeded=yes bytes=101`, leaked `no`.

### Latency (run 3)

- `createSession` (spawn CLI + init): 894 ms. Earlier runs: 2159 ms (first run, cold), 720 ms.
- First stream event: 12 ms after `stream()` (`mcp_status_changed`); first tool call (Create) at +5391 ms from session start.
- Turn 1 (two Creates): `done success +7418ms`, CLI `durationMs=6485`.
- Turn 2 (canary read): finished at +23159 ms from session start, CLI `durationMs=15739`.

### Implication

The runtime workspace should move outside the repo (and away from `.env`), or the executor needs a sandbox, because the handler cannot block reads. Reported to the human per the plan.

### Confinement (Task 12, revised after review)

**Sandbox findings, with sources**

- Droid ships a beta OS-level sandbox (Seatbelt on macOS). Sources: [docs.factory.com/cli/configuration/sandbox](https://docs.factory.com/cli/configuration/sandbox.md) and [docs.factory.com/autonomy-and-safety/sandbox](https://docs.factory.com/autonomy-and-safety/sandbox.md). Documented keys: `sandbox.enabled`, `sandbox.mode` (`per-command` default, or `whole-process`), `sandbox.filesystem.denyRead`, `allowWrite`, `denyWrite` (wins over allowWrite), `sandbox.network.allowedDomains`. The docs say reads are allow-all except `denyRead` and list no `allowRead`.
- **Observed: an undocumented `filesystem.allowRead` is honored as a carve-out inside `denyRead`.** With `denyRead: [$HOME]` and no allowRead, the in-workspace Edit failed with "Sandbox: read denied to ~/.ahead/workspace/notes/spike.md" (`SPIKE_READ_POLICY=home-noallow`). With `allowRead: [<workspace>]` added, Create, Edit and Read inside the workspace all worked and every canary read stayed denied. If a future CLI drops `allowRead`, the workspace becomes unreadable, which fails closed. This is now the spike's default policy (`home`).
- Droid still starts and works with `~/.factory` in denyRead. In `per-command` mode the main process is not sandboxed, so only the tools are blocked from reading it.
- Per session, no global config: `droid exec --settings <path>` ("runtime settings file merged for this process only") goes through the SDK's `execArgs` (appended by `buildArgs` in `dist/node.mjs`). `session.settings.sandbox` reports `{enabled: true, mode: 'per-command'}` when the file is applied, and the spike aborts otherwise. The `pickModel` probe session gets the same file. `~/.factory/settings.json` was not touched.
- Default runtime policy (`home`): `denyRead: [realpath($HOME), realpath(REPO_ROOT) + lexical REPO_ROOT if it differs, ~/.ssh, ~/.aws, ~/.config, ~/.netrc, ~/.npmrc, ~/.gnupg, ~/.factory]`, `allowRead: [realpath(workspace)]`, `denyWrite: [<workspace>/.git, REPO_ROOT spellings]`. Writes outside the cwd are denied by default. `SPIKE_READ_POLICY=list` drops `$HOME` and the allowRead.
- Spelling probes, all denied by the sandbox in all three sandbox-on policies: canonical absolute, relative (`../../Developer/calhacks26/.env.canary`), case variant (`/Users/rahulgupta/developer/calhacks26/.env.canary`), and a symlink to the canary in `$TMPDIR`. So the sandbox matches APFS case variants and resolves symlinks.

**Tools**

- `disabledToolIds`: Execute, Script, FetchUrl, WebSearch, LS, Glob, Grep, Task, Skill, ConnectApp, StageSettingsChanges, ListAutomations, ReadAutomation, ListAutomationTemplates.
- `ToolSearch` cannot be disabled. With it in `disabledToolIds`, `listTools()` still reports it allowed. It only looks up deferred tools and returned "Tool(s) not found" whenever it was called.
- Verified allowed set (exact match required, otherwise the spike aborts): `Create, Edit, Read, TodoWrite, ToolSearch` (+ `ApplyPatch` only if offered; claude-haiku-5-5 does not offer it, so it is untested live).
- The model still emits `Execute` calls now and then. The CLI rejects them ("Tool Execute is not permitted in this exec session"). The watchdog's name allowlist also aborts on them.

**Handler observations**

- Create and Edit inside the workspace reached the handler (`create`, `edit`) and were allowed.
- With the sandbox on, the outside Create was denied by the sandbox ("Sandbox: write denied") and never reached the handler. With the sandbox off, the handler denied it.

**Watchdog: what it does, and what actually stopped each canary read**

- It runs on every `tool_call`. It aborts if the tool name is not in the allowlist (`Read, Create, Edit, ApplyPatch, TodoWrite, ToolSearch`), or if any path-like input resolves outside the workspace. Path-like inputs: `file_path`, `filePath`, `path`, `paths[]`, `directory_path`, `dir`, `folder`, `cwd`, `pattern`/`glob` prefix, `target`, `notebook_path`, plus any other non-content string containing `/`, a `..` segment or a leading `~`. Paths are resolved with an lstat walk (a dangling symlink means deny), and the root and `.git/` are denied. On abort it logs every offending call, emits a `droid_event` for each one (validated with `parseServerEvent`; an invalid event fails the run), calls `session.interrupt()`, waits up to 1500 ms for the turn's `result`, breaks out of the stream, and calls `session.close()` (close took 1.4 to 2.3 s).
- **Sandbox on** (2 runs, policy `home`, 4 probes each = 8 canary reads): every read was **denied by the sandbox**. The watchdog fired on all 8, but the tool_result was already the sandbox denial, and the turn ended `success` 8 to 15 ms after `interrupt()`. Whether the interrupt ended the turn or the turn finished on its own can't be told apart here. **The watchdog was not tested in this mode.**
- **Sandbox off** (1 run, 4 canary reads): **the watchdog interrupt cancelled the Read in 4/4 calls**. The tool_result was "cancelled" (39 bytes) and the turn ended `interrupted` 16 to 23 ms after the interrupt. `close()` was never needed to end the turn.
- The watchdog is a race, not a guarantee. It sees the call only after Droid has decided to make it, and 4 local wins do not prove that a slower path can't lose. **The sandbox's denyRead (with allowRead for the workspace) is the control. The watchdog is detection plus a fast stop.**
- Spike-only exemption: the path check skips Create/Edit/ApplyPatch so the write-outside denial stays measurable. The name allowlist still applies to them.

**Final verification run (Task 10):** policy `home`, sandbox `enabled=true mode=per-command`, allowed tools `Create,Edit,Read,TodoWrite,ToolSearch`. write-inside ok (edit ok), read-inside ok, write-outside denied, all 4 canary reads sandbox-denied (81 bytes, handler-saw=no), watchdog fired on all 4 with interrupt-to-result 9 to 13 ms, canary leaked no, writes-session watchdog fires 0, invalid droid_events 0. `createSession` 501 to 879 ms across the five sessions of this run.

**Lane C rule:** the executor must watch every tool_use event and abort the session if any path resolves outside the workspace, emitting droid_event kind:'tool' denied:true. It must also abort on any tool name outside its allowlist, start Droid with the per-session sandbox settings file (denyRead `$HOME` + repo + the secret dirs above, allowRead the workspace, denyWrite `.git`), and verify `session.settings.sandbox.enabled` and the exact `listTools()` allowed set before the first prompt. After an abort it should `interrupt()`, then `close()`. It must spawn Droid with the allowlisted child env (see Summary for lanes). Lane C should classify denials from structured fields (for example `SandboxViolationType` in the SDK), not from regexes over tool_result text as this spike does. The guard tests in `apps/server/scripts/spike-droid.guard.test.ts` are the TDD seed.

**Measured verdicts (final code)**

Sandbox on, policy `home`, run 1 (run 2 identical except interrupt-to-result times):
```
sandbox: enabled=true mode=per-command read-policy=home
handler saw types: create,edit
write-inside: ok (edit: ok)
read-inside: ok
write-outside: denied
canary-read[absolute]: attempted=yes handler-saw=no succeeded=no bytes=81
watchdog[absolute]: fired=yes before-result=yes method=interrupt(result=success, +11ms) result=sandbox-denied stopped-by=sandbox
canary-read[relative]: attempted=yes handler-saw=no succeeded=no bytes=81
watchdog[relative]: fired=yes before-result=yes method=interrupt(result=success, +14ms) result=sandbox-denied stopped-by=sandbox
canary-read[case-variant]: attempted=yes handler-saw=no succeeded=no bytes=81
watchdog[case-variant]: fired=yes before-result=yes method=interrupt(result=success, +11ms) result=sandbox-denied stopped-by=sandbox
canary-read[symlink]: attempted=yes handler-saw=no succeeded=no bytes=81
watchdog[symlink]: fired=yes before-result=yes method=interrupt(result=success, +15ms) result=sandbox-denied stopped-by=sandbox
canary leaked to model: no
watchdog fires in writes session: 0
invalid droid_events: 0
```

Sandbox off (`SPIKE_SANDBOX=off`):
```
sandbox: not reported
write-inside: ok (edit: ok)
read-inside: ok
write-outside: denied
canary-read[absolute|relative|case-variant|symlink]: attempted=yes handler-saw=no succeeded=no bytes=39
watchdog[absolute]: fired=yes before-result=yes method=interrupt(result=interrupted, +18ms) result=cancelled stopped-by=watchdog
watchdog[relative]: fired=yes before-result=yes method=interrupt(result=interrupted, +23ms) result=cancelled stopped-by=watchdog
watchdog[case-variant]: fired=yes before-result=yes method=interrupt(result=interrupted, +16ms) result=cancelled stopped-by=watchdog
watchdog[symlink]: fired=yes before-result=yes method=interrupt(result=interrupted, +20ms) result=cancelled stopped-by=watchdog
canary leaked to model: no
```

Experiments: `SPIKE_READ_POLICY=list` gave the same canary result as `home` (all 4 sandbox-denied, read-inside ok). `home-noallow` denied all 4 canary reads but broke the in-workspace Edit (`edit: fail`), which shows allowRead is what keeps the workspace readable.

**Latency (Task 12 runs):** `createSession` 441 to 1051 ms. updateSettings plus listTools under 15 ms. Interrupt to turn end 8 to 23 ms. `close()` 1.4 to 2.3 s. A canary-read session took about 4 to 7 s, mostly model time before the Read call.

## Lane A browser audio

- The Vite dev server proxies `/ws` to `ws://localhost:8787` (`ws: true`); the page connects to `ws://<location.host>/ws`. Verified headless: smoke-voice with `AHEAD_SERVER_PORT=5173` gets partials and Sonic chunks through the proxy.
- Capture runs an `AudioContext({sampleRate:16000})` with an AudioWorklet and sends 100 ms s16le chunks. Playback uses the default context rate and schedules `AudioBuffer`s gaplessly per Sonic `contextId`.

### Lane A live measurements

To fill in after the spoken test: partial cadence, client TTFA (turn_end to first scheduled buffer), server `ttfa` metric, mic resume delay.
## Anthropic (Haiku intent)

`@anthropic-ai/sdk` 1.3.0 (exact pin) in `apps/server`, used by `HaikuIntentLlm` (`apps/server/src/belief/haiku.ts`). Request: `claude-haiku-5-5`, `max_tokens: 512`, `thinking: {type: 'disabled'}`, `output_config: {effort: 'low', format: {type: 'json_schema', schema}}`, no temperature/top_p, no tool_choice.

- SDK 1.3.0 types already include `output_config` (`effort`, `format: JSONOutputFormat`) and `ThinkingConfigDisabled`. No casts needed.
- Structured output comes back as one `text` block holding the JSON. The schema uses `additionalProperties: false` and makes every field required; entities are sent as `[{key, value}]` and turned into a record after parsing.
- Haiku returns the person as spoken (`"priya"`); the tracker maps it to the contact's full name.
- It produces `claims` on its own when a context snippet contradicts the partial (it flagged `said: thursday, known: Friday, docId: evt-priya-q3`). Case is not consistent, so normalize before comparing.

### Measured (2026-10-24, "draft a message to priya" plus 2 context snippets)

- First call in a process: 2898 ms (includes TLS setup and probably schema compilation).
- Next 6 calls: 1508 to 1626 ms (about 1.5 s steady state). Every call returned `draft_message` at confidence 0.9.
- That is slower than the ~1 s we planned for. The Moss loop doesn't wait on it (calls are fire-and-forget, up to `MAX_LLM_IN_FLIGHT: 2` in flight per turn), but the lock lands about 1.5 s after the partial that triggered it. A warm-up call at startup would remove the cold-start cost.

### Belief replay (Lane B)

`pnpm --filter @ahead/server replay` plays `demo-utterance-1` in real time through the live tracker (real Moss `ahead-corpus` + Haiku), after a warm-up outside timing (`loadIndex` + one query, one Haiku call). Measured 2026-10-24, 8 runs:

- Moss: 50 queries per turn (1 to 5 per partial). Per-query wall time inside the replay p50 7.4 to 15.8 ms, p95 17 to 31 ms. That is higher than the 2 ms measured with serial queries, because the tracker fires one partial's queries with `Promise.all` and each one's wall time includes waiting on the others. Still far under the 250 ms gap between partials.
- Haiku streaming calls: mostly 0.9 to 1.9 s, with outliers of 4.2 to 5.4 s (3 of about 50 calls). The first trigger is partial #1 ("Draft a message", +1.25 s), so the lock lands at +2.7 to +3.2 s.
- Without the "rate the intent only" prompt rule, Haiku rated "Draft a message" at 0.6 every time (fused 0.76: locks, but below `INTERJECT_AT`). With it: 0.9. Runs 1 to 4 (old prompt): 2 PASS, 2 FAIL (fused 0.76). Runs 5 to 8 (new prompt): 3 PASS, 1 FAIL.
- Passing runs: lock +2.68 to +2.98 s, interject +3.03 to +3.05 s on the "Thursday" partial (+3.01 s), so the interject comes 15 to 35 ms after that partial arrives.
- Before the trigger change below, the demo needed the first Haiku call to return within about 1.75 s. Run 5 took 1.84 s: the lock came 93 ms after the Thursday partial and the interject still fired on that partial, but the strict verdict counts it as FAIL.

After the tracker fixes (LLM call on the first changed partial, up to `MAX_LLM_IN_FLIGHT: 2` calls at once, no interject while finalized, `onEagerEnd` no longer waits for in-flight calls, fast `day`/`time` win over Haiku's): 6 runs, 6 PASS.

- Lock +1.78 to +2.75 s (on partials #3 to #6), interject +3.03 to +3.05 s on the Thursday partial (+3.01 to +3.02 s). The first call now starts at +1.0 s on "Draft a" (Haiku: draft_message 0.9), so the lock no longer depends on a single call finishing in 1.75 s.
- Haiku calls (including warm-up): 51 calls, 683 ms to 2255 ms, p50 1419 ms. 7 to 8 streaming calls plus 1 final call per turn (was 5 to 6).
- Final belief arrives 1.15 to 1.66 s after `transcript_final` (one final Haiku call). Before the fix it was up to about 10 s, because the eager end waited for every in-flight call.
- Moss: 50 queries per turn, p50 15 to 17 ms, p95 28 to 32 ms (concurrent wall time; the extra LLM traffic shares the event loop).

#### Moss: sequential vs `Promise.all` (measured 2026-10-24)

The tracker now logs Moss once per changed partial as `[moss] step X.Xms (N queries)`: the wall time of that partial's whole batch. `MossIndex.query` still logs each query as `[moss] query X.Xms`; the tracker no longer logs it a second time. `belief.latencyMs.moss` is that batch wall time (it used to be the max per-query time). The replay prints it per partial (`step`) and as `moss step` p50/p95 in the verdict.

A/B with the stricter verdict, 3 runs each way (16 changed partials, 50 queries per turn):

| | per-query p50 | per-query p95 | step p50 | step p95 | verdict |
| --- | --- | --- | --- | --- | --- |
| sequential (`for ... await`) | 4.6 to 5.7 ms | 18.1 to 21.1 ms | 20.8 to 25.6 ms | 35.1 to 36.7 ms | 3 PASS |
| `Promise.all` | 9.9 to 17.0 ms | 23.8 to 30.5 ms | 16.7 to 26.9 ms | 26.4 to 33.9 ms | 3 PASS |

- Step p50 is about the same either way. Step p95 is a few ms higher sequential. Both are far under the 250 ms gap between partials.
- Sequential gives honest per-query numbers (each query's time is its own), so the tracker runs queries in sequence.
- In sequential runs the first query of a step is usually the slowest (10 to 25 ms) and the rest take 2 to 6 ms. Hypothesis, not shown: the first query after an idle gap pays a warm-up cost, or shares the event loop with Haiku responses landing at the same time. The standalone spike measured about 2 ms per query with nothing else running.
- The replay verdict now also requires: the lock lands before the Thursday partial arrives (not just attributed to an earlier partial), the interject lands before the next partial arrives, the lock is `draft_message` with person `Priya Shah`, and the interject text is exactly `Heads up, Priya's meeting is Friday, not Thursday. Say Friday?`.
### Executor (Lane C)

Live smoke: `pnpm --filter @ahead/server smoke:executor` (`apps/server/scripts/smoke-executor.ts`). A real `Speculator` over `createDroidExecutor`, fed `turn_start`, a fixture `reschedule_event` belief (Priya Q3 review, Friday 2 PM to Monday 2026-11-02 9:00 AM, confidence 0.86), `turn_eager_end`, `turn_end` and a confirm. Run A confirms (commit), Run B rejects (rollback). It forces `AHEAD_WORKSPACE=~/.ahead/workspace-executor` so it never touches `~/.ahead/workspace`, and resets that workspace before each run and at the end. The script waits for Phase 1 to finish before sending eager end, so the two phases time separately. In the live server, eager end can land while Phase 1 is still running.

Both runs passed twice on 2026-10-24 (claude-haiku-5-5, droid CLI v0.249.0). Every run: one `diff` event for `calendar.json` only (471 characters), `evt-priya-q3` moved to `2026-11-02T09:00:00-08:00` / `10:00:00-08:00` (correct PST offset after the DST change, no template fix needed), no denied tool calls, every event valid, workspace clean on `main` with no `spec/*` branch after commit and after rollback, and `calendar.json` byte-identical to the seed after rollback.

| ms | Run 1 commit (pre-TodoWrite-fix) | Run 1 rollback (pre-TodoWrite-fix) | Run 2 commit | Run 2 rollback |
|---|---|---|---|---|
| createSession (first in process / later) | 762 | 447 | 794 | 530 |
| createSession (warm after commit or rollback) | 594 | 767 | 549 | 572 |
| Phase 1 (prepare branch + turn + commit) | 14475 | 7289 | 8236 | 16564 |
| Phase 2 (turn + commit) | 14575 | 12269 | 11065 | 12753 |
| diff (git) | 28 | 24 | 37 | 27 |
| belief lock to diff | 29078 | 19582 | 19339 | 29345 |
| commit / rollback | 1729 | 1618 | 936 | 1939 |

- `createSession` was 447 to 794 ms across all eight sessions, in either process. No clear cold/warm split.
- Phase 2 is mostly the model checking its own work. The Edit lands 3.8 to 6.4 s into the turn, then the model re-Reads `calendar.json`, updates its TodoWrite plan and writes a summary, and the turn ends at 11 to 14.5 s. The diff is only emitted after the turn ends, so about half of Phase 2 is post-edit. A "stop after the edit" line in the template is the obvious lever; not tried yet.
- Phase 1 varies from 7 to 16.5 s for the same prompt. The Read lands at 3.1 to 4.0 s; the rest is model time after it (TodoWrite plus reply text).
- `commit` and `rollback` include `session.close()` (1 to 2 s, as in the spike). The git part is tens of ms.
- **TodoWrite input is a string, not an array.** The CLI schema is `TodoWriteToolInputSchema = { todos: z.string() }` (`@factory/droid-sdk` `dist/chunk-TWAVPIPS.mjs`), and the model sends checklist lines like `1. [completed] Read calendar.json`. The SDK's own `parseTodos` also accepts arrays and a JSON-array string, but it isn't exported. Run 1 emitted every `plan` event with `steps=0` because `turn.ts` only read arrays; `turn.ts` now parses all those shapes (`todoSteps`, regression test in `turn.test.ts`), and Run 2 showed 4 to 5 steps per plan.
- No edits in Phase 1 in any run (Phase 1 only Read and TodoWrite), and the model never called a disabled tool.
- After commit or rollback the state machine warms a fresh session. `DroidExecutor.close()` shuts it down so a script or a server shutdown can exit cleanly. `close()` is terminal: afterwards `warm()` opens nothing and phases throw `SpeculationFailed('executor closed')`.

#### After latency fixes

Three more smoke runs on 2026-10-24 after two changes: every Phase 2 template now says `Stop immediately after the edit. Do not re-read the file or update the plan.` (find_file: reply with the path), and the executor emits the diff as soon as a Create/Edit/ApplyPatch result returns (`git add -A` plus `git diff --cached main` on the working tree), instead of at turn end. All six runs passed. Each emitted exactly one `diff` event (`calendar.json`, 471 characters): the end-of-phase diff matched the early one, so nothing was re-emitted. No denied tool calls.

`phase2-to-first-diff` runs from `turn_eager_end` to the first `diff` event. `lock-to-first-diff` runs from the belief lock to that event. `lock-to-diff` runs to the `result` event, where the old turn-end diff used to go, so it lines up with the earlier "belief lock to diff" row.

| ms | Run 1 commit | Run 1 rollback | Run 2 commit | Run 2 rollback | Run 3 commit | Run 3 rollback |
|---|---|---|---|---|---|---|
| createSession | 793 | 526 | 745 | 570 | 794 | 639 |
| Phase 1 | 7224 | 7204 | 6842 | 6867 | 16598 | 6219 |
| Phase 2 | 10765 | 10971 | 10376 | 12133 | 14767 | 11476 |
| phase2-to-first-diff | 3757 | 3416 | 3365 | 5323 | 4435 | 4630 |
| lock-to-first-diff | 10981 | 10620 | 10207 | 12190 | 21034 | 10849 |
| lock-to-diff | 18017 | 18209 | 17242 | 19026 | 31387 | 17725 |
| commit / rollback | 1616 | 1351 | 1482 | 1045 | 1221 | 1489 |

Before/after: the diff used to reach the HUD 19.3 to 29.3 s after the belief lock (Phase 2 11.1 to 14.6 s). It now arrives 10.2 to 21.0 s after the lock, 3.4 to 5.3 s into Phase 2.

- The stop line cut the post-edit tool calls but not the post-edit time. In 5 of 6 runs Phase 2 made no tool call after the Edit, yet the turn still ended 6.8 to 7.5 s after the Edit result: that's reply text only. Phase 2 as a whole (10.4 to 14.8 s) is about the same as before, so the early diff is what moved the number.
- Run 3 commit: the model still called TodoWrite after the Edit (+13.4 s), ignoring "do not update the plan". Its Phase 1 also took 16.6 s with two TodoWrite calls, which is what pushed that run's lock-to-first-diff to 21 s.
- The early diff and the committed diff are byte-identical for a modified file and for a new file (`git.test.ts` checks both), which is why the end-of-phase pass re-emits nothing.

#### STAGED when the edit lands (R25)

- `STAGED` now fires when Phase 2's edit lands, not when the Droid turn ends. Each successful Create/Edit/ApplyPatch result commits the working tree on `spec/<turnId>` (`phase2-edit`), emits the changed `diff` events, and the first one moves the state machine to `STAGED`. A Phase 2 with no edit (for example `find_file`) still stages when its turn ends.
- The turn keeps running in the background, and its end is informational: on success it still emits any changed final diff and `result {ok:true, summary}`. A confirm in `STAGED` commits right away. If the turn is still running, the commit interrupts it, resets the branch to the staged commit (dropping any later half-landed edit) and merges, so `main` gets exactly the diff the HUD showed. That superseded turn emits no `result`.
- If the turn fails after staging, the executor emits `droid_event kind:'result' payload {ok:false, failed:true, summary:'droid turn failed after staging'}`. The state stays `STAGED`, there's no rollback, and the staged diff can still be applied. The HUD should mark the diff stale.
- `DroidResultPayload` in contracts is still `{ok, summary}` and doesn't declare `failed`. The wire schema accepts it because `payload` is `unknown`. Lane D should read `failed` defensively (`(payload as {failed?: boolean}).failed === true`) until the human updates contracts.
- One live smoke run on 2026-10-24 passed both runs. Run A confirmed as soon as `STAGED` showed, and the commit interrupted the live Phase 2 turn 5.9 s in. main then held exactly the staged `calendar.json` change, with a clean tree and no `spec/*`. Run B (rollback) was unchanged. No `failed:true` result appeared in either run.

| ms | Commit | Rollback |
|---|---|---|
| createSession | 1212 | 1778 |
| Phase 1 | 11957 | 8472 |
| phase2-to-first-diff | 5870 | 5195 |
| lock-to-staged | 17827 | 13667 |
| lock-to-diff (turn-end result) | n/a (turn superseded by commit) | 21334 |
| commit / rollback | 1846 | 1769 |

`lock-to-staged` matches `lock-to-first-diff` to within 1 ms. In the rollback run, `STAGED` came 7.7 s before the turn ended.

## Integration

One `Orchestrator` per connection (`apps/server/src/orchestrator.ts`) routes VoiceSession, BeliefTracker and Speculator events per MERGE.md Step 2. Headless check: `DEMO_MODE=1 pnpm --filter @ahead/server dev`, then `pnpm --filter @ahead/server demo:run <fixture> --confirm=spoken|client|reject`. The driver plays the fixture through the live tracker, Moss, Haiku, Droid and Sonic. Only Ink is replaced. It answers the interject correction and the "Apply?" prompt, then checks the workspace `main`. Measured 2026-10-24, droid CLI v0.249.0, claude-haiku-5-5.

**Startup (before listening):** Moss `loadIndex` 3.1 to 6.4 s, Haiku warm-up 1.6 to 2.2 s, Droid `createSession` 0.7 to 1.3 s.

All times are from the fixture's `turn_start`. `merge done` runs from STAGED to the executor's `commit`/`rollback` metric. It includes the STAGED line playing and the 0.75 s spoken "Yes."/"No." fixture turn.

| ms | utt 1 spoken (a) | utt 1 spoken (b) | utt 1 client | utt 2 spoken | utt 2 reject |
|---|---|---|---|---|---|
| lock | 2412 | 1969 | 2411 | 2434 | 2282 |
| interject | 3042 | 3046 | 3054 | n/a | n/a |
| first droid_event | 5824 | 6686 | 6246 | 7129 | 5649 |
| STAGED | 24623 | 21830 | 18811 | 18050 | 25814 |
| merge done after STAGED | n/a (driver bug, fixed) | 2774 | 1815 | 2910 | 3754 (rollback) |
| result | main has Friday draft | PASS | PASS | PASS | PASS, main untouched |

- After the phantom-turn fix (636cf68), re-run with spoken confirms: utterance 1 lock 2024, interject 3058, first droid_event 6423, STAGED 23273, merge done +2592 after STAGED, PASS (draft says Friday). Utterance 2 lock 2281, first droid_event 5098, STAGED 14897, merge done +2553, PASS. Live `smoke:voice` PASS again (server Sonic TTFA 813 ms on that run, 74.9 ms on the first).
- Executor inside these runs: Phase 1 9.1 to 19.0 s, Phase 2 first diff 4.5 to 7.7 s, commit 1.36 to 1.69 s, rollback 1.66 s.
- Utterance 1: the fixture turn ends at +4.95 s. Phase 2 waits for the correction answer (by design, see below), which the driver gives at about +5.5 s, so STAGED lands 13 to 20 s after the user stops. Phase 1 is still running when Phase 2 is queued; the executor serializes them.
- Final Haiku belief after `turn_end`: 0.66 to 2.5 s (mostly 1.0 to 1.8 s).
- Sonic first chunk for orchestrator speech: 75 to 300 ms with a warm socket. One STAGED line took 1254 ms and one took 1054 ms; both came after a long idle gap on the socket. Not investigated.
- Lookup answers (`HaikuAnswerer`) were not exercised by these fixtures.

**Live smoke (`smoke:voice`, real Ink + Sonic, no DEMO_MODE):** PASS. Interject at +4.0 s. Partials pause up to 4.9 s while the interject plays, because the mic is muted. Ink transcribed "Q3 deck" as "Q3 demo". Server Sonic TTFA 74.9 ms. Nobody answered "Say Friday?", so Phase 2 waited out the 8 s correction window and the STAGED line came 13.8 s after `turn_end`. The socket closing then rolled the staged draft back (1.6 s).

### Behavior to know

- **Interject correction:** the interject is just "Say Friday?". The correction is applied only on a spoken yes or `confirm_action {apply:true}` for that turn. No, or silence for 4 s after the turn ends, keeps what was said. Phase 2 does not start until then. A correction yes does not commit; STAGED still asks "Apply?".
- **Spoken confirm (fast path):** while a confirm is pending (correction, or "Apply?" for 6 s), the first non-empty text of the next turn is matched against the yes/no lexicon in `reply.ts` (`parseConfirm`) and acted on at once, on the partial. No turn end, no Haiku. Anything else releases the hold, and the Speculator's own `turn_start` rolls a staged turn back. After the 6 s window a "yes" is an ordinary new turn. The server sends `metric {source:'ink', label:'confirm_window', ms}` (ms > 0 open, 0 closed); the HUD shows "Listening for yes / no".
- **Spoken prompts:** "Say Friday?", "Apply?" ("Open it?" for find_file), "Friday." (correction ack), "Done.", "Dropped.".
- **Eager end waits for the tracker:** Ink's `turn.eager_end` came about 25 ms before the tracker's belief for the same text, so Phase 2 ran on the belief without the last word ("morning"). The orchestrator now forwards eager end to the Speculator only after `tracker.onEagerEnd` resolves (Moss step only, never Haiku). A `turn_resume` or `turn_end` in between drops it. With `morning` = 09:00 in the fast entities, utterance 2 lands at Monday 09:00.
- **Drafts:** the draft_message template now says no sign-off and no names other than the recipient unless spoken.
- **Sonic slow first chunk is not a reconnect:** every slow first chunk (555, 813, 1054, 1254 ms) came on an already-open socket, 13 to 20 s after its last use, with no `[sonic] connect` in between. So no keepalive or reconnect was added. The cause is still unknown.

**Fix-wave re-run (2026-10-24, clean workspace, spoken confirms):** utterance 1 lock 2281, interject 3020, first droid_event 6043, STAGED 14792, merge done +2250, PASS (draft says Friday, no sign-off). Utterance 2 lock 2267, first droid_event 5734, STAGED 19088, merge done +2629, PASS (`2026-10-26T09:00-07:00`). The spoken yes acted 2 ms after its first partial, about 150 ms before `turn_end`. Live `smoke:voice` PASS; interject TTFA 93.5 ms, unanswered correction released at 4 s.

### Spoken-confirm trials (2026-10-24)

`DEMO_MODE=1 DEMO_LIVE_INK=1` keeps real Ink on in DEMO_MODE: fixtures drive the utterance, the mic goes to Ink. `scripts/confirm-trials.ts --wav=yes.wav --delay=N` plays demo-utterance-2 to "Apply?", streams silence frames like a live mic, and splices a 0.48 s "yes" (macOS `say`, Samantha, 16 kHz) in N ms after the prompt audio ends, estimated the way the server's playback clock does. Hit = COMMITTED within 8 s of the yes.

| Tail | Delay | Hits | Notes |
| --- | --- | --- | --- |
| 300 ms | 400 ms | 10/10 | first frame forwarded 7 to 84 ms after mute end; first Ink update 1.2 to 2.2 s after the yes started |
| 300 ms | 0 ms | 0/5 | no Ink update and no turn at all: the mute dropped the first ~300 ms of the word |
| 100 ms | 400 ms | 10/10 | |
| 100 ms | 0 ms | 5/5 | first update 1.0 to 2.8 s after the yes started |

- Dominant failure mode: a quick "yes" that starts inside the mute tail loses its first syllable and Ink emits nothing (no `turn.update`, no `turn.end`). No trial showed a `turn.end` with no update.
- Fix applied: `PLAYBACK_TAIL_MS` 300 to 100. The browser mic runs with `echoCancellation: true`. Not yet checked on speakers at the mic for self-transcription.
- Ink needs 1.0 to 2.8 s from the start of a one-word "yes" to its first update, so a spoken confirm lands about 1.5 s after the user speaks. The confirm card's Y / Enter is instant.
- Diagnostics in the server log: `[voice] dropped N mic frames; first frame forwarded +Xms after mute end`, `[voice] first update <turn> +Xms after mute end "<text>"`, `[voice] turn.end with no update <turn>`.


### Retrieval A/B: Moss vs cloud-sim (2026-10-24)

- **Switch:** the HUD top bar has a Retrieval toggle (Moss / Cloud-sim +300). It sends client event `retrieval_mode`. The server switches that connection's `SwitchableRetriever` (`apps/server/src/moss/cloud-sim.ts`) and confirms with metric `retrieval:<mode>`. Cloud-sim returns the same Moss results after a 300 ms sleep per query (`CLOUD_SIM_MS`), so only latency differs. It is a comparison, labelled cloud-sim everywhere, never a backend.
- **Interject lag:** the time from the first partial containing the contradicted word ("Thursday") to the interject. The orchestrator sends it as metric `interject_lag:<mode>`, and the HUD shows the last value per mode under each toggle option (kept across demo resets). The replay prints it as `interject lag`.
- **Measured** with `replay --local-corpus --retrieval=<mode>` on demo-utterance-1, 3 runs each, real Moss (synthetic corpus in an in-process session index) and real Haiku:

  | Retrieval | Interject lag after "Thursday" | Interject from turn start | Moss step per partial p50 / p95 |
  | --- | --- | --- | --- |
  | Moss (in process) | 12 to 17 ms | 3.02 to 3.03 s | 10 to 13 ms / 17 to 27 ms |
  | Cloud-sim (+300 ms per query) | 3.7 to 4.1 s | 6.8 to 7.2 s | 911 to 925 ms / 1.53 s |

- Why cloud-sim is so much worse than 300 ms: the tracker runs 1 to 4 queries per partial one after another, and partials arrive every 250 ms. At 300 ms a query, each partial's step takes 0.3 to 1.2 s, the steps queue up, and the interject lands after the sentence is over (the fixture ends at about 5 s). With Moss the interject lands on the "Thursday" partial itself, before the next one.
- **Corpus note:** `ahead-corpus` was rebuilt at 11:29 on 2026-10-24 with 321 imported Google docs (`g-email-*`, `g-contact-*`, `g-evt-*`), and `data/corpus/corpus.json` is gone. `evt-priya-q3` is no longer in the index, so demo-utterance-1 no longer locks or interjects against `ahead-corpus` (`replay` fails, `demo:run` fails "no interject"). `replay --local-corpus` uses the synthetic corpus from `generateCorpus()` in memory, without writing `data/corpus` or touching the cloud. The fixtures need re-recording on the real data.

### Correction wording fix (2026-10-24)

- **Bug:** after an accepted correction (Thursday to Friday), Haiku's free-form entities could still hold the spoken words in another slot (e.g. `message: "I'll see her Thursday at 2..."`). `correctBelief` fixed only `day`/`weekday`/`date_iso`, so Phase 2 got both days.
- **Fix:**
  - `correctBelief` makes the corrected value the only value. It replaces the spoken word in every free-text slot (not `weekday`/`date_iso`, which `resolveDay` sets) and records `superseded_<field>`.
  - Phase 2 drops `superseded_*` from the slots and adds: "Correction: the user originally said thursday, this was corrected to friday. Use friday only and do not mention thursday."
  - Post-check in the executor: an edit whose added lines name the superseded value (whole word, any case; values with a letter only) is not shown or staged. After the turn, such a draft gets one fix turn (metric `phase2-reject`). If it still names the value, Phase 2 fails rather than stage it.
- **Measured** with `scripts/correction-trials.ts` (real Droid, Phase 1 and Phase 2 on a fresh seed workspace, utterance 1's belief with the spoken message slot, correction applied by `correctBelief`):
  - With the fix: **5/5 pass** (Friday, no Thursday). The post-check never had to rerun, so the prompt alone was enough. 18 to 29 s per trial.
  - Control (`--control`, the old correction): 0/5. Every draft said Thursday and none said Friday.
- The DEMO_MODE fixture path could not be used for this: with the new corpus, utterance 1 never interjects (see the corpus note above).
