// agent/auth/workspace-scopes.mjs: the OAuth scopes the agent's own Google Workspace account uses,
// written once. A Workspace admin grants the whole list (WORKSPACE_SCOPES) to the delegation signer's
// client ID in the Admin console; each caller then asks agent/auth/dwd-token.mjs for a token carrying
// only the subset of the API it calls, so a scope missing from the grant breaks only the APIs that need
// it, and the error can name it. Only Workspace roles use these.
//
// Pure constants and two small helpers: no imports, so the dashboard's setup wizard can import it too.
// Callers: the ears and mouth (Chat), agent/providers/drive.mjs (Drive), the Workspace API clients in
// agent/providers/workspace*.mjs, and control's Workspace check.

const ROOT = 'https://www.googleapis.com/auth/';
const scopes = (...names) => Object.freeze(names.map((name) => `${ROOT}${name}`));

/** Chat as the ears use it: read messages and spaces, never post. */
export const CHAT_READ = scopes('chat.messages.readonly', 'chat.spaces.readonly');

/** Chat as the mouth uses it: post messages (the one way out), and see the spaces it posts to. */
export const CHAT_SEND = scopes('chat.messages', 'chat.spaces.readonly');

/** Every Chat scope the grant needs: the ears' and the mouth's together. */
export const CHAT = scopes('chat.messages', 'chat.messages.readonly', 'chat.spaces.readonly');

/** Drive: find, download, export and create files, and read and add comments. */
export const DRIVE = scopes('drive');

/** Google Docs: read documents, and change the ones the agent's account owns. */
export const DOCS = scopes('documents');

/** Google Sheets: read spreadsheets, and change the ones the agent's account owns. */
export const SHEETS = scopes('spreadsheets');

/** Google Slides: read presentations and build new ones. */
export const SLIDES = scopes('presentations');

/** Google Calendar: read calendars and free/busy, and manage events on the agent's own calendar. */
export const CALENDAR = scopes('calendar');

/** Gmail, read only: search and read the agent's mailbox. Nothing here can send or change mail. */
export const GMAIL_READ = scopes('gmail.readonly');

/** The full list an admin grants in the Admin console, in the order the setup wizard shows it. */
export const WORKSPACE_SCOPES = Object.freeze([...CHAT, ...DRIVE, ...DOCS, ...SHEETS, ...SLIDES, ...CALENDAR, ...GMAIL_READ]);

/** Each Workspace API the agent uses: its name, and the scopes a token for it carries. */
export const WORKSPACE_APIS = Object.freeze({
  chat: Object.freeze({ name: 'Google Chat', scopes: CHAT }),
  drive: Object.freeze({ name: 'Google Drive', scopes: DRIVE }),
  docs: Object.freeze({ name: 'Google Docs', scopes: DOCS }),
  sheets: Object.freeze({ name: 'Google Sheets', scopes: SHEETS }),
  slides: Object.freeze({ name: 'Google Slides', scopes: SLIDES }),
  calendar: Object.freeze({ name: 'Google Calendar', scopes: CALENDAR }),
  gmail: Object.freeze({ name: 'Gmail', scopes: GMAIL_READ }),
});

/**
 * The scopes as the Admin console's domain-wide delegation form takes them: one comma-separated line.
 *
 * @param {string[]} [list] default: WORKSPACE_SCOPES
 * @returns {string}
 */
export function adminConsoleScopes(list = WORKSPACE_SCOPES) {
  return list.join(',');
}

/**
 * A scope's short name, as people say it: `https://www.googleapis.com/auth/chat.messages` is
 * `chat.messages`. Anything else comes back unchanged.
 *
 * @param {string} scope
 * @returns {string}
 */
export function scopeName(scope) {
  const s = String(scope ?? '');
  return s.startsWith(ROOT) ? s.slice(ROOT.length) : s;
}
