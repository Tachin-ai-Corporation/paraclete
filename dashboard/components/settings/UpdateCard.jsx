'use client';
// dashboard/components/settings/UpdateCard.jsx: Settings, System: the version card. Which release the
// agent and this dashboard run, the newer releases of the repository with their notes, and, for
// admins, Install (POST /api/upgrade) and Check now (POST /api/releases). While an upgrade runs, every
// user sees its steps: the agent's VM first, then the dashboard's build, then its rollout; the card
// polls GET /api/upgrade, which also moves the upgrade on. Once it is done, the card waits until the
// new dashboard answers (GET /api/me names the new commit; the old revision may answer for a moment)
// and reloads the page. What to say and offer is decided in release-update.js.
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { ConfirmButton } from './ConfirmButton.jsx';
import { Notice } from './Notice.jsx';
import {
  NOTE_LINES_SHOWN, RELOAD_WAIT_MS, cardStatus, installChoices, isNewDashboard, noteLines, runsText, shouldAwaitReload, showsFailure,
  upgradeSteps,
} from './release-update.js';
import settings from './Settings.module.css';
import styles from './UpdateCard.module.css';

const UPGRADE_POLL_MS = 5000;
const ME_POLL_MS = 3000;

export function UpdateCard({ me }) {
  const isAdmin = me.user?.role === 'admin';
  const releases = usePoll('/api/releases', 0);
  const upgradePoll = usePoll('/api/upgrade', UPGRADE_POLL_MS);
  const upgrade = upgradePoll.data?.upgrade ?? null;
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sawRunning, setSawRunning] = useState(false);
  useEffect(() => {
    if (upgrade?.running) setSawRunning(true);
  }, [upgrade?.running]);
  // Each step can change what the agent runs (the VM moves first), so the versions are read again.
  const refreshReleases = releases.refresh;
  const upgradeState = upgrade?.state;
  useEffect(() => {
    if (upgradeState) refreshReleases();
  }, [upgradeState, refreshReleases]);

  const data = releases.data;
  const awaiting = shouldAwaitReload(upgrade, me.dashboard?.commit, { sawRunning });
  const status = cardStatus(data, upgrade, { awaiting });
  const choices = isAdmin ? installChoices(data, upgrade, { awaiting }) : [];
  const refreshLocked = Boolean(data?.refresh_at && Date.parse(data.refresh_at) > Date.now());

  async function install(version) {
    setBusy(true);
    setNotice(null);
    try {
      await api('/api/upgrade', { method: 'POST', body: { version } });
      setSawRunning(true);
      await upgradePoll.refresh();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      await upgradePoll.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    setNotice(null);
    try {
      await api('/api/releases', { method: 'POST' });
      await releases.refresh();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={settings.section}>
      <div className={settings.sectionHeader}>
        <div>
          <h2>
            Version <span className={`badge badge-${status.level}`}>{status.label}</span>
          </h2>
          <p>{status.summary}</p>
        </div>
        {isAdmin && data?.repo && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={checkNow}
            disabled={busy || refreshLocked}
            title={refreshLocked ? `GitHub was asked moments ago; again from ${formatDate(data.refresh_at)}` : 'Ask GitHub for releases now'}
          >
            Check now
          </button>
        )}
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {!data && releases.error && <Notice notice={{ kind: 'error', text: releases.error.message }} />}
      {data && (
        <div className={`card ${settings.panel} ${styles.card}`}>
          <dl className={settings.facts}>
            <dt>Agent</dt>
            <dd>
              {runsText(data.installed?.agent)}
              {data.installed?.agent?.status && data.installed.agent.status !== 'ready' && (
                <span className="muted"> · {data.installed.agent.status}</span>
              )}
            </dd>
            <dt>Dashboard</dt>
            <dd>{runsText(data.installed?.dashboard)}</dd>
            {data.repo && (
              <>
                <dt>Releases of</dt>
                <dd>
                  {data.repo}
                  {data.checked_at && <span className="muted"> · checked {timeAgo(data.checked_at)}</span>}
                </dd>
              </>
            )}
          </dl>
          {data.error && <p className={`error-text ${settings.small}`}>{data.error}</p>}
          {upgrade && (upgrade.running || showsFailure(data, upgrade) || awaiting) && (
            <Progress upgrade={upgrade} isAdmin={isAdmin} awaiting={awaiting} />
          )}
          {upgradePoll.error && upgrade?.running && (
            <p className={`error-text ${settings.small}`}>The upgrade's progress could not be read just now: {upgradePoll.error.message}</p>
          )}
          <Releases
            releases={data}
            choices={choices}
            busy={busy || Boolean(upgrade?.running)}
            onInstall={install}
          />
        </div>
      )}
    </section>
  );
}

