// agent/providers/notifications.mjs: the brain's helpers for what it tells people while work runs.
// Turns raw step output into a clean approval request or final delivery, writes status updates as
// envelopes for the mouth to send, and writes the quick acknowledgment for new work. It never sends
// anything itself: every outbound message leaves through the mouth. Used by the brain.
//
// Everything outside the module (model client, Firestore, the gateway, files, the clock) arrives
// through deps.

/**
 * Per-type summary rules. Approval requests and final deliveries are rewritten by the model into a
 * self-contained message; status updates and error reports pass through as written.
 */
const SUMMARY_TYPES = {
  approval_request: {
    llm: true,
    maxChars: 1500,
    prompt: (ctx) => [
      'You are writing a concise approval request notification for a human reviewer.',
      'Summarize the completed work into a clean, self-contained message.',
      '',
      'RULES:',
      `- 3-8 sentences max, under ${ctx.maxChars || 1500} characters`,
      '- Include ALL relevant URLs, links, and artifact references inline',
      '- The reader must NOT need any prior context — everything self-contained',
      '- State what was done, what the outcome is, and what happens next if approved',
      '- NEVER say "see above", "the link from earlier", or reference prior messages',
      '- Do NOT include raw command output, JSON blobs, or deployment logs',
      '- Do NOT include step numbers, organ names (motor, cerebellum), or internal jargon',
      '- Use markdown for readability (bold for key items, links clickable)',
      '',
      ctx.processName ? `PROCESS: ${ctx.processName}` : '',
      ctx.title ? `APPROVAL TITLE: ${ctx.title}` : '',
      ctx.customMessage ? `CUSTOM CONTEXT: ${ctx.customMessage}` : '',
      '',
      'COMPLETED STEPS:',
      JSON.stringify(ctx.steps, null, 2),
    ].filter(Boolean).join('\n'),
  },
  completion: {
    llm: true,
    maxChars: 3000,
    prompt: (ctx) => [
      'You are writing the final delivery for a completed mission.',
      '',
      'DELIVERY CONTRACT (answer, then reasoning, then risk):',
      '1. Lead with the answer in actionable form — the decision, number, or recommendation.',
      '   The first line must be safe to act on alone, or carry its own warning in the same breath.',
      '2. Then the compressed load-bearing chain a checker would need — audit trail, not proof of effort.',
      '3. Then risk — what would change this answer, any labeled assumptions (verified/inferred/assumed),',
      '   what to check before acting. Hedges are information: they live here, not smeared through the answer.',
      '',
      'RULES:',
      `- Under ${ctx.maxChars || 3000} characters`,
      '- Do NOT reorder: answer → reasoning → risk. This order is a contract.',
      '- If the text contains "— Reasoning —" / "— Risk & assumptions —" section markers, keep the',
      '  sections intact in that order; polish wording inside them, never move content across them.',
      '  Keep every "• [verified|inferred|assumed] ..." line\'s label — the bins are the point.',
      '- Include ALL relevant URLs, links, and artifact references inline',
      '- Self-contained — never reference prior messages',
      '- No internal jargon (motor, cerebellum, checkpoint, envelope)',
      '- Scale to stakes: one-line answer for a lookup, full treatment for anything signed',
      '',
      ctx.title ? `MISSION: ${ctx.title}` : '',
      '',
      'RAW OUTPUT:',
      ctx.rawText || '(empty)',
    ].filter(Boolean).join('\n'),
  },
  status_update: { llm: false }, // already human-readable
  error_report: { llm: false }, // errors must stay precise
};

/** Acknowledgments used when the model can't write one. */
export const ACK_FALLBACKS = Object.freeze([
  '✅ Got it — working on this now.',
  '👍 On it!',
  '✅ Received — let me look into this.',
  '📛 Working on it.',
]);

const CURRENT_MESSAGE_MARKER = '[Current message - respond to this]';
// Marks a gateway request as the brain's own, not a person's chat turn.
const BRAIN_MARKER = '[BRAIN-ORCHESTRATED]';
const ACK_TIMEOUT_MS = 15_000;

