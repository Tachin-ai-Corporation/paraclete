// agent/context/skill-requirements.mjs: what a skill package may require of its instance, and whether
// this instance has it. A skill.json may carry `"requires": ["workspace"]`: its commands need the
// agent's own Google Workspace account, which only Workspace roles have. On an instance without it, the
// gateway's skill catalog (agent/gateway/skill-catalog.mjs) leaves the skill out, so no organ is told
// about commands that cannot work, and control's `skills` view (agent/services/control/introspection.mjs)
// shows it as unavailable with the reason. tests/content/packages.test.mjs accepts only the
// requirements named here.
//
// It reads the instance record it is given and nothing else.

/**
 * Every requirement a skill may name: how to tell the instance meets it, and how a person is told it
 * does not.
 */
export const SKILL_REQUIREMENTS = Object.freeze({
  workspace: Object.freeze({
    met: (instance) => Boolean(instance?.workspace?.account),
    missing: 'needs a Workspace account',
  }),
});

/**
 * A skill.json's `requires`, as a list of strings: an array as written, one string as a list of one,
 * anything else as none.
 *
 * @param {object} manifest a parsed skill.json
 * @returns {string[]}
 */
export function skillRequires(manifest) {
  const r = manifest?.requires;
  if (Array.isArray(r)) return r.map(String);
  return typeof r === 'string' && r.trim() ? [r.trim()] : [];
}

/**
 * Why a skill cannot work on this instance, or null when it can. A requirement this code does not know
 * is never met: a skill naming one is left out rather than shown with commands that may not work.
 *
 * @param {string[]} requires from skillRequires()
 * @param {object|null} instance the instance record (config/instance.mjs loadInstance)
 * @returns {string|null} e.g. 'needs a Workspace account'
 */
export function unavailableReason(requires, instance) {
  const reasons = [];
  for (const name of requires || []) {
    const requirement = Object.hasOwn(SKILL_REQUIREMENTS, name) ? SKILL_REQUIREMENTS[name] : null;
    if (!requirement) reasons.push(`needs '${name}', which this instance does not know`);
    else if (!requirement.met(instance)) reasons.push(requirement.missing);
  }
  return reasons.length ? [...new Set(reasons)].join('; ') : null;
}
