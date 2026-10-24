// One-time, read-only import of the user's Google Calendar and Gmail into data/google/
// (gitignored overlay for the workspace) and data/corpus/corpus.json, then rebuilds the
// Moss index. Only readonly scopes, only list/get calls: nothing is ever written to Google.
// Prints counts and latency, never contents. Setup: docs/google-setup.md.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { google, Auth } from 'googleapis';
import { REPO_ROOT } from '../src/env.js';
import { logLatency } from '../src/log.js';
import { deriveContacts, shapeEvents, shapeThreads, toCorpus, type GEvent, type GThread } from './google-shape.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const AHEAD_DIR = path.join(os.homedir(), '.ahead');
const CLIENT_FILE = process.env.GOOGLE_CLIENT_FILE || path.join(AHEAD_DIR, 'google-client.json');
const TOKEN_FILE = path.join(AHEAD_DIR, 'google-token.json');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'google');
const CORPUS = path.join(REPO_ROOT, 'data', 'corpus', 'corpus.json');
const DAY = 24 * 60 * 60 * 1000;
const THREADS = 100;

async function timed<T>(source: string, label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  logLatency(source, label, performance.now() - t);
  return out;
}

function saveToken(tokens: Auth.Credentials): void {
  fs.mkdirSync(AHEAD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
}

// Installed-app flow: loopback redirect on a random port, PKCE, state check.
async function consent(client: Auth.OAuth2Client): Promise<void> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    redirect_uri: redirect,
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
  });
  console.log('[google] open this URL to grant read-only access (opening your browser):');
  console.log(url);
  try {
    execFileSync('open', [url], { stdio: 'ignore' });
  } catch {
    // Not fatal: the URL is printed above.
  }
  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url ?? '/', redirect).searchParams;
      if (!q.get('code') && !q.get('error')) return res.writeHead(404).end();
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
      res.end(ok ? 'AHEAD: access granted. You can close this tab.' : 'AHEAD: consent failed. Check the terminal.');
      if (ok) resolve(q.get('code')!);
      else reject(new Error(`consent failed: ${q.get('error') ?? 'state mismatch'}`));
    });
  }).finally(() => server.close());
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirect });
  client.setCredentials(tokens);
  saveToken(tokens);
  console.log(`[google] token saved to ${TOKEN_FILE}`);
}

async function authorize(): Promise<Auth.OAuth2Client> {
  if (!fs.existsSync(CLIENT_FILE)) {
    throw new Error(`missing OAuth client file ${CLIENT_FILE}; see docs/google-setup.md`);
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')) as {
    installed?: { client_id: string; client_secret: string };
  };
  if (!raw.installed) throw new Error(`${CLIENT_FILE} is not a Desktop app client; see docs/google-setup.md`);
  const client = new google.auth.OAuth2(raw.installed.client_id, raw.installed.client_secret);
  // Keep the cached token current when the library refreshes it.
  client.on('tokens', (t) => {
    const prev = fs.existsSync(TOKEN_FILE) ? (JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Auth.Credentials) : {};
    saveToken({ ...prev, ...t });
  });
  if (fs.existsSync(TOKEN_FILE)) {
    const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Auth.Credentials;
    const granted = new Set((cached.scope ?? '').split(' '));
    if (cached.refresh_token && SCOPES.every((s) => granted.has(s))) {
      client.setCredentials(cached);
      return client;
    }
  }
  await consent(client);
  return client;
}

async function main(): Promise<void> {
  if (process.env.IMPORT_GOOGLE !== '1') {
    console.error('[google] refusing to run: set IMPORT_GOOGLE=1 (see docs/google-setup.md)');
    process.exit(1);
  }
  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });
  const gmail = google.gmail({ version: 'v1', auth });

  const tz = (await timed('google', 'calendar tz', () => calendar.calendars.get({ calendarId: 'primary' }))).data
    .timeZone ?? 'UTC';
  const now = Date.now();
  const items: GEvent[] = await timed('google', 'calendar events', async () => {
    const out: GEvent[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date(now - 30 * DAY).toISOString(),
        timeMax: new Date(now + 60 * DAY).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: tz,
        maxResults: 250,
        pageToken,
      });
      out.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  });

  const self = (await timed('google', 'gmail profile', () => gmail.users.getProfile({ userId: 'me' }))).data
    .emailAddress ?? '';
  const threads: GThread[] = await timed('google', `gmail ${THREADS} threads`, async () => {
    const { data } = await gmail.users.threads.list({ userId: 'me', maxResults: THREADS });
    const ids = (data.threads ?? []).map((t) => t.id!).filter(Boolean);
    const out: GThread[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(
        ids.slice(i, i + 10).map((id) => gmail.users.threads.get({ userId: 'me', id, format: 'full' })),
      );
      out.push(...batch.map((r) => r.data));
    }
    return out;
  });

  const events = shapeEvents(items, tz);
  const { kept, skipped } = shapeThreads(threads, self, tz);
  const contacts = deriveContacts(items, kept, self);
  const corpus = toCorpus(events, contacts, kept);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'calendar.json'), JSON.stringify({ events }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify({ contacts }, null, 2) + '\n');
  fs.mkdirSync(path.dirname(CORPUS), { recursive: true });
  fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, 2) + '\n');

  console.log(`[google] events ${events.length} (of ${items.length} fetched)`);
  console.log(`[google] threads ${threads.length}, kept ${kept.length}, skipped ${skipped} by subject blocklist`);
  console.log(`[google] contacts ${contacts.length}`);
  console.log(`[corpus] wrote ${corpus.length} docs`);

  // Rebuild ahead-corpus from the corpus just written. Env (Moss keys from .env) is inherited.
  execFileSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'build-index.ts')], {
    stdio: 'inherit',
    env: { ...process.env, MOSS_DISABLE_TELEMETRY: '1' },
  });
}

main().catch((err: unknown) => {
  console.error(`[google] error ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
