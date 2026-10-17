'use client';
// dashboard/components/agent/BrainTab.jsx: the Agent page's Brain tab: the effort setting, and the
// models the brain runs on (the `brain_config` command).

import { EffortPanel } from './EffortPanel.jsx';
import { ModelsPanel } from './ModelsPanel.jsx';
import { VmView } from './VmView.jsx';
import styles from './Agent.module.css';

export function BrainTab({ brainConfig, status, isAdmin }) {
  return (
    <div className="stack">
      <EffortPanel isAdmin={isAdmin} status={status} />
      <section>
        <div className={styles.sectionHead}>
          <h2>Models</h2>
          <p className="muted">The models each part of the brain runs on, as the contracts set them and as the running gateway reports them.</p>
        </div>
        <VmView command={brainConfig}>{(result) => <ModelsPanel config={result} />}</VmView>
      </section>
    </div>
  );
}
