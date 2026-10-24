Task: move an event in calendar.json.
Read calendar.json. Find the event the user means (match on `title` and `attendees`). Note its `id`, `start` and `end`.
Write a TodoWrite plan of the edit, then stop and wait for details. Do not edit yet.
Do not run commands. Do not touch files outside this workspace.
---PHASE2---
Details from the user:
{{slots}}

Make the edit now in calendar.json.
- Date: an explicit ISO date (YYYY-MM-DD) above wins. Otherwise a weekday name means its next occurrence after today.
- Keep the event's `id`, `title`, `attendees`, `location` and duration. Change only `start` and `end`. If no new time is given, keep the old time of day.
- Write ISO 8601 with the US/Pacific offset: -07:00 before 2026-11-01, -08:00 from 2026-11-01. Example: 2026-10-26T09:00:00-07:00.
- Use the Edit tool on calendar.json in place. Never recreate the whole file. The file must stay valid JSON.
Reply with one sentence saying what moved.
Do not run commands. Do not touch files outside this workspace.
