'use client';
// dashboard/components/agent/SkillsTab.jsx: the Agent page's Skills tab: every skill on the instance
// in the gateway's catalog order (the `skills` command), grouped by where it comes from: the base
// skills every agent has, the generic role's, the instance role's, and the ones the agent wrote. Each
// shows when to use it, the organs that may, the commands it brings, and its SKILL.md.

import { useMemo, useState } from 'react';
import { Markdown } from '@/components/ui/Markdown.jsx';
import { Disclosure } from './Disclosure.jsx';
import { VmView } from './VmView.jsx';
import styles from './Agent.module.css';

/** A manifest list item as text: the installed skills list names, but a skill the agent wrote may not. */
const label = (item) => (typeof item === 'string' ? item : JSON.stringify(item));

function originLabel(origin) {
  if (origin === 'base') return 'Base skills';
  if (origin === 'agent') return 'Written by the agent';
  if (String(origin).startsWith('role:')) return `The ${origin.slice(5)} role`;
  return origin || 'Other';
}

function originAbout(origin) {
  if (origin === 'base') return 'Every agent has these.';
  if (origin === 'agent') return 'Skills the agent wrote for itself, kept under its data root.';
  if (origin === 'role:generic') return 'The base role every role builds on.';
  return 'Added by the instance’s role.';
}

function Skill({ skill }) {
  return (
    <div className={styles.skill}>
      <div className={styles.skillHead}>
        <h3>{skill.name}</h3>
        {skill.id !== skill.name && <code className="muted">{skill.id}</code>}
        {skill.version !== '' && skill.version != null && <span className="badge badge-plain">{`v${skill.version}`}</span>}
        {skill.problem && <span className="badge badge-warn">{skill.problem}</span>}
      </div>
      {skill.when_to_use && <p>{skill.when_to_use}</p>}
      <dl className={styles.facts}>
        {skill.organs.length > 0 && (
          <>
            <dt>Organs</dt>
            <dd className={styles.chips}>{skill.organs.map((organ, i) => <span key={i} className={styles.chip}>{label(organ)}</span>)}</dd>
          </>
        )}
        {skill.commands.length > 0 && (
          <>
            <dt>Commands</dt>
            <dd className={styles.chips}>{skill.commands.map((command, i) => <code key={i} className={styles.chip}>{label(command)}</code>)}</dd>
          </>
        )}
      </dl>
      {skill.skill_md !== null ? (
        <Disclosure title="SKILL.md" meta={skill.skill_md_truncated ? <span className="badge badge-warn">cut</span> : null}>
          <Markdown>{skill.skill_md}</Markdown>
          {skill.skill_md_truncated && <p className="muted">Cut: only the start of this SKILL.md is shown.</p>}
        </Disclosure>
      ) : (
        <p className="muted">
          {skill.skill_md_truncated ? 'SKILL.md not shown: the view reached its size limit before this skill.' : 'This skill has no SKILL.md.'}
        </p>
      )}
    </div>
  );
}

function SkillList({ skills }) {
  const [search, setSearch] = useState('');
  const groups = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found = skills.filter((s) => {
      const haystack = [s.name, s.id, s.when_to_use, ...s.organs.map(label), ...s.commands.map(label)].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    const byOrigin = new Map();
    for (const skill of found) {
      if (!byOrigin.has(skill.origin)) byOrigin.set(skill.origin, []);
      byOrigin.get(skill.origin).push(skill);
    }
    return [...byOrigin.entries()];
  }, [skills, search]);

  if (skills.length === 0) return <p className="muted">The VM reported no skills.</p>;
  return (
    <div className="stack">
      <input
        className={`input ${styles.search}`}
        type="search"
        placeholder="Search skills, organs, commands"
        aria-label="Search skills"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {groups.length === 0 && <p className="muted">No skill matches.</p>}
      {groups.map(([origin, list]) => (
        <section key={origin}>
          <div className={styles.sectionHead}>
            <h2>{`${originLabel(origin)} (${list.length})`}</h2>
            <p className="muted">{originAbout(origin)}</p>
          </div>
          <div className={styles.skillList}>
            {list.map((skill) => <Skill key={`${origin}-${skill.id}`} skill={skill} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SkillsTab({ skills }) {
  return <VmView command={skills}>{(result) => <SkillList skills={result.skills || []} />}</VmView>;
}
