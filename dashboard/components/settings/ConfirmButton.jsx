'use client';
// dashboard/components/settings/ConfirmButton.jsx: a button for an action that cannot be taken back
// (remove a user, delete a secret, restart a service). The first click asks, in place; only the second
// acts.
import { useState } from 'react';
import styles from './Settings.module.css';

/**
 * @param {object}   props
 * @param {string}   props.label          the button, e.g. "Remove"
 * @param {string}   [props.confirmLabel] the button that acts, e.g. "Remove ada@example.com"
 * @param {string}   [props.prompt]       the question shown beside it
 * @param {() => void} props.onConfirm
 * @param {boolean}  [props.disabled]
 * @param {boolean}  [props.danger]       red when true (default), plain otherwise
 */
export function ConfirmButton({ label, confirmLabel, prompt, onConfirm, disabled = false, danger = true }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={`btn btn-sm ${danger ? 'btn-danger' : ''}`} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className={styles.confirm}>
      {prompt && <span className="muted">{prompt}</span>}
      <button
        type="button"
        className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel || label}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
