'use client';
// dashboard/components/chat/Composer.jsx: where the person writes to the agent and adds files. Enter
// sends and Shift+Enter starts a new line; the box grows with the text. Attach (or a drop onto the
// conversation, handled by ChatView.jsx) adds files, which upload at once and show as chips above the
// box (UploadChips.jsx); Send waits until they are all uploaded, and a message may be files alone.
// While a message is going out the box is locked with the text and files still in it, and if the send
// fails they stay and the reason shows below, so nothing is lost.

import { useLayoutEffect, useRef, useState } from 'react';
import { UploadChips } from './UploadChips.jsx';
import { filesOf } from './upload-list.js';
import styles from './Composer.module.css';

/** Tallest the box grows before it scrolls, in pixels (Composer.module.css caps it the same). */
const MAX_HEIGHT = 220;

/**
 * @param {object} props
 * @param {string} props.agentName
 * @param {(text: string, attachments: object[]) => Promise<string|null>} props.onSend  resolves to why it failed, or null
 * @param {object} props.uploads  useUploads() (use-uploads.js): the files to go with the message
 */
export function Composer({ agentName, onSend, uploads }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);
  const picker = useRef(null);
  const { summary } = uploads;

  // Grows with the text; empty, it is the one line its stylesheet gives it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '';
    if (text) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const hasContent = Boolean(text.trim()) || summary.attachments.length > 0;
  const canSend = hasContent && !sending && !summary.blocked;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const sent = uploads.items.filter((item) => item.status === 'done').map((item) => item.key);
    const failure = await onSend(text.trim(), summary.attachments);
    setSending(false);
    if (failure) setError(failure);
    else {
      setText('');
      uploads.clear(sent);
    }
    requestAnimationFrame(() => box.current?.focus());
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function onPicked(event) {
    uploads.add(filesOf(event.target.files));
    // The same file can be picked again after it was removed.
    event.target.value = '';
  }

  let note = <p id="composer-note" className={`muted ${styles.note}`}>Enter to send, Shift+Enter for a new line. Attach files, or drop them on the conversation.</p>;
  if (error) note = <p id="composer-note" className={`error-text ${styles.note}`} role="alert">Not sent: {error}</p>;
  else if (summary.blocked && uploads.items.length) note = <p id="composer-note" className={`muted ${styles.note}`}>Send waits: {summary.blocked}.</p>;

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <UploadChips items={uploads.items} onRemove={uploads.remove} onRetry={uploads.retry} disabled={sending} />
      <div className={styles.box}>
        <input ref={picker} type="file" multiple hidden onChange={onPicked} tabIndex={-1} />
        <button
          type="button"
          className={`btn btn-ghost btn-sm ${styles.attach}`}
          onClick={() => picker.current?.click()}
          disabled={sending}
          title="Attach files"
        >
          Attach
        </button>
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
        <button type="submit" className="btn btn-primary" disabled={!canSend}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {note}
    </form>
  );
}
