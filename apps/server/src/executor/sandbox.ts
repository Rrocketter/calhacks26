// Droid sandbox settings and the verified session opener. Ported from scripts/spike-droid.ts
// (the `home` read policy only; there is no switch to turn the sandbox off).
import fs from 'node:fs';
import path from 'node:path';
import {
  AutonomyLevel,
  createSession,
  type DroidSession,
} from '@factory/droid-sdk/node';
import { REPO_ROOT, WORKSPACE_DIR } from '../env.js';
import { logLatency } from '../log.js';
import { assertWorkspaceLocation, droidChildEnv } from './guard.js';

export const MODEL_ID = 'claude-haiku-5-5';
export const DISABLED_TOOLS = [
  'Execute', 'Script', 'FetchUrl', 'WebSearch', 'LS', 'Glob', 'Grep', 'Task', 'Skill',
  'ConnectApp', 'StageSettingsChanges', 'ListAutomations', 'ReadAutomation', 'ListAutomationTemplates',
];
const WRITE_TOOLS = ['Create', 'Edit', 'ApplyPatch'];
// ToolSearch cannot be disabled: it stays allowed even when listed in disabledToolIds (observed).
export const BASE_ALLOWED = ['Create', 'Edit', 'Read', 'TodoWrite', 'ToolSearch'];

type CreateOpts = NonNullable<Parameters<typeof createSession>[0]>;
type SettingsWithEnabled = Parameters<DroidSession['updateSettings']>[0] & { enabledToolIds?: string[] };

export interface SandboxOpts {
  home: string;
  repoRoot: string;
  workspace: string;
}

// Canonical (on-disk case, symlinks resolved) and lexical spelling of a path.
function spellings(p: string): string[] {
  let real = p;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    // does not exist; keep the lexical form only
  }
  return [...new Set([real, p])];
}

function canonical(p: string): string {
  return spellings(p)[0]!;
}

export function sandboxSettings(opts: SandboxOpts): object {
  const home = canonical(opts.home);
  const workspace = canonical(opts.workspace);
  const repo = spellings(opts.repoRoot);
  const secretDirs = ['.ssh', '.aws', '.config', '.netrc', '.npmrc', '.gnupg', '.factory'].map((d) => path.join(opts.home, d));
  const filesystem = {
    denyRead: [...new Set([home, ...repo, ...secretDirs])],
    allowRead: [workspace],
    denyWrite: [path.join(workspace, '.git'), ...repo],
  };
  return { sandbox: { enabled: true, mode: 'per-command', filesystem } };
}

export function writeSandboxSettings(dir: string, opts: SandboxOpts): string {
  const file = path.join(dir, 'droid-settings.json');
  fs.writeFileSync(file, JSON.stringify(sandboxSettings(opts), null, 2));
  return file;
}

export function verifySandbox(settings: unknown): void {
  const enabled = (settings as { sandbox?: { enabled?: unknown } } | null | undefined)?.sandbox?.enabled;
  if (enabled !== true) throw new Error('droid sandbox disabled');
}

export function verifyAllowedTools(tools: { id: unknown; allowed: boolean }[]): string[] {
  const allowed = tools.filter((t) => t.allowed).map((t) => String(t.id)).sort();
  const offered = new Set(tools.map((t) => String(t.id)));
  const expected = [...BASE_ALLOWED, ...(offered.has('ApplyPatch') ? ['ApplyPatch'] : [])].sort();
  if (allowed.join(',') !== expected.join(',')) {
    throw new Error(`allowed tool set mismatch, expected ${expected.join(',')}`);
  }
  return allowed;
}

export interface OpenSessionOpts {
  permissionHandler: CreateOpts['permissionHandler'];
  abortSignal?: AbortSignal;
  settingsFile: string;
  onMetric?: (label: string, ms: number) => void;
}

export async function openDroidSession(opts: OpenSessionOpts): Promise<DroidSession> {
  assertWorkspaceLocation(WORKSPACE_DIR, REPO_ROOT);
  const t0 = performance.now();
  const session = await createSession({
    cwd: WORKSPACE_DIR,
    env: droidChildEnv(),
    modelId: MODEL_ID,
    autonomyLevel: AutonomyLevel.Off,
    disabledToolIds: DISABLED_TOOLS,
    permissionHandler: opts.permissionHandler,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    execArgs: ['--settings', opts.settingsFile],
  });
  const ms = performance.now() - t0;
  logLatency('droid', 'createSession', ms);
  opts.onMetric?.('createSession', ms);
  try {
    verifySandbox(session.settings);
    // At AutonomyLevel.Off the CLI drops the write tools; enabledToolIds (untyped in 0.10.0) restores them.
    const enable: SettingsWithEnabled = { enabledToolIds: WRITE_TOOLS };
    await session.updateSettings(enable);
    verifyAllowedTools(await session.listTools());
  } catch (e) {
    await session.close().catch(() => undefined);
    throw e;
  }
  return session;
}
