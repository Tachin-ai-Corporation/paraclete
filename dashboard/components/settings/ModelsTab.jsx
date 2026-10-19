'use client';
// dashboard/components/settings/ModelsTab.jsx: Settings, Models. The agent runs on Gemini; Claude Opus
// can run its cortex (decides each step) and its strong tier (plans, executes and verifies), with Gemini
// as the fallback. Every user sees whether Claude is on and with which model, read from the
// `brain_config` command. An admin also gets, in three steps:
//   1. Model Garden: a link per Claude model the contracts list, where a project owner enables it and
//      accepts Anthropic's terms;
//   2. Test: the `claude_check` command, which sends each of those models one short message from the
//      agent's VM and reports, model by model, whether it answered and the one thing to do if not;
//   3. the switch: `set_model` turns Claude on with the newest model that answered a recent test, or
//      off. Without a passing test the switch says why it is not offered (models-settings.js
//      switchDecision); the control service checks the model again and waits for the restarted
//      gateway to run it.
// Agent, Models stays the read-only view of every tier. SettingsView.jsx adds this tab.

import { useEffect, useState } from 'react';
import { useCommand } from '@/lib/client/use-command.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { ConfirmButton } from './ConfirmButton.jsx';
import { Notice } from './Notice.jsx';
import { candidateRows, checkSummary, claudeState, switchDecision, switchOutcome } from './models-settings.js';
import styles from './Settings.module.css';

function StateCard({ state }) {
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>
        Claude <span className={`badge ${state.on ? 'badge-info' : 'badge-neutral'}`}>{state.on ? 'on' : 'off'}</span>
      </h2>
      <p>
        {state.on
          ? `The cortex and the strong tier run ${state.label} (${state.model}), falling back to ${state.fallback || 'Gemini'}.`
          : 'Gemini runs every organ. Turned on, Claude runs the cortex and the strong tier, and Gemini stays the fallback.'}
      </p>
      {state.updatedBy && (
        <p className={`muted ${styles.small}`}>Last switched by {state.updatedBy}, {formatDate(state.updatedAt)}.</p>
      )}
      {state.ignored && (
        <p className={`error-text ${styles.small}`}>
          The stored choice, {String(state.ignored)}, is not a model this release can run, so {state.label} runs instead. Test and switch again to choose.
        </p>
      )}
      {state.gatewayDiffers && (
        <p className={`error-text ${styles.small}`}>
          The model gateway runs {state.running?.cortex || 'another model'} for the cortex: it has not restarted since the setting changed.
        </p>
      )}
    </div>
  );
}

function TestResult({ test }) {
  if (!test) return <span className="muted">Not tested</span>;
  if (test.ok) return <span className="badge badge-ok">Answers</span>;
  return <span className="badge badge-danger">{test.status ? `Failed (${test.status})` : 'Failed'}</span>;
}

