// tests/install/fake-cloud.mjs: stands in for gcloud, git and curl when the tests run
// install/install.sh and install/uninstall.sh, so no test reaches Google Cloud or GitHub. Shims named
// gcloud, git and curl (written by harness.mjs) exec this file with the tool's name first. It answers
// from a JSON state file (FAKE_CLOUD_STATE), applies every change a real command would make to that
// state, and appends each call to FAKE_CLOUD_LOG as { tool, command, args, write }, where write says
// whether the real command would change something. A command shape it doesn't know fails loudly
// (exit 3), so a script change that adds one fails a test until the fake learns it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync as readNativeFile, writeFileSync } from 'node:fs';

/** Reads a file a script named. Under Git for Windows a path inside an argument like
 * key=/tmp/x reaches this program unconverted, so cygpath translates it. */
function readFileSync(path, encoding) {
  if (process.platform === 'win32' && path.startsWith('/')) {
    path = spawnSync('cygpath', ['-w', path], { encoding: 'utf8' }).stdout.trim();
  }
  return readNativeFile(path, encoding);
}

const [tool, ...args] = process.argv.slice(2);
const statePath = process.env.FAKE_CLOUD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));

function log(command, write) {
  appendFileSync(process.env.FAKE_CLOUD_LOG, `${JSON.stringify({ tool, command, args, write })}\n`);
}

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function out(text) {
  if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(0);
}

function fail(message, code = 1) {
  process.stderr.write(`fake ${tool}: ${message}\n`);
  process.exit(code);
}

/** Positional words, and flags as { name: value | true } from --name=value and --name. A flag given
 * more than once (--field-config) collects its values in an array. */
function parse(list) {
  const words = [];
  const flags = {};
  for (const arg of list) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? true : arg.slice(eq + 1);
      flags[name] = name in flags ? [].concat(flags[name], value) : value;
    } else {
      words.push(arg);
    }
  }
  return { words, flags };
}

const policyText = (bindings) => (bindings || []).map(([role, member]) => `${role},${member}`).join('\n');

function addBinding(bindings, role, member) {
  if (!bindings.some(([r, m]) => r === role && m === member)) bindings.push([role, member]);
}

function removeBinding(bindings, role, member) {
  return bindings.filter(([r, m]) => !(r === role && m === member));
}

