'use client';
// dashboard/components/settings/DriveCard.jsx: the body of the Setup tab's Drive item. Three parts:
//   - the address to share Drive files and folders with, with a copy button;
//   - Test Drive (admins): sends the drive_check command, which runs on the VM as the agent's Drive
//     identity, and shows what it found (drive-settings.js driveCheckView): who the agent is on Drive,
//     whether Drive answers, what is shared with it, its shared drives, whether it can write to the
//     output folder, and the advice the check gave;
//   - the output folder (GET and PATCH /api/settings/drive): where the agent saves files to Drive when
//     nobody names a folder. Admins paste a folder link or id, which is parsed here to the id.
// SetupTab.jsx owns the drive_check command, so the checklist item's state follows the same result.

import { Fragment, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { timeAgo } from '@/lib/client/format.js';
import { CopyButton } from './CopyButton.jsx';
import { driveCheckView, folderLink, parseDriveFolder } from './drive-settings.js';
import settingsStyles from './Settings.module.css';
import styles from './DriveCard.module.css';

function CheckResult({ check }) {
  const view = driveCheckView(check.result);
  if (!view) return null;
  return (
    <div className={styles.result}>
      <dl className={settingsStyles.facts}>
        {view.lines.map((line) => (
          <Fragment key={line.label}>
            <dt>{line.label}</dt>
            <dd className={line.problem ? 'error-text' : undefined}>{line.text}</dd>
          </Fragment>
        ))}
      </dl>
      {view.sample.length > 0 && (
        <div>
          <p className="muted">Some of what is shared with it:</p>
          <ul className={styles.sample}>
            {view.sample.map((file) => (
              <li key={file.id}>
                {file.name}
                {file.owner && <span className="muted">{` · shared by ${file.owner}`}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.advice.length > 0 && (
        <div className={styles.advice}>
          <h4>What to do</h4>
          <ul>{view.advice.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </div>
      )}
      {check.command?.finished_at && <p className="muted">Checked {timeAgo(check.command.finished_at)}.</p>}
    </div>
  );
}

function OutputFolder({ isAdmin }) {
  const { data, error, refresh } = usePoll('/api/settings/drive', 0);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const parsed = parseDriveFolder(value);
  const typed = value.trim();
  const current = data?.drive_output_folder || null;

  async function save(id) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api('/api/settings/drive', { method: 'PATCH', body: { drive_output_folder: id } });
      await refresh();
      setValue('');
      setSaved(true);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.part}>
      <h4>Output folder</h4>
      <p className="muted">
        Where the agent saves files to Drive when nobody names a folder. For its service account this must be a
        folder in a shared drive it is a member of (as Content manager), since a service account has no Drive
        storage of its own.
      </p>
      {error && <p className="error-text">The setting could not be read: {error.message}</p>}
      {data && (
        <p>
          {current ? (
            <>
              Set to{' '}
              <a href={folderLink(current)} target="_blank" rel="noopener noreferrer"><code>{current}</code></a>
              {data.updated_by && <span className="muted">{` by ${data.updated_by} ${timeAgo(data.updated_at)}`}</span>}.
            </>
          ) : (
            <span className="muted">None set.</span>
          )}
        </p>
      )}
      {data?.invalid && <p className="error-text">What is stored is not a folder id, so the agent ignores it. Set a folder to replace it.</p>}
      {isAdmin ? (
        <form
          className={styles.folderForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.id) save(parsed.id);
          }}
        >
          <input
            className="input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setSaved(false);
            }}
            placeholder="A Drive folder link or id"
            aria-label="Output folder: a Drive folder link or id"
            disabled={saving}
          />
          <button type="submit" className="btn btn-sm" disabled={saving || !parsed.id}>{saving ? 'Saving…' : 'Save'}</button>
          {current && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => save(null)} disabled={saving}>Clear</button>
          )}
        </form>
      ) : (
        <p className="muted">Only a dashboard admin can change it.</p>
      )}
      {typed && parsed.error && <p className="error-text">{parsed.error}</p>}
      {typed && parsed.id && parsed.id !== typed && <p className="muted">Folder id: <code>{parsed.id}</code></p>}
      {saveError && <p className="error-text">Not saved: {saveError}</p>}
      {saved && <p className="muted">Saved. Run Test Drive to check the agent can write there.</p>}
    </div>
  );
}

/**
 * @param {object}  props
 * @param {string}  props.address  the address to share with
 * @param {boolean} props.isAdmin
 * @param {object}  props.check    useCommand('drive_check')
 */
export function DriveCard({ address, isAdmin, check }) {
  return (
    <div className={styles.card}>
      {address && (
        <div className={settingsStyles.address}>
          <code>{address}</code>
          <CopyButton text={address} label="Copy address" />
        </div>
      )}
      <div className={styles.part}>
        <div className={styles.head}>
          <h4>Test Drive</h4>
          {isAdmin ? (
            <button type="button" className="btn btn-sm" onClick={() => check.run()} disabled={check.running}>
              {check.running ? 'Testing…' : 'Test Drive'}
            </button>
          ) : (
            <span className="muted">Only a dashboard admin can run it.</span>
          )}
        </div>
        <p className="muted">
          Checks, as the agent, that it reaches Drive, what is shared with it and which shared drives it belongs to,
          and that it can write to the output folder (it creates a small file there and deletes it again).
        </p>
        {/* Without a result, the checklist item already says why the test did not finish. */}
        {check.error && check.result && <p className="error-text">The last test did not finish ({check.error}); what follows is from the one before.</p>}
        <CheckResult check={check} />
      </div>
      <OutputFolder isAdmin={isAdmin} />
    </div>
  );
}
