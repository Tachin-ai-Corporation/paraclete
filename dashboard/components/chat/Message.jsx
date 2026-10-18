// dashboard/components/chat/Message.jsx: one message in the conversation. The agent's text is
// Markdown (components/ui/Markdown.jsx, which never renders raw HTML); the person's own is shown as
// typed, and a message that was files alone has no bubble. The message's files follow as download
// chips: the agent's handed-back files and the person's uploads alike.

import { Markdown } from '@/components/ui/Markdown.jsx';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { Attachments } from './Attachments.jsx';
import styles from './Message.module.css';

/**
 * @param {object}  props
 * @param {object}  props.message  from /api/chat/messages, or the one being sent (`pending: true`)
 * @param {string}  props.agentName
 * @param {boolean} props.grouped  follows a message from the same side: no name and time line
 * @param {string}  [props.note]   a warning shown under it
 */
export function Message({ message, agentName, grouped, note }) {
  const fromAgent = message.from === 'agent';
  const name = fromAgent ? message.sender_name || agentName : 'You';
  const classes = [styles.message, fromAgent ? styles.agent : styles.user, grouped ? styles.grouped : '', message.pending ? styles.pending : '']
    .filter(Boolean)
    .join(' ');
  return (
    <article className={classes}>
      {!grouped && (
        <div className={styles.meta}>
          <span className={styles.name}>{name}</span>
          {message.pending ? (
            <span>Sending…</span>
          ) : (
            <time dateTime={message.timestamp || undefined} title={formatDate(message.timestamp)}>{timeAgo(message.timestamp)}</time>
          )}
        </div>
      )}
      {fromAgent ? (
        <Markdown className={styles.body}>{message.text}</Markdown>
      ) : message.text ? (
        <div className={styles.bubble} title={grouped ? formatDate(message.timestamp) : undefined}>{message.text}</div>
      ) : null}
      <Attachments files={message.attachments} />
      {note && <p className={styles.note} role="status">{note}</p>}
    </article>
  );
}
