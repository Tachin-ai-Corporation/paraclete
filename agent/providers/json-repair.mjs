// agent/providers/json-repair.mjs: gets a JSON object out of a model's text response, and repairs JSON
// the model cut off at its output limit. Pure functions with no dependencies. It does not check the
// object against a schema; vertex-text.mjs does that. Used by vertex-text.mjs and by the brain when it
// reads an organ's decision.

const warn = (...args) => console.warn('[json-repair]', ...args);

/**
 * Parses a model's raw response into a JSON object. Tries, in order: the first balanced object that
 * carries an `action`, the widest {...} span, a truncation repair of that span, a truncation repair of
 * the whole text, and the whole text as JSON. Markdown fences and a trailing "Action:" block are
 * stripped first.
 *
 * Never throws. Anything that isn't a string (an empty model response arrives as null or undefined)
 * is treated as empty text.
 *
 * @param {string} raw raw model response text
 * @returns {object} the parsed object, or { error: 'parse_failed', raw: <first 500 chars> }
 */
export function parseJsonResponse(raw) {
  const text = typeof raw === 'string' ? raw : '';

  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  // Older prompts asked for an "Action:" line after the JSON; models still add one sometimes.
  cleaned = cleaned.replace(/\nAction:.*$/s, '');

  const extracted = extractBalancedJson(cleaned);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (parsed.action) return parsed;
    } catch {}
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      warn(`JSON parse failed (greedy): ${e.message}`);
      const repaired = repairTruncatedJson(jsonMatch[0]);
      if (repaired) {
        warn('JSON repair succeeded: recovered a truncated response');
        return repaired;
      }
    }
  }

  // Truncated JSON that never reached a closing brace.
  const repaired = repairTruncatedJson(cleaned);
  if (repaired) {
    warn('JSON repair succeeded on raw input: recovered a truncated response');
    return repaired;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    warn(`Could not parse response: ${text.substring(0, 300)}`);
    return { error: 'parse_failed', raw: text.substring(0, 500) };
  }
}

/** Walks `json` and returns the delimiters still open at its end, and whether a string is open. */
function scanDelimiters(json) {
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
  }
  return { stack, inString };
}

/**
 * Repairs JSON a model cut off at its output token limit. Closes an open string (or drops the
 * half-written last field), then closes every open array and object. The result is missing whatever
 * the model never wrote, but keeps the action and checkpoints it did write, which beats a parse
 * failure.
 *
 * Only an object with an `action` or a `classification` counts as recovered: anything else is too
 * damaged to act on.
 *
 * @param {string} text possibly truncated JSON
 * @returns {object|null} the repaired object, or null when there was nothing to repair or it failed
 */
export function repairTruncatedJson(text) {
  if (!text || text.length < 10) return null;

  const start = text.indexOf('{');
  if (start === -1) return null;
  let json = text.substring(start);

  const first = scanDelimiters(json);
  if (first.stack.length === 0 && !first.inString) return null;

  if (first.inString) {
    // The cut most likely fell mid-value. When a comma closes the last complete field nearby, drop
    // the partial field; otherwise just close the string.
    const lastComma = json.lastIndexOf(',');
    const lastColon = json.lastIndexOf(':');
    if (lastComma > lastColon && lastComma > json.length - 500) {
      json = json.substring(0, lastComma);
    } else {
      json += '"';
    }
  }

  const { stack } = scanDelimiters(json);
  let suffix = '';
  while (stack.length > 0) suffix += stack.pop() === '{' ? '}' : ']';
  if (!suffix) return null;

  try {
    const parsed = JSON.parse(json + suffix);
    if (parsed.action || parsed.classification) {
      warn(`repairTruncatedJson: closed ${suffix.length} delimiters, recovered action=${parsed.action || parsed.classification}`);
      return parsed;
    }
  } catch (e) {
    warn(`repairTruncatedJson: repair failed: ${e.message}`);
  }
  return null;
}

/**
 * Returns the first balanced {...} span in `text`, tracking strings and escapes so braces inside
 * string values don't count.
 *
 * @param {string} text
 * @returns {string|null} the span, or null when there is no complete object
 */
export function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null;
}
