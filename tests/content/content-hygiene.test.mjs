// tests/content/content-hygiene.test.mjs: the agent-facing text describes one agent. No prompt, skill,
// role, process or responsibility file mentions handing work to other agents, teammates, a group of
// agents, a controlling agent above this one, or per-agent specialties; none points at the predecessor's
// install path, cites a rule by an internal canon id, or tells the agent to edit a prompt file. Shape is
// checked by packages.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFiles, readRepoFile, isText } from '../repo/repo-files.mjs';

const CONTENT = /^(prompts|skills|roles)\//;
const files = repoFiles().filter((path) => CONTENT.test(path) && isText(path));

// Some of these words are also on developers' private denylists (see DEVELOPING.md section 6), so
// they are assembled from pieces here rather than written whole in this file.
const FL = ['fl', 'eet'].join('');
const PR = ['pri', 'me'].join('');
const CK = ['core', 'kit'].join('');

/** A banned term: its pattern, and why the product never says it. */
const BANNED = [
  { pattern: /\bdelegat(e|es|ed|ing|ion|ions|or|ors)\b/i, why: 'there is no other agent to hand work to' },
  { pattern: /\bteammates?\b/i, why: 'the agent has no teammates' },
  { pattern: new RegExp(`\\b${FL}s?\\b`, 'i'), why: 'one project holds one agent' },
  { pattern: new RegExp(`\\b${PR}s?\\b`, 'i'), why: 'no agent sits above this one' },
  { pattern: /\bspecialt(y|ies)\b/i, why: 'an instance has a role, not a specialty' },
  { pattern: new RegExp(`/opt/${CK}|\\b${CK}\\b`, 'i'), why: "the install root is /opt/paraclete" },
  { pattern: /\bSOUL(_APPEND|\.base)?\.md\b|\bIDENTITY\.md\b/, why: 'organ prompts are prompts/<organ>.md, read-only to the agent' },
  { pattern: /\b[BC]-\d{1,2}\b/, why: 'rules are stated in plain words, not cited by canon id' },
  { pattern: /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/, why: 'nothing fills template placeholders into these files' },
];

// "Domain-wide delegation" is the Google Workspace mechanism a Workspace role's account rests on; it
// is not about agents handing work to each other.
const ALLOWED_PHRASES = [/domain-wide delegation/gi];

/** Text with the allowed phrases taken out. */
function withoutAllowed(text) {
  return ALLOWED_PHRASES.reduce((t, phrase) => t.replace(phrase, ''), text);
}

test('the banned patterns catch what they are for, and only that', () => {
  const caught = ['Delegate it to them', 'ask a teammate', `the ${FL} agents`, `report to ${PR}`,
    'its specialty', `/opt/${CK}/bin`, 'edit SOUL.md', 'as B-28 says', '{{AGENT_NAME}}'];
  for (const sample of caught) assert.ok(BANNED.some(({ pattern }) => pattern.test(sample)), sample);
  const clean = ['the primary key', 'a fleeting look', 'set up domain-wide delegation in the Admin console',
    'specialist tools', '{ a: { b }}'];
  for (const sample of clean) {
    assert.ok(!BANNED.some(({ pattern }) => pattern.test(withoutAllowed(sample))), sample);
  }
});

test('there is agent-facing content to check', () => {
  assert.ok(files.some((f) => f.startsWith('prompts/')), 'no prompts found');
  assert.ok(files.some((f) => f.startsWith('skills/')), 'no skills found');
  assert.ok(files.some((f) => f.startsWith('roles/')), 'no roles found');
});

test('agent-facing text describes one agent, in its own terms', () => {
  const found = [];
  for (const path of files) {
    const lines = withoutAllowed(readRepoFile(path)).split('\n');
    for (const { pattern, why } of BANNED) {
      lines.forEach((line, i) => {
        const match = pattern.exec(line);
        if (match) found.push(`${path}:${i + 1}: '${match[0]}' (${why})`);
      });
    }
  }
  assert.deepEqual(found, []);
});

test('no agent-facing text tells the agent to edit its own prompts', () => {
  const found = [];
  for (const path of files) {
    const text = readRepoFile(path);
    for (const m of text.matchAll(/(edit|update|rewrite|modify|change)\s+(your|the)\s+(own\s+)?(organ\s+)?prompt files?/gi)) {
      found.push(`${path}: '${m[0]}'`);
    }
  }
  assert.deepEqual(found, []);
});
