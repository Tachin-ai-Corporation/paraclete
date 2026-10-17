# agent/work/

How work moves: Request → Mission → Checkpoint → Task, and everything that keeps it honest.

**Belongs here:** mission and checkpoint state, the checkpoint executor, approval gates, the scheduler
and responsibilities, verification verdicts, finalization and deliverables, the resource ledger.
**Doesn't:** model calls (`gateway/`), persistence details (`storage/`), or what goes into a prompt
(`context/`).

Most of this package is pure functions over plain data. Keep it that way: it is the part of the agent
that must be deterministic.

**Status:** empty. Arrives in build plan phase 2.
