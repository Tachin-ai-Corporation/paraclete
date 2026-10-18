// tests/content/command-flags.test.mjs: agent-facing text uses commands as they really are. Skill
// procedures, role prompts and playbooks are written separately from the commands they name, so a flag
// can drift: a procedure telling the agent to run `docs-comment --anchor` when the command takes
// `--quote` sends it into an error loop. For every skill command with a USAGE string, every flag that
// text writes after the command's name, on the same line, must appear in that USAGE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFiles, repoRoot } from '../repo/repo-files.mjs';

const files = repoFiles();

/** Every skill command shipped as a file in a skill package: name → path. */
function skillCommands() {
  const commands = new Map();
  for (const path of files.filter((f) => /(^skills|^roles\/[^/]+\/skills)\/[^/]+\/skill\.json$/.test(f))) {
    const dir = path.slice(0, -'skill.json'.length);
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
    for (const name of manifest.commands || []) {
      if (files.includes(`${dir}${name}.mjs`)) commands.set(name, `${dir}${name}.mjs`);
    }
  }
  return commands;
}

/** The flags a USAGE string names, e.g. `--mission`. */
const flagsOf = (usage) => new Set(String(usage).match(/--[a-z][a-z0-9-]*/g) || []);

/** Agent-facing text: skills' SKILL.md, and everything in a role package but its JSON settings. */
const texts = files.filter((f) => /\.md$/.test(f) && (/^skills\//.test(f) || /^roles\//.test(f) || /^prompts\//.test(f)))
  .concat(files.filter((f) => /^roles\/[^/]+\/processes\/.+\.json$/.test(f) || /^roles\/[^/]+\/responsibilities\.json$/.test(f)));

test('every flag agent-facing text gives a skill command is one the command takes', async () => {
  const commands = skillCommands();
  assert.ok(commands.size > 20, 'found the skill commands');
  const usages = new Map();
  for (const [name, path] of commands) {
    const mod = await import(pathToFileURL(join(repoRoot, path)).href);
    if (typeof mod.USAGE === 'string') usages.set(name, flagsOf(mod.USAGE));
  }
  const wrong = [];
  for (const path of texts) {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    for (const [name, flags] of usages) {
      // The command's name, then the rest of that line up to a closing backtick or quote.
      const pattern = new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])([^\\n\`"]*)`, 'g');
      for (const match of text.matchAll(pattern)) {
        for (const flag of match[1].match(/--[a-z][a-z0-9-]*/g) || []) {
          if (!flags.has(flag)) wrong.push(`${path}: ${name} ${flag}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], [], 'flags these commands do not take');
});
