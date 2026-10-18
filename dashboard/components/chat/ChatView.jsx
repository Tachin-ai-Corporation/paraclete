'use client';
// dashboard/components/chat/ChatView.jsx: the Chat page, the dashboard's home. The signed-in user's
// own conversation with the agent: the messages (polled every few seconds while the tab is visible,
// older ones loaded on demand), the missions the conversation started while they run, the composer,
// and a side panel of the agent's notices that belong to no conversation. Everything is read through
// /api/chat/*, which only ever serves the caller's own thread. Files dropped anywhere on the
// conversation join the composer's (use-uploads.js), and go with the next message.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { mergeMessages, pollSince, replyState } from './conversation.js';
import { MessageList } from './MessageList.jsx';
import { Presence } from './Presence.jsx';
import { Composer } from './Composer.jsx';
import { Notices } from './Notices.jsx';
import { useUploads } from './use-uploads.js';
import { draggingFiles, filesOf } from './upload-list.js';
import styles from './ChatView.module.css';

const MESSAGES_POLL_MS = 3000;
const PRESENCE_POLL_MS = 5000;

const NOT_LOADED = { known: false, hasMore: false, loading: false, error: null };

export function ChatView({ agentName }) {
  // Every message seen so far, oldest first. The first read is the newest page; after that each poll
  // asks only for what is new since the newest message (and the person's own still unread).
  const [messages, setMessages] = useState([]);
  const [older, setOlder] = useState(NOT_LOADED);
  const [pending, setPending] = useState(null);

  const since = pollSince(messages);
  const latest = usePoll(since ? `/api/chat/messages?since=${encodeURIComponent(since)}` : '/api/chat/messages', MESSAGES_POLL_MS);
  const presence = usePoll('/api/chat/presence', PRESENCE_POLL_MS);
  const refreshPresence = presence.refresh;

  useEffect(() => {
    const page = latest.data;
    if (!page?.messages) return;
    if (page.since && page.has_more) {
      // More arrived than one poll holds: start again from the newest page rather than leave a gap.
      setMessages([]);
      setOlder(NOT_LOADED);
      return;
    }
    setMessages((prev) => mergeMessages(prev, page.messages));
    if (!page.since) setOlder((state) => (state.known ? state : { ...state, known: true, hasMore: Boolean(page.has_more) }));
  }, [latest.data]);

  const oldest = messages[0]?.timestamp;

  const loadEarlier = useCallback(async () => {
    if (!oldest) return;
    setOlder((state) => ({ ...state, loading: true, error: null }));
    try {
      const page = await api(`/api/chat/messages?before=${encodeURIComponent(oldest)}`);
      setMessages((prev) => mergeMessages(page.messages, prev));
      setOlder({ known: true, hasMore: Boolean(page.has_more), loading: false, error: null });
    } catch (err) {
      setOlder((state) => ({ ...state, loading: false, error: `Earlier messages could not be loaded: ${err.message}` }));
    }
  }, [oldest]);

  const uploads = useUploads();
  const addFiles = uploads.add;
  // Drag events fire for every child the pointer crosses; the overlay stays until the drag has left
  // the conversation itself.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dropHandlers = {
    onDragEnter(event) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver(event) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave(event) {
      if (!draggingFiles(event.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop(event) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(filesOf(event.dataTransfer.files));
    },
  };

  const send = useCallback(async (text, attachments = []) => {
    setPending({
      id: 'sending', from: 'user', text, timestamp: new Date().toISOString(), pending: true,
      attachments: attachments.map((file) => ({ ...file, downloadable: false })),
    });
    try {
      const { message } = await api('/api/chat/messages', { method: 'POST', body: { text, attachments } });
      setMessages((prev) => mergeMessages(prev, [message]));
      refreshPresence();
      return null;
    } catch (err) {
      return err.message || 'the message could not be sent';
    } finally {
      setPending(null);
    }
  }, [refreshPresence]);

  const missions = presence.data?.missions || [];
  const reply = replyState({ messages, missions, sending: Boolean(pending), now: Date.now() });

  return (
    <div className={styles.chat}>
      <section className={styles.conversation} aria-label={`Conversation with ${agentName}`} {...dropHandlers}>
        {dragging && <div className={styles.drop} aria-hidden="true">Drop files to send them to {agentName}</div>}
        <header className={styles.header}>
          <h1>Chat</h1>
          <span className="muted">Your conversation with {agentName}</span>
        </header>
        <MessageList
          messages={messages}
          pending={pending}
          reply={reply}
          agentName={agentName}
          loading={latest.loading && messages.length === 0}
          error={latest.error}
          earlier={{ hasMore: older.hasMore, loading: older.loading, error: older.error }}
          onLoadEarlier={loadEarlier}
        />
        <Presence missions={missions} />
        <Composer agentName={agentName} onSend={send} uploads={uploads} />
      </section>
      <Notices agentName={agentName} />
    </div>
  );
}
