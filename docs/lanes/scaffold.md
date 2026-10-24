## Lane 0: Scaffold + contracts (run FIRST, alone, Fri 8 to 10 PM, main branch)

Goal: a monorepo where three lanes can build in parallel without touching each other.

Deliverables
1. pnpm workspace with `apps/server`, `apps/web`, `packages/contracts`. TypeScript strict. Build + lint scripts. `.env.example`. `pnpm check:secrets`.
2. `packages/contracts/src/events.ts`: the full WebSocket event schema, client→server and server→client, using zod. Events at minimum:
   - c2s: `audio_chunk`, `demo_control`, `confirm_action {turnId, apply:boolean}`
   - s2c: `transcript_partial {turnId,text,ts}`, `transcript_final`, `turn_start`, `turn_end`, `belief_update {turnId, belief:Belief}`, `moss_hits {turnId, hits, latencyMs}`, `state_change {turnId, state}`, `droid_event {turnId, kind:'plan'|'step'|'tool'|'diff'|'result', payload}`, `interject {turnId, text}`, `tts_audio_chunk`, `error`
3. `packages/contracts/src/belief.ts`: the `Belief` type from PLAN.md, the `Intent` enum, the `State` enum.
4. `packages/contracts/mocks/`: a mock Ink partial stream (reads a JSON fixture of timed partials), a mock Moss (returns canned hits), a mock Droid (emits a fake plan + 3 steps + a diff over 2 s). Each lane uses the others' mocks.
5. `workspace-seed/` with `calendar.json`, `contacts.json`, `notes/`, `messages/outbox/`, `files/` containing the demo facts from PLAN.md section 5. Plus `pnpm reset:workspace`, which deletes `var/workspace/`, copies the seed in, runs `git init`, and makes an initial commit on `main` inside it. `var/` is gitignored. Do NOT `git init` anywhere else.
6. Spikes, each as a tiny script in `apps/server/scripts/spike-*.ts` that proves the key works and prints latency: `spike-ink.ts` (stream a wav, print partials with timestamps), `spike-sonic.ts` (synthesize one line, save wav), `spike-moss.ts` (index 10 docs, query, print ms), `spike-droid.ts` (one-shot run that writes a file under var/workspace/ with a permission handler that denies everything outside it). Write findings to `docs/sdk-notes.md`.

Do not build features. Stop when all four spikes pass.
