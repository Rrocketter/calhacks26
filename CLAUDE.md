# CLAUDE.md

Read PLAN.md first. It is the source of truth for scope, action set, state machine, and the demo script. Do not expand scope beyond PLAN.md section 4 without the human saying so.

## Repo layout
- `packages/contracts` shared types + WebSocket event schema. Frozen after Fri night. Changing it requires updating every lane's mocks.
- `apps/server` Node 20, TypeScript, single process. Moss runtime, belief tracker, Droid executor, Cartesia proxies.
- `apps/web` Vite + React + TypeScript. Mic, playback, HUD.
- `workspace-seed/` tracked seed files for the fake user's life (calendar, contacts, notes, outbox, files).
- `~/.ahead/workspace/` (override `AHEAD_WORKSPACE`) runtime copy with its own git repo, made by `pnpm reset:workspace`. Droid edits only here. Never `git init` inside the main repo. The only nested repo is the runtime workspace at ~/.ahead/workspace (AHEAD_WORKSPACE). It lives outside the repo because Droid's Read tools bypass the permission handler, so the workspace must not be able to reach the repo's .env.
- Never commit API keys anywhere.
- `data/corpus/` generated synthetic personal corpus. Generator script lives in `apps/server/scripts/gen-corpus.ts`.
- `docs/` lane briefs and README drafts.

## Rules
- pnpm workspaces. `pnpm -r build` must pass before any merge to main.
- Every lane works in its own git worktree on branch `lane/<name>`. Merge to main only via the human.
- Mock the other lanes through `packages/contracts/mocks/`. Never import across apps except via contracts.
- Secrets in `.env` only, `.env.example` committed. CI-style check: `pnpm check:secrets` greps for key patterns.
- Log every external call with latency: `[moss] 4.2ms`, `[ink] partial +88ms`, `[droid] tool:write_file`. The HUD reads these.
- Prefer boring, working code over clever code. Hackathon, not production. But no fake data in the live path. DEMO_MODE is an explicit flag and is the only place fixtures are allowed.
- When a sponsor SDK behaves differently from docs, write what you found in `docs/sdk-notes.md` so other lanes don't rediscover it.
- Before claiming a task done, run it. Use the superpowers verification-before-completion skill.

## Superpowers usage
- Start every lane with `/brainstorm` only if the lane brief is ambiguous. Otherwise go straight to `/write-plan` from `docs/lanes/<lane>.md`, then `/execute-plan`.
- Lane worktrees are created by the human. Don't create or remove worktrees yourself.
- After creating a worktree, run `pnpm install && pnpm reset:workspace` once.
- Use `test-driven-development` for belief tracker and executor state machine (pure logic, cheap to test). Skip TDD for audio plumbing, verify manually.
- Use `systematic-debugging` when an SDK call fails, do not guess at fixes.
- Use `requesting-code-review` before signaling a lane is ready to merge.

## Sponsor requirements that must survive to the end
- Cartesia README section: setup, features used (Ink 2 streaming + turn detection, Sonic 3.5 streaming, barge-in), known limitations, accessibility/privacy/responsible-use notes.
- Factory README section: where Droid runs, the trigger, the permission handler, how plans/steps/diffs are surfaced, commit/rollback.
- Moss README section: why in-process retrieval is load-bearing, queries per utterance, measured latency.
