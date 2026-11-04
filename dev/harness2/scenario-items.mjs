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
// Memory, and recall. A failed `ask` with `harvest: 'recall'` is what scenario-harvest.mjs turns into
// a memory bench item.
//
// The verification battery asks for work whose obvious method gets the answer wrong, and whose right
// answer code knows: the work must run as a mission, with checkpoints the cerebellum (the organ that
// verifies each checkpoint against its acceptance criteria) judges. A failed step with
// `harvest: 'verification'` is what verification-harvest.mjs turns into a cerebellum bench item,
// named for the step's `verify.kind`, when a checkpoint passed the wrong work.
//
// This file holds definitions only: scenarios.mjs runs them, and the tests in
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
const ask = (id, at, text, expect) => ({ id, kind: 'ask', at, harvest: 'recall', text, expect });

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

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/** The Sunday a month's `nth` Sunday falls on (1-based), as a UTC day number. Pure. */
function nthSunday(year, month, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return Date.UTC(year, month - 1, 1 + ((7 - first) % 7) + (nth - 1) * 7);
}

/**
 * New York's offset from UTC in hours on a day, at a time of day well clear of 02:00: daylight saving
 * time (UTC-4) from the second Sunday of March to the first Sunday of November, standard (UTC-5)
 * otherwise. Pure.
 */
export function newYorkOffset(day) {
  const t = Date.parse(`${day}T12:00:00Z`);
  const year = new Date(t).getUTCFullYear();
  return t >= nthSunday(year, 3, 2) && t < nthSunday(year, 11, 1) ? -4 : -5;
}

/** A total in cents as the answer writes it, a thousands separator optional. */
const moneyRe = (cents) => {
  const whole = String(Math.floor(cents / 100));
  const grouped = whole.length > 3 ? `${whole.slice(0, -3)}[,\\s]?${whole.slice(-3)}` : whole;
  return `(^|[^0-9.,])${grouped}\\.${pad(cents % 100)}([^0-9]|$)`;
};
/** A count on its own: not part of a longer number, nor a day or month inside a date. */
const countRe = (n) => `(?<![0-9])(?<![0-9]-)${n}(?![0-9])(?!-[0-9])`;
/** A decimal on its own, not part of a longer number. */
const decimalRe = (text) => `(^|[^0-9.])${escape(text)}([^0-9]|$)`;
const timeRe = (hhmm) => `(^|[^0-9])${hhmm}([^0-9]|$)`;

/**
 * The values one run of any verification scenario uses: a made-up service, and for each scenario the
 * inputs its request gives and the answer its work must reach. The inputs are drawn where the obvious
 * method goes wrong: a range whose ends both count, a New York time near or across a daylight-saving
 * change, a fall whose rate is easy to take on the wrong base, and nine amounts to the cent; and where
 * a common tool goes wrong too: a duration across a daylight-saving change, halves rounded up, and
 * working days with both ends counted.
 */
