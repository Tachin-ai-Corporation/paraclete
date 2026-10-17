'use client';
// dashboard/components/settings/CopyButton.jsx: copies a value (the agent's service-account address) to
// the clipboard and says so for a moment. Where the browser refuses the clipboard, the value beside it
// is still there to select.
import { useEffect, useRef, useState } from 'react';

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="btn btn-sm" onClick={copy} disabled={!text}>
      {copied ? 'Copied' : label}
    </button>
  );
}
