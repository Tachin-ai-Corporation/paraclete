'use client';
// dashboard/components/chat/use-uploads.js: the files waiting to go with the next message, and their
// trips to the bucket. Each file goes in three steps (lib/server/uploads.mjs): ask the dashboard for a
// signed URL (POST /api/files/uploads), PUT the bytes straight to the bucket with XMLHttpRequest, whose
// upload events give the progress, then tell the dashboard it arrived (POST
// /api/files/uploads/:id/complete), which answers the attachment the message carries. A file can be
// removed at any point (an upload in flight is aborted) and a failed one tried again. The list's
// bookkeeping is upload-list.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { newItem, putFailure, uploadSummary } from './upload-list.js';

/** PUTs a file to a signed URL, reporting progress; resolves when the bucket has it, rejects with why not. */
function putFile(url, headers, file, { onProgress, onRequest }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onRequest(xhr);
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers || {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(putFailure(xhr.status, xhr.responseText))));
    xhr.onerror = () => reject(new Error(putFailure(0)));
    xhr.onabort = () => reject(Object.assign(new Error('removed'), { aborted: true }));
    xhr.send(file);
  });
}

/**
 * @returns {{items: object[], summary: ReturnType<typeof uploadSummary>, add: (files: object[]) => void,
 *   remove: (key: string) => void, retry: (key: string) => void, clear: (keys?: string[]) => void}}
 */
export function useUploads() {
  const [items, setItems] = useState([]);
  const requests = useRef(new Map()); // key -> the XMLHttpRequest in flight
  const removed = useRef(new Set()); // keys the person removed: their uploads stop at the next step
  const counter = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const xhr of requests.current.values()) xhr.abort();
    };
  }, []);

  const update = useCallback((key, change) => {
    if (!alive.current) return;
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const upload = useCallback(async (key, file) => {
    const gone = () => removed.current.has(key) || !alive.current;
    try {
      const started = await api('/api/files/uploads', { method: 'POST', body: { name: file.name, size: file.size, content_type: file.type || '' } });
      if (gone()) return;
      update(key, { name: started.name });
      await putFile(started.url, started.headers, file, {
        onProgress: (loaded) => update(key, { loaded }),
        onRequest: (xhr) => requests.current.set(key, xhr),
      });
      requests.current.delete(key);
      if (gone()) return;
      const attachment = await api(`/api/files/uploads/${encodeURIComponent(started.upload_id)}/complete`, {
        method: 'POST', body: { gcs_path: started.gcs_path },
      });
      update(key, { status: 'done', loaded: file.size, attachment });
    } catch (err) {
      requests.current.delete(key);
      if (err.aborted || gone()) return;
      update(key, { status: 'failed', error: err.message || 'the upload failed' });
    }
  }, [update]);

  const add = useCallback((files) => {
    const added = files.map((file) => {
      counter.current += 1;
      return newItem(file, `f${counter.current}`);
    });
    if (!added.length) return;
    setItems((list) => [...list, ...added]);
    for (const item of added) upload(item.key, item.file);
  }, [upload]);

  const remove = useCallback((key) => {
    removed.current.add(key);
    requests.current.get(key)?.abort();
    requests.current.delete(key);
    setItems((list) => list.filter((item) => item.key !== key));
  }, []);

  const retry = useCallback((key) => {
    const item = items.find((entry) => entry.key === key);
    if (!item || item.status !== 'failed') return;
    update(key, { status: 'uploading', loaded: 0, error: null, attachment: null });
    upload(key, item.file);
  }, [items, update, upload]);

  // After a send: forget the files it carried (or all), keeping any added while it went out.
  const clear = useCallback((keys) => {
    setItems((list) => (keys ? list.filter((item) => !keys.includes(item.key)) : []));
  }, []);

  return { items, summary: uploadSummary(items), add, remove, retry, clear };
}
