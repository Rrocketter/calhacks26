# AHEAD (working name)
### A voice agent that starts working before you finish your sentence, and interrupts you when you're about to be wrong.

Cal Hacks 13.0, Oct 23 to 25 2026. Solo build. Submission deadline Sunday 9:00 AM. Judging 10:30 to 12:30 Sunday, must be at table the whole window.

---

## 1. The one-line pitch

Every voice assistant waits for you to stop talking, then thinks. AHEAD retrieves on every Ink transcript update (sub-10 ms via Moss), builds a live belief about what you want while you're still speaking, speculatively stages the action with a Factory Droid, and answers the instant you stop. If what you're saying contradicts what it knows, it cuts in mid-sentence.

## 2. Why this can win

- The core trick (retrieval on every Ink update, ~60 queries per utterance at ~2 ms (3-4 queries per update, ~4 updates/s, for a ~4-5 s utterance), measured p50 2.0 ms / p95 2.4 ms) is only possible because Moss runs in-process at sub-10 ms. A cloud vector DB at 200 to 500 ms cannot do this. That is the "impossible made possible" hook sponsors asked for.
- Voice is the entire interface, not a feature. Cartesia's turn detection literally decides when speculation becomes commitment.
- Droid does real work on a trigger (belief confidence threshold), with scoped permissions, visible plan/steps/diffs, and rollback. That is Factory's rubric nearly verbatim.
- Speculative execution with cancellation and rollback is a real systems problem. Solo plus technically complex is a credible pairing.
- Last year's grand prize (FaceTimeOS) was a real-time voice loop with a "that shouldn't work" moment. This is the same shape with a sharper twist.

## 3. Tracks and what each judge must see

| Track | Must-haves | How AHEAD satisfies it |
|---|---|---|
| Best Solo Hack | Team of 1 on Devpost, live demo, full judging window | Yes by construction |
| Moss | Moss used meaningfully; voice agent / personal agent that remembers you | Moss is queried on every Ink transcript update. Latency HUD shows per-query ms. Project collapses without it. |
| Moss Social Post | Post with engagement | Post a 20 to 30 s clip of the interjection moment with the latency HUD visible, tag @usemoss |
| Cartesia | Voice core to product, 2-min demo-first pitch, README with setup + features used + limitations, no keys in repo, accessibility/privacy/responsible-use addressed | Ink 2 streaming STT + turn detection, Sonic 3.6 WebSocket streaming TTS with barge-in. README sections written. Privacy: corpus is local, nothing leaves except STT/TTS audio. |
| Factory Droid SDK | Droid does real work in the running product, runs on a designed trigger, scoped permissions with safety, visible plans/steps/diffs/results, README explains where Droid is used, no chatbot wrapper, no slides-only demo | Droid dispatched when belief confidence crosses threshold. Permission handler allows writes only under `~/.ahead/workspace/`, denies Execute and network. All Droid tool events stream to the UI. Staged work lives on a git branch and is committed or discarded. |
| Most Technically Complex (stretch) | Judges see real engineering | Speculation + cancellation + rollback + sub-100 ms loop |

## 4. How it works (system design)

```
Mic ──► Cartesia Ink 2 (streaming STT, turn events)
            │ turn.update ~250 ms (cumulative transcript, numbers normalized)
            ▼
      Belief Tracker (server, TS)
            │  ├─ Moss hybrid query, 3-4 per update (full text, last ~6 words, one per entity), ~2 ms each, in-process
            │  ├─ recency-weighted hit accumulator
            │  └─ Haiku structured call on every Nth update, never blocking Moss → {intent, entities, claims, confidence}
            │
            ├─ contradiction? (claim vs retrieved fact, conf ≥ 0.8) ──► INTERJECT via Sonic (barge-in)
            │
            └─ belief lock: confidence ≥ 0.75 and intent ∈ ACTIONS ──► PHASE 1
                                                              │
                                                              ▼
                                                    Droid session (Factory SDK), pre-created warm at LISTENING
                                                    cwd = ~/.ahead/workspace/ on branch spec/<id>
                                                    Phase 1 prompt: open target file, find the record,
                                                    plan the edit, wait for details
                                                    permission handler: fs under ~/.ahead/workspace/ only
                                                    events → UI (plan, steps, diffs)
                                                              │
   Ink turn.eager_end ──► PHASE 2: final slot values sent as a second turn in the same session
   Ink turn.resume    ──► un-finalize (back to listening, Phase 2 result discarded)
   Ink turn.end       ──► Close turn: confirm belief against final transcript (1 Haiku call)
                      ├─ match   → Sonic speaks result instantly, asks "apply?"
                      │             user "yes" → merge branch (COMMIT)
                      └─ diverge → abort Droid, delete branch (ROLLBACK), run fresh
```

