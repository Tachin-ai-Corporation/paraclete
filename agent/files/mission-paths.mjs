// agent/files/mission-paths.mjs: where a mission's files sit on the VM. Each mission works in its own
// tree, <missions root>/<mission id> (agent/work/artifacts.mjs makes it); files fetched for the mission
// land in its inbox, <tree>/missions/<id>/inbox/, which the tree's git excludes keep out of every
// commit. Files going out are not here: they go to the bucket (file-store.mjs). Used by sources.mjs
// and the files skill's file-get and file-share.

import { existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

/** A mission id is one plain path segment, as artifacts.mjs requires of a tree's directory name. */
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The id, checked: one path segment of letters, digits, '_' and '-'.
 *
 * @param {string} id
 * @returns {string}
 * @throws {Error} naming the id when it is not one
 */
export function checkMissionId(id) {
  if (!MISSION_ID.test(String(id ?? ''))) {
    throw new Error(`'${id ?? ''}' is not a mission id: it is the last part of the mission tree's path, letters, digits, '-' and '_'`);
  }
  return id;
}

/** A mission's working tree. */
export function missionTree(missionsRoot, missionId) {
  return join(missionsRoot, checkMissionId(missionId));
}

/** A mission's inbox: <tree>/missions/<id>/inbox. */
export function missionInbox(missionsRoot, missionId) {
  return join(missionTree(missionsRoot, missionId), 'missions', missionId, 'inbox');
}

/**
 * Whether the mission's tree exists: it does from the moment the mission starts until it ends.
 *
 * @param {string} missionsRoot
 * @param {string} missionId
 */
export function missionTreeExists(missionsRoot, missionId) {
  const tree = missionTree(missionsRoot, missionId);
  return existsSync(tree) && statSync(tree).isDirectory();
}

/**
 * The mission whose tree holds a path, or null when the path is outside every mission tree.
 *
 * @param {string} missionsRoot
 * @param {string} path absolute, or relative to the working directory
 * @returns {string|null}
 */
export function missionOfPath(missionsRoot, path) {
  const rel = relative(resolve(missionsRoot), resolve(path));
  if (!rel || rel.startsWith('..') || rel === '..') return null;
  const first = rel.split(sep)[0];
  return MISSION_ID.test(first) ? first : null;
}

/**
 * A name not yet taken in a directory: `report.pdf`, then `report-2.pdf`, `report-3.pdf`.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
export function freeName(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 2;
  while (existsSync(join(dir, `${stem}-${n}${ext}`))) n += 1;
  return `${stem}-${n}${ext}`;
}
