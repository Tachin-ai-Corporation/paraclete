// dev/harness2/verification-harvest.mjs: turns work the canary got wrong, after its cerebellum (the
// organ that verifies each checkpoint against its acceptance criteria) passed it, into a cerebellum
// bench item (docs/plan/MODULAR_LOOPS.md, phase 5: the canary's failures arrive as bench items). Lab
// only: nothing here is in install/manifest.txt.
//
// When a step of the verification battery fails (scenario-items.mjs: work whose obvious answer is
// wrong, with an answer code checks), this reads the mission that did the work: its checkpoints (the
// C envelopes, each with the instruction and the acceptance criteria its verifier judged against)
// and each checkpoint's tasks (the T envelopes, whose outputs were the evidence). Then:
//
// - **verified wrong work:** checkpoints passed their verification, and none of their tasks' outputs
//   holds the right answer. The last checkpoint that passed becomes a defective cerebellum item in the bench's own shape
//   (bench-items.mjs CEREBELLUM_ITEMS), named for the scenario's kind of defect, scrubbed of the lab's
//   identifiers, and written beside the scenario state. Its clean twin, the same checkpoint with the
//   evidence put right, is the reviewer's to write, since the bench takes its items in pairs
//   (harvested-items/README.md).
// - **right work, wrong answer:** a checkpoint that passed holds the right answer: the work was
//   right, and the answer went wrong after it. No item.
// - **caught:** every checkpoint that judged the work failed it. The cerebellum did its job, and the
//   wrong answer came from what ran after it. No item.
// - **no checkpoint:** the mission answered without a plan, so no verifier saw the work. No item.
//
// It changes no bench. Called by scenarios.mjs, through `node dev/harness2/cli.mjs scenarios
// --battery verification`.

import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS } from '../../agent/storage/collections.mjs';
import { READINESS_DOC } from '../dev-env.mjs';
import { BENCH_VERSION } from './bench.mjs';
import { scrub } from './scenario-harvest.mjs';

export const VERIFICATION_HARVEST_DIR = '.local/canary/harvested';
/** A task's output kept in a row: enough for the evidence a verifier reads, never a whole log. */
const ROW_KEPT = 6000;
const READ_LIMIT = 100;

const ms = (stamp) => Date.parse(stamp);
const clip = (text, n) => (String(text ?? '').length > n ? `${String(text).slice(0, n)}…` : String(text ?? ''));
const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));

/**
 * The criteria a checkpoint's verifier judged against: its own, or, for one planned without any, the
 * stated outcome the checkpoint executor judges it on instead (agent/work/checkpoint-executor.mjs).
 */
export function judgedCriteria(checkpoint) {
  const own = String(checkpoint.accept_criteria || '').trim();
  if (own) return own;
  return `The checkpoint's stated outcome is achieved: "${String(checkpoint.instruction || '').substring(0, 300)}". The task outputs show concrete evidence that it was produced.`;
}

/**
 * The mission behind a step, as its verifiers saw it: each checkpoint, in the order it ran, with its
 * criteria, whether it passed, and its tasks' outputs as the rows they were judged on.
 *
 * @param {object} o
 * @param {object} o.db a Firestore client for the canary (dev-env.mjs devContext().db())
 * @param {string} o.missionId
 */
export async function captureMission({ db, missionId, collections = COLLECTIONS }) {
  const children = (parent) => db.query('', collections.work, [{ field: 'parent_id', op: 'EQUAL', value: { stringValue: parent } }], { noOrderBy: true, limit: READ_LIMIT, strict: true });
  const mission = await db.read(`${collections.work}/${missionId}`, { strict: true });
  const checkpoints = [];
  for (const cp of (await children(missionId)).filter((d) => d.type === 'C').sort(byCreated)) {
    const tasks = (await children(cp.id)).filter((d) => d.type === 'T').sort(byCreated);
    const n = cp.source_meta?.checkpoint ?? checkpoints.length + 1;
    checkpoints.push({
      id: cp.id,
      n,
      status: cp.status,
      instruction: String(cp.instruction || ''),
      acceptCriteria: judgedCriteria(cp),
      rows: tasks.map((t, i) => ({
        step: `${n}.${t.source_meta?.task_step ?? i + 1}`,
        agent: t.source_meta?.agent || 'motor',
        result: String(t.output ?? ''),
      })),
    });
  }
  const instance = await db.read(READINESS_DOC, { strict: true });
  return { mission: mission ? { id: missionId, status: mission.status, output: String(mission.output ?? '') } : null, checkpoints, commit: instance?.commit || null };
}

