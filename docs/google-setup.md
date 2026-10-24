# Google import setup

`pnpm import:google` copies your real Google Calendar and Gmail into AHEAD, one time, read only. It asks Google for two scopes and nothing else:

- `calendar.readonly`
- `gmail.readonly`

The script only lists and reads. It cannot create, change, send, or delete anything in your Google account.

You need about 10 minutes and a Google account. All steps below happen in a browser except the last two.

## What gets imported

- Calendar: events from 30 days ago to 60 days ahead, from every calendar you own or can edit (your primary calendar, other accounts' calendars shared to you with edit rights, and calendars you created, like "Research"). Read-only subscriptions such as holiday calendars or group calendars you can only view are skipped. Each event is tagged with its calendar's name. A calendar named after an email address is tagged with just the domain, and your primary calendar is tagged `primary`. An invite that shows up on two calendars is kept once.
- Gmail: your 60 most recent threads. For each thread it keeps the subject, sender, recipients, date, and Gmail's short preview snippet of the first message (about 200 characters). Message bodies and attachments are never downloaded.
- Contacts: built from event attendees and email senders. When an event has no other attendees, names come from the title instead: "Pulsar Project with Hayk & Luka" gives Hayk and Luka. A first name that matches exactly one known attendee becomes that person's full name. `contacts.json` holds names only, no email addresses or phone numbers, plus the calendars (or `gmail`) each person came from. Your own address and no-reply senders are left out.

Before anything reaches the search corpus:

- Email addresses in snippets are replaced with the person's name, or `[email]` when the name is unknown. Links become `[link]`.
- Threads whose subject contains "receipt", "password", "verification code", or "statement" are skipped.
- The terminal prints counts and timings only, never subjects, names, or message text.

## Step 1. Create a Google Cloud project

1. Open https://console.cloud.google.com and sign in with the Google account you want to import.
2. Accept the terms if asked.
3. Click the project picker at the top left (it may say "Select a project").
4. Click **New project**.
5. Project name: `ahead-import`. Leave Location as is.
6. Click **Create**, wait a few seconds, then select the new project in the project picker.

## Step 2. Turn on the two APIs

1. In the search bar at the top, type `Google Calendar API` and open it.
2. Click **Enable**.
3. Search for `Gmail API`, open it, and click **Enable**.

## Step 3. Set up the consent screen (testing mode)

The consent screen is the page Google shows you when the script asks for access. In testing mode, only accounts you list can use it, and nothing is published.

1. Search for `Google Auth Platform` (older consoles call it "OAuth consent screen") and open it.
2. Click **Get started**.
3. App name: `AHEAD import`. User support email: pick your own address. Click **Next**.
4. Audience: choose **External**. Click **Next**.
5. Contact information: type your email. Click **Next**.
6. Tick the box to agree to the user data policy, then click **Continue** and **Create**.

## Step 4. Add yourself as a test user

1. In the left menu of Google Auth Platform, click **Audience**.
2. Check that Publishing status says **Testing**. Leave it that way. Do not click "Publish app".
3. Under **Test users**, click **Add users**.
4. Type the Gmail address you are importing and click **Save**.

## Step 5. Add the two read-only scopes

1. In the left menu, click **Data Access**.
2. Click **Add or remove scopes**.
3. In the filter box, type `calendar.readonly` and tick `.../auth/calendar.readonly`.
4. Clear the filter, type `gmail.readonly` and tick `.../auth/gmail.readonly`.
5. Click **Update**, then **Save** at the bottom of the page.

## Step 6. Create a Desktop app client and download it

1. In the left menu, click **Clients**.
2. Click **Create client**.
3. Application type: **Desktop app**. Name: `ahead-cli`.
4. Click **Create**.
5. In the dialog, click **Download JSON**. If the dialog closes first, click the client's name and use the download button there.
6. Move the file into place and lock it down:

   ```bash
   mkdir -p ~/.ahead
   mv ~/Downloads/client_secret_*.json ~/.ahead/google-client.json
   chmod 600 ~/.ahead/google-client.json
   ```

This file identifies the app, not you, but treat it as a secret anyway. It lives outside the repo and must never be committed. To keep it somewhere else, set `GOOGLE_CLIENT_FILE=/path/to/file.json`.

## Step 7. Turn on the flag

Add this line to the repo's `.env`:

```
IMPORT_GOOGLE=1
```

To leave calendars out, list their names, comma-separated (case does not matter). You can put this in `.env` or in front of the command:

```
CALENDAR_EXCLUDE=Recruiting
```

The flag gates three things. Without it, nothing changes:

- `pnpm import:google` refuses to run.
- `pnpm reset:workspace` puts your imported calendar (one file per event under `calendar/`) and `contacts.json` in place of the seed ones. `workspace-seed/files/` stays.
- The server loads contacts from the import instead of `workspace-seed/`.

## Step 8. Run the import

```bash
pnpm import:google
```

Your browser opens Google's consent page (the URL is also printed in the terminal if it does not open). Then:

1. Pick the account you added as a test user.
2. Google warns "Google hasn't verified this app". That is expected for a testing-mode app you made yourself. Click **Continue**.
3. Google lists what the app wants. Tick both boxes: "View your calendars..." and "Read all your email...". If you leave one unticked, the import fails with a scope error.
4. Click **Continue**.
5. The tab says "AHEAD: access granted. You can close this tab." Close it.

The terminal then prints something like:

```
[google] calendar list 120.3ms
[google] calendar events [primary] 310.4ms
[google] calendar events [Research] 140.2ms
[google] calendars kept 3, read-only skipped 4, excluded 1 (Recruiting)
[google] gmail 60 threads 6120.0ms
[google] events [primary] 30
[google] events [Research] 12
[google] events 42 (of 44 fetched, duplicates and cancelled dropped)
[google] threads 60, kept 52, skipped 8 by subject blocklist
[google] contacts 55
[corpus] wrote 184 docs
[moss] createIndex 184 docs (upload+build) 3400.2ms
```

The last part rebuilds the Moss index `ahead-corpus` from the new corpus.

Gmail limits how fast one user can read mail, so threads are fetched 10 at a time with a one-second pause. If Google still says the quota is exceeded, the script waits and retries on its own (you will see `[google] rate limited, retry ...`). If it gives up, just run it again: calendar data fetched in the last 6 hours is reused instead of downloaded again. `CALENDAR_EXCLUDE` still applies to reused data, so you can change it without refetching. Use `pnpm import:google --fresh` to force a full refetch.

The token is saved to `~/.ahead/google-token.json` (outside the repo, owner-only permissions), so later runs skip the browser. Google expires testing-mode tokens after 7 days. When that happens, delete the token file and run the import again.

## Step 9. Load it into the workspace

```bash
pnpm reset:workspace
```

Then start the server as usual. The demo now runs on your data.

## Where the data goes

Local and gitignored:

- `data/google/calendar/` (one JSON file per event plus `index.json`; an older import's `calendar.json` is split on reset)
- `data/google/contacts.json`
- `data/corpus/corpus.json`

`workspace-seed/` is never touched.

Sent to services while the demo runs:

- Moss: building the index uploads the corpus docs (redacted snippets, names, event titles). Queries run locally after that.
- Factory Droid: opens the one event file under `calendar/` that the server names when it stages an edit; for a draft the server passes the one contact in the prompt. Contacts have no email addresses. Drafts go to `messages/outbox/` and are never sent.
- Anthropic (Haiku): receives the top search hits for each utterance.

## Undo

1. Revoke access at https://myaccount.google.com/connections: find "AHEAD import" and remove it.
2. Delete the local copies:

   ```bash
   rm -rf data/google ~/.ahead/google-token.json
   ```

3. Remove `IMPORT_GOOGLE=1` from `.env`.
4. Go back to the seed:

   ```bash
   pnpm reset:workspace
   pnpm --filter @ahead/server gen:corpus
   pnpm --filter @ahead/server build:index
   ```

You can also delete the `ahead-import` project in the Cloud console.

## Troubleshooting

- **"Access blocked: AHEAD import has not completed the Google verification process"**: the account is not a test user. Redo Step 4 with the exact address.
- **"missing OAuth client file"**: the JSON is not at `~/.ahead/google-client.json`. Redo Step 6.
- **"is not a Desktop app client"**: you created a Web application client. Create a new one with type Desktop app.
- **"Request had insufficient authentication scopes"**: a box was left unticked on the consent page. Delete `~/.ahead/google-token.json` and run again.
- **"invalid_grant"**: the cached token expired or was revoked. Delete `~/.ahead/google-token.json` and run again.
- **"Quota exceeded ... Units per minute per user"** after all retries: wait a minute and run again. The calendar is not refetched.
- **"Gmail API has not been used in project ..."**: the API is off. Redo Step 2 and wait a minute.
