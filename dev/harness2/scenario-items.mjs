// dev/harness2/scenario-items.mjs: the canary's scenario batteries, the scripts scenarios.mjs drives a
// live instance through over hours or days (docs/plan/MODULAR_LOOPS.md, 2.6). Lab only: nothing here
// is in install/manifest.txt.
//
// A scenario is a short conversation with the agent spread over time: steps sent as dashboard
// messages, each in a thread of its own, `at` minutes into the run (each gap counted from when the
// step before it ended, so a slow mission never shortens the next wait). A `teach` step sets
// the scenario up (it tells the agent something) and must simply finish; an `ask` step is the check,
// and its answer must name every value its `expect` lists. Each run draws fresh values (`values`, from
// a seed the run's id gives), so no run can pass on what an earlier one taught: the canary's memory
// fills with facts about many made-up services, which is the noise a real agent's memory holds.
//
// The memory battery checks the memory path end to end, from a fact told in chat to the answer that
// needs it: the mission line and lessons a mission leaves, the nightly consolidation into Core
// Memory, and recall. A failed `ask` with `recall: true` is what scenario-harvest.mjs turns into a
// memory bench item. This file holds definitions only: scenarios.mjs runs them, and the tests in
// tests/dev/harness2/scenarios.test.mjs check that every scenario's requests and checks fit its values.

const HOUR = 60;
const DAY = 24 * HOUR;

/** A small, seeded generator (mulberry32), so a run's values follow from its id. */
export function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJECTIVES = ['Amber', 'Birch', 'Cinder', 'Dune', 'Ember', 'Fern', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Kestrel',
  'Lumen', 'Maple', 'Nimbus', 'Onyx', 'Pebble', 'Quartz', 'Russet', 'Saffron', 'Tundra', 'Umber', 'Velvet', 'Willow', 'Zephyr'];
const NOUNS = ['Heron', 'Lantern', 'Comet', 'Badger', 'Falcon', 'Otter', 'Beacon', 'Raven', 'Marten', 'Puffin', 'Kite', 'Lynx',
  'Osprey', 'Wren', 'Bison', 'Gecko'];
const FIRST_NAMES = ['Odile', 'Tomasz', 'Ines', 'Kwame', 'Saanvi', 'Bjorn', 'Leilani', 'Mateo', 'Yuki', 'Farah', 'Dmitri', 'Ngozi',
  'Pavel', 'Aroha', 'Cyrus', 'Elif'];
