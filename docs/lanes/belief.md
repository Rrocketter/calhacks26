## Lane B: Retrieval + belief tracker (`lane/belief`, apps/server)

Goal: given a stream of partials, produce a stream of `Belief` objects, with Moss on the hot path.

Deliverables
1. `scripts/gen-corpus.ts`: generate 300 to 500 synthetic docs for one fictional user (calendar events, contacts, notes, emails, file summaries) with metadata `{type, date, people[]}`. Must include the demo facts from PLAN.md section 5 verbatim.
2. `MossIndex`: build index from corpus, load in-process at server start, `query(text, {k, filters})` returning hits + measured ms. Hybrid mode.
3. `BeliefTracker` (pure logic, TDD this):
   - `onUpdate(turnId, text)` (driven by Ink `turn.update`, ~250 ms): normalize text first (Ink writes "two" as "2" and adds punctuation), then 3-4 Moss queries: full text, last ~6 words, one per extracted entity. Merge into a recency-weighted accumulator per turn. ~60 queries per utterance at ~2 ms (3-4 queries per update, ~4 updates/s, for a ~4-5 s utterance; measured p50 2.0 ms / p95 2.4 ms).
   - on every Nth update, if the text changed, call Claude Haiku with `{partial, topHits}` and a strict JSON schema → `Belief`. Never block the Moss loop on this.
   - contradiction detection: when Haiku returns `claims` whose `said` conflicts with the `known` value from a top hit, and confidence ≥ 0.8, emit `interject` once per turn.
   - emits `belief_update` and `moss_hits` after every step.
   - `onEagerEnd(turnId, text)` finalizes slots (trigger for Phase 2); `onResume(turnId)` un-finalizes; `onTurnEnd(turnId, finalText)`: one Haiku call to confirm or revise the belief, returns final `Belief`.
4. Thresholds in one config object: `SPECULATE_AT=0.75`, `INTERJECT_AT=0.8`, `LLM_EVERY_N_UPDATES`.
5. Replay harness: feed a fixture of timed partials from the demo script and print the belief timeline. This is also the DEMO_MODE backbone.

Done when: on the demo fixture, belief locks `draft_message` + `person=Priya` before the word "Thursday" arrives, and the contradiction fires at "Thursday".
