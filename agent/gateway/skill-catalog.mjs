// agent/gateway/skill-catalog.mjs: the skill index a tool-using organ sees: one line per skill saying
// when to use it and where its SKILL.md is, so the organ reads the procedure before running a command
// instead of guessing its syntax. Built from the skill directories the caller passes (the base skills,
// the generic role's, the chosen role's, and any the agent wrote); it reads skill.json files and
// nothing else. The gateway service builds the text once at startup and passes it to every turn.
//
// The text is part of the cached system prefix, so it is byte-stable: directories in the order given,
// skills sorted by directory name.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Organs that only plan. A skill used by nothing else is left out: a tool-using organ never reads it. */
export const PLANNING_ORGANS = Object.freeze(['cortex', 'prefrontal']);

/**
 * The skills found in the directories, in catalog order. A skill is a subdirectory with a skill.json;
 * an unreadable or invalid one is skipped.
 *
 * @param {string[]} skillDirs
 * @returns {Array<{id: string, name: string, whenToUse: string, organs: string[], path: string}>}
 */
export function findSkills(skillDirs) {
  const entries = [];
  for (const dir of skillDirs || []) {
    if (!dir || !existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      const skillDir = join(dir, name);
      const manifestPath = join(skillDir, 'skill.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const organs = Array.isArray(m.organs) ? m.organs : (m.organs ? [m.organs] : []);
        entries.push({
          id: m.id || name,
          name: m.name || m.id || name,
          whenToUse: m.when_to_use || m.description || '',
          organs,
          path: join(skillDir, 'SKILL.md'),
        });
      } catch { /* an invalid skill.json leaves that skill out */ }
    }
  }
  return entries;
}

/**
 * The skill index text, ready to append to a system prompt, or '' when there are no skills. Skills
 * whose `organs` are all planning organs are left out; a skill that names no organs is in.
 *
 * @param {string[]} skillDirs e.g. [skills/, roles/generic/skills/, roles/<role>/skills/, <agent-written skills>]
 * @returns {string}
 */
export function buildSkillCatalog(skillDirs) {
  const entries = findSkills(skillDirs)
    .filter((e) => !(e.organs.length > 0 && e.organs.every((o) => PLANNING_ORGANS.includes(o))));
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.name} (${e.id}): ${e.whenToUse}\n  → readFile ${e.path}`);
  return `\n\n## Available Skills\nBefore using any command tool, read the relevant SKILL.md:\n${lines.join('\n')}\n\nDo NOT guess skill paths. Only the paths listed above exist.\n`;
}