### Components
- `apps/web` Vite + React. Mic capture, audio playback, HUD. Talks to server over one WebSocket.
- `apps/server` Node + TS. Holds Moss runtime, belief tracker, Droid executor, Cartesia proxies. Single process. Sonic goes over the WebSocket API with `sonic-3.6`; `/tts/bytes` is spike only. Ink rewrites numbers ("two" becomes "2") and adds punctuation, so contradiction and entity matching normalize text first.
- `packages/contracts` Shared TS types and the WebSocket event schema. Written FIRST. Every lane codes against it with mocks.
- `workspace-seed/` Tracked seed files that stand in for "your life": `calendar.json`, `contacts.json`, `notes/*.md`, `messages/outbox/*.md`, `files/*`.
- `~/.ahead/workspace/` (override `AHEAD_WORKSPACE`) Runtime copy of the seed, outside the repo, with its own `git init`, created by `pnpm reset:workspace`. Droid edits these. Diffs are real and visible. Never nest a git repo inside the main repo.
- `data/corpus/` Generated synthetic personal corpus (300 to 500 docs) indexed into Moss with metadata (type, date, people).

### Action set (exactly five, do not add more)
1. `reschedule_event` (edit calendar.json)
2. `draft_message` (write messages/outbox/<name>.md)
3. `find_file` (locate + surface a file from files/)
4. `add_note` (append to notes/)
5. `lookup` (read-only answer from corpus, no Droid)

### Belief tracker contract
```ts
type Belief = {
  intent: "reschedule_event"|"draft_message"|"find_file"|"add_note"|"lookup"|"unknown";
  entities: Record<string,string>;      // person, date, time, file, topic
  claims: {field:string; said:string; known:string; docId:string}[]; // for contradictions
  confidence: number;                    // 0..1
  topHits: {docId:string; score:number; snippet:string}[];
  latencyMs: {moss:number; llm?:number};
}
```

### Speculation rules
- One Droid session per turn, at most two prompts (Phase 1 plan, Phase 2 slots). If intent changes after dispatch, abort and discard.
- Droid may only touch `~/.ahead/workspace/`. Execute tool disabled. No network.
- Read/LS bypass the permission handler, so the workspace sits outside the repo, tools are disabled, and a watchdog aborts stray runs (see `docs/sdk-notes.md`, Droid section).
- Two-phase speculation. Phase 1 at belief lock: warm session gets "open the target file, find the record, plan the edit, wait for details". Phase 2 at `turn.eager_end`: final slot values go in as a second turn of the same session. `turn.resume` un-finalizes, `turn.end` closes the turn. The server forwards `turn_eager_end` and `turn_resume` to the UI as s2c events.
- On turn.resume, interrupt any running Phase 2 prompt and reset the spec branch to its post-Phase-1 commit; the next turn.eager_end sends Phase 2 again.
- Pre-create a warm Droid session at LISTENING (not tied to a turnId); the spec/<turnId> branch is created at belief lock, after turn.start assigns the turnId.
- Every speculation runs on branch `spec/<turnId>`. COMMIT = fast-forward merge to main. ROLLBACK = branch delete.
- Visible state machine in UI: LISTENING → BELIEF_FORMING → SPECULATING → STAGED → (COMMITTED | ROLLED_BACK)

