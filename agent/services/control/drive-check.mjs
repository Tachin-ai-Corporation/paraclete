// agent/services/control/drive-check.mjs: the drive_check command, the dashboard's Test Drive button. It
// checks, as the agent's own Drive identity (agent/providers/drive.mjs picks it: the agent's Workspace
// account when it has one, else the VM's service account), what the agent can reach in Google Drive:
// whether Drive answers at all, what is shared with it, which shared drives it belongs to, and whether
// the admin's output folder (config/settings drive_output_folder) takes new files. The write test
// creates one small file there and moves it straight to the trash; nothing else in Drive is touched.
// Every finding that needs a person's action becomes a plain sentence in `advice`, including the
// organization-wide sharing block that also shuts out a service account. The result shape is
// README.md's. commands.mjs calls it.

import { readAdminSettings } from '../service-runtime.mjs';
import { describeType, FOLDER_MIME } from '../../providers/drive.mjs';

/** Files shared with the agent are counted up to this many; `capped` says there are more. */
const SHARED_COUNT_CAP = 100;
/** How many of them the result names. */
const SAMPLE_SIZE = 5;
const TEST_FILE_TEXT = "This file was made by the paraclete agent's Drive check, which moves it to the trash straight away. If you can see it, the check could not remove it: you can delete it.\n";

/**
 * Runs the check. A Drive failure is reported in the result, never thrown; a Firestore failure
 * reading the settings is thrown, which fails the command.
 *
 * @param {object}   o
 * @param {object}   o.drive  a client from createDriveClient()
 * @param {object}   o.db     a client from agent/storage/firestore.mjs
 * @param {Function} [o.now]  () => Date, for the test file's name
 * @returns {Promise<object>} the drive_check result
 */
export async function checkDrive({ drive, db, now = () => new Date() }) {
  const { kind, email } = drive.identity();
  const serviceAccount = kind === 'service_account';
  const settings = await readAdminSettings(db, { strict: true });
  const folderId = typeof settings.drive_output_folder === 'string' && settings.drive_output_folder.trim()
    ? settings.drive_output_folder.trim()
    : null;

  const result = {
    identity: { kind, email },
    reachable: false,
    error: null,
    shared_with_me: { count: 0, capped: false, sample: [] },
    shared_drives: [],
    output_folder: null,
    advice: [],
  };
  const advise = (sentence) => result.advice.push(sentence);

  try {
    await drive.about();
    result.reachable = true;
  } catch (err) {
    result.error = err.message;
    advise(unreachableAdvice(err, { serviceAccount, email }));
    if (folderId) result.output_folder = { id: folderId, name: null, drive_id: null, writable: false, error: 'not checked: Drive is unreachable' };
    return result;
  }

  let sharedKnown = false;
  try {
    const shared = await drive.find({ sharedWithMe: true, limit: SHARED_COUNT_CAP });
    result.shared_with_me = {
      count: shared.files.length,
      capped: shared.capped,
      sample: shared.files.slice(0, SAMPLE_SIZE).map((f) => ({
        id: f.id,
        name: f.name ?? null,
        mime_type: f.mimeType ?? null,
        owner: f.owners?.[0]?.emailAddress || f.owners?.[0]?.displayName || null,
      })),
    };
    sharedKnown = true;
  } catch (err) {
    result.error = result.error || err.message;
    advise(`Listing the files shared with the agent failed: ${err.message} Run the check again in a minute.`);
  }

  try {
    result.shared_drives = (await drive.listSharedDrives()).map((d) => ({ id: d.id, name: d.name ?? null, can_add_files: d.canAddChildren === true }));
  } catch (err) {
    result.error = result.error || err.message;
    advise(`Listing the shared drives the agent belongs to failed: ${err.message} Run the check again in a minute.`);
  }

  if (sharedKnown && result.shared_with_me.count === 0) {
    advise(`Nothing is shared with the agent yet. To give it a file or folder, open it in Google Drive, choose Share, and add ${email}${serviceAccount ? '' : ", the agent's own account"} (Viewer is enough for it to read).`);
    if (serviceAccount) {
      advise(`Organizations that block sharing outside their domain also block sharing with a service account, so Drive may refuse ${email}. There are three ways out: make ${email} a member of a shared drive and keep the files there (as Content manager it can also save files there); have a Workspace admin allow sharing with ${email}; or install paraclete with a Workspace role, which gives the agent its own account inside the organization.`);
    }
  }

  if (!folderId) {
    advise(serviceAccount
      ? `Optional: set an output folder in Settings to let the agent save files to Drive. For this service account it must be a folder in a shared drive ${email} belongs to as Content manager. Without one, results still arrive as downloads.`
      : 'Optional: set an output folder in Settings to choose where the agent saves files in Drive; without one it saves them to its own My Drive. Results arrive as downloads either way.');
    return result;
  }

  result.output_folder = await checkOutputFolder({ drive, folderId, sharedDrives: result.shared_drives, now, serviceAccount, email, advise });
  return result;
}

