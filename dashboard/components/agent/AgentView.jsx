'use client';
// dashboard/components/agent/AgentView.jsx: the Agent page. Who the agent is (its install state and
// persona), what its brain runs on and how hard it works (effort, models), what it remembers, the
// skills it has, and its configuration. Most of it lives on the VM and is asked for through read-only
// commands, each sent the first time its tab opens; Core Memory and the effort setting are read from
// Firestore through the dashboard's own routes. Only admins change anything here (the effort).

import { Tabs, useHashTab } from '@/components/ui/Tabs.jsx';
import { usePoll } from '@/lib/client/use-poll.js';
import { useLazyCommand } from './use-lazy-command.js';
import { OverviewTab } from './OverviewTab.jsx';
import { BrainTab } from './BrainTab.jsx';
import { MemoryTab } from './MemoryTab.jsx';
import { SkillsTab } from './SkillsTab.jsx';
import { ConfigTab } from './ConfigTab.jsx';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'brain', label: 'Brain' },
  { key: 'memory', label: 'Memory' },
  { key: 'skills', label: 'Skills' },
  { key: 'config', label: 'Config' },
];
const KEYS = TABS.map((tab) => tab.key);

export function AgentView() {
  const [tab, setTab] = useHashTab(KEYS, 'overview');
  const { data: me } = usePoll('/api/me', 0);
  const { data: agent, error: agentError, loading: agentLoading } = usePoll('/api/agent', 30_000);
  const isAdmin = me?.user?.role === 'admin';

  // One command per view, sent when its tab first opens and kept while the page is open.
  const workspace = useLazyCommand('workspace', tab === 'overview' || tab === 'memory');
  const brainConfig = useLazyCommand('brain_config', tab === 'brain');
  const status = useLazyCommand('status', tab === 'brain');
  const skills = useLazyCommand('skills', tab === 'skills');
  const config = useLazyCommand('config', tab === 'config');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{agent?.name || 'Agent'}</h1>
          <p>{agent ? `Role: ${agent.role}` : 'Who the agent is, what it runs on, and what it knows.'}</p>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      {tab === 'overview' && <OverviewTab agent={agent} agentError={agentError} agentLoading={agentLoading} workspace={workspace} />}
      {tab === 'brain' && <BrainTab brainConfig={brainConfig} status={status} isAdmin={isAdmin} />}
      {tab === 'memory' && <MemoryTab workspace={workspace} />}
      {tab === 'skills' && <SkillsTab skills={skills} />}
      {tab === 'config' && <ConfigTab config={config} />}
    </div>
  );
}
