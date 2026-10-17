// agent/services/ears/preprocess.mjs: repairs a Google Chat message that Chat's markdown rendering
// mangled (underscores eaten as italics, which breaks file ids, paths and names) before the brain
// reads it, through one utility-model call with preprocess-prompt.md. It never blocks a message: a
// failed, unparseable or unneeded repair passes the text through unchanged. Used by inbound.mjs, for
// Chat messages only; dashboard text arrives as typed.

import { parseJsonResponse } from '../../providers/json-repair.mjs';

/** Text worth a repair call: long, or several lines. Short direct mentions pass straight through. */
export function needsPreprocess(text) {
  return Boolean(text) && (text.length > 500 || /\n.*\n.*\n/s.test(text));
}

/**
 * Creates the preprocessor.
 *
 * @param {object}   options
 * @param {boolean}  options.enabled       ears.preprocess.enabled
 * @param {string}   options.prompt        the repair instruction (preprocess-prompt.md)
 * @param {Function} options.transform     vertex-text transform(text, instruction, opts) => string|null
 * @param {object}   [options.callOptions] maxTokens, temperature, disableThinking for the call
 * @param {Function} [options.log]         (level, message, fields) logger
 * @param {Function} [options.now]         clock in milliseconds (injectable for tests)
 * @returns {(text: string) => Promise<string>} the text to classify
 */
export function createPreprocessor({ enabled, prompt, transform, callOptions = {}, log = () => {}, now = Date.now }) {
  const active = Boolean(enabled && prompt && transform);

  return async function preprocess(text) {
    if (!active || !needsPreprocess(text)) return text;
    const started = now();
    try {
      const raw = await transform(text, prompt, callOptions);
      if (raw == null) {
        log('WARN', 'preprocess: the utility model did not answer; passing the message through', {});
        return text;
      }
      const result = parseJsonResponse(raw);
      const repairs = Array.isArray(result.repairs) ? result.repairs : [];
      const cleaned = typeof result.cleaned === 'string' && result.cleaned.trim() ? result.cleaned : null;
      const elapsedMs = now() - started;
      if (repairs.length > 0 && cleaned) {
        // What came in and what goes out, so a bad repair can be traced to its message.
        log('INFO', 'preprocess repaired a message', {
          repairs, confidence: result.confidence || 'unknown', elapsed_ms: elapsedMs,
          original: text.slice(0, 500), cleaned: cleaned.slice(0, 500),
        });
        return cleaned;
      }
      log('INFO', 'preprocess: no repair needed', { confidence: result.confidence || 'unknown', elapsed_ms: elapsedMs });
      return text;
    } catch (err) {
      log('WARN', 'preprocess failed; passing the message through', { error: err.message });
      return text;
    }
  };
}
