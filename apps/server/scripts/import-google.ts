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
import { writeCalendarDir } from '../../../scripts/calendar-layout.mjs';
import { withRetry } from './google-retry.js';
import { seedFileDocs } from './seed-files.js';
import {
  deriveContacts,
  parseExclude,
  selectCalendars,
  shapeEvents,
  shapeThreads,
  toCorpus,
  type GCalendar,
  type GEvent,
  type GThread,
} from './google-shape.js';

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
const THREADS = 60;
// threads.get costs 10 quota units; 10 per batch with a pause stays far below the per-user limit.
const BATCH = 10;
const BATCH_PAUSE_MS = 1000;
// Calendar fetched by a run that then failed (e.g. on Gmail quota) is reused by the retry.
const CAL_CACHE = path.join(OUT_DIR, '.calendar-partial.json');
const CAL_CACHE_MAX_AGE = 6 * 60 * 60 * 1000;

// Holds every owner/writer calendar, so a changed CALENDAR_EXCLUDE still applies on reuse.
type CalCache = { v: 2; fetchedAt: number; tz: string; calendars: GCalendar[]; items: GEvent[] };

function readCalCache(): CalCache | undefined {
  if (process.argv.includes('--fresh') || !fs.existsSync(CAL_CACHE)) return undefined;
  try {
    const c = JSON.parse(fs.readFileSync(CAL_CACHE, 'utf8')) as CalCache;
    if (c.v === 2 && Date.now() - c.fetchedAt < CAL_CACHE_MAX_AGE) return c;
  } catch {
    // Corrupt or half-written: refetch.
  }
  fs.rmSync(CAL_CACHE, { force: true });
  return undefined;
}

async function timed<T>(source: string, label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  logLatency(source, label, performance.now() - t);
  return out;
}

function saveToken(tokens: Auth.Credentials): void {
  fs.mkdirSync(AHEAD_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(AHEAD_DIR, 0o700);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
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
      res.end(ok ? 'Ahem: access granted. You can close this tab.' : 'Ahem: consent failed. Check the terminal.');
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
  fs.rmSync(CAL_CACHE, { force: true });
  return client;
}

async function fetchCalendars(calendar: ReturnType<typeof google.calendar>): Promise<GCalendar[]> {
  const out: GCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await withRetry(() => calendar.calendarList.list({ maxResults: 250, pageToken }));
    out.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function fetchEvents(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  label: string,
  tz: string,
): Promise<GEvent[]> {
  const now = Date.now();
  return timed('google', `calendar events [${label}]`, async () => {
    const out: GEvent[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await withRetry(() =>
        calendar.events.list({
          calendarId,
          timeMin: new Date(now - 30 * DAY).toISOString(),
          timeMax: new Date(now + 60 * DAY).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: tz,
          maxResults: 250,
          pageToken,
        }),
      );
      // Keep only what google-shape reads: no descriptions or conference data on disk.
      out.push(
        ...(data.items ?? []).map((e) => ({
          id: e.id,
          status: e.status,
          summary: e.summary,
          location: e.location,
          start: e.start,
          end: e.end,
          attendees: e.attendees?.map((a) => ({ email: a.email, displayName: a.displayName, self: a.self, resource: a.resource })),
          calendar: label,
        })),
      );
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  });
}

async function main(): Promise<void> {
  if (process.env.IMPORT_GOOGLE !== '1') {
    console.error('[google] refusing to run: set IMPORT_GOOGLE=1 (see docs/google-setup.md)');
    process.exit(1);
  }
  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });
  const gmail = google.gmail({ version: 'v1', auth });

  let cache = readCalCache();
  if (cache) {
    console.log(`[google] calendars reused from earlier run (${cache.items.length} events, --fresh to refetch)`);
  } else {
    const tz = (await timed('google', 'calendar tz', () => withRetry(() => calendar.calendars.get({ calendarId: 'primary' }))))
      .data.timeZone ?? 'UTC';
    const calendars = await timed('google', 'calendar list', () => fetchCalendars(calendar));
    const items: GEvent[] = [];
    // Primary first, so an invite on two calendars is tagged with the primary one.
    const all = selectCalendars(calendars, []).kept.sort((x, y) => +(y.label === 'primary') - +(x.label === 'primary'));
    for (const c of all) items.push(...(await fetchEvents(calendar, c.id, c.label, tz)));
    cache = { v: 2, fetchedAt: Date.now(), tz, calendars, items };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CAL_CACHE, JSON.stringify(cache) + '\n', { mode: 0o600 });
  }
  const { tz } = cache;
  const picked = selectCalendars(cache.calendars, parseExclude(process.env.CALENDAR_EXCLUDE));
  const keep = new Set(picked.kept.map((c) => c.label));
  const items = cache.items.filter((e) => keep.has(e.calendar ?? ''));
  console.log(
    `[google] calendars kept ${picked.kept.length}, read-only skipped ${picked.readOnly}, excluded ${picked.excluded.length}` +
      (picked.excluded.length ? ` (${picked.excluded.join(', ')})` : ''),
  );

  const self = (await timed('google', 'gmail profile', () => withRetry(() => gmail.users.getProfile({ userId: 'me' }))))
    .data.emailAddress ?? '';
  const threads: GThread[] = await timed('google', `gmail ${THREADS} threads`, async () => {
    const { data } = await withRetry(() => gmail.users.threads.list({ userId: 'me', maxResults: THREADS }));
    const ids = (data.threads ?? []).map((t) => t.id!).filter(Boolean);
    const out: GThread[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      if (i) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
      // metadata = headers + snippet; bodies are not downloaded.
      const batch = await Promise.all(
        ids.slice(i, i + BATCH).map((id) =>
          withRetry(() =>
            gmail.users.threads.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Date'] }),
          ),
        ),
      );
      out.push(...batch.map((r) => r.data));
    }
    return out;
  });

  const events = shapeEvents(items, tz, self);
  const { kept, skipped } = shapeThreads(threads, self, tz);
  const contacts = deriveContacts(events, kept, self);
  // The workspace keeps workspace-seed/files/ under the Google overlay, so the corpus does too.
  const corpus = [...toCorpus(events, contacts, kept), ...seedFileDocs(path.join(REPO_ROOT, 'workspace-seed'))];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Same shape as the workspace: one file per event plus calendar/index.json.
  writeCalendarDir(events, path.join(OUT_DIR, 'calendar'));
  fs.rmSync(path.join(OUT_DIR, 'calendar.json'), { force: true });
  fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify({ contacts }, null, 2) + '\n');
  fs.mkdirSync(path.dirname(CORPUS), { recursive: true });
  fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, 2) + '\n');

  for (const c of picked.kept) {
    console.log(`[google] events [${c.label}] ${events.filter((e) => e.calendar === c.label).length}`);
  }
  console.log(`[google] events ${events.length} (of ${items.length} fetched, duplicates and cancelled dropped)`);
  console.log(`[google] threads ${threads.length}, kept ${kept.length}, skipped ${skipped} by subject blocklist`);
  console.log(`[google] contacts ${contacts.length}`);
  console.log(`[corpus] wrote ${corpus.length} docs`);

  // Rebuild ahead-corpus from the corpus just written. Env (Moss keys from .env) is inherited.
  execFileSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'build-index.ts')], {
    stdio: 'inherit',
    env: { ...process.env, MOSS_DISABLE_TELEMETRY: '1' },
  });
  fs.rmSync(CAL_CACHE, { force: true });
}

main().catch((err: unknown) => {
  console.error(`[google] error ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
