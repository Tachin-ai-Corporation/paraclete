// agent/auth/workspace-scopes.mjs: the OAuth scopes the agent's own Google Workspace account uses,
// written once. A Workspace admin grants the role's list (`workspaceScopesFor(role)`, defaulting to
// `WORKSPACE_SCOPES`) to the delegation signer's client ID in the Admin console; each caller then asks
// agent/auth/dwd-token.mjs for a token carrying only the subset of the API it calls, so a scope missing
// from the grant breaks only the APIs that need it, and the error can name it. Only Workspace roles use
// these. Standard roles keep Gmail read-only (`WORKSPACE_SCOPES`, 9 scopes); mail-sending roles such
// as `support-specialist` add `GMAIL_SEND` (`gmail.send`, 10 scopes).
//
// Pure constants and three small helpers: no imports, so the dashboard's setup wizard can import it too.
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

/** Gmail, send: send outbound messages and threaded replies from the agent's mailbox or verified aliases. */
export const GMAIL_SEND = scopes('gmail.send');

/** Gmail scopes for roles that both read intake mail and send replies. */
export const GMAIL = scopes('gmail.readonly', 'gmail.send');

/** Roles allowed to hold `gmail.send` in their domain-wide delegation grant. */
export const MAIL_SEND_ROLES = Object.freeze(['support-specialist']);

/** The base nine scopes an admin grants for standard Workspace roles, in setup-wizard order. */
export const WORKSPACE_SCOPES = Object.freeze([...CHAT, ...DRIVE, ...DOCS, ...SHEETS, ...SLIDES, ...CALENDAR, ...GMAIL_READ]);

/** Each standard Workspace API the agent uses: its name, and the scopes a token for it carries. */
export const WORKSPACE_APIS = Object.freeze({
  chat: Object.freeze({ name: 'Google Chat', scopes: CHAT }),
  drive: Object.freeze({ name: 'Google Drive', scopes: DRIVE }),
  docs: Object.freeze({ name: 'Google Docs', scopes: DOCS }),
  sheets: Object.freeze({ name: 'Google Sheets', scopes: SHEETS }),
  slides: Object.freeze({ name: 'Google Slides', scopes: SLIDES }),
  calendar: Object.freeze({ name: 'Google Calendar', scopes: CALENDAR }),
  gmail: Object.freeze({ name: 'Gmail', scopes: GMAIL_READ }),
});

const SUPPORT_WORKSPACE_SCOPES = Object.freeze([...WORKSPACE_SCOPES, ...GMAIL_SEND]);
const SUPPORT_WORKSPACE_APIS = Object.freeze({
  ...WORKSPACE_APIS,
  gmail: Object.freeze({ name: 'Gmail', scopes: GMAIL }),
});

/**
 * The full scope list an admin grants in the Admin console for `role`. Standard Workspace roles use
 * the base nine scopes (Gmail read-only); roles in MAIL_SEND_ROLES add `gmail.send`.
 *
 * @param {string|null} [role]
 * @returns {readonly string[]}
 */
export function workspaceScopesFor(role = null) {
  return MAIL_SEND_ROLES.includes(role) ? SUPPORT_WORKSPACE_SCOPES : WORKSPACE_SCOPES;
}

/**
 * The Workspace APIs map for `role`: identical to WORKSPACE_APIS except MAIL_SEND_ROLES include
 * `gmail.send` on Gmail.
 *
 * @param {string|null} [role]
 * @returns {object}
 */
export function workspaceApisFor(role = null) {
  return MAIL_SEND_ROLES.includes(role) ? SUPPORT_WORKSPACE_APIS : WORKSPACE_APIS;
}

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

/**
 * The Cloud console page where the project's Chat app is configured. Google requires a Chat app
 * record (a name and a description; interactive features off) of the project that calls the Chat API,
 * also for calls made as a user, as the agent's are. Nobody sees the record: the agent is a person in
 * Chat, not an app. Google has no API to write it, so an admin saves it on this page.
 *
 * @param {string} project
 * @returns {string}
 */
export function chatAppPage(project) {
  return `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${encodeURIComponent(project)}`;
}