function readMetadata(flags) {
  const metadata = {};
  if (typeof flags.metadata === 'string') {
    for (const pair of flags.metadata.split(',')) metadata[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  }
  if (typeof flags['metadata-from-file'] === 'string') {
    for (const pair of flags['metadata-from-file'].split(',')) {
      metadata[pair.slice(0, pair.indexOf('='))] = readFileSync(pair.slice(pair.indexOf('=') + 1), 'utf8');
    }
  }
  return metadata;
}

const bucketOf = (url) => url.replace(/^gs:\/\//, '').replace(/\/.*$/, '');

/** gcloud command paths, each { write, run(words after the path, flags) }. */
const GCLOUD = {
  'config get-value': { write: false, run: () => out(state.configProject || '') },
  'auth list': { write: false, run: () => out(state.account || '') },
  'auth print-access-token': { write: false, run: () => (state.account ? out('fake-token') : fail('not logged in')) },
  'projects describe': { write: false, run: ([p]) => (p === state.project ? out(state.projectNumber) : fail('not found')) },
  'projects get-ancestors': { write: false, run: () => out(state.ancestors.join('\n')) },
  'billing projects describe': { write: false, run: () => out(state.billingEnabled ? 'True' : 'False') },
  'projects get-iam-policy': { write: false, run: () => out(policyText(state.projectPolicy)) },
  'projects add-iam-policy-binding': {
    write: true,
    run: (_, f) => { addBinding(state.projectPolicy, f.role, f.member); save(); out(''); },
  },
  'projects remove-iam-policy-binding': {
    write: true,
    run: (_, f) => { state.projectPolicy = removeBinding(state.projectPolicy, f.role, f.member); save(); out(''); },
  },
  'services list': { write: false, run: () => out(state.services.join('\n')) },
  'services enable': {
    write: true,
    run: (names) => { state.services.push(...names.filter((n) => !state.services.includes(n))); save(); out(''); },
  },
  'iam service-accounts describe': {
    write: false,
    run: ([email]) => (state.accounts.includes(email) ? out(email) : fail('NOT_FOUND')),
  },
  'iam service-accounts create': {
    write: true,
    run: ([id], f) => {
      const email = `${id}@${f.project}.iam.gserviceaccount.com`;
      if (state.accounts.includes(email)) fail('ALREADY_EXISTS');
      state.accounts.push(email);
      save();
      out('');
    },
  },
  'iam service-accounts delete': {
    write: true,
    run: ([email]) => { state.accounts = state.accounts.filter((a) => a !== email); delete state.accountPolicies[email]; save(); out(''); },
  },
  'iam service-accounts get-iam-policy': {
    write: false,
    run: ([email]) => (state.accounts.includes(email) ? out(policyText(state.accountPolicies[email])) : fail('NOT_FOUND')),
  },
  'iam service-accounts add-iam-policy-binding': {
    write: true,
    run: ([email], f) => {
      if (!state.accounts.includes(email)) fail('NOT_FOUND');
      addBinding((state.accountPolicies[email] ||= []), f.role, f.member);
      save();
      out('');
    },
  },
  'firestore databases describe': {
    write: false,
    run: (_, f) => {
      if (!state.database) fail('NOT_FOUND');
      if (String(f.format).includes('deleteProtectionState')) {
        out(`projects/${state.project}/databases/(default)\t${state.database.deleteProtection ? 'DELETE_PROTECTION_ENABLED' : 'DELETE_PROTECTION_DISABLED'}`);
      }
      out(state.database.type);
    },
  },
  'firestore databases create': {
    write: true,
    run: (_, f) => {
      if (state.database) fail('ALREADY_EXISTS');
      state.database = { type: 'FIRESTORE_NATIVE', location: f.location, deleteProtection: f['delete-protection'] === true };
      save();
      out('');
    },
  },
  'firestore databases update': {
    write: true,
    run: (_, f) => { if (f['no-delete-protection']) state.database.deleteProtection = false; save(); out(''); },
  },
  'firestore databases delete': {
    write: true,
    run: () => {
      if (state.database?.deleteProtection) fail('FAILED_PRECONDITION: delete protection is on');
      state.database = null;
      state.indexes = [];
      state.ttls = [];
      save();
      out('');
    },
  },
  'firestore indexes composite list': {
    write: false,
    run: () => (state.database ? out(JSON.stringify(state.indexes)) : fail('NOT_FOUND')),
  },
  'firestore indexes composite create': {
    write: true,
    run: (_, f) => {
      const fields = [].concat(f['field-config']).map((config) => {
        const kv = Object.fromEntries(config.split(',').map((p) => p.split('=')));
        return { fieldPath: kv['field-path'], order: kv.order.toUpperCase() };
      });
      fields.push({ fieldPath: '__name__', order: fields.at(-1).order });
      state.indexes.push({
        name: `projects/${f.project}/databases/(default)/collectionGroups/${f['collection-group']}/indexes/CICAg${state.indexes.length + 1}`,
        queryScope: String(f['query-scope']).toUpperCase().replace(/-/g, '_'),
        fields,
        state: 'CREATING',
      });
      save();
      out('');
    },
  },
  'firestore indexes composite delete': {
    write: true,
    run: ([id]) => { state.indexes = state.indexes.filter((i) => !i.name.endsWith(`/indexes/${id}`)); save(); out(''); },
  },
  'firestore fields ttls list': {
    write: false,
    run: () => out(state.ttls.map((t) => `${t.name}\t${t.state}`).join('\n')),
  },
  'firestore fields ttls update': {
    write: true,
    run: ([field], f) => {
      const name = `projects/${f.project}/databases/(default)/collectionGroups/${f['collection-group']}/fields/${field}`;
      state.ttls = state.ttls.filter((t) => t.name !== name);
      if (f['enable-ttl']) state.ttls.push({ name, state: 'CREATING' });
      save();
      out('');
    },
  },
  'storage buckets describe': {
    write: false,
    run: ([url]) => (state.buckets[bucketOf(url)] ? out(bucketOf(url)) : fail('NOT_FOUND')),
  },
  'storage buckets create': {
    write: true,
    run: ([url], f) => {
      if (state.buckets[bucketOf(url)]) fail('409 already exists');
      state.buckets[bucketOf(url)] = {
        location: f.location,
        uniformAccess: f['uniform-bucket-level-access'] === true,
        publicAccessPrevention: f['public-access-prevention'] === true,
        lifecycle: f['lifecycle-file'] ? JSON.parse(readFileSync(f['lifecycle-file'], 'utf8')) : null,
        policy: [],
      };
      save();
      out('');
    },
  },
  'storage buckets update': {
    write: true,
    run: ([url], f) => {
      const bucket = state.buckets[bucketOf(url)] || fail('NOT_FOUND');
      if (f['uniform-bucket-level-access']) bucket.uniformAccess = true;
      if (f['public-access-prevention']) bucket.publicAccessPrevention = true;
      if (f['lifecycle-file']) bucket.lifecycle = JSON.parse(readFileSync(f['lifecycle-file'], 'utf8'));
      save();
      out('');
    },
  },
  'storage buckets get-iam-policy': {
    write: false,
    run: ([url]) => (state.buckets[bucketOf(url)] ? out(policyText(state.buckets[bucketOf(url)].policy)) : fail('NOT_FOUND')),
  },
  'storage buckets add-iam-policy-binding': {
    write: true,
    run: ([url], f) => { addBinding(state.buckets[bucketOf(url)].policy, f.role, f.member); save(); out(''); },
  },
  'storage buckets remove-iam-policy-binding': {
    write: true,
    run: ([url], f) => {
      const bucket = state.buckets[bucketOf(url)];
      bucket.policy = removeBinding(bucket.policy, f.role, f.member);
      save();
      out('');
    },
  },
  'storage rm': {
    write: true,
    run: ([url], f) => {
      if (!f.recursive) fail('only --recursive on a whole bucket is modelled');
      delete state.buckets[bucketOf(url)];
      save();
      out('');
    },
  },
  'run services describe': {
    write: false,
    run: ([name], f) => {
      const service = state.runServices[name];
      return service && service.region === f.region ? out(String(f.format).includes('url') ? service.url : name) : fail('NOT_FOUND');
    },
  },
  'run services delete': { write: true, run: ([name]) => { delete state.runServices[name]; save(); out(''); } },
  'artifacts repositories describe': {
    write: false,
    run: ([name], f) => (state.imageRepositories.includes(`${f.location}/${name}`) ? out(name) : fail('NOT_FOUND')),
  },
  'artifacts repositories delete': {
    write: true,
    run: ([name], f) => {
      state.imageRepositories = state.imageRepositories.filter((r) => r !== `${f.location}/${name}`);
      save();
      out('');
    },
  },
  'compute networks describe': {
    write: false,
    run: ([name], f) => {
      const network = state.networks[name];
      if (!network) fail('NOT_FOUND');
      out(String(f.format).includes('description') ? network.description : name);
    },
  },
  'compute networks create': {
    write: true,
    run: ([name], f) => { state.networks[name] = { mode: f['subnet-mode'], description: f.description || '' }; save(); out(''); },
  },
  'compute networks delete': { write: true, run: ([name]) => { delete state.networks[name]; save(); out(''); } },
  'compute firewall-rules describe': {
    write: false,
    run: ([name]) => (state.firewallRules[name] ? out(name) : fail('NOT_FOUND')),
  },
  'compute firewall-rules create': {
    write: true,
    run: ([name], f) => {
      state.firewallRules[name] = {
        network: f.network, direction: f.direction, action: f.action, rules: f.rules,
        sourceRanges: f['source-ranges'], targetTags: f['target-tags'],
      };
      save();
      out('');
    },
  },
  'compute firewall-rules delete': { write: true, run: ([name]) => { delete state.firewallRules[name]; save(); out(''); } },
  'compute instances list': {
    write: false,
    run: (_, f) => {
      const wanted = /^name=(.+)$/.exec(String(f.filter || ''))?.[1];
      out(Object.entries(state.instances).filter(([name]) => !wanted || name === wanted)
        .map(([name, vm]) => `${name}\t${vm.zone}`).join('\n'));
    },
  },
  'compute instances describe': {
    write: false,
    run: ([name]) => {
      const vm = state.instances[name] || fail('NOT_FOUND');
      out(JSON.stringify({ name, metadata: { items: Object.entries(vm.metadata).map(([key, value]) => ({ key, value })) } }));
    },
  },
  'compute instances create': {
    write: true,
    run: ([name], f) => {
      if (state.instances[name]) fail('ALREADY_EXISTS');
      const { metadata: _m, 'metadata-from-file': _f, ...settings } = f;
      const metadata = readMetadata(f);
      state.instances[name] = { zone: f.zone, settings, metadata };
      // The VM boots and its bootstrap reports, as install/README.md describes.
      if (state.bootstrapReports) {
        state.agentInstance = {
          status: state.bootstrapReports, commit: metadata['paraclete-ref'], error: state.bootstrapError || '',
          updateTime: new Date().toISOString(),
        };
      }
      save();
      out('');
    },
  },
  'compute instances add-metadata': {
    write: true,
    run: ([name], f) => {
      const vm = state.instances[name] || fail('NOT_FOUND');
      Object.assign(vm.metadata, readMetadata(f));
      save();
      out('');
    },
  },
  'compute instances delete': { write: true, run: ([name]) => { delete state.instances[name]; save(); out(''); } },
};

function gcloud() {
  const { words, flags } = parse(args);
  for (let n = Math.min(4, words.length); n > 0; n -= 1) {
    const command = words.slice(0, n).join(' ');
    if (GCLOUD[command]) {
      log(command, GCLOUD[command].write);
      return GCLOUD[command].run(words.slice(n), flags);
    }
  }
  log(words.join(' '), null);
  return fail(`unknown command: ${args.join(' ')}`, 3);
}

function git() {
  const list = args[0] === '-C' ? args.slice(2) : args;
  if (list[0] === 'remote' && list[1] === 'get-url') {
    log('remote get-url', false);
    return state.gitRemote ? out(state.gitRemote) : fail('no such remote');
  }
  if (list[0] === 'ls-remote') {
    log('ls-remote', false);
    const url = list.find((a) => a.startsWith('https://'));
    const listing = state.remotes[url];
    return listing === undefined ? fail(`could not read ${url}`, 128) : out(listing);
  }
  log(list.join(' '), null);
  return fail(`unknown command: ${args.join(' ')}`, 3);
}

function curl() {
  const url = args.find((a) => /^https?:\/\//.test(a)) || '';
  if (url.endsWith(':testIamPermissions')) {
    log('testIamPermissions', false);
    const body = JSON.parse(args[args.indexOf('--data') + 1]);
    return out(JSON.stringify({ permissions: body.permissions.filter((p) => !state.deniedPermissions.includes(p)) }));
  }
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    log('raw', false);
    return state.rawFiles.includes(url.slice('https://raw.githubusercontent.com/'.length)) ? out('') : fail('404', 22);
  }
  if (url.includes('firestore.googleapis.com') && url.endsWith('/documents/agent/instance')) {
    log('firestore get agent/instance', false);
    const doc = state.agentInstance;
    if (!doc) return out(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }));
    const fields = { status: { stringValue: doc.status }, commit: { stringValue: doc.commit } };
    if (doc.error) fields.error = { stringValue: doc.error };
    return out(JSON.stringify({ name: 'agent/instance', fields, updateTime: doc.updateTime }));
  }
  log(url, null);
  return fail(`unknown request: ${args.join(' ')}`, 3);
}

({ gcloud, git, curl })[tool]?.() ?? fail(`unknown tool ${tool}`, 3);
