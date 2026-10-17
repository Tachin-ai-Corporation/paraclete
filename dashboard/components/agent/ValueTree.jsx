'use client';
// dashboard/components/agent/ValueTree.jsx: any JSON value as readable, nested key and value rows: the
// instance record, the release, the admin settings, the contracts, a project's deploy target. Keys
// that start with an underscore are the contracts' notes on a section; they show as text above its
// fields rather than as fields.

import styles from './ValueTree.module.css';

const isScalar = (value) => value === null || typeof value !== 'object';

function Scalar({ value }) {
  if (value === null || value === undefined) return <span className={styles.none}>none</span>;
  if (typeof value === 'boolean') return <span className={styles.bool}>{String(value)}</span>;
  if (typeof value === 'number') return <span className={styles.number}>{value}</span>;
  if (value === '') return <span className={styles.none}>empty</span>;
  return <span className={styles.string}>{String(value)}</span>;
}

/**
 * @param {{value: unknown}} props
 */
export function ValueTree({ value }) {
  if (isScalar(value)) return <Scalar value={value} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.none}>none</span>;
    if (value.every(isScalar)) {
      return (
        <span className={styles.chips}>
          {value.map((item, i) => <code key={i} className={styles.chip}>{item === null ? 'null' : String(item)}</code>)}
        </span>
      );
    }
    return (
      <ol className={styles.items}>
        {value.map((item, i) => <li key={i}><ValueTree value={item} /></li>)}
      </ol>
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className={styles.none}>none</span>;
  const notes = entries.filter(([key, v]) => key.startsWith('_') && typeof v === 'string');
  const fields = entries.filter(([key, v]) => !(key.startsWith('_') && typeof v === 'string'));
  return (
    <div className={styles.map}>
      {notes.map(([key, note]) => <p key={key} className={styles.note}>{note}</p>)}
      {fields.map(([key, v]) => (
        <div key={key} className={styles.row}>
          <span className={styles.key}>{key}</span>
          <div className={isScalar(v) || Array.isArray(v) ? styles.value : styles.nested}>
            <ValueTree value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}