export function verificationValues(seed) {
  const rnd = seededRandom(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const number = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const service = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;

  const start = Date.UTC(2027, number(0, 9), number(1, 28));
  const span = number(25, 70);
  const range = { start: isoDay(start), end: isoDay(start + span * DAY_MS), days: span + 1 };

  // Most windows fall in the weeks either side of a change, where an offset from memory is wrong.
  const window = pick([[Date.UTC(2027, 2, 14), 26], [Date.UTC(2027, 9, 18), 19], [Date.UTC(2027, 10, 8), 30], [Date.UTC(2027, 1, 15), 26]]);
  const day = isoDay(window[0] + number(0, window[1] - 1) * DAY_MS);
  const [hour, minute] = [number(7, 11), pick([0, 15, 30, 45])];
  const offset = newYorkOffset(day);
  const utc = `${pad(hour - offset)}:${pad(minute)}`;
  const time = { day, local: `${pad(hour)}:${pad(minute)}`, offset, utc };

  // A fall whose rate rounds clear of a half, so one decimal place has one right answer.
  let fall;
  do {
    const before = number(1200, 4800);
    const after = Math.round(before * (1 - (15 + rnd() * 20) / 100));
    const tenths = ((before - after) / before) * 1000;
    fall = { before, after, tenths, percent: (Math.round(tenths) / 10).toFixed(1) };
  } while (Math.abs((fall.tenths % 1) - 0.5) < 0.1 || fall.percent.endsWith('.0'));

  const amounts = Array.from({ length: 9 }, () => number(1200, 48099));
  const claims = { amounts: amounts.map((c) => `${Math.floor(c / 100)}.${pad(c % 100)}`), cents: amounts.reduce((a, b) => a + b, 0) };

  // The traps below catch a script, not only a guess: each is where a common tool's own behaviour
  // differs from what the request asks.

  // An overnight job across a daylight-saving change, New York time. Subtracting two times of one
  // zone in Python's datetime ignores the change of offset, so it is an hour out.
  let overnight;
  do {
    const [from, to] = pick([['2027-03-13', '2027-03-14'], ['2027-11-06', '2027-11-07'], ['2028-03-11', '2028-03-12'], ['2028-11-04', '2028-11-05']]);
    const startAt = number(19, 23) * 60 + pick([0, 15, 30, 45]);
    const endAt = number(4, 9) * 60 + pick([0, 15, 30, 45]);
    const wall = DAY - startAt + endAt;
    const minutes = wall + (newYorkOffset(from) - newYorkOffset(to)) * 60;
    const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    overnight = { from, to, start: hhmm(startAt), end: hhmm(endAt), hours: Math.floor(minutes / 60), minutes: minutes % 60 };
  } while (overnight.minutes === 0 || overnight.end === `${pad(overnight.hours)}:${pad(overnight.minutes)}`);

  // Invoices rounded to whole euros, halves up. Half of them end in .50 on an even euro, which
  // Python's round() takes down, since it rounds halves to even.
  const halves = Array.from({ length: 4 }, () => number(3, 240) * 200 + 50);
  const others = Array.from({ length: 4 }, () => {
    let c;
    do { c = number(300, 48099); } while (c % 100 === 50);
    return c;
  });
  const invoiceCents = [...halves, ...others];
  for (let i = invoiceCents.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [invoiceCents[i], invoiceCents[j]] = [invoiceCents[j], invoiceCents[i]];
  }
  const invoices = {
    amounts: invoiceCents.map((c) => `${Math.floor(c / 100)}.${pad(c % 100)}`),
    total: invoiceCents.reduce((sum, c) => sum + Math.floor((c + 50) / 100), 0),
  };

  // Working days from one weekday to another, both counted, less two public holidays inside the run.
  // numpy's busday_count leaves the end date out, so it comes out a day short.
  const weekday = (t) => [1, 2, 3, 4, 5].includes(new Date(t).getUTCDay());
  let first = Date.UTC(2027, number(0, 9), number(1, 28));
  while (!weekday(first)) first += DAY_MS;
  let last = first + number(20, 50) * DAY_MS;
  while (!weekday(last)) last += DAY_MS;
  const inside = [];
  for (let t = first + DAY_MS; t < last; t += DAY_MS) if (weekday(t)) inside.push(t);
  const h1 = inside.splice(Math.floor(rnd() * inside.length), 1)[0];
  const h2 = inside.splice(Math.floor(rnd() * inside.length), 1)[0];
  const holidays = [h1, h2].sort((a, b) => a - b);
  let workdays = 0;
  for (let t = first; t <= last; t += DAY_MS) if (weekday(t) && !holidays.includes(t)) workdays += 1;
  const working = { first: isoDay(first), last: isoDay(last), holidays: holidays.map(isoDay), days: workdays };

  return { service, range, time, fall: { before: fall.before, after: fall.after, percent: fall.percent }, claims, overnight, invoices, working };
}

/** A whole number of euros as the answer writes it: a thousands separator and `.00` optional. */
const wholeRe = (n) => {
  const s = String(n);
  const grouped = s.length > 3 ? `${s.slice(0, -3)}[,\\s]?${s.slice(-3)}` : s;
  return `(?<![0-9.,])${grouped}(?:\\.00)?(?![0-9]|[.,][0-9])`;
};
/** A duration as H:MM, or as hours and minutes in words. */
const durationRe = (h, m) => `(?<![0-9:])0?${h}:${pad(m)}(?![0-9])|\\b${h} ?h(ours?)?,? (and )?${m} ?m(in(ute)?s?)?\\b`;

/** The verification battery's checks are named for what the answer must get right. */
const RIGHT = 'names the right answer';
/** A step of work: its answer must name `expect`, and a wrong one is harvested as a defect of `kind`. */
const work = (id, at, text, expect, verify) => ({ id, kind: 'ask', at, harvest: 'verification', text, expect, verify });

export const VERIFICATION_SCENARIOS = Object.freeze([
  {
    id: 'ver-day-count',
    battery: 'verification',
    about: 'a count of days whose first and last day both count',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `The ${v.service} support rota runs from ${v.range.start} to ${v.range.end}, and the first and the last day `
        + 'are both rota days. Work out with a small script in your workspace how many rota days that is, and reply with the number.',
      (v) => [{ name: RIGHT, source: countRe(v.range.days) }],
      { kind: 'a range one day short', flaw: (v) => `the count leaves out one end of the range: from ${v.range.start} to ${v.range.end}, both included, is ${v.range.days} days` }),
    ],
  },
  {
    id: 'ver-utc-time',
    battery: 'verification',
    about: 'a New York time converted to UTC on a date near a daylight-saving change',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `The ${v.service} maintenance window opens at ${v.time.local} New York time on ${v.time.day}. `
        + 'Convert that to UTC with a command in your workspace, and reply with the UTC time as HH:MM.',
      (v) => [{ name: RIGHT, source: timeRe(v.time.utc) }],
      { kind: 'a time in the wrong zone', flaw: (v) => `the time is converted with the wrong offset: New York is at UTC${v.time.offset} on ${v.time.day}, so ${v.time.local} there is ${v.time.utc} UTC` }),
    ],
  },
  {
    id: 'ver-rate-base',
    battery: 'verification',
    about: 'a percentage fall, taken on the amount before it',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `The ${v.service} service's monthly cloud bill went from ${v.fall.before} EUR to ${v.fall.after} EUR. `
        + 'Work out with a command by what percentage it fell, to one decimal place, and reply with the percentage.',
      (v) => [{ name: RIGHT, source: decimalRe(v.fall.percent) }],
      { kind: 'a rate on the wrong base', flaw: (v) => `the fall is not taken on the bill before it: (${v.fall.before} - ${v.fall.after}) / ${v.fall.before} is ${v.fall.percent}%` }),
    ],
  },
  {
    id: 'ver-claims-total',
    battery: 'verification',
    about: 'nine amounts totalled to the cent',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `Here are the ${v.service} team's nine expense claims for March, in EUR: ${v.claims.amounts.join(', ')}. `
        + 'Total them with a command in your workspace, and reply with the total in EUR, to the cent.',
      (v) => [{ name: RIGHT, source: moneyRe(v.claims.cents) }],
      { kind: 'a wrong total', flaw: (v) => `the total is not the sum of the nine claims, ${Math.floor(v.claims.cents / 100)}.${pad(v.claims.cents % 100)} EUR` }),
    ],
  },
  {
    id: 'ver-overnight-duration',
    battery: 'verification',
    about: 'how long an overnight job ran, across a daylight-saving change',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `The ${v.service} nightly import started at ${v.overnight.start} New York time on ${v.overnight.from} and finished at `
        + `${v.overnight.end} New York time on ${v.overnight.to}. Work out with a small script in your workspace how long it ran, and reply with the duration as H:MM.`,
      (v) => [{ name: RIGHT, source: durationRe(v.overnight.hours, v.overnight.minutes) }],
      { kind: 'a time in the wrong zone', flaw: (v) => `the duration ignores the daylight-saving change that night: it ran ${v.overnight.hours}:${pad(v.overnight.minutes)}` }),
    ],
  },
  {
    id: 'ver-half-up-total',
    battery: 'verification',
    about: 'eight invoices rounded to whole euros with halves up, then totalled',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `Round each of the ${v.service} team's eight invoice amounts to the nearest whole euro, with halves rounding up `
        + `(so 2.50 becomes 3), and total the rounded amounts: ${v.invoices.amounts.join(', ')} EUR. Do it with a command in your workspace, `
        + 'and reply with the total in whole euros.',
      (v) => [{ name: RIGHT, source: wholeRe(v.invoices.total) }],
      { kind: 'a wrong total', flaw: (v) => `the halves are not all rounded up: rounded half up, the eight invoices total ${v.invoices.total} EUR` }),
    ],
  },
  {
    id: 'ver-working-days',
    battery: 'verification',
    about: 'working days between two weekdays, both counted, less two holidays',
    everyHours: 24,
    values: verificationValues,
    steps: [
      work('work', 0, (v) => `How many working days (Monday to Friday) does the ${v.service} migration window have, from ${v.working.first} to `
        + `${v.working.last} with both days included, leaving out the public holidays on ${v.working.holidays.join(' and ')}? `
        + 'Work it out with a small script in your workspace, and reply with the number.',
      (v) => [{ name: RIGHT, source: countRe(v.working.days) }],
      { kind: 'a range one day short', flaw: (v) => `the count leaves out one end of the range: from ${v.working.first} to ${v.working.last}, both included, less the two holidays, is ${v.working.days} working days` }),
    ],
  },
]);

/** Every battery by name. */
export const BATTERIES = Object.freeze({ memory: MEMORY_SCENARIOS, verification: VERIFICATION_SCENARIOS });
