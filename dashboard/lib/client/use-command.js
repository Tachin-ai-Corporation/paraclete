'use client';
// dashboard/lib/client/use-command.js: asking the VM something and waiting for the answer. A command
// goes to POST /api/commands; the control service on the VM picks it up within a few seconds and
// writes the outcome, which this hook polls for. Views (status, skills, workspace...) and changes
// (restart, run now...) both go through it; the result shapes are in
// agent/services/control/README.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 1500;
/** Longer than control's poll plus a slow command; an upgrade is followed by its own view. */
const GIVE_UP_MS = 120_000;

/**
 * @param {string}  type             the command type
 * @param {object}  [options]
 * @param {object}  [options.params]
 * @param {boolean} [options.auto]   send it once on mount (for read-only views)
 * @returns {{run: (params?: object) => Promise<object|null>, command: object|null, result: any,
 *   error: string|null, running: boolean}}
 */
export function useCommand(type, { params, auto = false } = {}) {
  const [command, setCommand] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  // Set again on every mount: React's strict mode mounts, unmounts and mounts once more in
  // development, and a ref left false would stop every poll.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (override) => {
    setRunning(true);
    setError(null);
    try {
      const { id } = await api('/api/commands', { method: 'POST', body: { type, params: override ?? params ?? {} } });
      const deadline = Date.now() + GIVE_UP_MS;
      while (alive.current) {
        const current = await api(`/api/commands/${id}`);
        setCommand(current);
        if (current.status === 'done' || current.status === 'failed') {
          if (current.status === 'failed') setError(current.error || 'the command failed');
          return current;
        }
        if (Date.now() > deadline) {
          setError('the agent has not answered yet; its VM may be down or restarting');
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return null;
    } catch (err) {
      if (alive.current) setError(err.message);
      return null;
    } finally {
      if (alive.current) setRunning(false);
    }
    // params is read at call time; callers pass fresh params to run() when they change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  useEffect(() => {
    if (auto) run();
  }, [auto, run]);

  return { run, command, result: command?.result ?? null, error, running };
}
