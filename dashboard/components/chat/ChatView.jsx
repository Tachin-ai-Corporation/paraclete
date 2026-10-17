'use client';
// dashboard/components/chat/ChatView.jsx: the Chat page, the dashboard's home. The signed-in user's
// own conversation with the agent: the messages (polled every few seconds while the tab is visible,
// older ones loaded on demand), the missions the conversation started while they run, the composer,
// and a side panel of the agent's notices that belong to no conversation. Everything is read through
// /api/chat/*, which only ever serves the caller's own thread.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { mergeMessages, pollSince, replyState } from './conversation.js';
import { MessageList } from './MessageList.jsx';
import { Presence } from './Presence.jsx';
import { Composer } from './Composer.jsx';
import { Notices } from './Notices.jsx';
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

  const send = useCallback(async (text) => {
    setPending({ id: 'sending', from: 'user', text, timestamp: new Date().toISOString(), attachments: [], pending: true });
    try {
      const { message } = await api('/api/chat/messages', { method: 'POST', body: { text } });
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
      <section className={styles.conversation} aria-label={`Conversation with ${agentName}`}>
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
        <Composer agentName={agentName} onSend={send} />
      </section>
      <Notices agentName={agentName} />
    </div>
  );
}