/**
 * What a wrong answer says about verification, from the mission's checkpoints, and the checkpoint
 * that passed the wrong work when one did. A passed checkpoint whose rows hold every value the answer
 * had to name did the work right, and the answer went wrong after it. When none does, the work that
 * reached the answer was wrong, and the last checkpoint that passed it is the miss. Pure.
 *
 * @param {object} capture captureMission's result
 * @param {Array<{source: string}>} expect the values the answer had to name
 * @returns {{diagnosis: string, checkpoint?: object}}
 */
export function diagnoseMission(capture, expect) {
  if (!capture.checkpoints.length) return { diagnosis: 'no checkpoint' };
  const passed = capture.checkpoints.filter((c) => c.status === 'complete');
  if (!passed.length) return { diagnosis: 'caught' };
  const holds = (c) => expect.every((e) => new RegExp(e.source, 'i').test(c.rows.map((r) => r.result).join('\n')));
  if (passed.some(holds)) return { diagnosis: 'right work, wrong answer' };
  return { diagnosis: 'verified wrong work', checkpoint: passed[passed.length - 1] };
}

/**
 * The defective cerebellum item a checkpoint that passed wrong work becomes: its instruction, the
 * criteria it was judged on, and its tasks' outputs as rows. Pure.
 */
export function verificationItem({ run, stepId, request, checkpoint, at, commit = null, mission = null, scrubbing = {} }) {
  const s = (text) => scrub(text, scrubbing);
  return {
    id: `cbh-${run.id}-defect`,
    organ: 'cerebellum',
    split: 'train',
    bench: BENCH_VERSION + 1,
    expect: 'fail',
    kind: request.verify.kind,
    flaw: s(request.verify.flaw),
    instruction: s(checkpoint.instruction),
    acceptCriteria: s(checkpoint.acceptCriteria),
    rows: checkpoint.rows.map((r) => ({ step: r.step, agent: r.agent, result: s(clip(r.result, ROW_KEPT)) })),
    harvested: { from: 'canary', run: run.id, scenario: run.scenario, step: stepId, at: new Date(at).toISOString(), commit, mission, checkpoint: checkpoint.n },
  };
}

/**
 * The harvest scenarios.mjs calls for a failed verification step: capture the mission, diagnose, and,
 * when a checkpoint passed the wrong work, write the item.
 *
 * @param {object} o
 * @param {Function} o.capture async ({missionId}) => the captured mission (captureMission, bound to the canary)
 * @param {string} [o.dir] where items are written, from `repoRoot`
 * @returns {Function} async ({run, stepId, request, outcome}) => {diagnosis, checkpoints, item?, file?}
 */
export function verificationHarvester({ capture, repoRoot = process.cwd(), dir = VERIFICATION_HARVEST_DIR, scrubbing = {}, now = Date.now, writeFile = null }) {
  const write = writeFile || ((file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  });
  return async ({ run, stepId, request, outcome }) => {
    if (!outcome.mission) return { diagnosis: 'not captured', reason: 'the step named no mission' };
    const captured = await capture({ missionId: outcome.mission });
    const { diagnosis, checkpoint } = diagnoseMission(captured, request.expect);
    const checkpoints = captured.checkpoints.map((c) => ({ n: c.n, status: c.status }));
    if (!checkpoint) return { diagnosis, checkpoints };
    const step = run.steps.find((st) => st.id === stepId);
    const at = ms(step?.ranAt) || now();
    const item = verificationItem({ run, stepId, request, checkpoint, at, commit: captured.commit, mission: outcome.mission, scrubbing });
    const file = path.join(dir, `${item.id}.json`);
    write(path.resolve(repoRoot, file), `${JSON.stringify(item, null, 2)}\n`);
    return { diagnosis, checkpoints, item: item.id, file };
  };
}