function Candidates({ rows }) {
  return (
    <div className={styles.tableWrap}>
      <table className={`table ${styles.list}`}>
        <thead>
          <tr>
            <th>Model</th>
            <th>Last test</th>
            <th>What to do</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model}>
              <td>
                {row.label}
                {row.current && <>{' '}<span className="badge badge-info">running</span></>}
                <span className={styles.sub}><code>{row.id}</code></span>
                <span className={styles.sub}>
                  <a href={row.link} target="_blank" rel="noopener noreferrer">Open in Model Garden</a>
                </span>
              </td>
              <td className={styles.nowrap}><TestResult test={row.test} /></td>
              <td>
                {row.test && !row.test.ok && (
                  <>
                    <p>{row.test.fix}</p>
                    {row.test.error && <p className={`muted ${styles.small}`}>Google said: {row.test.error}</p>}
                  </>
                )}
                {row.test?.ok && row.best && <span className="muted">The newest model that answered</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminSteps({ state, project, onSwitched }) {
  const check = useCommand('claude_check');
  const switcher = useCommand('set_model');
  const [notice, setNotice] = useState(null);
  const busy = check.running || switcher.running;
  const result = check.result;
  const rows = candidateRows({ candidates: state.candidates, check: result, project, state });
  const decision = switchDecision({ state, check: result });

  async function runSwitch(enabling, model = null) {
    setNotice(null);
    const command = await switcher.run(enabling ? { claude_enabled: true, claude_model: model } : { claude_enabled: false });
    // Without a command the request itself failed, and switcher.error, shown below, says why.
    if (command) setNotice(switchOutcome(command, { enabling, model }));
    onSwitched();
  }

  return (
    <div className="stack">
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {switcher.error && !notice && !switcher.running && switcher.command?.status !== 'failed' && (
        <Notice notice={{ kind: 'error', text: `Not switched: ${switcher.error}` }} />
      )}

      <div className={`card ${styles.panel}`}>
        <h2 className={styles.panelTitle}>1. Accept Anthropic's terms in Model Garden</h2>
        <p className="muted">
          Claude on Vertex AI is billed to this project and needs a project owner to enable each model and accept
          Anthropic's terms, once, on the model's Model Garden page. The agent calls Claude from {state.location || 'its Claude region'}.
        </p>
        <Candidates rows={rows} />
      </div>

      <div className={`card ${styles.panel}`}>
        <h2 className={styles.panelTitle}>2. Test</h2>
        <p className="muted">
          Sends each model above one short message from the agent's VM, as the agent, and reports which ones answer. Each
          test costs a few tokens per model.
        </p>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setNotice(null); check.run(); }}>
            {check.running ? 'Testing…' : 'Test'}
          </button>
          {result && <span className="muted">{checkSummary(result)} Tested {timeAgo(result.checked_at)}.</span>}
        </div>
        {check.error && !check.running && <p className="error-text">The test did not finish: {check.error}</p>}
      </div>

      <div className={`card ${styles.panel}`}>
        <h2 className={styles.panelTitle}>3. Turn Claude on or off</h2>
        <p className="muted">The model gateway restarts with the new setting, which takes a few seconds.</p>
        <div className="row">
          {decision.allowed && (
            <ConfirmButton
              label={decision.action === 'switch' ? `Switch to ${decision.label}` : `Turn Claude on with ${decision.label}`}
              confirmLabel={decision.action === 'switch' ? `Switch to ${decision.label}` : `Turn on ${decision.label}`}
              prompt="The cortex and the strong tier move to it; Gemini stays the fallback."
              danger={false}
              disabled={busy}
              onConfirm={() => runSwitch(true, decision.model)}
            />
          )}
          {state.on && (
            <ConfirmButton
              label="Turn Claude off"
              confirmLabel="Turn off"
              prompt="Gemini runs every organ again."
              danger={false}
              disabled={busy}
              onConfirm={() => runSwitch(false)}
            />
          )}
          {switcher.running && <span className="muted">Switching; the gateway is restarting…</span>}
        </div>
        {!decision.allowed && <p className="muted">{decision.reason}</p>}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.me  GET /api/me
 */
export function ModelsTab({ me }) {
  const isAdmin = me.user?.role === 'admin';
  const config = useCommand('brain_config', { auto: true });
  // A refresh's command has no result until the VM answers: keep showing the last one meanwhile, so
  // the steps below (and the test they hold) stay in place.
  const [lastConfig, setLastConfig] = useState(null);
  useEffect(() => {
    if (config.result) setLastConfig(config.result);
  }, [config.result]);
  const state = claudeState(config.result || lastConfig);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Models</h2>
          <p>
            The agent runs on Gemini. Claude Opus can run its cortex, which decides each step of a mission, and its strong
            tier, which plans, executes and verifies; Gemini stays the fallback. Agent, Models shows every tier.
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => config.run()} disabled={config.running}>
          {config.running ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <AsyncState loading={!state && config.running} error={!state ? config.error : null}>
        {state && (
          <div className="stack">
            {config.error && !config.running && <p className="error-text">The agent's VM did not answer the refresh: {config.error}</p>}
            <StateCard state={state} />
            {isAdmin
              ? <AdminSteps state={state} project={me.dashboard?.project || ''} onSwitched={() => config.run()} />
              : <p className="muted">Only a dashboard admin can test the Claude models or turn Claude on or off.</p>}
          </div>
        )}
      </AsyncState>
    </section>
  );
}
