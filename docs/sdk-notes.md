# SDK notes

Other sections are added per spike. Numbers are measured output from the spike scripts, not estimates.

## Moss

- Package: `@moss-js/moss@1.21.0` (pinned with `-E`). ESM only. Native N-API binding comes from the optional dependency `@moss-js/moss-core-darwin-arm64` (0.36.0), so it runs on arm64 with no Rosetta. If you see "Cannot find native binding", check that pnpm installed optional deps.
- Run: `pnpm -r build` first (contracts dist), then `pnpm --filter @ahead/server spike:moss`. The script sets `MOSS_DISABLE_TELEMETRY=1`.
- Calls used: `new MossClient(projectId, projectKey)`, `listIndexes()`, `deleteIndex(name)`, `createIndex(name, docs, {modelId: 'moss-minilm'})`, `loadIndex(name)`, `query(name, text, {topK})`, `close()` in `finally`.
- Docs are `{id, text, metadata}`; metadata values must be strings.
- `createIndex` on an existing name throws "Index already exists", so list and delete first.
- `loadIndex` must be called before `query` (no cloud fallback in 1.21.0).

### Measured (10 docs, 20 timed queries, first run on this machine)

| Step | Result |
| --- | --- |
| createIndex (upload + cloud build + poll) | 3820.6 ms |
| loadIndex | 19866.4 ms |
| warmup query | 2.1 ms |
| query wall-clock p50 | 2.0 ms |
| query wall-clock p95 | 2.4 ms |
| SDK `timeTakenInMs` p50 / p95 | 0 / 0 (reported as whole ms, so sub-ms rounds to 0) |

Top hits:
- "draft a message to Priya" -> `evt-priya-q3` (score 0.036)
- "meeting with Priya Thursday" -> `evt-priya-q3` (score 0.351)
- "q3 deck" -> `contact-priya` (score 1.000), not the file doc
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
