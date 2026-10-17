// agent/providers/to-str.mjs: turns any value into a string without throwing. It does not trim,
// format or truncate; callers do that. Used wherever an envelope field or a model's output of unknown
// shape becomes prompt text, for example by context/compaction.mjs.

/**
 * Converts a value to a string. Strings pass through and null or undefined become ''. An object
 * gives its `instruction` or `text` field first, because those are the fields that carry the words in
 * envelopes, tasks and step results, and falls back to JSON. Anything else goes through String().
 *
 * @param {*} v
 * @returns {string}
 */
export function toStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return typeof v === 'object' ? (v.instruction || v.text || JSON.stringify(v)) : String(v);
}
