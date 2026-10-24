# SDK notes

Other sections are added per spike. Numbers are measured output from the spike scripts, not estimates.

## Moss

- Package: `@moss-js/moss@1.21.0` (pinned with `-E`). ESM only. Native N-API binding comes from the optional dependency `@moss-js/moss-core-darwin-arm64` (0.36.0), so it runs on arm64 with no Rosetta. If you see "Cannot find native binding", check that pnpm installed optional deps.
- Run: `pnpm -r build` first (contracts dist), then `pnpm --filter @ahead/server spike:moss`. The script sets `MOSS_DISABLE_TELEMETRY=1`.
- Calls used: `new MossClient(projectId, projectKey)`, `listIndexes()`, `deleteIndex(name)`, `createIndex(name, docs, {modelId: 'moss-minilm'})`, `loadIndex(name)`, `query(name, text, {topK})`, `close()` in `finally`.
- Docs are `{id, text, metadata}`; metadata values must be strings.
- `createIndex` on an existing name throws "Index already exists", so list and delete first.
- `loadIndex` must be called before `query` (no cloud fallback in 1.21.0).

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

- `loadIndex` took about 20 s on this first run. Likely the embedding model downloading from models.moss.link at runtime. Call `loadIndex` at server startup, never on the request path. Re-measure on a warm run.
- Queries are in-process and fast (about 2 ms) once loaded, well under the 10 ms target.
- Scores are not comparable across queries (a 1.000 top score for "q3 deck" still ranked the contact above the file). Do not threshold on raw score without tuning. Short queries like "q3 deck" may favor the contact doc; consider `alpha` tuning or richer doc text in the corpus.
- `timeTakenInMs` is integer-resolution, so measure latency with `performance.now()` around the call.

### Index names (rule)

- The free plan allows 3 indexes total.
- The only allowed index names are `ahead-spike` (spikes) and `ahead-corpus` (Lane B owns it), both exported from `MOSS_INDEX` in `@ahead/contracts`.
- No lane creates any other index.

## Cartesia Sonic (TTS)

**`/tts/bytes` is spike-only. It proves the key and gives a rough time-to-first-byte, but Lane A must use the Sonic WebSocket for real time-to-first-audio.**

- Spike endpoint: `POST https://api.cartesia.ai/tts/bytes` with `Authorization: Bearer <key>`, `Cartesia-Version: 2026-08-14`, `Content-Type: application/json`.
- Model `sonic-3.6`, voice Skylar `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`, `language: "en"`, output `{container:"wav", encoding:"pcm_s16le", sample_rate:24000}`. Model and voice are constants at the top of `apps/server/scripts/spike-sonic.ts`.
- Run: `pnpm --filter @ahead/server spike:sonic`. Output goes to `var/spikes/sonic.wav` (gitignored).

### Measured (one run, 90-character interjection line)

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

### WebSocket (what Lane A should use)

- Endpoint: `wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14`.
- Request: `{model_id, transcript, voice, language:"en", context_id, output_format:{container:"raw", encoding:"pcm_s16le", sample_rate}, continue}`.
- Responses: `chunk {data: base64}`, `timestamps`, `flush_done`, `done`, `error`.
- Cancel: `{context_id, cancel:true}` only halts generation that has not started. For barge-in, also drop any incoming chunks for that `context_id` and flush browser playback.
- Use a new `context_id` per reply.
- These WebSocket details come from the docs and are untested live.

## Cartesia Ink 2 (STT)

Spike: `pnpm --filter @ahead/server spike:ink` streams `apps/server/scripts/fixtures/demo-utterance-1.wav` (made with macOS `say`, 16 kHz mono s16, 4.78 s) in real time.

- Endpoint: `wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14`.
- Auth: header `X-API-Key` worked on the first try. No need for `Authorization: Bearer`.
- Send raw PCM (no WAV header) as binary frames of 3200 bytes every 100 ms, then 2.5 s of zero frames, then text `{"type":"close"}`. The server flushes and closes with code 1000.
- Ink 2 has no word-level partials. `turn.update` carries the cumulative transcript, which maps to our `transcript_partial` event.

