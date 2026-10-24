# Lane B: Retrieval + Belief Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a stream of Ink partials into a stream of `Belief` objects with Moss on the hot path, and prove it on the demo fixture with a replay harness.

**Architecture:** A deterministic corpus generator writes `data/corpus/corpus.json`; a build script uploads it to the Moss index `ahead-corpus`; `MossIndex` loads it in-process at startup. `BeliefTracker` is pure logic with injected `Retriever`, `IntentLlm` and `emit`: every `turn.update` normalizes text, runs 3-4 Moss queries, accumulates recency-weighted hits, and fires a non-blocking Haiku intent call. Confidence fuses Haiku's intent confidence with rank-based Moss entity support; raw Moss scores are never thresholded. The replay harness drives the tracker from the Ink fixture with real Moss and real Haiku and prints a timeline.

**Tech Stack:** Node 20, TypeScript 6.0.3, `@moss-js/moss@1.21.0`, `@anthropic-ai/sdk` (NEW, needs human approval, see Global Constraints), `node:test` via `tsx` (the server's existing runner), zod schemas from `@ahead/contracts`.

**Spec:** `docs/lanes/belief.md`, `PLAN.md` section 4 (Belief tracker contract, Interjection rules) and section 5 (demo script), `docs/sdk-notes.md` (Moss, Ink 2, Summary for lanes).

## Global Constraints

- Do not edit `packages/contracts`. If the schema needs a change, stop and tell the human.
- Moss index name: only `MOSS_INDEX.corpus` (`'ahead-corpus'`) from `@ahead/contracts`. No other index.
- Never call `loadIndex` on the request path; load once at startup.
- Moss `score` is vector-only and not comparable across queries; use rank and metadata, never a raw score threshold.
- Confidence = Haiku intent confidence fused with Moss hit support. Moss alone never locks a belief.
- Normalize numbers and punctuation before any matching (`"two"` -> `"2"`, strip commas/periods, lowercase).
- Thresholds in one exported config object: `SPECULATE_AT = 0.75`, `INTERJECT_AT = 0.8`, `LLM_EVERY_N_UPDATES = 2`.
- Every emitted event must pass `parseServerEvent(JSON.stringify(ev))`. Confidence clamped to [0, 1].
- Log every external call with latency via `logLatency` (`[moss] query 2.0ms`, `[llm] intent 380.0ms`).
- Max one `interject` per turn. Interject text comes from one constant `INTERJECT_TEMPLATE = "Heads up, {person}'s meeting is {known}, not {said}. Say {known}?"` in `config.ts` (under 3 s spoken; human-approved wording). Demo renders `Heads up, Priya's meeting is Friday, not Thursday. Say Friday?`.
- Entities carry normalized date fields so Lane C never parses prose: `weekday` (lowercase, e.g. `friday`) and `date_iso` (`YYYY-MM-DD`), resolved from the spoken day as the next occurrence on or after the injected `today` (default: real local date; no fixed demo date in the live path). `time` stays as spoken-normalized (`2`, `2 pm`).
- Haiku model id: `claude-haiku-5-5`, `thinking: {type: 'disabled'}`, `output_config: {effort: 'low', format: {type: 'json_schema', schema}}`, `max_tokens: 512`. No forced `tool_choice`.
- **New dependency `@anthropic-ai/sdk` (exact pin, `-E`) in `apps/server` requires human approval before Task 4.**
- Secrets only from `.env` via `requireEnv`; never print keys.
- No fixtures in the live path. The replay harness is the DEMO_MODE backbone and is the only place the Ink fixture is used.
- Commit after each task; never push.
- Checks before claiming a task done: `pnpm -r build && pnpm -r lint && pnpm --filter @ahead/server test`.

## Review Focus

1. Haiku slower than ~1 s or erroring: the Moss loop must keep emitting `belief_update` per partial, belief stays unlocked, no crash. (Task 4 test `llm failure keeps moss loop running`.)
2. Out-of-order Haiku results (call for partial 5 returns after call for partial 7): a stale result must not overwrite a newer one. (Task 4 test `stale llm result is dropped`.)
3. Duplicate identical partials (Ink bursts): no extra Moss queries or Haiku calls. (Task 4 test `unchanged text is skipped`.)
4. Claim where `said` equals `known` after normalization ("Friday" vs "friday,"): no interject. (Task 5 test `same day after normalization is not a contradiction`.)
5. `onResume` after `onEagerEnd`, and events for an unknown/ended turn: un-finalize without losing the belief; ignore unknown turns. (Task 5 tests `resume un-finalizes`, `unknown turn is ignored`.)

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/scripts/gen-corpus.ts` | Deterministic (seeded) generator, writes `data/corpus/corpus.json` |
| `apps/server/scripts/gen-corpus.test.ts` | Corpus shape + demo facts |
| `apps/server/scripts/build-index.ts` | Delete-if-exists + `createIndex('ahead-corpus')`, then load + sample queries with latency |
| `apps/server/src/moss/index.ts` | `MossIndex` (implements `Retriever`) |
| `apps/server/src/belief/normalize.ts` | `normalize()`, number words, weekday canon |
| `apps/server/src/belief/entities.ts` | Rule-based fast entity extraction (person, day, time, file) from known contacts |
| `apps/server/src/belief/config.ts` | `BELIEF_CONFIG` thresholds |
| `apps/server/src/belief/types.ts` | `Retriever`, `IntentLlm`, `IntentResult`, `CorpusDoc` |
| `apps/server/src/belief/tracker.ts` | `BeliefTracker` |
| `apps/server/src/belief/haiku.ts` | `HaikuIntentLlm` (implements `IntentLlm`) |
| `apps/server/src/belief/*.test.ts` | Unit tests (fakes only, no network) |
| `apps/server/scripts/replay.ts` | Replay harness (real Moss + Haiku, fixture partials) |

Add each new `*.test.ts` to the explicit list in `apps/server/package.json` `test` script. Add scripts `gen:corpus`, `build:index`, `replay` (same `node --env-file=../../.env --import tsx` pattern as the spikes; Moss scripts set `MOSS_DISABLE_TELEMETRY=1`).

---

### Task 1: Corpus generator

**Files:**
- Create: `apps/server/scripts/gen-corpus.ts`, `apps/server/scripts/gen-corpus.test.ts`
- Modify: `apps/server/package.json` (script `gen:corpus`, test list)

**Interfaces:**
- Produces: `type CorpusDoc = { id: string; text: string; metadata: { type: 'calendar'|'contact'|'note'|'email'|'file'; date: string; people: string; day?: string; time?: string; title?: string } }` (all metadata values strings; `people` is `', '`-joined full names; `day` lowercase weekday, `time` normalized like `"2 pm"` for calendar docs). Export it from `apps/server/src/belief/types.ts` (create that file here). Export `generateCorpus(seed?: number): CorpusDoc[]` from `gen-corpus.ts`; `main` writes `data/corpus/corpus.json` (already gitignored) only when run directly.

Content rules: every record in `workspace-seed/` becomes a doc with the same id (`evt-priya-q3`, `contact-priya`, ..., `file-q3-deck`, `file-budget-2026`, `note-2026-10-20-q3-planning`), read from the seed files at generation time. Demo facts verbatim: `evt-priya-q3` text contains `Q3 deck review with Priya Shah`, `Friday`, `2 PM`, `Conference Room B`; `contact-priya` contains `Priya Shah` and `priya.shah@example.com`; `file-q3-deck` contains `files/q3-deck.pdf`. Filler: ~40 extra contacts, past/future calendar events, notes, emails, file summaries from a seeded PRNG (mulberry32), total 300 to 500. Filler must not contain another person named Priya and must not schedule any other event with Priya Shah on a Thursday (keeps the demo contradiction unambiguous).

- [ ] **Step 1: Write failing tests** `gen-corpus.test.ts`:
  - `corpus size is 300..500 and ids are unique`
  - `all metadata values are strings`
  - `demo facts present verbatim` (asserts the substrings above on `evt-priya-q3`, `contact-priya`, `file-q3-deck`; `evt-priya-q3.metadata.day === 'friday'`, `.time === '2 pm'`, `.people` includes `'Priya Shah'`)
  - `every workspace-seed record has a doc` (ids from calendar.json, contacts.json, files/, notes/)
  - `deterministic`: `generateCorpus(1)` deep-equals `generateCorpus(1)`
  - `only one Priya, and no Thursday Priya event`
- [ ] **Step 2:** `pnpm --filter @ahead/server test` -> FAIL (module missing).
- [ ] **Step 3:** Implement `generateCorpus` and `main`.
- [ ] **Step 4:** Test passes; `pnpm --filter @ahead/server gen:corpus` prints `[corpus] wrote N docs` with 300 <= N <= 500.
- [ ] **Step 5:** Build + lint, commit `feat(belief): synthetic corpus generator`.

### Task 2: Moss index build + `MossIndex`

**Files:**
- Create: `apps/server/scripts/build-index.ts`, `apps/server/src/moss/index.ts`
- Modify: `apps/server/src/belief/types.ts`, `apps/server/package.json` (script `build:index`)

**Interfaces:**
- Produces in `types.ts`: `type RetrievedHit = MossHit & { metadata: Record<string,string> }`; `interface Retriever { query(text: string, opts?: { k?: number; filter?: object }): Promise<{ hits: RetrievedHit[]; latencyMs: number }> }`.
- Produces in `moss/index.ts`: `class MossIndex implements Retriever { static async load(client?: MossClient): Promise<MossIndex>; query(...); close(): Promise<void> }`. `load` constructs `MossClient(requireEnv('MOSS_PROJECT_ID'), requireEnv('MOSS_PROJECT_KEY'))` if none passed, calls `loadIndex(MOSS_INDEX.corpus)` once and logs it. `query` uses hybrid (`alpha: 0.5`), default `k = 5`, measures wall-clock with `performance.now()`, logs `[moss] query X.Xms`, maps `docs` to `{docId, score, snippet: text.slice(0, 160), metadata: metadata ?? {}}`. Blank text returns `{hits: [], latencyMs: 0}` without calling Moss.

No unit test (thin SDK wrapper; verified live per CLAUDE.md "skip TDD for plumbing").

- [ ] **Step 1:** Implement `build-index.ts`: read `data/corpus/corpus.json` (fail with a clear message telling the user to run `gen:corpus` if missing), `listIndexes` -> `deleteIndex` if `ahead-corpus` exists, `createIndex(MOSS_INDEX.corpus, docs, {modelId: 'moss-minilm'})`, then `MossIndex.load`, warmup, and 20 timed queries over: `draft a message to priya`, `priya thursday`, `q3 deck`, `what time is my priya meeting`. Print top-3 ids per query and p50/p95. `close()` in `finally`.
- [ ] **Step 2:** Implement `MossIndex`.
- [ ] **Step 3:** Run `pnpm --filter @ahead/server build:index`. Expected: `evt-priya-q3` in top 3 for `priya thursday` and `what time is my priya meeting`; `contact-priya` in top 3 for `draft a message to priya`; p50 under 10 ms. If the ranking differs, try `alpha` 0.3/0.7 and record what you found (numbers) in `docs/sdk-notes.md` under Moss as "ahead-corpus (Lane B)".
- [ ] **Step 4:** Build + lint, commit `feat(belief): ahead-corpus index and MossIndex`.

### Task 3: Normalize + entity extraction (TDD)

**Files:**
- Create: `apps/server/src/belief/normalize.ts`, `entities.ts`, `normalize.test.ts`, `entities.test.ts`

**Interfaces:**
- `normalize(text: string): string`: lowercase; number words `zero..twelve` -> digits; strip `, . ! ? ; :` and quotes except intra-word apostrophes; collapse whitespace; trim.
- `lastWords(text: string, n: number): string` on normalized text.
- `type FastEntities = { person?: string; day?: string; time?: string; file?: string }` (person is the full contact name, day lowercase weekday or `today|tomorrow`, time like `"2"` or `"2 pm"`, file like `"q3 deck"`).
- `resolveDay(day: string, today: Date): { weekday: string; date_iso: string }`: `today`/`tomorrow` relative, weekday = next occurrence on or after `today` (same weekday = today), local date, `YYYY-MM-DD`.
- `makeEntityExtractor(contacts: { name: string }[]): (normalizedText: string) => FastEntities`. Person matches first name or full name as a whole word. Day matches weekday names and `today|tomorrow`. Time matches `at <n>( pm| am)?` or `<n> (pm|am)`. File matches `q\d deck|budget`.

- [ ] **Step 1: Failing tests:**
  - `normalize("Draft a message to Priya saying, I'll see her Thursday at two.") === "draft a message to priya saying i'll see her thursday at 2"`
  - `normalize("Friday,") === normalize("friday")`
  - `lastWords("a b c d e f g h", 6) === "c d e f g h"`
  - extractor with contacts `[{name:'Priya Shah'},{name:'Marcus Lee'}]` on normalized demo partials: `"draft a message to priya"` -> `{person:'Priya Shah'}`; `"... see her thursday"` -> `{person:'Priya Shah', day:'thursday'}`; `"... thursday at 2"` adds `time:'2'`; `"draft a"` -> `{}`; `"... for the q3 deck"` adds `file:'q3 deck'`; `"priyanka"` -> no person.
  - `resolveDay('thursday', new Date(2026, 9, 24))` -> `{weekday:'thursday', date_iso:'2026-10-29'}`; `'friday'` -> `2026-10-30`; `'saturday'` -> `2026-10-24`; `'tomorrow'` -> `{weekday:'sunday', date_iso:'2026-10-25'}`; `'monday'` -> `2026-10-26`.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(belief): text normalization and fast entities`.

### Task 4: BeliefTracker core loop (TDD)

**Files:**
- Create: `apps/server/src/belief/config.ts`, `tracker.ts`, `tracker.test.ts`, `haiku.ts`
- Modify: `apps/server/src/belief/types.ts`, `apps/server/package.json` (add `@anthropic-ai/sdk` exact pin, approved by human)

**Interfaces:**
- `config.ts`: `export const INTERJECT_TEMPLATE` (see Global Constraints) and `export const BELIEF_CONFIG = { SPECULATE_AT: 0.75, INTERJECT_AT: 0.8, LLM_EVERY_N_UPDATES: 2, RECENCY_DECAY: 0.6, TOP_HITS: 5, W_LLM: 0.6, W_MOSS: 0.4 } as const; export type BeliefConfig = typeof BELIEF_CONFIG` (constructor accepts `Partial<BeliefConfig>`).
- `types.ts`: `type IntentResult = { intent: Intent; entities: Record<string,string>; claims: Claim[]; confidence: number }`; `interface IntentLlm { classify(input: { partial: string; topHits: MossHit[]; final?: boolean }): Promise<{ result: IntentResult; latencyMs: number }> }`.
- `tracker.ts`: `class BeliefTracker { constructor(deps: { retriever: Retriever; llm: IntentLlm; contacts: { name: string }[]; emit: (ev: ServerEvent) => void; config?: Partial<BeliefConfig>; today?: () => Date }); onUpdate(turnId: string, text: string): Promise<void>; onEagerEnd(turnId: string, text: string): Promise<void>; onResume(turnId: string): void; onTurnEnd(turnId: string, finalText: string): Promise<Belief>; current(turnId: string): Belief | undefined; isLocked(turnId: string): boolean; isFinalized(turnId: string): boolean; idle(): Promise<void> }` (`idle()` resolves when no LLM call is in flight; tests and the harness use it).
- `haiku.ts`: `class HaikuIntentLlm implements IntentLlm` (constructor takes optional `Anthropic` client). System prompt lists the five actions and asks for `{intent, entities, claims, confidence}`; user content is the partial plus numbered top hits (`docId: snippet`). JSON schema with `additionalProperties: false`, all fields required, `intent` enum = `[...ACTIONS, 'unknown']`, `entities` as array of `{key, value}` (converted to a record after parse), claims items `{field, said, known, docId}`. Parse, clamp confidence, validate intent; on any error throw (the tracker handles it). Log `[llm] intent X.Xms`.

**`onUpdate` algorithm (decisions the tests pin):**
1. Unknown turn: create state. Normalize; if equal to last normalized text for the turn, return (no queries, no emit).
2. Queries (issued with `Promise.all`): full normalized text; `lastWords(text, 6)` if it differs from full; one per fast entity (`person` -> person name, `day` -> `"<person> <day>"` if person else day, `file` -> file). Dedupe query strings. Emit one `moss_hits` per query and one `metric` `{source:'moss', label:'query', ms}` per query.
3. Accumulator: per docId, `acc = acc * RECENCY_DECAY + rankWeight` where `rankWeight = 1/(rank+1)` summed over this update's queries (decay applied once per update to all docs). `topHits` = top `TOP_HITS` by acc, carrying the latest snippet/score.
4. `mossSupport` in [0,1]: fraction of fast entities among {person, file} that resolve, where person resolves if a doc in `topHits` has `metadata.people` containing the person's full name, file resolves if a `type:'file'` doc in topHits has title/text containing the file words. 0 when there are no such entities.
5. LLM: on every `LLM_EVERY_N_UPDATES`-th changed update, or when a new fast entity appeared since the last call, start `llm.classify` without awaiting it, unless a call is in flight, in which case remember the latest text and fire one call on completion. Each call carries a sequence number; a result whose seq is lower than the last applied seq is dropped.
6. Belief: `intent`/`entities`/`claims` from the latest applied LLM result (fast entities merged in, LLM wins on conflict, `person` normalized to the contact full name if it matches; when a day is known, add `weekday` and `date_iso` via `resolveDay(day, today())`, fast-path day wins for these two keys); `confidence = clamp(W_LLM * llmConf + W_MOSS * mossSupport)` when intent is not `unknown`, else `min(0.5, W_MOSS * mossSupport)`. `latencyMs.moss` = max of this update's query times, `llm` = latest LLM latency. Emit `belief_update` after the Moss step and again after each applied LLM result.
7. Lock: `isLocked` is true once `intent !== 'unknown'` and `confidence >= SPECULATE_AT`; on the first lock log `[belief] lock <intent> <person> conf=X`. (Speculation dispatch belongs to Lane C; the tracker only exposes the flag.)
8. LLM error: log `[llm] error ...`, emit `{type:'error', source:'llm', message}`, keep the previous belief.

Fakes in tests: `FakeRetriever` with a table `query -> hits` (default empty), `FakeLlm` returning scripted results with controllable resolve order (deferred promises).

- [ ] **Step 1: Failing tests** in `tracker.test.ts`:
  - `emits moss_hits per query and a belief_update per changed partial` (3 queries for `"draft a message to priya"`: full, person, plus lastWords only if different; assert dedupe)
  - `every emitted event parses with parseServerEvent`
  - `unchanged text is skipped` (same text twice, second call emits nothing, retriever called once per query)
  - `moss alone never locks` (llm never resolves, strong person hit -> confidence <= 0.5, `isLocked` false)
  - `entities include weekday and date_iso` (today = 2026-10-24, partial with `thursday` -> `weekday:'thursday'`, `date_iso:'2026-10-29'`)
  - `locks draft_message + Priya when llm agrees and moss supports person` (llm returns `{intent:'draft_message', entities:{person:'Priya'}, confidence:0.9}`, retriever returns `contact-priya` with `metadata.people:'Priya Shah'` at rank 0 -> after `idle()`, confidence = 0.6*0.9+0.4*1 = 0.94, entities.person === 'Priya Shah', locked)
  - `llm called every Nth update and on new entity, never concurrently`
  - `stale llm result is dropped`
  - `llm failure keeps moss loop running` (llm rejects -> `error` event, later updates still emit `belief_update`)
  - `confidence is clamped to [0,1]` (llm returns 1.7)
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement config, types, tracker. **Step 4:** PASS.
- [ ] **Step 5:** Implement `HaikuIntentLlm`; verify live with a one-off `node --env-file=../../.env --import tsx -e` call on `"draft a message to priya"` (expect intent `draft_message`, print latency). Not a unit test.
- [ ] **Step 6:** Build + lint + test, commit `feat(belief): BeliefTracker update loop and Haiku intent`.

### Task 5: Contradiction, eager end, resume, turn end (TDD)

**Files:**
- Modify: `apps/server/src/belief/tracker.ts`, `tracker.test.ts`

**Interfaces:** same class as Task 4; adds behavior only.

**Contradiction decision:** a claim is a candidate from either source:
- (a) Haiku `claims` from the latest applied result, or
- (b) the fast path, run on every update: if fast entities have `person` and `day` (or `time`), and a `type:'calendar'` doc in the current `topHits` has `metadata.people` containing that person, compare normalized `day` (or `time`) with `metadata.day` (`metadata.time`); differ -> claim `{field:'day', said:<Said as spoken, capitalized>, known:<Known capitalized>, docId}`.

A candidate fires `interject` only if all hold: its `docId` is in `topHits` (strong hit = rank < 3 in the accumulator); `normalize(said) !== normalize(known)`; `normalize(known)` appears in that doc's normalized text or metadata; `normalize(said)` appears in the current normalized partial; the belief is locked with `confidence >= INTERJECT_AT` (so Haiku intent + Moss support gate it, not Moss score); and no interject yet this turn. The claim is added to `belief.claims` and a `belief_update` is emitted before the `interject`. Text: `INTERJECT_TEMPLATE` with `{person}` = contact first name, `{known}`/`{said}` capitalized weekdays. Log `[belief] interject day said=Thursday known=Friday doc=evt-priya-q3`.

- `onEagerEnd(turnId, text)`: run `onUpdate` with the text, await `idle()`, mark finalized, return. `onResume(turnId)`: clear finalized only. `onTurnEnd(turnId, finalText)`: one `llm.classify({partial: finalText, topHits, final: true})` awaited; apply as in Task 4 (no seq drop); emit final `belief_update`; delete turn state; return the belief. If that call fails, return the last belief.
- Unknown turnId on `onResume`/`onTurnEnd`: no-op / return an `unknown` belief with confidence 0 without throwing.

- [ ] **Step 1: Failing tests:**
  - `fast-path day contradiction fires once when locked` (locked draft_message/Priya, calendar hit `evt-priya-q3` with `metadata {people:'Priya Shah', day:'friday', time:'2 pm', type:'calendar'}`, partial `"... see her Thursday"` -> exactly one `interject` with text === `"Heads up, Priya's meeting is Friday, not Thursday. Say Friday?"`, claim `{field:'day', said:'Thursday', known:'Friday', docId:'evt-priya-q3'}`; the next partial emits no second interject)
  - `no interject when not locked` (same hits, llm unresolved)
  - `llm claim is verified against the doc` (llm claim with `known:'Wednesday'` not in doc text -> no interject)
  - `same day after normalization is not a contradiction` (said `"Friday,"`, known `"friday"`)
  - `eager end finalizes and resume un-finalizes`
  - `turn end makes one llm call and returns final belief`, `unknown turn is ignored`
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Build + lint + test, commit `feat(belief): contradiction interject and turn lifecycle`.

### Task 6: Replay harness

**Files:**
- Create: `apps/server/scripts/replay.ts`
- Modify: `apps/server/package.json` (script `replay`)

**Interfaces:**
- Consumes: `loadFixture` from `@ahead/contracts/mocks/node`, `mockInkStream` from `@ahead/contracts/mocks`, `MossIndex`, `HaikuIntentLlm`, `BeliefTracker`, contacts from `workspace-seed/contacts.json` (via `REPO_ROOT`).
- Produces: `pnpm --filter @ahead/server replay [fixture=demo-utterance-1] [--speed=1]`. Exports `runReplay(opts: { fixture: string; speed: number; tracker: BeliefTracker; print: (line: string) => void }): Promise<ReplayResult>` with `ReplayResult = { lockAtMs?: number; lockPartial?: string; interjectAtMs?: number; interjectPartial?: string; finalBelief: Belief }` so DEMO_MODE (Lane E) can reuse it.

Behavior: loads Moss at startup (outside timing), then plays the fixture in real time (speed 1 default). Maps `transcript_partial` -> `onUpdate` (not awaited, so a slow Haiku never delays the stream; Moss work is awaited per update in order via a small serial queue), `turn_eager_end` -> `onEagerEnd`, `turn_resume` -> `onResume`, `transcript_final` -> `onTurnEnd`. Timeline lines, times relative to `turn_start`:

```
+1750ms partial  "Draft a message to Priya"
+1752ms moss     4 queries max 2.3ms top: contact-priya, evt-priya-q3, file-q3-deck
+1752ms belief   unknown conf=0.40
+2140ms belief   draft_message person=Priya Shah conf=0.94 LOCK (llm 388ms)
+3000ms partial  "...see her Thursday"
+3003ms INTERJECT "Heads up, Priya's meeting is Friday, not Thursday. Say Friday?"
```

End with a verdict block: `lock: +Xms on "<partial>"`, `interject: +Yms on "<partial>"`, `thursday partial: +3000ms`, then `PASS` if the lock partial precedes the first partial containing `Thursday` and the interject was triggered by the Thursday partial (the partial being processed when it fired), else `FAIL` with exit code 1. Also print Moss query count and p50/p95 for the turn.

- [ ] **Step 1:** Implement `replay.ts`.
- [ ] **Step 2:** Run `pnpm --filter @ahead/server replay`. Expected: `PASS`, lock on the `"Draft a message to Priya"` (or `"... saying,"`) partial, interject on the `"... Thursday"` partial.
- [ ] **Step 3:** If FAIL, use superpowers:systematic-debugging; do not loosen the verdict.
- [ ] **Step 4:** Build + lint + test, run `pnpm check:secrets`, commit `feat(belief): replay harness`.
- [ ] **Step 5:** Request code review (superpowers:requesting-code-review) on the whole branch.
