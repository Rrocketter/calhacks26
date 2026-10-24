## Lane A: Voice pipeline (`lane/voice`, apps/server + apps/web audio bits)

Goal: mic in, Ink 2 `turn.update` out at ~250 ms cadence (measured), turn events, Sonic playback with barge-in.

Deliverables
1. Browser: AudioWorklet capturing 16 kHz PCM, chunked over WS as `audio_chunk`. Playback via AudioContext queue with a `stopNow()` that ramps gain to 0 in 30 ms (used for barge-in).
2. Server: `InkClient` wrapping Cartesia Ink 2 streaming STT. Emits `transcript_partial` on every `turn.update`, and surfaces `turn.eager_end` (finalize trigger), `turn.resume` (un-finalize), `turn.end` (closes the turn; emits `transcript_final` + `turn_end`). Also emit `turn_eager_end` / `turn_resume`. Log cadence.
3. Server: `SonicClient` streaming TTS (WebSocket, `sonic-3.6`) to `tts_audio_chunk`. Function `speak(text, {interrupt:boolean})`. When `interrupt`, pause forwarding audio to Ink for 1.5 s so the agent does not transcribe itself.
4. A `turnId` lifecycle: new id on Ink `turn.start` (always the first event of a turn). `turn.resume` keeps the same id.
5. Test against `mockBeliefStream` from `@ahead/contracts/mocks`: when it emits `interject`, Sonic speaks over the user and STT resumes cleanly. `mockInkStream` replays an Ink fixture (`loadFixture('demo-utterance-1')` from `@ahead/contracts/mocks/node`, or import `@ahead/contracts/mocks/fixtures/demo-utterance-1.json` in the browser). `MockMoss` and `mockDroidRun` stand in for Lanes B and C.

Done when: a human can talk, see partials appear word by word in a bare page, and hear a canned Sonic reply at turn end. Measure and record partial cadence and time-to-first-audio in `docs/sdk-notes.md`.