/**
 * Creates a notifier.
 *
 * @param {object}   deps
 * @param {object}   deps.vertexText        a client from vertex-text.mjs (uses .transform())
 * @param {Function} deps.firestoreWrite    async (collection, docId, data) => result
 * @param {Function} [deps.firestoreRead]   async (collection, docId) => doc or null
 * @param {{work: string}} deps.collections collection names: pass COLLECTIONS from agent/storage/collections.mjs
 * @param {Function} [deps.addressFromMeta] (sourceMeta, sourceChannel) => Address (see channel.mjs)
 * @param {Function} deps.generateId        (prefix) => unique id
 * @param {Function} [deps.cachedReadFile]  (path) => file content or null
 * @param {Function} [deps.getGatewayConfig] () => { url, token, route } for the acknowledgment call
 * @param {Function} [deps.getProjects]     () => the live projects map
 * @param {Function} [deps.logger]          (level, msg) logger
 * @param {Function} [deps.fetch]           fetch implementation (injectable for tests)
 * @param {Function} [deps.now]             clock in milliseconds (injectable for tests)
 * @param {object}   [deps.config]
 * @param {string}   [deps.config.identityPath] the agent's IDENTITY.md, read for the acknowledgment's voice
 * @returns {{summarizeForDelivery: Function, extractCurrentMessage: Function, writeStatusUpdate: Function, generateAck: Function}}
 */
