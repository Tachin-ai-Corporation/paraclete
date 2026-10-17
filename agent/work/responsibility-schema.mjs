// agent/work/responsibility-schema.mjs: the shape of a responsibility, the scheduled or triggered
// work the agent owns, whether it arrives as an installed default from a role package or as the
// agent's own record. How the two layer, and which writes are allowed, lives in
// responsibility-store.mjs; the validator that reads this schema is validate-schema.mjs. Used by
// responsibility-store.mjs.

import { ID_PATTERN } from './work-ids.mjs';

/**
 * One responsibility. The trigger is flat on purpose: `schedule` is a time, `event` is an
 * occurrence, and exactly one of them is set. An earlier shape nested both under a `trigger` object
 * while the scheduler read a top-level `schedule` nobody wrote, so a responsibility could be
 * authored, validated and installed and then never fire. This schema describes the record the
 * scheduler actually runs.
 */
export const RESPONSIBILITY_SCHEMA = {
  id: 'responsibility',
  version: 1,
  spec: {
    type: 'object',
    properties: {
      id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'Stable identity across revisions' },
      name: { type: 'string', required: true, minLength: 1, maxLength: 80 },

      // Exactly one of these; the check below enforces it. With neither, the responsibility can
      // never fire; with both, which one wins is undefined. Both states validate field by field,
      // so only the cross-field rule catches them.
      schedule: {
        type: 'string', nullable: true,
        describe: 'Five-field cron expression, read in `timezone`',
      },
      event: { type: 'string', nullable: true, describe: 'Event name that fires this instead of a clock' },

      timezone: {
        type: 'string', default: 'UTC',
        describe: 'IANA zone. Explicit, because a daylight-saving change silently shifts a fire time',
      },
      effect_scope: {
        type: 'string', enum: ['world', 'memory'], default: 'world',
        describe: 'memory: a firing writes only the agent\'s memory (working memory, Core Memory, Deep Truths), '
          + 'all of it through temporal-memory; enforced by the checkpoint executor (agent/work/memory-scope.mjs)',
      },

      instruction: { type: 'string', required: true, minLength: 10, describe: 'The goal handed to the agent when this fires' },
      success_criteria: { type: 'string', required: true, minLength: 10, describe: 'How the agent knows the firing succeeded' },

      singleton: {
        type: 'boolean', default: false,
        describe: 'Refuse to fire while an earlier firing of this responsibility is still in progress',
      },
      min_spacing_minutes: {
        type: 'integer', nullable: true, min: 0,
        describe: 'Floor between firings, independent of the cron: a guard against a tight schedule',
      },
      context: {
        type: 'object', open: true, default: {},
        describe: 'Guidance carried into the mission: purpose, process steps, reference files, prior '
          + 'learnings. Not the place for success_criteria, which is a top-level field.',
      },

      project_id: { type: 'string', nullable: true, pattern: ID_PATTERN },
      enabled: { type: 'boolean', default: true },

      processRef: {
        type: 'string', nullable: true, pattern: ID_PATTERN,
        describe: 'The process playbook a firing recalls as its planning prior (agent/work/scheduler.mjs)',
      },
      processParameters: {
        type: 'object', open: true, nullable: true,
        describe: 'Parameters carried alongside processRef for the playbook',
      },
      triggerable: {
        type: 'boolean', default: false,
        describe: 'A person may ask the agent to run this out of turn',
      },
      locked: {
        type: 'boolean', default: false,
        describe: 'Installed upkeep: no edit by the agent or the dashboard may override or disable it. It '
          + 'changes only with a release. See agent/work/responsibility-store.mjs.',
      },
    },
    check: (r) => {
      const hasSchedule = Boolean(r.schedule);
      const hasEvent = Boolean(r.event);
      if (!hasSchedule && !hasEvent) return 'a responsibility needs either a schedule or an event; with neither it can never fire';
      if (hasSchedule && hasEvent) return 'a responsibility takes a schedule or an event, not both; which one wins would be undefined';
      if (hasSchedule && r.schedule.trim().split(/\s+/).length !== 5) return 'schedule must be a five-field cron expression';
      return null;
    },
  },
};
