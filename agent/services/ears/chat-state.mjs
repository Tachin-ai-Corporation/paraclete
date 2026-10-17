// agent/services/ears/chat-state.mjs: what the ears remember about Google Chat across restarts: the
// newest message time taken in per space, the names of messages already taken in, and the agent's
// own Chat user id. Kept in one JSON file under the data root, so a restart neither replays a
// space's history nor misses what arrived while the service was down. What the state means is
// chat-inbox.mjs. Used by the ears' main.mjs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ cursors: {}, seen: [], agentUserId: null });

/**
 * A state store backed by one JSON file. A missing or unreadable file reads as empty state; a write
 * goes to a temporary file first and is renamed over the old one, so a crash mid-write never
 * leaves half a file.
 *
 * @param {string}   path
 * @param {object}   [options]
 * @param {Function} [options.log] (level, message, fields) logger
 * @returns {{load: () => {cursors: object, seen: string[], agentUserId: string|null}, save: (state: object) => void}}
 */
export function createFileStateStore(path, { log = () => {} } = {}) {
  function load() {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return EMPTY();
    }
    try {
      const data = JSON.parse(raw);
      return {
        cursors: data.cursors && typeof data.cursors === 'object' ? data.cursors : {},
        seen: Array.isArray(data.seen) ? data.seen.filter((s) => typeof s === 'string') : [],
        agentUserId: typeof data.agentUserId === 'string' ? data.agentUserId : null,
      };
    } catch (err) {
      log('WARN', 'Chat state file is unreadable; starting from empty state', { path, error: err.message });
      return EMPTY();
    }
  }

  function save(state) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      log('WARN', 'Chat state could not be saved; a restart may replay recent messages', { path, error: err.message });
    }
  }

  return { load, save };
}