export function createNotifier(deps) {
  const {
    vertexText,
    firestoreWrite,
    firestoreRead,
    collections,
    addressFromMeta,
    generateId,
    cachedReadFile = () => null,
    getGatewayConfig,
    getProjects = () => ({}),
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    config = {},
  } = deps;
  if (!collections?.work) {
    throw new Error('createNotifier: collections.work is required (pass COLLECTIONS from agent/storage/collections.mjs)');
  }

  const log = deps.logger || ((level, msg) => console.log(`[notifications] ${level}: ${msg}`));
  const isoNow = () => new Date(now()).toISOString();

  /**
   * Makes notification text ready to deliver. Types with model rules are rewritten; the rest, and any
   * failed or empty rewrite, return `rawText` as is.
   *
   * @param {string} type     a summary type: approval_request, completion, status_update, error_report
   * @param {string} rawText  the text to fall back to
   * @param {object} [context] type-specific context: steps, title, processName, customMessage, rawText
   * @returns {Promise<string>}
   */
  async function summarizeForDelivery(type, rawText, context = {}) {
    const typeConfig = SUMMARY_TYPES[type];
    if (!typeConfig || !typeConfig.llm) return rawText;

    const maxChars = typeConfig.maxChars || 1500;
    const promptText = typeConfig.prompt({ ...context, maxChars });

    try {
      const instruction = 'You are a notification writer. Return ONLY the notification text — no JSON, no markdown fences, no preamble.';
      const content = await vertexText.transform(promptText, instruction, { maxTokens: 2048 });
      if (content && content.length > 0) {
        // The model sometimes wraps its answer in a fence anyway.
        const cleaned = content.replace(/^```[a-z]*\s*/gi, '').replace(/\s*```$/g, '').trim();
        log('INFO', `summarizeForDelivery(${type}): ${cleaned.length} chars (from ${JSON.stringify(context.steps || []).length} chars raw)`);
        return cleaned.substring(0, maxChars);
      }
      log('WARN', `summarizeForDelivery(${type}): empty response, falling back to raw`);
      return rawText;
    } catch (e) {
      log('WARN', `summarizeForDelivery(${type}) error: ${e.message}, falling back to raw`);
      return rawText;
    }
  }

  /**
   * The message to answer, out of an intake's composite text. The ears frame an intake as earlier
   * chat context followed by "[Current message - respond to this]" and the new message; text without
   * the marker is returned whole.
   *
   * @param {string} intakeText
   * @returns {string}
   */
  function extractCurrentMessage(intakeText) {
    if (!intakeText) return intakeText || '';
    const idx = intakeText.indexOf(CURRENT_MESSAGE_MARKER);
    if (idx !== -1) return intakeText.substring(idx + CURRENT_MESSAGE_MARKER.length).trim();
    return intakeText;
  }

  /**
   * Writes a status update as a completed task envelope under `envelopeId`, addressed like its
   * parent, with delivery pending. The mouth picks it up and sends it.
   *
   * @param {string} envelopeId the envelope the update is about
   * @param {string} message    human-readable status
   */
  async function writeStatusUpdate(envelopeId, message) {
    let parentMeta = {};
    let parentChannel = 'system';
    let deliveryAddr = null;
    try {
      const parent = firestoreRead ? await firestoreRead(collections.work, envelopeId) : null;
      if (parent) {
        parentMeta = parent.source_meta || {};
        parentChannel = parent.source_channel || 'system';
        if (addressFromMeta) deliveryAddr = addressFromMeta(parentMeta, parentChannel);
      }
    } catch (e) {
      log('WARN', `writeStatusUpdate: failed to read parent ${envelopeId}: ${e.message}`);
    }

    const statusId = generateId('status');
    const at = isoNow();
    await firestoreWrite(collections.work, statusId, {
      id: statusId,
      type: 'T',
      parent_id: envelopeId,
      status: 'complete',
      intent: 'notification',
      instruction: 'Status update',
      output: message,
      delivery_status: 'pending',
      delivery_address: deliveryAddr,
      source_channel: parentChannel,
      source_meta: parentMeta,
      created_at: at,
      started_at: at,
      completed_at: at,
      updated_at: at,
      children: [],
      accept_criteria: null,
      context_summary: null,
      context_forward: null,
      error: null,
      iteration: 0,
    });
    log('INFO', `Status update written: ${statusId} — ${String(message).substring(0, 80)}`);
  }

  /**
   * A brief acknowledgment for incoming work, in the agent's voice, aware of what it is already
   * working on so a follow-up reads as continuity. Falls back to a generic acknowledgment on any
   * failure.
   *
   * @param {string} intakeText
   * @param {Array}  activeEnvelopes   active or blocked envelope summaries ({ status, instruction })
   * @param {Array}  [recentMissions]  recently finished missions ({ instruction, status, project_id })
   * @returns {Promise<string>} one sentence, under 200 characters
   */
  async function generateAck(intakeText, activeEnvelopes, recentMissions = []) {
    try {
      const identity = config.identityPath ? (cachedReadFile(config.identityPath) || '').substring(0, 500) : '';

      let workContext = '';
      if (activeEnvelopes && activeEnvelopes.length > 0) {
        const summaries = activeEnvelopes.map((e) =>
          `${e.status === 'blocked' ? '🚫 BLOCKED' : '🔵 ACTIVE'}: "${(e.instruction || '').substring(0, 80)}"`,
        ).join('\n');
        workContext = `\nYour current work:\n${summaries}`;
      }

      let recentContext = '';
      if (recentMissions.length > 0) {
        const summaries = recentMissions.map((m) =>
          `• "${m.instruction}" → ${m.status}${m.project_id ? ` [${m.project_id}]` : ''}`,
        ).join('\n');
        recentContext = `\nYour recent work:\n${summaries}`;
      }

      let projectContext = '';
      const projects = getProjects() || {};
      if (Object.keys(projects).length > 0) {
        const projectNames = Object.values(projects)
          .map((p) => `• ${p.name || p.id}: ${(p.description || '').substring(0, 80)}`)
          .join('\n');
        projectContext = `\nProjects you work on:\n${projectNames}`;
      }

      const ackMessage = extractCurrentMessage(intakeText);

      const systemPrompt = [
        'You are acknowledging an incoming message from someone you work with. Write a BRIEF (1 sentence, max 20 words) acknowledgment. Be natural, warm, and varied — never robotic. Reference what the person asked about if you can.',
        workContext,
        recentContext,
        projectContext,
        '\nIMPORTANT: If the user\'s message relates to your recent or current work, acknowledge the CONTINUITY — say something like "Picking back up on the sync pipeline" or "Taking another look at this." Don\'t treat it as brand new if you recognize it from recent history.',
        `\nYour personality:\n${identity || 'Helpful and professional.'}`,
      ].filter(Boolean).join('\n');

      const { url, token, route } = getGatewayConfig();
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: route,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${BRAIN_MARKER}\nAcknowledge this message briefly:\n"${ackMessage.substring(0, 300)}"` },
          ],
          max_tokens: 60,
          temperature: 0.9,
        }),
        signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
      });

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content && content.length > 2 && content.length < 200) return content;
      }
    } catch (e) {
      log('DEBUG', `ACK generation failed (using fallback): ${e.message}`);
    }
    return ACK_FALLBACKS[Math.floor(Math.random() * ACK_FALLBACKS.length)];
  }

  return { summarizeForDelivery, extractCurrentMessage, writeStatusUpdate, generateAck };
}