### Measured (one run, times relative to first audio byte)

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
- Several updates arrive within a few ms of each other (for example +3204, +3219, +3236), so debounce downstream.
- The last `turn.update`, `turn.eager_end` and the final update land at the same instant (+5380 ms). The final update adds a trailing period.
- `say` writes a WAV that `file` describes only as "RIFF data, WAVE audio", so the spike's parser walks chunks to find `fmt ` and `data`.
- Errors print as `[ink] error <title> <message>`. Headers and keys are never printed.

### Turn events

- `turn.start` is always the first event in a turn.
- `turn.update.transcript` is cumulative within the turn and never revised.
- `turn.eager_end` fires when the end-of-turn probability crosses `turn_eager_end_threshold` (default 0.6). It carries the transcript so far.
- It is always followed by exactly one of `turn.resume` (the user kept talking, the same turn continues, more `turn.update` follow) or `turn.end` (turn closed, final transcript).
- AHEAD uses `turn.eager_end` as the "finalize speculation" signal. It must treat `turn.resume` as "un-finalize, keep speculating", not as a new turn.
- In the spike run `turn.eager_end` appeared once and `turn.end` followed 345 ms later. `turn.resume` did not appear (the fixture has no mid-utterance pause), so its handling is untested live.

## Factory Droid SDK

**CANARY READ BYPASSED HANDLER.** Droid's `Read` and `LS` tools read files outside `var/workspace/` without ever calling the permission handler. The handler only scopes writes. Treat everything the server process can read as readable by the model.

- Package: `@factory/droid-sdk@0.10.0` (pinned with `-E`), imported from `@factory/droid-sdk/node`. No postinstall build script, so pnpm did not block anything.
- `createSession` spawns the local `droid` CLI (`~/.local/bin/droid`, v0.249.0) as `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` and passes `FACTORY_API_KEY` from `process.env`.
- Options used: `cwd: WORKSPACE_DIR`, `modelId: 'claude-haiku-5-5'` (accepted, no fallback needed), `autonomyLevel: AutonomyLevel.Off`, `disabledToolIds: ['Execute','Script','FetchUrl','WebSearch']`, `permissionHandler`, `abortSignal` (180 s watchdog).
- Script: `pnpm --filter @ahead/server spike:droid` (`apps/server/scripts/spike-droid.ts`).

### Quirks

- **At `AutonomyLevel.Off` the CLI removes Create/Edit/ApplyPatch.** `session.listTools()` shows them `allowed=false`, and the model reports "no tool can create or write files". At `low` they come back. To keep Off and still route writes through the handler, call `session.updateSettings({ enabledToolIds: ['Create','Edit','ApplyPatch'] })` right after `createSession`. `enabledToolIds` is not in the 0.10.0 TypeScript type for `updateSettings`, so it needs a cast, but the CLI accepts it (listTools then shows `Create=true Edit=true`, settings show them in `enabledToolIds`). Took 10 to 17 ms.
- **Returning `Cancel` ends the whole turn.** After the outside write was denied, the turn finished with `result success` and the remaining step never ran. The spike sends step 3 as a second `session.stream()` turn on the same session. AHEAD's executor should expect a denial to stop the plan.
- `permissionHandler` fired once per write with `confirmationType`/`details.type = 'create'` and an absolute `details.filePath`. The only options to return are values from `params.options`; we return `proceed_once` or `cancel`, and a `permission_resolved` event follows within 1 ms.
- Tools still allowed at Off with our disabled list: Read, LS, Grep, Glob, Task, Skill, ToolSearch, TodoWrite, ConnectApp, ListAutomations, ReadAutomation, ListAutomationTemplates, StageSettingsChanges. None of them asked for permission. `Task` (subagents) and `Skill` are worth disabling in the real executor.
- Droid masked the secret-shaped values in the canary before they reached the model. The Read result was 101 bytes (the file size), contained the key name `FAKE_KEY`, contained a mask run, and did not contain the 32-hex canary value. The model answered "The read succeeded. The file is 101 bytes." This masking is Droid's own behavior and should not be relied on: file names, non-secret text, and directory listings outside the workspace are fully visible (an `LS` of the repo root returned 1526 bytes).
- The model calls `ToolSearch` when it can't find a tool; it returned a 24-byte error each time.

### Permission handler behavior observed

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
git -C var/workspace status --short:
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
