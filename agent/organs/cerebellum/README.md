# agent/organs/cerebellum/

The cerebellum: the organ that verifies each checkpoint against its acceptance criteria, and checks
the final answer. It judges; it never does the work it judges.

| File | What it does |
|---|---|
| `verify.mjs` | The milestone check of one checkpoint: builds the verifier's prompts, asks, retries a non-answer, re-checks on the complete evidence, tries to overturn a pass when the stakes call for it, and grades the result |
| `verdict.mjs` | Reads the verdict from the verifier's terminal tool call (`report_pass` or `report_fail`), never from its prose, and the stakes order the attack duty uses |

**Called by:** the checkpoint executor (`agent/work/checkpoint-executor.mjs`), which the brain service
hands `verifyMilestone` with its budgets (`verifySettings` in `agent/services/brain/settings.mjs`); the
brain's synthesize and blocked steps (`agent/services/brain/actions/`), which read verdicts.

**Also the cerebellum's, elsewhere for now:** its base prompt (`prompts/cerebellum.md`), its skill
(`skills/verification/`), the verdict tools' schemas (`agent/gateway/tools.mjs`) and the final-answer
check in `agent/services/brain/actions/synthesize.mjs`. Its module in `dev/loop/modules.json` names
what a lane may change.

**Tests:** `tests/agent/organs/cerebellum/`.
