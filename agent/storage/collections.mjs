// agent/storage/collections.mjs: the name of every Firestore collection paraclete uses. One project
// holds one agent, so every top-level collection sits at the database root. Code takes names from
// here and never writes a collection name as a string literal. Renaming one needs a data migration.

export const COLLECTIONS = Object.freeze({
  /** The single document describing this instance's agent. */
  agent: 'agent',
  /** Dashboard users and their dashboard roles. */
  users: 'users',
  /** Conversation threads between a user and the agent. */
  threads: 'threads',
  /** Chat messages in and out. */
  messages: 'messages',
  /** Inbound requests waiting for the brain to classify them. */
  intake: 'intake',
  /** Requests, missions, checkpoints and tasks. */
  work: 'work',
  /** Approval gates waiting for, or resolved by, a person. */
  approvals: 'approvals',
  /** Process playbooks. */
  processes: 'processes',
  /** Projects and their context. */
  projects: 'projects',
  /** Scheduled and triggered work the agent owns. */
  responsibilities: 'responsibilities',
  /** Requests to run a responsibility now. */
  responsibilityTriggers: 'responsibility_triggers',
  /** Last-run state the scheduler keeps per responsibility. */
  responsibilityState: 'responsibility_state',
  /** Durable facts the agent has learned. */
  coreMemory: 'core_memory',
  /** Large tool results stored by reference. */
  toolResults: 'tool_results',
  /** Files coming in and going out. */
  files: 'files',
  /** Commands from the dashboard to the VM's control service. */
  commands: 'commands',
  /** Instance settings. */
  config: 'config',
  /** Git artifact repositories: one document per repo, holding its refs. */
  gitRepos: 'git_repos',
});

/** Subcollections, named relative to their parent document. */
export const SUBCOLLECTIONS = Object.freeze({
  /** processes/{id}/revisions: earlier versions of a process. */
  processRevisions: 'revisions',
  /** projects/{id}/promotions: artifacts promoted out of a project. */
  projectPromotions: 'promotions',
  /** work/{id}/history: the step-by-step record of one envelope. */
  workHistory: 'history',
  /** git_repos/{repoId}/refs/{branch}: one ref per branch, '/' stored as '__'. */
  gitRefs: 'refs',
  /** threads/{key}/turns: the turns of one conversation thread. */
  threadTurns: 'turns',
  /** responsibilities/{id}/revisions: earlier versions of a responsibility the agent changed. */
  responsibilityRevisions: 'revisions',
});
