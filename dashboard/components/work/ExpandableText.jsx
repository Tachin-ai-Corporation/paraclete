'use client';
// dashboard/components/work/ExpandableText.jsx: a long text from the agent (an output, a question, a
// message) shown short with "Show all". The server sends texts as { text, chars, clipped }: when it
// sent only the start of a very long one, a link opens the envelope's own page, which carries much
// more. Task outputs also split off the gateway's tool log ([TOOL EXECUTION LOG] ... [END TOOL LOG])
// into its own fold, so the answer reads first.
import Link from 'next/link';
import { useState } from 'react';
import { Markdown } from '@/components/ui/Markdown.jsx';
import styles from './ExpandableText.module.css';

const LOG_START = '[TOOL EXECUTION LOG]';
const LOG_END = '[END TOOL LOG]';

/** A turn's output as its prose and its tool log (the log may be cut off when the text was clipped). */
export function splitToolLog(text) {
  const s = String(text || '');
  const start = s.indexOf(LOG_START);
  if (start === -1) return { prose: s, log: '', calls: 0 };
  const rest = s.slice(start + LOG_START.length);
  const end = rest.indexOf(LOG_END);
  const log = (end === -1 ? rest : rest.slice(0, end)).trim();
  const after = end === -1 ? '' : rest.slice(end + LOG_END.length).trim();
  const prose = [s.slice(0, start).replace(/\n-{3,}\s*$/, '').trim(), after].filter(Boolean).join('\n\n');
  return { prose, log, calls: (log.match(/^\[TOOL\]/gm) || []).length };
}

/**
 * @param {object}  props
 * @param {{text: string, chars: number, clipped: boolean}|null} props.value
 * @param {boolean} [props.markdown]  render as Markdown (the agent's replies); otherwise as plain text
 * @param {number}  [props.collapsedChars]  past this much, show it folded
 * @param {string}  [props.fullHref]  where the whole text is, when the server sent only its start
 */
export function ExpandableText({ value, markdown = false, collapsedChars = 700, fullHref = null }) {
  const [open, setOpen] = useState(false);
  if (!value || !value.text) return null;
  const long = value.text.length > collapsedChars;
  const folded = long && !open;
  return (
    <div className={styles.wrap}>
      {markdown ? (
        <div className={folded ? styles.folded : undefined}>
          <Markdown>{value.text}</Markdown>
        </div>
      ) : (
        <pre className={styles.plain}>{folded ? `${value.text.slice(0, collapsedChars).trimEnd()}…` : value.text}</pre>
      )}
      {(long || value.clipped) && (
        <div className={styles.controls}>
          {long && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show all'}
            </button>
          )}
          {value.clipped && (
            <span className="muted">
              Only the first {value.text.length.toLocaleString()} of {value.chars.toLocaleString()} characters are here.
              {fullHref && <> <Link href={fullHref}>Open it on its own page</Link>.</>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A task's output: the answer first, then its tool calls folded away. */
export function TurnOutput({ value, fullHref = null }) {
  if (!value || !value.text) return null;
  const { prose, log, calls } = splitToolLog(value.text);
  return (
    <div className={styles.wrap}>
      {prose && <ExpandableText value={{ ...value, text: prose, clipped: value.clipped && !log }} markdown fullHref={fullHref} />}
      {log && (
        <details className={styles.log}>
          <summary>{calls === 1 ? '1 tool call' : `${calls} tool calls`}</summary>
          <pre className={styles.plain}>{log}</pre>
          {value.clipped && (
            <p className="muted">
              Cut short here.{fullHref && <> <Link href={fullHref}>Open the task</Link> for the rest.</>}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
