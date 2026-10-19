'use client';
// dashboard/components/agent/ModelsPanel.jsx: what the brain runs on, from the `brain_config` command:
// whether Claude is on, each model tier as the contracts set it beside what the running gateway
// reports, where the models are served, the step budget of an organ turn, and the models the
// services call directly. The Claude switch itself is in Settings, Models; this shows its state.
//
// With Claude on, the cortex and strong tiers move to the Claude model (the settings' `claude_model`:
// the admin's tested choice, else the contracts' Claude model) and the fallback to its Claude fallback;
// the fast tier stays (organModels in agent/services/gateway/settings.mjs). The gateway reads the switch
// when it starts, so a gateway that differs from the setting has not been restarted since it changed.

import { formatDate } from '@/lib/client/format.js';
import { MODEL_TIERS } from './organs.js';
import styles from './Agent.module.css';

function expectedModels(tiers, claudeOn, claude) {
  if (!claudeOn) return { cortex: tiers.cortex, strong: tiers.strong, fast: tiers.fast, fallback: tiers.fallback };
  return { cortex: claude, strong: claude, fast: tiers.fast, fallback: tiers.claude_fallback };
}

function Gateway({ running }) {
  if (!running) return null;
  const providers = running.providers && typeof running.providers === 'object' ? Object.entries(running.providers) : [];
  return (
    <div className={styles.gateway}>
      <div className="row">
        <strong>Gateway</strong>
        <span className={`badge ${running.reachable ? 'badge-ok' : 'badge-danger'}`}>{running.reachable ? 'reachable' : 'not reachable'}</span>
        {running.reachable && <span className={`badge ${running.ready ? 'badge-ok' : 'badge-warn'}`}>{running.ready ? 'ready' : 'not ready'}</span>}
        {typeof running.uptime_sec === 'number' && <span className="muted">{`up ${Math.round(running.uptime_sec / 60)} min`}</span>}
        {typeof running.requests === 'number' && <span className="muted">{`${running.requests} turns served`}</span>}
        {typeof running.sessions === 'number' && <span className="muted">{`${running.sessions} open sessions`}</span>}
      </div>
      {providers.length > 0 && (
        <div className="row">
          {providers.map(([id, info]) => (
            <span key={id} className={`badge ${info?.available ? 'badge-ok' : 'badge-neutral'}`} title={info?.location ? `location ${info.location}` : ''}>
              {`${id}${info?.available ? '' : ' (unavailable)'}`}
            </span>
          ))}
        </div>
      )}
      {running.error && <p className="error-text">{running.error}</p>}
    </div>
  );
}

export function ModelsPanel({ config }) {
  const { settings = {}, tiers = {}, locations = {}, running = null, organ_max_steps: maxSteps, service_models: services = {} } = config;
  const claudeOn = settings.claude_enabled === true;
  const claude = settings.claude_model || tiers.claude;
  const expected = expectedModels(tiers, claudeOn, claude);
  const runs = running?.models || null;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 className={styles.cardTitle}>Claude</h2>
          <span className={`badge ${claudeOn ? 'badge-info' : 'badge-neutral'}`}>{claudeOn ? 'on' : 'off'}</span>
        </div>
        <p className="muted">
          {claudeOn
            ? `The cortex and the strong tier run on ${claude}, falling back to ${tiers.claude_fallback}.`
            : `Gemini runs every organ. Turned on, Claude (${claude}) runs the cortex and the strong tier.`}
          {settings.claude_updated_by && ` Last switched by ${settings.claude_updated_by}, ${formatDate(settings.claude_updated_at)}.`}
          {' '}Shown read-only here; admins test and switch it in Settings, Models.
        </p>
      </div>

      <div className="card">
        <h2 className={styles.cardTitle}>Model tiers</h2>
        <div className={styles.tableWrap}>
          <table className="table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Serves</th>
                <th>Gateway runs</th>
                <th>{claudeOn ? 'Expected with Claude on' : 'Contracts'}</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_TIERS.map((tier) => {
                const actual = runs?.[tier.id];
                const differs = Boolean(actual) && actual !== expected[tier.id];
                return (
                  <tr key={tier.id}>
                    <td><strong>{tier.label}</strong></td>
                    <td className="muted">{tier.serves}</td>
                    <td>
                      {actual ? <code>{actual}</code> : <span className="muted">not reported</span>}
                      {differs && <span className="badge badge-warn" title="The gateway reads the settings when it starts">differs</span>}
                    </td>
                    <td><code>{expected[tier.id] || '—'}</code></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {runs && MODEL_TIERS.some((t) => runs[t.id] && runs[t.id] !== expected[t.id]) && (
          <p className="error-text">The gateway runs models other than the settings imply: it has not restarted since they changed.</p>
        )}
        <Gateway running={running} />
      </div>

      <div className="card">
        <h2 className={styles.cardTitle}>Serving</h2>
        <dl className={styles.facts}>
          <dt>Gemini location</dt>
          <dd><code>{locations.google || '—'}</code></dd>
          <dt>Claude location</dt>
          <dd><code>{locations.anthropic || '—'}</code></dd>
          <dt>Organ turn budget</dt>
          <dd>{typeof maxSteps === 'number' ? `Up to ${maxSteps} model calls per organ turn, tool steps included` : '—'}</dd>
          <dt>Utility model</dt>
          <dd><code>{services.utility || '—'}</code> <span className="muted">classifies intake, writes acknowledgments, digests results</span></dd>
          <dt>Ears</dt>
          <dd><code>{services.ears_preprocess || '—'}</code> <span className="muted">repairs Google Chat messages the Chat formatting mangled</span></dd>
          <dt>Mouth</dt>
          <dd><code>{services.mouth || '—'}</code> <span className="muted">voices replies and status notes</span></dd>
        </dl>
      </div>
    </div>
  );
}
