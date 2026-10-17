// dashboard/components/agent/organs.js: the brain's organs as the Agent page names them: each prompt
// file's organ, in the order a mission meets them, with its plain job. The jobs are the ones in
// docs/GLOSSARY.md and agent/gateway/organs.mjs; the browser cannot import either, so keep the three
// in step. `identity` is not an organ: it is the agent's identity prompt, listed first.

export const PERSONA_PARTS = Object.freeze([
  { id: 'identity', label: 'Identity', job: 'Who the agent is, who it works for, and its voice' },
  { id: 'cortex', label: 'Cortex', job: 'Decides the next step of a mission' },
  { id: 'prefrontal', label: 'Prefrontal', job: 'Plans a mission’s checkpoints' },
  { id: 'motor', label: 'Motor', job: 'Executes tasks with tools' },
  { id: 'cerebellum', label: 'Cerebellum', job: 'Verifies each checkpoint and owns the verdict' },
  { id: 'temporal-memory', label: 'Temporal memory', job: 'Maintains the agent’s memory' },
  { id: 'temporal-research', label: 'Temporal research', job: 'Researches outside sources' },
]);

/** The model tiers (the contracts' vertex.models) and the organs each one serves. */
export const MODEL_TIERS = Object.freeze([
  { id: 'cortex', label: 'Cortex', serves: 'The cortex' },
  { id: 'strong', label: 'Strong', serves: 'Prefrontal, motor and cerebellum' },
  { id: 'fast', label: 'Fast', serves: 'Temporal memory and temporal research' },
  { id: 'fallback', label: 'Fallback', serves: 'Any organ whose model fails mid-turn' },
]);
