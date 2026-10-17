'use client';
// dashboard/lib/client/use-poll.js: live data without a push channel. The dashboard reads Firestore
// only on the server, so views poll their API route: at once, then every `intervalMs` while the tab is
// visible, and again as soon as it becomes visible. A failed poll keeps the last good data and reports
// the error; the next poll tries again.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * @param {string|null} path        the API route to poll; null pauses polling
 * @param {number}      intervalMs  0 reads once
 * @returns {{data: any, error: Error|null, loading: boolean, refresh: () => Promise<void>}}
 */
export function usePoll(path, intervalMs = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(path));
  const current = useRef(path);
  current.current = path;

  const refresh = useCallback(async () => {
    const asked = current.current;
    if (!asked) return;
    try {
      const body = await api(asked);
      if (current.current !== asked) return;
      setData(body);
      setError(null);
    } catch (err) {
      if (current.current === asked) setError(err);
    } finally {
      if (current.current === asked) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) return undefined;
    setLoading(true);
    setData(null);
    refresh();
    if (!intervalMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, intervalMs, refresh]);

  return { data, error, loading, refresh };
}
