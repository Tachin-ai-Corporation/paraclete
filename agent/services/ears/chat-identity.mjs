// agent/services/ears/chat-identity.mjs: which dashboard user, if any, sent a Google Chat message.
// Chat names people to the agent's account only by their resource name ('users/<id>'), never by
// email, and the dashboard's users list (users/{email} in Firestore) knows people only by email. The
// one bridge the agent's Chat scopes allow is the direct message: Chat finds the direct message
// between the agent and a given email (findDirectMessage), so a direct message's other member is
// known, and once that person writes in it their user id is known too, in every space. The ears
// stamp the email on what such a person sends (source_meta.sender_email); the brain takes approvals
// in Chat only from a sender whose email is a dashboard user (agent/services/brain/approval-replies.mjs).
// Nothing here decides what anyone may do. Used by chat-inbox.mjs.
//
// What it remembers: the user ids it learned, by email, kept in the Chat state file through the
// inbox (a restart does not forget who wrote in a direct message last month). The direct messages
// themselves are looked up again after a restart.

import { DASHBOARD_ROLES } from '../../storage/dashboard-users.mjs';

/** The roles a dashboard user record holds; a record with any other is no user (agent/storage/dashboard-users.mjs). */
export { DASHBOARD_ROLES };

/** How often the users list is read again and missing direct messages looked for. */
const DEFAULT_REFRESH_MS = 600_000;
/** The shortest gap between two refreshes a new direct message asks for. */
const FORCED_GAP_MS = 60_000;
/** Direct-message lookups one refresh makes at most, so a long users list cannot spend the quota. */
const MAX_LOOKUPS = 25;

/**
 * The emails of the dashboard's users, from the users collection's documents.
 *
 * @param {object[]} docs documents of the users collection, each with its id (the email)
 * @returns {string[]} lowercase
 */
export function dashboardUserEmails(docs) {
  return (docs || [])
    .filter((d) => d && DASHBOARD_ROLES.includes(d.role) && typeof d.id === 'string' && d.id.includes('@'))
    .map((d) => d.id.toLowerCase());
}

/**
 * Creates the identity map.
 *
 * @param {object}   deps
 * @param {Function} deps.readUsers         () => Promise<string[]>: the dashboard users' emails; throws on an outage
 * @param {Function} deps.findDirectMessage (token, email) => Promise<string|null> (agent/providers/channel.mjs)
 * @param {string}   [deps.agentAccount]    the agent's own Workspace address, never looked up
 * @param {object}   [deps.people]          saved { 'users/<id>': email } from an earlier run
 * @param {Function} [deps.onChange]        () => void: the learned ids changed; persist them
 * @param {number}   [deps.refreshMs]
 * @param {Function} [deps.log]             (level, message, fields) logger
 * @param {Function} [deps.now]             clock in milliseconds
 */
export function createChatIdentity({
  readUsers, findDirectMessage, agentAccount = '', people: saved = {}, onChange = () => {},
  refreshMs = DEFAULT_REFRESH_MS, log = () => {}, now = Date.now,
}) {
  let users = null; // Set of emails once read
  let lastRefresh = -Infinity;
  const dmOf = new Map(); // email -> direct message space, or null when they have none yet
  const ownerOf = new Map(); // direct message space -> email
  const people = new Map(Object.entries(saved || {}).filter(([id, email]) => id.startsWith('users/') && typeof email === 'string'));
  const self = String(agentAccount || '').toLowerCase();

  /**
   * Reads the users list again and looks for the direct messages it does not know yet. Runs every
   * refreshMs; `force` (a new direct message appeared) runs it sooner, at most once a minute.
   * A rate limit propagates, so the inbox backs off; any other lookup failure is logged and retried
   * at the next refresh.
   *
   * @param {string} token
   * @param {{force?: boolean}} [opts]
   */
  async function refresh(token, { force = false } = {}) {
    const t = now();
    if (t - lastRefresh < (force ? FORCED_GAP_MS : refreshMs)) return;
    lastRefresh = t;
    users = new Set(await readUsers());

    let changed = false;
    for (const email of [...dmOf.keys()]) if (!users.has(email)) dmOf.delete(email);
    for (const [id, email] of [...people]) {
      if (!users.has(email)) { people.delete(id); changed = true; }
    }

    let lookups = 0;
    for (const email of users) {
      if (email === self || dmOf.get(email)) continue;
      if (lookups >= MAX_LOOKUPS) break;
      lookups += 1;
      try {
        dmOf.set(email, await findDirectMessage(token, email));
      } catch (err) {
        if (err.status === 429) throw err;
        log('WARN', 'Chat: could not look up a direct message with a dashboard user', { user: email, error: err.message });
      }
    }
    ownerOf.clear();
    for (const [email, space] of dmOf) if (space) ownerOf.set(space, email);
    if (changed) onChange();
  }

  /**
   * Learns a person's user id from a message they wrote in their direct message with the agent.
   *
   * @param {object}  message a Chat message not from the agent
   * @param {string}  space
   */
  function learn(message, space) {
    const email = ownerOf.get(space);
    const id = message?.sender?.name;
    if (!email || typeof id !== 'string' || !id.startsWith('users/') || people.get(id) === email) return;
    people.set(id, email);
    log('INFO', 'Chat: learned which dashboard user writes as a Chat user', { user: email, chat_user: id });
    onChange();
  }

  /**
   * The dashboard user's email for a sender, or null when it is not known to be one.
   *
   * @param {string}  senderId 'users/<id>'
   * @param {string}  space
   * @param {boolean} directMessage whether `space` is a direct message
   * @returns {string|null}
   */
  function emailOf(senderId, space, directMessage) {
    const email = (directMessage ? ownerOf.get(space) : null) || people.get(senderId) || null;
    return email && (!users || users.has(email)) ? email : null;
  }

  /** What to persist: the learned user ids. */
  const saveable = () => Object.fromEntries(people);

  /** How many dashboard users are known in Chat, for the health file. */
  const known = () => new Set([...ownerOf.values(), ...people.values()]).size;

  return { refresh, learn, emailOf, saveable, known };
}
