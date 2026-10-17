'use client';
// dashboard/components/agent/VmView.jsx: the frame of a view the VM answers through a command (skills,
// workspace, configuration, models...). It says when the agent is being asked, when the answer came,
// and why there is none; Refresh asks again. While a refresh runs, the last answer stays on screen.

import { useEffect, useState } from 'react';
import { timeAgo } from '@/lib/client/format.js';
import styles from './Agent.module.css';

/**
 * @param {object}   props
 * @param {object}   props.command   from useCommand() or useLazyCommand()
 * @param {(result: object) => React.ReactNode} props.children  renders the result
 */
export function VmView({ command, children }) {
  const { result, error, running, command: doc, run } = command;
  const [last, setLast] = useState(null);
  useEffect(() => {
    if (result) setLast({ result, at: doc?.finished_at || null });
  }, [result, doc?.finished_at]);
  const shown = result || last?.result || null;
  const at = result ? doc?.finished_at : last?.at;

  return (
    <div className={styles.vmView}>
      <div className={styles.vmBar}>
        <span className="muted">
          {running ? 'Asking the agent’s VM…' : at ? `From the agent’s VM ${timeAgo(at)}` : ''}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => run()} disabled={running}>
          {running ? 'Asking…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!shown && running && <p className="muted">The control service on the VM answers within a few seconds.</p>}
      {shown && children(shown)}
    </div>
  );
}
