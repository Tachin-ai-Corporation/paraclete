'use client';
// dashboard/components/chat/MessageList.jsx: the scrolling conversation. It keeps to the newest
// message as messages arrive, unless the person has scrolled up to read, in which case it offers a
// button back down instead of pulling the page from under them. Loading earlier messages keeps the
// view where it was. The agent's typing row sits at the end while a reply is on its way.

import { useLayoutEffect, useRef, useState } from 'react';
import { Message } from './Message.jsx';
import styles from './MessageList.module.css';

/** Closer than this to the bottom counts as reading the newest. */
const NEAR_BOTTOM_PX = 120;
/** Messages from the same side this close together share one name and time line. */
const GROUP_MS = 5 * 60_000;

function grouped(previous, message) {
  if (!previous || previous.from !== message.from || previous.pending || message.pending) return false;
  return Date.parse(message.timestamp) - Date.parse(previous.timestamp) < GROUP_MS;
}

function Welcome({ agentName }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.avatar} aria-hidden="true">{(agentName || 'P').charAt(0).toUpperCase()}</div>
      <h2>Start a conversation with {agentName}</h2>
      <p className="muted">
        Ask a question or hand over a task. Work it takes on shows here while it runs, and the files it makes come
        back as downloads.
      </p>
    </div>
  );
}

function Typing({ reply, agentName }) {
  const label = reply.kind === 'working' ? `${agentName} is working on "${reply.title}"` : `${agentName} is on it`;
  return (
    <div className={styles.typing} role="status">
      <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>
      <span>{label}</span>
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object[]} props.messages      oldest first
 * @param {object}   [props.pending]     the message being sent
 * @param {object}   [props.reply]       from replyState() in conversation.js
 * @param {string}   props.agentName
 * @param {boolean}  props.loading       nothing read yet
 * @param {Error}    [props.error]       the last poll failed
 * @param {{hasMore: boolean, loading: boolean, error: string|null}} props.earlier
 * @param {() => void} props.onLoadEarlier
 */
export function MessageList({ messages, pending, reply, agentName, loading, error, earlier, onLoadEarlier }) {
  const scroller = useRef(null);
  const nearBottom = useRef(true);
  const anchor = useRef(null);
  const lastEnd = useRef(null);
  const [showJump, setShowJump] = useState(false);

  const items = pending ? [...messages, pending] : messages;
  const firstId = messages[0]?.id ?? null;
  const last = items[items.length - 1];
  const endKey = `${last?.id ?? ''}|${reply?.kind ?? ''}`;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Earlier messages were added above: keep the same messages in view.
    if (anchor.current && anchor.current.firstId !== firstId) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    }
    if (endKey === lastEnd.current) return;
    lastEnd.current = endKey;
    if (nearBottom.current || last?.pending) {
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  });

  function onScroll() {
    const el = scroller.current;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom.current && showJump) setShowJump(false);
  }

  function loadEarlier() {
    const el = scroller.current;
    anchor.current = { firstId, height: el.scrollHeight, top: el.scrollTop };
    onLoadEarlier();
  }

  function jumpToNewest() {
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    setShowJump(false);
  }

  return (
    <div className={styles.wrap}>
      <div ref={scroller} className={styles.scroller} onScroll={onScroll} role="log" aria-label="Messages">
        <div className={styles.inner}>
          {earlier.hasMore && (
            <button type="button" className={`btn btn-ghost btn-sm ${styles.earlier}`} onClick={loadEarlier} disabled={earlier.loading}>
              {earlier.loading ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {earlier.error && <p className="error-text">{earlier.error}</p>}
          {loading && <p className="muted">Loading the conversation…</p>}
          {error && <p className="error-text">The conversation could not be refreshed: {error.message}</p>}
          {!loading && !error && items.length === 0 && <Welcome agentName={agentName} />}
          {items.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              agentName={agentName}
              grouped={grouped(items[index - 1], message)}
              note={reply?.kind === 'not_picked_up' && reply.id === message.id
                ? `${agentName} has not picked this up yet. Its VM may be stopped or restarting.`
                : null}
            />
          ))}
          {reply && reply.kind !== 'not_picked_up' && <Typing reply={reply} agentName={agentName} />}
        </div>
      </div>
      {showJump && (
        <button type="button" className={`btn btn-sm ${styles.jump}`} onClick={jumpToNewest}>
          New messages below
        </button>
      )}
    </div>
  );
}
