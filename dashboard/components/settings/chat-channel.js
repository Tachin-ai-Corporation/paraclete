// dashboard/components/settings/chat-channel.js: how the Google Chat channel reads on Settings, System.
// Pure: it turns the `gchat` blocks of the ears' and the mouth's heartbeats (in the `status` command's
// answer, services.<service>.heartbeat.gchat; written by agent/services/ears/main.mjs and
// agent/services/mouth/main.mjs) into a badge, one sentence and a few facts. The System tab renders
// it; how people reach the agent in Chat is agent/services/ears/README.md.

/**
 * Plural-aware count: count(1, 'space') is '1 space', count(3, 'space') is '3 spaces'.
 *
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export function count(n, one, many = `${one}s`) {
  const value = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * The Chat channel as the System tab shows it.
 *
 * @param {object|null|undefined} ears   status.services.ears.heartbeat.gchat
 * @param {object|null|undefined} [mouth] status.services.mouth.heartbeat.gchat
 * @returns {{state: string, badge: {level: string, label: string}, summary: string, error: string|null,
 *   facts: Array<{label: string, value: string, at?: string}>}} `at` marks a fact whose value is a time
 */
export function chatChannelView(ears, mouth = null) {
  if (!ears || typeof ears !== 'object') {
    return {
      state: 'unknown',
      badge: { level: 'warn', label: 'unknown' },
      summary: 'The ears have not reported Google Chat: they are not running, or run a release from before it.',
      error: null,
      facts: [],
    };
  }
  if (ears.state === 'off') {
    return {
      state: 'off',
      badge: { level: 'neutral', label: 'off' },
      summary: 'Not set up: this instance has no Workspace account. A Workspace role gets Google Chat once its account is set up.',
      error: null,
      facts: [],
    };
  }

  const facts = [];
  if (ears.account) facts.push({ label: 'Account', value: ears.account });

  if (ears.state !== 'ready') {
    return {
      state: 'connecting',
      badge: { level: 'warn', label: 'connecting' },
      summary: "Waiting for the agent's Workspace account: the user must exist and the domain-wide delegation must grant the Chat scopes.",
      error: ears.last_error || null,
      facts,
    };
  }

  const reads = [count(ears.spaces, 'space'), count(ears.direct_messages, 'direct message')].join(' and ');
  facts.push({ label: 'Reads', value: reads });
  if (Number(ears.external_spaces) > 0) {
    facts.push({ label: 'Not read', value: `${count(ears.external_spaces, 'space')} open to people outside the organization` });
  }
  facts.push({ label: 'Dashboard users known in Chat', value: String(Number(ears.known_users) || 0) });
  if (ears.last_ok_at) facts.push({ label: 'Last read', value: ears.last_ok_at, at: ears.last_ok_at });
  if (Number(ears.taken_in) > 0) facts.push({ label: 'Messages taken in', value: String(ears.taken_in) });
  if (mouth) {
    facts.push({ label: 'Replies sent', value: `${Number(mouth.sent) || 0}${Number(mouth.refused) ? `, ${mouth.refused} refused` : ''}` });
  }

  const sendError = mouth?.last_error && (!mouth.last_sent_at || String(mouth.last_error_at) > String(mouth.last_sent_at))
    ? `Sending: ${mouth.last_error}` : null;
  const error = ears.last_error || sendError || null;
  const trouble = Boolean(error) || ears.rate_limited;
  return {
    state: 'ready',
    badge: trouble ? { level: 'warn', label: ears.rate_limited ? 'rate limited' : 'ready, with errors' } : { level: 'ok', label: 'ready' },
    summary: 'People reach the agent by sending its account a direct message, or by mentioning it in a space it was added to.',
    error,
    facts,
  };
}