const LAST_NAMES = ['Marchetti', 'Okafor', 'Lindqvist', 'Haddad', 'Kowalczyk', 'Nakamura', 'Ferreira', 'Abernathy', 'Sato',
  'Delacroix', 'Mensah', 'Ivanova', 'Quispe', 'Varga', 'Thorne', 'Castell'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** The values one run of any memory scenario uses: a made-up service and the facts about it. */
export function memoryValues(seed) {
  const rnd = seededRandom(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const number = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const service = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
  const slug = service.toLowerCase().replace(/\s+/g, '-');
  const person = () => ({ first: pick(FIRST_NAMES), last: pick(LAST_NAMES) });
  const owner = person();
  let next = person();
  // Two different people share neither name, so a check for the newer one never passes on the older.
  while (next.first === owner.first || next.last === owner.last) next = person();
  return {
    service,
    slug,
    database: `${slug}-stg-${number(1000, 9999)}`,
    dashboard: `${slug}-golden-${number(10, 99)}`,
    bucket: `${slug}-backups-${number(100, 999)}`,
    person: owner,
    other: next,
    weekday: pick(WEEKDAYS),
    hour: number(9, 17),
    minutes: number(12, 95),
    days: number(14, 120),
    version: `${number(2, 9)}.${number(0, 19)}`,
  };
}

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const name = (p) => `${p.first} ${p.last}`;
/** A person is named when the answer gives either name. */
const personRe = (p) => `\\b(${escape(p.first)}|${escape(p.last)})\\b`;
/** A number on its own, not part of a longer one. */
const numberRe = (n) => `(^|[^0-9])${n}([^0-9]|$)`;

/** The names a memory item's checks carry (bench-items.mjs RECALL_KEEPS), so a harvested item reads like a written one. */
export const KEEPS = Object.freeze({
  turns: 'keeps the fact the request turns on',
  other: 'keeps the other fact the request needs',
  newer: 'keeps the newer of two facts that disagree',
});

const teach = (id, at, text) => ({ id, kind: 'teach', at, text });
const ask = (id, at, text, expect) => ({ id, kind: 'ask', at, recall: true, text, expect });

export const MEMORY_SCENARIOS = Object.freeze([
  {
    id: 'mem-across-threads',
    battery: 'memory',
    about: 'three facts told in one thread, asked for in another ten minutes later',
    everyHours: 24,
    values: memoryValues,
    steps: [
      teach('teach', 0, (v) => `For future reference, three facts about the ${v.service} service: its staging database is ${v.database}; `
        + `this month's on-call engineer for it is ${name(v.person)}; and deploys to it are frozen every ${v.weekday} from ${v.hour}:00 UTC. `
        + 'Nothing to do now, just keep these in mind.'),
      ask('ask', 10, (v) => `Remind me: for the ${v.service} service, what is the staging database called, who is on call this month, and when are its deploys frozen?`,
        (v) => [
          { name: KEEPS.turns, source: escape(v.database) },
          { name: KEEPS.other, source: personRe(v.person) },
          { name: KEEPS.other, source: escape(v.weekday) },
        ]),
    ],
  },
  {
    id: 'mem-next-day',
    battery: 'memory',
    about: 'three facts asked for a day later, after a nightly consolidation',
    everyHours: 24,
    values: memoryValues,
    steps: [
      teach('teach', 0, (v) => `Please remember this for later: the ${v.service} service's metrics dashboard is called ${v.dashboard}, `
        + `its error budget is ${v.minutes} minutes a month, and ${name(v.person)} approves changes to its alerts. No action needed now.`),
      ask('ask', 26 * HOUR, (v) => `What is the ${v.service} service's error budget, what is its metrics dashboard called, and who approves changes to its alerts?`,
        (v) => [
          { name: KEEPS.turns, source: numberRe(v.minutes) },
          { name: KEEPS.other, source: escape(v.dashboard) },
          { name: KEEPS.other, source: personRe(v.person) },
        ]),
    ],
  },
  {
    id: 'mem-changed-fact',
    battery: 'memory',
    about: "a fact that changed ten minutes after it was told, asked for a day later",
    everyHours: 24,
    values: memoryValues,
    steps: [
      teach('teach', 0, (v) => `For the record: ${name(v.person)} owns the ${v.service} service and decides what goes into its releases. Nothing to do now.`),
      teach('change', 10, (v) => `An update about the ${v.service} service: ${name(v.person)} has moved to another team, so ${name(v.other)} owns it from now on `
        + 'and decides what goes into its releases. Nothing else to do.'),
      ask('ask', 26 * HOUR, (v) => `Who owns the ${v.service} service now, and decides what goes into its releases?`,
        (v) => [{ name: KEEPS.newer, source: personRe(v.other) }]),
    ],
  },
  {
    id: 'mem-applied',
    battery: 'memory',
    about: 'a convention told one day, needed by a task the next that does not mention it',
    everyHours: 24,
    values: memoryValues,
    steps: [
      teach('teach', 0, (v) => `A convention to keep: release notes for the ${v.service} service go in docs/${v.slug}-releases.md, and `
        + `${name(v.person)} must sign them off before they are published. Nothing to do now.`),
      ask('ask', 26 * HOUR, (v) => `Draft a two-line release note for version ${v.version} of the ${v.service} service (it fixes a login timeout). `
        + "Don't publish or save anything: just show me the draft, the file it belongs in, and who has to sign it off.",
      (v) => [
        { name: KEEPS.turns, source: escape(`${v.slug}-releases.md`) },
        { name: KEEPS.other, source: personRe(v.person) },
      ]),
    ],
  },
  {
    id: 'mem-week',
    battery: 'memory',
    about: 'two facts asked for a week later',
    everyHours: 72,
    values: memoryValues,
    steps: [
      teach('teach', 0, (v) => `Please remember: the ${v.service} service's backups are kept for ${v.days} days, in the ${v.bucket} bucket. Nothing to do now.`),
      ask('ask', 7 * DAY + HOUR, (v) => `How long are the ${v.service} service's backups kept, and in which bucket?`,
        (v) => [
          { name: KEEPS.turns, source: numberRe(v.days) },
          { name: KEEPS.other, source: escape(v.bucket) },
        ]),
    ],
  },
]);

/** Every battery by name. */
export const BATTERIES = Object.freeze({ memory: MEMORY_SCENARIOS });
