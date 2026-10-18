'use client';
// dashboard/components/settings/SettingsView.jsx: the Settings page. Its tabs, the open one kept in the
// URL hash: Users and Secrets for admins (a member sees a note instead), Workspace on a role with a
// Google Workspace account (workspace/WorkspaceTab.jsx), System and Setup for everyone. Who is asking
// and what the dashboard was built from come from GET /api/me, read once; whether the role has a
// Workspace account, and its state, from GET /api/workspace, which the Setup checklist shows too.
import { usePoll } from '@/lib/client/use-poll.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { Tabs, useHashTab } from '@/components/ui/Tabs.jsx';
import { UsersTab } from './UsersTab.jsx';
import { SecretsTab } from './SecretsTab.jsx';
import { SystemTab } from './SystemTab.jsx';
import { SetupTab } from './SetupTab.jsx';
import { WorkspaceTab } from './workspace/WorkspaceTab.jsx';
import styles from './Settings.module.css';

const TABS = [
  { key: 'users', label: 'Users' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'workspace', label: 'Workspace', workspaceOnly: true },
  { key: 'system', label: 'System' },
  { key: 'setup', label: 'Setup' },
];
const KEYS = TABS.map((tab) => tab.key);

const ADMIN_ONLY = {
  users: 'Dashboard admins add and remove users and change their roles. Ask one of them if someone needs access.',
  secrets: 'Dashboard admins manage the secrets the agent can use. Ask one of them to add or change one.',
};

export function SettingsView() {
  const { data: me, error, loading } = usePoll('/api/me', 0);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Who can use this dashboard, the agent's secrets, how its system is running, and what setup is left.</p>
        </div>
      </div>
      <AsyncState loading={loading && !me} error={me ? null : error}>
        {me && <SettingsTabs me={me} />}
      </AsyncState>
    </div>
  );
}

function SettingsTabs({ me }) {
  const isAdmin = me.user?.role === 'admin';
  const [active, select] = useHashTab(KEYS, isAdmin ? 'users' : 'setup');
  const workspace = usePoll('/api/workspace', 0);
  const tabs = TABS.filter((tab) => !tab.workspaceOnly || workspace.data?.needed);
  const adminOnly = !isAdmin && ADMIN_ONLY[active];
  return (
    <>
      <Tabs tabs={tabs} active={active} onSelect={select} />
      {adminOnly && <p className={`card ${styles.adminOnly}`}>{adminOnly}</p>}
      {isAdmin && active === 'users' && <UsersTab me={me.user} />}
      {isAdmin && active === 'secrets' && <SecretsTab />}
      {active === 'workspace' && (
        <AsyncState loading={!workspace.data && !workspace.error} error={workspace.data ? null : workspace.error}>
          {workspace.data && <WorkspaceTab workspace={workspace.data} refresh={workspace.refresh} isAdmin={isAdmin} />}
        </AsyncState>
      )}
      {active === 'system' && <SystemTab me={me} />}
      {active === 'setup' && <SetupTab me={me} workspace={workspace} />}
    </>
  );
}
