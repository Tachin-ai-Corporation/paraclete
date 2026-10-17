// Tests for agent/work/deploy-target.mjs. The defect being prevented: a deploy confused the Google
// Cloud project id (marketing-site) with the Hosting site id (acme-www), so a bare deploy hit the
// project's default site, and a second deploy shipped a placeholder because the Drive source was
// never placed in the deploy directory. The descriptor keeps site and project apart and names the
// source, and the render states the exact --site/--project command.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeployDescriptor, validateDeployDescriptor, renderDeployBlock,
} from '../../../agent/work/deploy-target.mjs';

const FULL = {
  platform: 'firebase-hosting',
  gcp_project: 'marketing-site',
  hosting_site: 'acme-www',
  source: { kind: 'drive', ref: '1OJ9F6M9' },
  flow: 'Flow: staging → approval → live',
};

describe('normalizeDeployDescriptor', () => {
  it('keeps site and project as distinct fields', () => {
    const n = normalizeDeployDescriptor(FULL);
    assert.equal(n.hosting_site, 'acme-www');
    assert.equal(n.gcp_project, 'marketing-site');
    assert.notEqual(n.hosting_site, n.gcp_project, 'the site must never collapse into the project');
    assert.deepEqual(n.source, { kind: 'drive', ref: '1OJ9F6M9' });
  });

  it('accepts alias keys (site, project, gcpProject) and repo for git', () => {
    const n = normalizeDeployDescriptor({ site: 'sX', project: 'pY', source: { kind: 'repo', ref: 'r1' } });
    assert.equal(n.hosting_site, 'sX');
    assert.equal(n.gcp_project, 'pY');
    assert.equal(n.source.kind, 'git', 'repo is an alias for git');
    assert.equal(n.platform, 'firebase-hosting', 'defaults the platform');
    assert.equal(normalizeDeployDescriptor({ hostingSite: 's', gcpProject: 'p' }).gcp_project, 'p');
  });

  it('drops a malformed source but keeps the target', () => {
    const n = normalizeDeployDescriptor({ site: 'sX', project: 'pY', source: { kind: 'ftp', ref: 'x' } });
    assert.equal(n.source, null);
    assert.equal(n.hosting_site, 'sX');
  });

  it('carries an explicit Drive source shape (file or folder) and drops a nonsense one', () => {
    assert.equal(normalizeDeployDescriptor({ ...FULL, source: { kind: 'drive', ref: 'r', shape: 'file' } }).source.shape, 'file');
    assert.equal(normalizeDeployDescriptor({ ...FULL, source: { kind: 'drive', ref: 'r', shape: 'FOLDER' } }).source.shape, 'folder');
    assert.equal('shape' in normalizeDeployDescriptor({ ...FULL, source: { kind: 'drive', ref: 'r', shape: 'zip' } }).source, false);
  });

  it('accepts drive_file and drive_folder as kind aliases for drive plus a shape', () => {
    assert.deepEqual(normalizeDeployDescriptor({ ...FULL, source: { kind: 'drive_file', ref: 'r' } }).source, { kind: 'drive', ref: 'r', shape: 'file' });
    assert.deepEqual(normalizeDeployDescriptor({ ...FULL, source: { kind: 'drive_folder', ref: 'r' } }).source, { kind: 'drive', ref: 'r', shape: 'folder' });
  });

  it('ignores a shape on a git source: git is always a tree', () => {
    assert.deepEqual(normalizeDeployDescriptor({ ...FULL, source: { kind: 'git', ref: 'r', shape: 'file' } }).source, { kind: 'git', ref: 'r' });
  });

  it('returns null when nothing is usable', () => {
    assert.equal(normalizeDeployDescriptor(null), null);
    assert.equal(normalizeDeployDescriptor({}), null);
    assert.equal(normalizeDeployDescriptor({ platform: 'firebase-hosting' }), null);
  });
});

describe('validateDeployDescriptor', () => {
  it('passes a complete firebase-hosting target', () => {
    assert.equal(validateDeployDescriptor(FULL).ok, true);
  });

  it('fails firebase-hosting without the site (the deploy target)', () => {
    const r = validateDeployDescriptor({ platform: 'firebase-hosting', gcp_project: 'marketing-site' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /hosting_site/);
  });

  it('fails firebase-hosting without the project', () => {
    const r = validateDeployDescriptor({ platform: 'firebase-hosting', hosting_site: 'acme-www' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gcp_project/);
  });

  it('fails an empty descriptor', () => {
    assert.equal(validateDeployDescriptor({}).ok, false);
  });

  it('passes another platform with a target', () => {
    assert.equal(validateDeployDescriptor({ platform: 'cloud-run', gcp_project: 'p', hosting_site: 'svc' }).ok, true);
  });
});

describe('renderDeployBlock', () => {
  it('labels site and project distinctly and states the --site/--project command', () => {
    const md = renderDeployBlock(FULL);
    assert.match(md, /## Deployment \(authoritative/);
    assert.match(md, /Hosting site \(deploy TARGET — firebase `--site`\): `acme-www`/);
    assert.match(md, /GCP project \(firebase `--project`\): `marketing-site`.*NOT the deploy site/);
    assert.match(md, /firebase hosting:channel:deploy staging --site acme-www --project marketing-site/);
    assert.match(md, /- Flow: staging → approval → live/);
  });

  it('a Drive source with no shape says to inspect what landed, not to assume a folder', () => {
    const md = renderDeployBlock(FULL);
    assert.match(md, /Google Drive source `1OJ9F6M9`/);
    assert.match(md, /INSPECT what landed/);
    assert.match(md, /do not assume a folder/i);
  });

  it('a single-file Drive source says to place it as index.html and not to expect an images dir', () => {
    const md = renderDeployBlock({ ...FULL, source: { kind: 'drive', ref: '1OJ9F6M9', shape: 'file' } });
    assert.match(md, /Google Drive FILE `1OJ9F6M9`/);
    assert.match(md, /place it as `index\.html`/);
    assert.match(md, /do NOT treat a missing `images\/` as incomplete/);
  });

  it('a Drive folder source says to fetch all its files, preserving structure', () => {
    const md = renderDeployBlock({ ...FULL, source: { kind: 'drive', ref: '1OJ9F6M9', shape: 'folder' } });
    assert.match(md, /Google Drive FOLDER `1OJ9F6M9`/);
    assert.match(md, /ALL its files/);
  });

  it('names the drive skill rather than a command', () => {
    assert.match(renderDeployBlock(FULL), /with the drive skill/);
  });

  it('renders a git source as a clone', () => {
    const md = renderDeployBlock({ ...FULL, source: { kind: 'git', ref: 'marketing-site' } });
    assert.match(md, /git repo `marketing-site`.*clone it/);
  });

  it('renders another platform plainly', () => {
    const md = renderDeployBlock({ platform: 'cloud-run', gcp_project: 'p', hosting_site: 'svc', source: { kind: 'git', ref: 'r' }, flow: 'Flow: direct' });
    assert.match(md, /- Platform: cloud-run\n- Project: `p`\n- Target: `svc`\n- Source: git `r`\n- Flow: direct/);
  });

  it('returns an empty string for an invalid or absent descriptor, so it is safe to concatenate', () => {
    assert.equal(renderDeployBlock(null), '');
    assert.equal(renderDeployBlock({ platform: 'firebase-hosting', gcp_project: 'p' }), '');
  });
});
