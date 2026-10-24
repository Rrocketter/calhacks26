import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=ahead', '-c', 'user.email=ahead@localhost', '-c', 'commit.gpgsign=false'];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

// Manages spec/<turnId> branches in the runtime workspace repo (never the main repo).
export class WorkspaceGit {
  constructor(private readonly root: string) {}

  branchName(turnId: string): string {
    return 'spec/' + turnId.replace(/[^A-Za-z0-9._-]/g, '-');
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await run('git', ['-C', this.root, ...FLAGS, ...args], { env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`, { cause: err });
    }
  }

  async prepare(turnId: string): Promise<void> {
    await this.git('checkout', '-f', 'main');
    await this.git('clean', '-fd');
    const stale = (await this.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/spec/'))
      .split('\n')
      .filter(Boolean);
    for (const b of stale) await this.git('branch', '-D', b);
    await this.git('checkout', '-b', this.branchName(turnId));
  }

  async commitAll(message: string): Promise<string> {
    await this.git('add', '-A');
    await this.git('commit', '--allow-empty', '--no-verify', '-m', message);
    return (await this.git('rev-parse', 'HEAD')).trim();
  }

  async resetTo(sha: string): Promise<void> {
    await this.git('reset', '--hard', sha);
    await this.git('clean', '-fd');
  }

  async diffFiles(turnId: string): Promise<{ file: string; diff: string }[]> {
    const b = this.branchName(turnId);
    const names = (await this.git('diff', '--name-only', `main..${b}`)).split('\n').filter(Boolean);
    const out: { file: string; diff: string }[] = [];
    for (const file of names) out.push({ file, diff: await this.git('diff', `main..${b}`, '--', file) });
    return out;
  }

  async merge(turnId: string): Promise<void> {
    const b = this.branchName(turnId);
    await this.git('checkout', 'main');
    await this.git('merge', '--ff-only', b);
    await this.git('branch', '-d', b);
  }

  async discard(turnId: string): Promise<void> {
    const b = this.branchName(turnId);
    await this.git('checkout', '-f', 'main');
    await this.git('clean', '-fd');
    const exists = (await this.git('for-each-ref', '--format=%(refname:short)', `refs/heads/${b}`)).trim();
    if (exists) await this.git('branch', '-D', b);
  }

  async isClean(): Promise<boolean> {
    return (await this.git('status', '--porcelain')).trim() === '';
  }

  async currentBranch(): Promise<string> {
    return (await this.git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  }
}
