# agent/providers/

Clients for outside services the agent's code calls directly.

**Belongs here:** single-shot Vertex text calls with schema enforcement (classification, digests),
channel clients (dashboard, Google Chat), notifications, JSON repair for model output, and the Google
Workspace API clients (Drive, Calendar, Gmail, Docs, Sheets, Slides) the skills' commands call.
**Doesn't:** organ turns with tools. Those go through `gateway/`.

## Files

| File | Does |
|---|---|
| `vertex-text.mjs` | Single-shot Vertex AI text calls with schema enforcement: classification, digests, the cortex's decision schemas |
| `json-repair.mjs` | Recovers JSON from model output that is almost valid |
| `channel.mjs` | Channel addresses and delivery: the dashboard and Google Chat |
| `notifications.mjs` | Acknowledgments and status notes written to the person who asked |
| `to-str.mjs` | Turns any model output value into text |
| `drive.mjs` | Google Drive as the agent's Drive identity (its service account, or its Workspace account): find, download, export, create new files, list shared drives, read Drive links, and Google's errors in plain words. It never edits, moves or deletes a file it did not just create |
| `workspace.mjs` | The core of the Workspace clients: acting as the agent's own Workspace account with a token per API carrying only that API's scopes, Google's errors in plain words with the fix (a scope missing from the grant named), and the ownership check every in-place change passes |
| `workspace-calendar.mjs` | Google Calendar: events in a window, one event, free/busy, and creating and changing events the agent organizes on its own calendar (attendees' answers never touched); time zones and shared free time |
| `workspace-gmail.mjs` | Gmail, read only: search, a message or thread as text, attachments |
| `workspace-docs.mjs` | Google Docs: a document as Markdown or exact text, comments, new Docs from Markdown, and find-and-replace or a section rewrite in Docs the agent owns |
| `workspace-sheets.mjs` | Google Sheets: tabs and values, new Sheets from CSV, and value writes in Sheets the agent owns; A1 notation |
| `workspace-slides.mjs` | Google Slides: a deck as text with speaker notes, and new decks from an outline |
