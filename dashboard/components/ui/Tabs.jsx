'use client';
// dashboard/components/ui/Tabs.jsx: tabs that remember the open one in the URL hash (#memory), so a
// link or a reload lands on the same tab.
import { useCallback, useEffect, useState } from 'react';

/**
 * @param {string[]} keys
 * @param {string}   fallback
 * @returns {[string, (key: string) => void]}
 */
export function useHashTab(keys, fallback) {
  const [active, setActive] = useState(fallback);
  useEffect(() => {
    const read = () => {
      const key = window.location.hash.replace(/^#/, '');
      setActive(keys.includes(key) ? key : fallback);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
    // keys is a constant list per page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallback]);
  const select = useCallback((key) => {
    setActive(key);
    window.history.replaceState(null, '', `#${key}`);
  }, []);
  return [active, select];
}

/**
 * @param {{tabs: {key: string, label: string}[], active: string, onSelect: (key: string) => void}} props
 */
export function Tabs({ tabs, active, onSelect }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.key} type="button" role="tab" className="tab" aria-selected={tab.key === active} onClick={() => onSelect(tab.key)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
