'use client';
// dashboard/components/chat/Composer.jsx: where the person writes to the agent. Enter sends and
// Shift+Enter starts a new line; the box grows with the text. While a message is going out the box
// is locked with the text still in it, and if the send fails the text stays and the reason shows
// below, so nothing typed is lost.

import { useLayoutEffect, useRef, useState } from 'react';
import styles from './Composer.module.css';

/** Tallest the box grows before it scrolls, in pixels (Composer.module.css caps it the same). */
const MAX_HEIGHT = 220;

/**
 * @param {object} props
 * @param {string} props.agentName
 * @param {(text: string) => Promise<string|null>} props.onSend  resolves to why it failed, or null
 */
export function Composer({ agentName, onSend }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);

  // Grows with the text; empty, it is the one line its stylesheet gives it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '';
    if (text) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  async function submit() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    const failure = await onSend(value);
    setSending(false);
    if (failure) setError(failure);
    else setText('');
    requestAnimationFrame(() => box.current?.focus());
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.box}>
        <textarea
          ref={box}
          className={styles.input}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
          placeholder={`Message ${agentName}`}
          aria-label={`Message to ${agentName}`}
          aria-describedby="composer-note"
        />
        <button type="submit" className="btn btn-primary" disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error ? (
        <p id="composer-note" className={`error-text ${styles.note}`} role="alert">Not sent: {error}</p>
      ) : (
        <p id="composer-note" className={`muted ${styles.note}`}>Enter to send, Shift+Enter for a new line</p>
      )}
    </form>
  );
}
