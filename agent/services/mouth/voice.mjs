// agent/services/mouth/voice.mjs: turns what the brain produced into what the agent says, through
// one utility-model call with voice-prompt.md: first person, the substance kept exactly, internal
// framing stripped, in the tone of the recent conversation. The same call decides whether the text
// is pure internal noise to suppress. Sending is outbound.mjs. Used by delivery.mjs.
//
// The voice never loses a message. With the model off, unavailable or unparseable, the brain's text
// goes out as written; a voiced answer with no text gets one plain rephrase call, then the raw text.

import { parseJsonResponse } from '../../providers/json-repair.mjs';

/** Below this, a rephrase is treated as empty and the raw text goes out instead. */
const MIN_REPHRASE_CHARS = 10;

/**
 * Creates the voice.
 *
 * @param {object}   deps
 * @param {Function} deps.transform      vertex-text transform(text, instruction, opts) => string|null
 * @param {string}   deps.prompt         voice-prompt.md, with {agent_name} placeholders
 * @param {string}   deps.agentName
 * @param {boolean}  [deps.enabled=true] mouth.llm_enabled
 * @param {object}   [deps.callOptions]  maxTokens, temperature, disableThinking
 * @param {Function} [deps.log]          (level, message, fields) logger
 * @returns {(input: {rawText: string, question?: string, contextHint?: string, convoTail?: string}) =>
 *   Promise<{action: 'deliver'|'suppress', text: string, voiced: string}>} `voiced` says how the text
 *   was made: yes, retry, raw (model off), unavailable, unparsed, passthrough_identical,
 *   passthrough_empty, or suppressed
 */
export function createVoice({ transform, prompt, agentName, enabled = true, callOptions = {}, log = () => {} }) {
  const instruction = String(prompt || '').replaceAll('{agent_name}', agentName);
  const rephraseInstruction = `You are ${agentName}. Rephrase the following for chat. Keep ALL factual content, links, and data intact. Just make it sound like you (${agentName}) are talking naturally to a colleague. Return ONLY the rephrased text, no JSON.`;

  return async function voice({ rawText, question = '', contextHint = '', convoTail = '' }) {
    if (!enabled || !instruction) return { action: 'deliver', text: rawText, voiced: 'raw' };

    const parts = [];
    if (convoTail) parts.push(`RECENT CONVERSATION (historical turns for tone and topic context):\n${convoTail}`);
    if (contextHint) parts.push(`DELIVERY GUIDANCE (shape the tone; do NOT quote this line):\n${contextHint}`);
    if (question) parts.push(`CONTEXT (what the person asked, or what triggered this):\n${question}`);
    parts.push(`BRAIN OUTPUT:\n${rawText}`);

    const result = await transform(parts.join('\n\n'), instruction, callOptions);
    if (result == null) return { action: 'deliver', text: rawText, voiced: 'unavailable' };
    const parsed = parseJsonResponse(result);
    if (parsed.error === 'parse_failed') return { action: 'deliver', text: rawText, voiced: 'unparsed' };

    // An escalation marker in the brain's text always reaches a person, whatever the model decided.
    const escalate = /\[ESCALATE\]/i.test(rawText);
    if (parsed.action === 'suppress' && !escalate) return { action: 'suppress', text: '', voiced: 'suppressed' };

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (text) {
      return { action: 'deliver', text, voiced: text === rawText ? 'passthrough_identical' : 'yes' };
    }
    log('WARN', 'voicing returned no text; asking for a plain rephrase');
    const retry = ((await transform(rawText, rephraseInstruction, callOptions)) || '').trim();
    return retry.length > MIN_REPHRASE_CHARS
      ? { action: 'deliver', text: retry, voiced: 'retry' }
      : { action: 'deliver', text: rawText, voiced: 'passthrough_empty' };
  };
}
