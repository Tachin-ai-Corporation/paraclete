'use client';
// dashboard/components/agent/Disclosure.jsx: a section that opens and closes, for the long texts the
// Agent and Library pages list many of: organ prompts, memory files, SKILL.md files, contracts
// sections, playbook revisions. Its body renders only while it is open, so a list of closed files
// renders none of their Markdown.

import { useState } from 'react';
import styles from './Disclosure.module.css';

/**
 * @param {object}          props
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.meta]         shown at the right of the title
 * @param {boolean}         [props.defaultOpen]
 * @param {React.ReactNode} props.children
 */
export function Disclosure({ title, meta = null, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={styles.disclosure} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <span className={styles.title}>{title}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </summary>
      {open && <div className={styles.body}>{children}</div>}
    </details>
  );
}