/** The output folder: its name, its shared drive, and whether a new file can be created in it. */
async function checkOutputFolder({ drive, folderId, sharedDrives, now, serviceAccount, email, advise }) {
  const folder = { id: folderId, name: null, drive_id: null, writable: false, error: null };
  const notWritable = (why) => {
    const label = folder.name ? `"${folder.name}" (${folderId})` : folderId;
    if (serviceAccount && folder.name && !folder.drive_id) {
      advise(`The output folder ${label} is in someone's My Drive, where a service account cannot create files: it has no Drive storage of its own. Choose a folder in a shared drive ${email} belongs to as Content manager.`);
    } else if (serviceAccount) {
      advise(`The output folder ${label} does not take new files from ${email}: ${why} It must be a folder in a shared drive ${email} belongs to as Content manager: add it to that shared drive, or choose a folder in one it belongs to.`);
    } else {
      advise(`The output folder ${label} does not take new files from ${email}: ${why} Share it with ${email} as Editor, or choose another folder.`);
    }
  };

  let meta;
  try {
    meta = await drive.getMeta(folderId);
  } catch (err) {
    folder.error = err.message;
    notWritable(err.message);
    return folder;
  }
  const sharedRoot = Boolean(meta.driveId && (folderId === meta.driveId || meta.id === meta.driveId));
  const sharedDriveName = sharedRoot
    ? sharedDrives?.find((d) => d.id === meta.driveId)?.name || null
    : null;
  folder.name = sharedDriveName ?? meta.name ?? null;
  folder.drive_id = meta.driveId ?? null;
  if (meta.mimeType !== FOLDER_MIME) {
    folder.error = `it is a ${describeType(meta.mimeType)}, not a folder`;
    advise(`The output folder setting names "${folder.name}" (${folderId}), which is a ${describeType(meta.mimeType)}, not a folder. Choose a folder.`);
    return folder;
  }
  if (meta.capabilities?.canAddChildren === false) {
    folder.error = `${email} can open this folder but not add files to it`;
    notWritable(`${folder.error}.`);
    return folder;
  }

  const name = `paraclete-drive-check-${now().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}.txt`;
  let created;
  try {
    created = await drive.create({ name, parentId: folderId, mimeType: 'text/plain', bytes: TEST_FILE_TEXT });
  } catch (err) {
    folder.error = err.message;
    notWritable(err.message);
    return folder;
  }
  folder.writable = true;
  try {
    await drive.remove(created.id);
  } catch (err) {
    folder.error = `the test file ${name} (${created.id}) was created but could not be moved to the trash: ${err.message}`;
    advise(`The check created ${name} in the output folder but could not move it to the trash, so ${email} can add files there but not remove them. Saving results works; delete the test file by hand, or make ${email} a Content manager so the check can clean up after itself.`);
  }
  return folder;
}

/** What to do when Drive does not answer the agent at all, by the kind of failure. */
function unreachableAdvice(err, { serviceAccount, email }) {
  switch (err.kind) {
    case 'api_disabled':
      return 'Turn on the Google Drive API for this project (Google Cloud console, APIs & Services); the installer normally turns it on.';
    case 'scope':
      return serviceAccount
        ? "The agent's VM runs without the Drive scope. Re-run the installer, which creates the VM with the cloud-platform and drive scopes."
        : "Add https://www.googleapis.com/auth/drive to the scopes of the agent's domain-wide delegation grant in the Google Admin console.";
    case 'token':
    case 'auth':
      return serviceAccount
        ? `Google did not accept the credentials of ${email}. Check that the agent's VM runs as that service account, then run the check again.`
        : `The agent's Workspace account ${email} cannot get a Drive token. Check its domain-wide delegation grant in the Google Admin console: the client ID, and the drive scope.`;
    case 'domain_policy':
      return `Your organization's Drive policy keeps ${email} out of Drive. A Workspace admin can change it.`;
    default:
      return 'Drive did not answer the agent. Run the check again in a minute; if it keeps failing, check the agent\'s status in System.';
  }
}
