'use client';
// dashboard/components/library/LibraryView.jsx: the Library page. What the agent does on its own
// (its responsibilities, from the VM through the `responsibilities` command), the playbooks it follows
// for kinds of work, and the projects it works within (both read from Firestore through
// /api/library/). Admins switch a responsibility on or off and run one now; everything else is
// read-only here.

import { useState } from 'react';
import { Tabs, useHashTab } from '@/components/ui/Tabs.jsx';
import { usePoll } from '@/lib/client/use-poll.js';
import { useLazyCommand } from '@/components/agent/use-lazy-command.js';
import { ResponsibilitiesTab } from './ResponsibilitiesTab.jsx';
import { ProcessesTab } from './ProcessesTab.jsx';
import { ProjectsTab } from './ProjectsTab.jsx';

const TABS = [
  { key: 'responsibilities', label: 'Responsibilities' },
  { key: 'processes', label: 'Processes' },
  { key: 'projects', label: 'Projects' },
];
const KEYS = TABS.map((tab) => tab.key);

export function LibraryView() {
  const [tab, setTab] = useHashTab(KEYS, 'responsibilities');
  const { data: me } = usePoll('/api/me', 0);
  const isAdmin = me?.user?.role === 'admin';
  const responsibilities = useLazyCommand('responsibilities', tab === 'responsibilities');
  // The open playbook and project survive switching tabs.
  const [processId, setProcessId] = useState(null);
  const [projectId, setProjectId] = useState(null);

  const openProcess = (id) => {
    setProcessId(id);
    setTab('processes');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p>What the agent does on its own schedule, the playbooks it follows, and the projects it works within.</p>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      {tab === 'responsibilities' && <ResponsibilitiesTab list={responsibilities} isAdmin={isAdmin} />}
      {tab === 'processes' && <ProcessesTab selected={processId} onSelect={setProcessId} />}
      {tab === 'projects' && <ProjectsTab selected={projectId} onSelect={setProjectId} onOpenProcess={openProcess} />}
    </div>
  );
}