function Progress({ upgrade, isAdmin, awaiting }) {
  if (upgrade.state === 'failed') {
    return (
      <div className={styles.progress} role="alert">
        <h3>
          Installing {upgrade.version} failed{' '}
          <span className="muted">{upgrade.updated_at ? `· ${timeAgo(upgrade.updated_at)}` : ''}</span>
        </h3>
        <p className="error-text">{upgrade.error || 'No reason was recorded.'}</p>
        {isAdmin && upgrade.build_log_url && (
          <p className={settings.small}>
            <a href={upgrade.build_log_url} target="_blank" rel="noreferrer">The build's log in the Cloud console</a>
          </p>
        )}
      </div>
    );
  }
  const steps = upgradeSteps(upgrade);
  return (
    <div className={styles.progress} role="status">
      <h3>
        {upgrade.state === 'done' ? `Installed ${upgrade.version}` : `Installing ${upgrade.version}`}{' '}
        <span className="muted">
          · asked for by {upgrade.requested_by || 'an admin'} {upgrade.requested_at ? timeAgo(upgrade.requested_at) : ''}
        </span>
      </h3>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <li key={step.key} className={styles[step.state]}>
            <span className={styles.mark} aria-hidden="true" />
            <span>
              {step.label}
              {step.state === 'done' && <span className="muted"> · done</span>}
              {step.detail && <span className={settings.sub}>{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {upgrade.notice && <p className={`muted ${settings.small}`}>{upgrade.notice}</p>}
      {isAdmin && upgrade.build_log_url && upgrade.state === 'build' && (
        <p className={settings.small}>
          <a href={upgrade.build_log_url} target="_blank" rel="noreferrer">Follow the build in the Cloud console</a>
        </p>
      )}
      {awaiting && <AwaitReload upgrade={upgrade} />}
    </div>
  );
}

/** Waits for the dashboard on the upgrade's commit to answer, then reloads the page. */
function AwaitReload({ upgrade }) {
  const me = usePoll('/api/me', ME_POLL_MS);
  const [late, setLate] = useState(false);
  const ready = isNewDashboard(me.data, upgrade);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), RELOAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (ready) window.location.reload();
  }, [ready]);
  if (ready) return <p className={settings.small}>The new dashboard answers; reloading.</p>;
  return (
    <p className={settings.small}>
      {late
        ? 'The new dashboard has not answered yet. Cloud Run may still be starting it; reload the page in a minute. '
        : 'Waiting for the new dashboard to answer; this page then reloads by itself. '}
      {late && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.location.reload()}>
          Reload now
        </button>
      )}
    </p>
  );
}

function Releases({ releases, choices, busy, onInstall }) {
  const newer = releases.newer || [];
  const repair = releases.repair && choices.includes(releases.repair) ? releases.repair : null;
  if (!newer.length && !repair) return null;
  return (
    <div className={styles.releases}>
      {repair && (
        <div className={styles.release}>
          <div className={styles.releaseHead}>
            <strong>{repair}</strong>
            <span className="muted">the agent runs it; this dashboard does not yet</span>
            <InstallButton version={repair} again busy={busy} onInstall={onInstall} />
          </div>
        </div>
      )}
      {newer.length > 0 && <h3>{newer.length === 1 ? 'A newer release' : `${newer.length} newer releases`}</h3>}
      {newer.map((release) => (
        <Release
          key={release.version}
          release={release}
          action={choices.includes(release.version) ? <InstallButton version={release.version} busy={busy} onInstall={onInstall} /> : null}
        />
      ))}
    </div>
  );
}

function InstallButton({ version, again = false, busy, onInstall }) {
  return (
    <ConfirmButton
      label={again ? 'Finish installing' : 'Install'}
      confirmLabel={`Install ${version}`}
      prompt="The agent restarts on it, then the dashboard is rebuilt and replaced: about ten minutes."
      danger={false}
      disabled={busy}
      onConfirm={() => onInstall(version)}
    />
  );
}

function Release({ release, action }) {
  const [open, setOpen] = useState(false);
  const notes = noteLines(release.notes, open ? Infinity : NOTE_LINES_SHOWN);
  return (
    <div className={styles.release}>
      <div className={styles.releaseHead}>
        <strong>{release.version}</strong>
        {release.name && release.name !== release.version && <span>{release.name}</span>}
        {release.published_at && <span className="muted">{formatDate(release.published_at)}</span>}
        {release.url && (
          <a href={release.url} target="_blank" rel="noreferrer" className={settings.small}>On GitHub</a>
        )}
        {action}
      </div>
      {notes.lines.length > 0 ? (
        <ul className={styles.notes}>
          {notes.lines.map((line, i) => (
            // Lines can repeat, so their place in the list is part of the key.
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className={styles[line.kind]}>{line.text}</li>
          ))}
        </ul>
      ) : (
        <p className={`muted ${settings.small}`}>No notes.</p>
      )}
      {(notes.more > 0 || open) && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${notes.more} more lines)`}
        </button>
      )}
    </div>
  );
}
