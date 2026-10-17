// agent/services/brain/actions/index.mjs: the moves the cortex (the organ that decides each step) can
// choose, each handled by one file. Every handler takes (ctx, deps): ctx is the mission's turn
// ({ envelope, decision, priorResults, memory, iteration }) and deps the brain's services (see
// envelope-runner.mjs). A handler returns { exit: true } when the mission's run ends, { continue: true,
// priorResultsAppend?, activeGuard? } to decide again, or { nextAction } to hand the decision to
// another move. The legal moves match CORTEX_SCHEMAS.decide in agent/providers/vertex-text.mjs.

import { handleBlocked } from './blocked.mjs';
import { handleCheckpointPlan } from './checkpoint-plan.mjs';
import { handleNeedsInput } from './needs-input.mjs';
import { handleStatusUpdate } from './status-update.mjs';
import { handleSynthesize } from './synthesize.mjs';
import { handleSynthesizeWithFailure } from './synthesize-with-failure.mjs';
import { handleTriggerResponsibility } from './trigger-responsibility.mjs';
import { handleWait } from './wait.mjs';

/** Each move the cortex may choose, and its handler. */
export const ACTION_HANDLERS = Object.freeze({
  checkpoint_plan: handleCheckpointPlan,
  synthesize: handleSynthesize,
  synthesize_with_failure: handleSynthesizeWithFailure,
  needs_input: handleNeedsInput,
  blocked: handleBlocked,
  status_update: handleStatusUpdate,
  wait: handleWait,
  trigger_responsibility: handleTriggerResponsibility,
});

/** The legal moves, in the order the cortex is told them. */
export const ACTION_NAMES = Object.freeze(Object.keys(ACTION_HANDLERS));
