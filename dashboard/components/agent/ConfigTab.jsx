'use client';
// dashboard/components/agent/ConfigTab.jsx: the Agent page's Config tab: the instance's configuration
// as the VM holds it (the `config` command): the instance record the bootstrap wrote, the installed
// release, the admin settings, and the contracts, the single source for the values the services
// share. None of it is secret: the record names the gateway token's file, never its content.

import { Disclosure } from './Disclosure.jsx';
import { ValueTree } from './ValueTree.jsx';
import { VmView } from './VmView.jsx';
import styles from './Agent.module.css';

const fieldCount = (value) => {
  if (!value || typeof value !== 'object') return '';
  const n = Object.keys(value).filter((key) => !key.startsWith('_')).length;
  return `${n} ${n === 1 ? 'value' : 'values'}`;
};

function Contracts({ contracts }) {
  if (!contracts || typeof contracts !== 'object') return <p className="muted">The VM sent no contracts.</p>;
  const entries = Object.entries(contracts);
  const notes = entries.filter(([key, value]) => key.startsWith('_') && typeof value === 'string');
  const scalars = entries.filter(([key, value]) => !key.startsWith('_') && (value === null || typeof value !== 'object'));
  const sections = entries.filter(([key, value]) => !key.startsWith('_') && value !== null && typeof value === 'object');
  return (
    <div className="stack">
      {notes.map(([key, note]) => <p key={key} className="muted">{note}</p>)}
      {scalars.length > 0 && <ValueTree value={Object.fromEntries(scalars)} />}
      <div>
        {sections.map(([key, value]) => (
          <Disclosure key={key} title={key} meta={<span>{fieldCount(value)}</span>}>
            <ValueTree value={value} />
          </Disclosure>
        ))}
      </div>
    </div>
  );
}

function Config({ result }) {
  return (
    <div className="stack">
      <div>
        <Disclosure title="Instance" meta={<span>written by the VM’s bootstrap at every install and upgrade</span>} defaultOpen>
          <ValueTree value={result.instance} />
        </Disclosure>
        <Disclosure title="Release" meta={<span>what is installed on the VM</span>}>
          {result.release ? <ValueTree value={result.release} /> : <p className="muted">The VM has no release record.</p>}
        </Disclosure>
        <Disclosure title="Admin settings" meta={<span>config/settings in Firestore</span>} defaultOpen>
          <ValueTree value={result.settings} />
        </Disclosure>
      </div>
      <section>
        <div className={styles.sectionHead}>
          <h2>Contracts</h2>
          <p className="muted">config/contracts.json as installed on the VM. It changes only with a release.</p>
        </div>
        <Contracts contracts={result.contracts} />
      </section>
      <Disclosure title="Everything as JSON">
        <pre className={styles.raw}>{JSON.stringify(result, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}

export function ConfigTab({ config }) {
  return <VmView command={config}>{(result) => <Config result={result} />}</VmView>;
}