### Interjection rules
- Trigger only when a claim's `said` conflicts with `known` and confidence ≥ 0.8 and the doc is a strong hit.
- Pause STT consumption for 1.5 s, play Sonic line, resume. Keep the user's partial so the sentence continues.
- Max one interjection per turn.

## 5. Demo script (Cartesia wants demo-first, one complete flow)

Corpus facts to seed: meeting with Priya is Friday 2 PM. Project file "q3-deck.pdf" in files/. Contact Priya.

**Utterance 1 (the interjection, lead with this):**
"Draft a message to Priya saying I'll see her Thursday at two for the..."
→ at "Thursday" the agent cuts in: "Quick note, your meeting with Priya is Friday at two, not Thursday. Want me to say Friday?" User: "yes." Draft is already staged (Droid started at "Draft a message to Priya"). Commit. ~12 seconds.

**Utterance 2 (zero-latency answer):**
"Move my Friday meeting with Priya to Monday morning."
→ HUD shows belief lock at "Friday meeting with Priya", Droid stages the calendar edit before "Monday" is spoken, Sonic responds the instant the turn ends with the diff summary. Apply.

**Utterance 3 (rollback, shows honesty):**
"Find the... actually never mind, what time is my Priya meeting now?"
→ Speculation on find_file starts, intent diverges, UI shows ROLLED_BACK, answers the lookup. Judges see the system is honest about mispredictions.

**Hardcoded fallback:** a `DEMO_MODE=1` flag that replays recorded Ink partials from a fixture file so the full loop runs even if the mic or network dies. Build this Saturday night, not Sunday morning.

## 6. Definition of done (ordered, stop at a working state at each tier)

**Tier 1, must ship (Sat 6 PM):** mic → Ink partials → Moss query per partial → belief JSON → Sonic answer at turn end. HUD shows transcript, belief, Moss latency. Lookup action only.
**Tier 2 (Sat 11 PM):** Droid speculation for reschedule_event and draft_message with branch commit/rollback and event stream to UI. State machine visible.
**Tier 3 (Sun 2 AM):** contradiction interjection with barge-in. DEMO_MODE fixture. Demo video recorded.
**Tier 4 (Sun 6 AM):** README (Cartesia + Factory sections), Devpost final, social post, remaining two actions if time.

## 7. Timeline

| When | What |
|---|---|
| Fri 8 PM to 10 PM | Scaffold, contracts, API key spikes for all four services (biggest risk, do first) |
| Fri 10 PM to Sat 3 AM | Lanes A/B/C build against mocks in parallel |
| Sat 9 AM to 6 PM | Lanes continue, UI lane starts, integrate Tier 1 by 6 PM |
| Sat 6 PM to 11 PM | Tier 2 integration, Devpost draft submitted by 10 PM |
| Sat 11 PM to Sun 2 AM | Tier 3, record demo video, DEMO_MODE |
| Sun 2 AM to 6 AM | README, polish, sleep 2 to 3 h |
| Sun 6 AM to 9 AM | Final Devpost, social post, rehearse 2-min pitch 5 times |

## 8. Risks and mitigations
- Ink update rate bursty or slow → query on every turn.update, diff only; no debounce needed at Ink's ~250 ms cadence.
- Haiku belief call too slow → run on every Nth `turn.update`, never block Moss loop; Moss hits alone can drive speculation for simple intents.
- Droid startup latency (spawns CLI) → keep one warm session per turn, pre-create at LISTENING.
- Barge-in audio clipping → use AudioContext with gain ramp, stop STT ingest during TTS.
- Any sponsor API down at judging → DEMO_MODE fixture replay.

## 9. Accounts and keys needed tonight
Cartesia API key, Moss portal project id + key, Factory API key + `droid` CLI installed on PATH, Anthropic API key. Check the Cal Hacks live site Hacker Starter Pack for sponsor credits before paying for anything.
