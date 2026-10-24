## Lane B: Retrieval + belief tracker (`lane/belief`, apps/server)

Goal: given a stream of partials, produce a stream of `Belief` objects, with Moss on the hot path.

Deliverables
1. `scripts/gen-corpus.ts`: generate 300 to 500 synthetic docs for one fictional user (calendar events, contacts, notes, emails, file summaries) with metadata `{type, date, people[]}`. Must include the demo facts from PLAN.md section 5 verbatim.
2. `MossIndex`: build index from corpus, load in-process at server start, `query(text, {k, filters})` returning hits + measured ms. Hybrid mode.
3. `BeliefTracker` (pure logic, TDD this):
   - `onPartial(turnId, text)`: diff against last partial, query Moss with the new text window (last ~12 tokens) and the full partial, merge into a recency-weighted accumulator per turn.
   - every 400 ms, if the partial changed, call Claude Haiku with `{partial, topHits}` and a strict JSON schema → `Belief`. Never block the Moss loop on this.
   - contradiction detection: when Haiku returns `claims` whose `said` conflicts with the `known` value from a top hit, and confidence ≥ 0.8, emit `interject` once per turn.
   - emits `belief_update` and `moss_hits` after every step.
   - `onTurnEnd(turnId, finalText)`: one Haiku call to confirm or revise the belief, returns final `Belief`.
4. Thresholds in one config object: `SPECULATE_AT=0.75`, `INTERJECT_AT=0.8`, `LLM_INTERVAL_MS=400`, `PARTIAL_DEBOUNCE_MS=100`.
5. Replay harness: feed a fixture of timed partials from the demo script and print the belief timeline. This is also the DEMO_MODE backbone.

Done when: on the demo fixture, belief locks `draft_message` + `person=Priya` before the word "Thursday" arrives, and the contradiction fires at "Thursday".
