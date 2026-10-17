'use client';
// dashboard/components/Shell.jsx: the frame around every page for a signed-in user: the agent's name
// and install state, the navigation (with the count of approvals waiting), and who is signed in.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePoll } from '@/lib/client/use-poll.js';
import styles from './Shell.module.css';

const NAV = [
  { href: '/', label: 'Chat' },
  { href: '/work', label: 'Work' },
  { href: '/approvals', label: 'Approvals', badge: 'approvals' },
  { href: '/agent', label: 'Agent' },
  { href: '/library', label: 'Library' },
  { href: '/settings', label: 'Settings' },
];

const STATUS_BADGE = { ready: 'badge-ok', failed: 'badge-danger' };

export function Shell({ user, agentName, children }) {
  const pathname = usePathname() || '/';
  const { data: agent } = usePoll('/api/agent', 30_000);
  const { data: approvals } = usePoll('/api/approvals/count', 15_000);
  const counts = { approvals: approvals?.pending || 0 };
  const isActive = (href) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.agent}>
          <div className={styles.avatar} aria-hidden="true">{(agentName || 'P').charAt(0).toUpperCase()}</div>
          <div className={styles.agentText}>
            <div className={styles.agentName}>{agentName}</div>
            <span className={`badge ${STATUS_BADGE[agent?.status] || 'badge-neutral'}`} title={agent?.error || ''}>
              {agent ? agent.status : '…'}
            </span>
          </div>
        </div>
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={styles.navLink}
              aria-current={isActive(item.href) ? 'page' : undefined}
            >
              <span>{item.label}</span>
              {item.badge && counts[item.badge] > 0 && <span className={styles.count}>{counts[item.badge]}</span>}
            </Link>
          ))}
        </nav>
        <div className={styles.user}>
          <div className={styles.userEmail} title={user.email}>{user.email}</div>
          <div className="muted">{user.role === 'admin' ? 'Admin' : 'Member'}</div>
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
