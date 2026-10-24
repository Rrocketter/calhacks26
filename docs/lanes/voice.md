## Lane A: Voice pipeline (`lane/voice`, apps/server + apps/web audio bits)

Goal: mic in, Ink 2 partials out at ≤ 150 ms cadence, turn detection events, Sonic playback with barge-in.

Deliverables
1. Browser: AudioWorklet capturing 16 kHz PCM, chunked over WS as `audio_chunk`. Playback via AudioContext queue with a `stopNow()` that ramps gain to 0 in 30 ms (used for barge-in).
2. Server: `InkClient` wrapping Cartesia Ink 2 streaming STT. Emits `transcript_partial` on every partial, `transcript_final` + `turn_end` on Ink's native turn detection. Log cadence.
3. Server: `SonicClient` streaming TTS to `tts_audio_chunk`. Function `speak(text, {interrupt:boolean})`. When `interrupt`, pause forwarding audio to Ink for 1.5 s so the agent does not transcribe itself.
4. A `turnId` lifecycle: new id on first partial after a `turn_end`.
5. Test against the mock belief tracker: when mock emits `interject`, Sonic speaks over the user and STT resumes cleanly.

Done when: a human can talk, see partials appear word by word in a bare page, and hear a canned Sonic reply at turn end. Measure and record partial cadence and time-to-first-audio in `docs/sdk-notes.md`.
