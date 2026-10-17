'use client';
// dashboard/components/agent/use-lazy-command.js: a read-only command sent the first time a view wants
// it, and kept for the rest of the page's life. The Agent and Library pages hold one per tab at the
// page level, so a tab's answer from the VM survives switching tabs and back, and a tab nobody opens
// costs the VM nothing. Refreshing is the hook's run().
//
// The ask waits a moment: a page first renders its default tab and only then reads the tab named in
// the URL, and the default tab's command should not be sent on the way past it.

import { useEffect, useRef } from 'react';
import { useCommand } from '@/lib/client/use-command.js';

const SETTLE_MS = 50;

/**
 * @param {string}  type    a read-only command (agent/services/control/README.md)
 * @param {boolean} wanted  true once a view needs the answer
 * @returns {ReturnType<typeof useCommand>}
 */
export function useLazyCommand(type, wanted) {
  const command = useCommand(type);
  const asked = useRef(false);
  const { run } = command;
  useEffect(() => {
    if (!wanted || asked.current) return undefined;
    const timer = setTimeout(() => {
      asked.current = true;
      run();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wanted, run]);
  return command;
}
