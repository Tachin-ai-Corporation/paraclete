// tests/install/fake-cloud.mjs: stands in for gcloud, git and curl when the tests run
// install/install.sh and install/uninstall.sh, so no test reaches Google Cloud, GitHub or Vertex AI.
// Shims named gcloud, git and curl (written by harness.mjs) exec this file with the tool's name first.
// It answers from a JSON state file (FAKE_CLOUD_STATE), applies every change a real command would make
// to that state, and appends each call to FAKE_CLOUD_LOG as { tool, command, args, write }, where write
// says whether the real command would change something. A command shape it doesn't know fails loudly
// (exit 3), so a script change that adds one fails a test until the fake learns it. The dashboard's
// pieces behave as the real ones do where the installer depends on it: Cloud Run reports CPU in
// millicores, `run deploy --iap` grants IAP's service agent the invoker role (and fails while that
// agent does not exist), a build pushes only into an existing repository, a Firestore write with
// the exists=false precondition never overwrites, and a bucket shows its CORS setting as cors_config.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync as readNativeFile, writeFileSync as writeNativeFile } from 'node:fs';

/** A path a script named, as this program opens it. Under Git for Windows a path inside an argument
 * like key=/tmp/x reaches this program unconverted, so cygpath translates it. */
function nativePath(path) {
  if (process.platform === 'win32' && path.startsWith('/')) {
    return spawnSync('cygpath', ['-w', path], { encoding: 'utf8' }).stdout.trim();
  }
  return path;
}

function readFileSync(path, encoding) {
  return readNativeFile(nativePath(path), encoding);
}

function writeFileSync(path, text) {
  writeNativeFile(nativePath(path), text);
}

/** What raw.githubusercontent.com serves as dashboard/cloudbuild.json at any commit: this repo's own. */
const CLOUDBUILD_JSON = readNativeFile(new URL('../../dashboard/cloudbuild.json', import.meta.url), 'utf8');

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

/** The member IAP's service agent is in IAM policies. */
const iapAgent = () => `serviceAccount:service-${state.projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`;

/** The env-vars file `gcloud run deploy --env-vars-file` reads, as install/lib/dashboard.mjs writes it. */
function readEnvFile(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const colon = line.indexOf(': ');
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 2))];
  }));
}

/** [path, tag] of an image reference <path>:<tag>. */
function splitImage(ref) {
  const colon = ref.lastIndexOf(':');
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

/** '<location>/<repository>' of an Artifact Registry image path. */
function repositoryOf(imagePath) {
  const m = /^([a-z0-9-]+)-docker\.pkg\.dev\/[^/]+\/([^/]+)\//.exec(imagePath);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** A service as `gcloud run services describe --format=json` prints it: Cloud Run's Knative form. */
function knativeService(name, s) {
  const annotations = { 'run.googleapis.com/ingress': s.ingress || 'all' };
  if (s.iap) annotations['run.googleapis.com/iap-enabled'] = 'true';
  if (s.urls) annotations['run.googleapis.com/urls'] = JSON.stringify(s.urls);
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: { name, annotations },
    spec: {
      template: {
        metadata: { annotations: s.maxInstances ? { 'autoscaling.knative.dev/maxScale': String(s.maxInstances) } : {} },
        spec: {
          serviceAccountName: s.account,
          containers: [{
            image: s.image,
            env: Object.entries(s.env || {}).map(([envName, value]) => ({ name: envName, value })),
            resources: { limits: { cpu: s.cpu, memory: s.memory } },
          }],
        },
      },
    },
    status: { url: s.url },
  };
}

/** A schedule from `gcloud scheduler jobs create|update http`'s flags. */
function scheduleFrom(f) {
  return {
    location: f.location, schedule: f.schedule, timeZone: f['time-zone'], uri: f.uri, httpMethod: f['http-method'],
    account: f['oauth-service-account-email'], scope: f['oauth-token-scope'], description: f.description,
  };
}

function service(name, region) {
  const found = state.runServices[name];
  return found && found.region === region ? found : null;
}

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
  'iam service-accounts remove-iam-policy-binding': {
    write: true,
    run: ([email], f) => {
      if (!state.accounts.includes(email)) fail('NOT_FOUND');
      const before = state.accountPolicies[email] || [];
      // As gcloud does, a binding that is not there is an error.
      if (!before.some(([r, m]) => r === f.role && m === f.member)) fail('Policy binding with the specified principal and role not found!');
      state.accountPolicies[email] = removeBinding(before, f.role, f.member);
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
    run: ([url], f) => {
      const bucket = state.buckets[bucketOf(url)] || fail('NOT_FOUND');
      if (f.format !== 'json') return out(bucketOf(url));
      // As gcloud storage shows a bucket: the CORS setting is cors_config, absent while there is none.
      return out(JSON.stringify({ name: bucketOf(url), location: bucket.location, ...(bucket.cors ? { cors_config: bucket.cors } : {}) }));
    },
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
      if (f['cors-file']) {
        const cors = JSON.parse(readFileSync(f['cors-file'], 'utf8'));
        if (!Array.isArray(cors)) fail('a CORS file is a JSON list of rules');
        bucket.cors = cors;
      }
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
      const found = service(name, f.region) || fail('NOT_FOUND');
      if (f.format === 'json') out(JSON.stringify(knativeService(name, found)));
      return out(String(f.format).includes('url') ? found.url : name);
    },
  },
  'run services delete': {
    write: true,
    run: ([name], f) => {
      delete state.runServices[name];
      delete state.iapPolicies[`${f.region}/${name}`];
      save();
      out('');
    },
  },
  'run deploy': {
    write: true,
    run: ([name], f) => {
      if (f.iap && !state.iapAgent) fail(`${iapAgent().slice('serviceAccount:'.length)} does not exist`);
      const [path, tag] = splitImage(f.image);
      if (!(state.images[path] || []).includes(tag)) fail(`Image '${f.image}' not found`);
      const before = state.runServices[name];
      const policy = before?.policy || [];
      if (f.iap) addBinding(policy, 'roles/run.invoker', iapAgent());
      state.runServices[name] = {
        region: f.region,
        url: before?.url || `https://${name}-${state.projectNumber}.${f.region}.run.app`,
        image: f.image,
        env: f['env-vars-file'] ? readEnvFile(f['env-vars-file']) : (before?.env || {}),
        account: f['service-account'],
        iap: f.iap === true,
        ingress: f.ingress || 'all',
        // Cloud Run reports CPU in millicores, whatever the deploy said.
        cpu: `${Number(f.cpu) * 1000}m`,
        memory: f.memory,
        maxInstances: f['max-instances'],
        policy: f['no-allow-unauthenticated'] ? policy.filter(([, member]) => member !== 'allUsers') : policy,
      };
      save();
      out('');
    },
  },
  'run services get-iam-policy': {
    write: false,
    run: ([name], f) => out(policyText((service(name, f.region) || fail('NOT_FOUND')).policy)),
  },
  'run services add-iam-policy-binding': {
    write: true,
    run: ([name], f) => {
      addBinding((service(name, f.region) || fail('NOT_FOUND')).policy ||= [], f.role, f.member);
      save();
      out('');
    },
  },
  'iap web get-iam-policy': {
    write: false,
    run: (_, f) => {
      if (f['resource-type'] !== 'cloud-run' || !service(f.service, f.region)) fail('NOT_FOUND');
      out(policyText(state.iapPolicies[`${f.region}/${f.service}`]));
    },
  },
  'iap web add-iam-policy-binding': {
    write: true,
    run: (_, f) => {
      if (f['resource-type'] !== 'cloud-run' || !service(f.service, f.region)) fail('NOT_FOUND');
      addBinding((state.iapPolicies[`${f.region}/${f.service}`] ||= []), f.role, f.member);
      save();
      out('');
    },
  },
  'beta services identity create': {
    write: true,
    run: (_, f) => {
      if (f.service !== 'iap.googleapis.com') fail(`only IAP's service agent is modelled, not ${f.service}`);
      state.iapAgent = true;
      save();
      process.stderr.write(`Service identity created: ${iapAgent().slice('serviceAccount:'.length)}\n`);
      out('');
    },
  },
  'artifacts repositories describe': {
    write: false,
    run: ([name], f) => (state.imageRepositories.includes(`${f.location}/${name}`) ? out(name) : fail('NOT_FOUND')),
  },
  'artifacts repositories create': {
    write: true,
    run: ([name], f) => {
      if (state.imageRepositories.includes(`${f.location}/${name}`)) fail('ALREADY_EXISTS');
      if (f['repository-format'] !== 'docker') fail('only docker repositories are modelled');
      state.imageRepositories.push(`${f.location}/${name}`);
      save();
      out('');
    },
  },
  'artifacts repositories delete': {
    write: true,
    run: ([name], f) => {
      const key = `${f.location}/${name}`;
      state.imageRepositories = state.imageRepositories.filter((r) => r !== key);
      delete state.repositoryPolicies[key];
      for (const path of Object.keys(state.images)) if (repositoryOf(path) === key) delete state.images[path];
      save();
      out('');
    },
  },
  'artifacts repositories get-iam-policy': {
    write: false,
    run: ([name], f) => (state.imageRepositories.includes(`${f.location}/${name}`)
      ? out(policyText(state.repositoryPolicies[`${f.location}/${name}`])) : fail('NOT_FOUND')),
  },
  'artifacts repositories add-iam-policy-binding': {
    write: true,
    run: ([name], f) => {
      if (!state.imageRepositories.includes(`${f.location}/${name}`)) fail('NOT_FOUND');
      addBinding((state.repositoryPolicies[`${f.location}/${name}`] ||= []), f.role, f.member);
      save();
      out('');
    },
  },
  'artifacts repositories remove-iam-policy-binding': {
    write: true,
    run: ([name], f) => {
      const key = `${f.location}/${name}`;
      if (!state.imageRepositories.includes(key)) fail('NOT_FOUND');
      const before = state.repositoryPolicies[key] || [];
      if (!before.some(([r, m]) => r === f.role && m === f.member)) fail('Policy binding with the specified principal and role not found!');
      state.repositoryPolicies[key] = removeBinding(before, f.role, f.member);
      save();
      out('');
    },
  },
  'artifacts docker tags list': {
    write: false,
    run: ([path]) => (state.imageRepositories.includes(repositoryOf(path)) ? out((state.images[path] || []).join('\n')) : fail('NOT_FOUND')),
  },
  'builds submit': {
    write: true,
    run: ([source], f) => {
      const substitutions = Object.fromEntries(String(f.substitutions).split(',').map((pair) => pair.split('=')));
      const config = readFileSync(f.config, 'utf8');
      if (state.buildFails) fail('BUILD FAILURE: Build step 0 "gcr.io/cloud-builders/docker" failed');
      if (!state.imageRepositories.includes(repositoryOf(substitutions._IMAGE))) fail(`name unknown: repository for ${substitutions._IMAGE} not found`);
      (state.images[substitutions._IMAGE] ||= []).push(substitutions._COMMIT);
      state.builds.push({
        source, revision: f['git-source-revision'], config, substitutions,
        serviceAccount: f['service-account'], region: f.region, timeout: f.timeout,
      });
      save();
      out(`DONE\n${substitutions._IMAGE}:${substitutions._COMMIT}`);
    },
  },
  // The automatic-update job, in Cloud Run's v1 form as `gcloud run jobs describe --format=json` prints it.
  'run jobs describe': {
    write: false,
    run: ([name], f) => {
      const job = state.runJobs?.[name];
      if (!job || job.region !== f.region) fail('NOT_FOUND');
      if (f.format !== 'json') return out(name);
      return out(JSON.stringify({
        apiVersion: 'run.googleapis.com/v1',
        kind: 'Job',
        metadata: { name },
        spec: { template: { spec: { template: { spec: {
          serviceAccountName: job.account,
          timeoutSeconds: String(job.timeoutSeconds),
          maxRetries: job.maxRetries,
          containers: [{
            image: job.image, command: job.command, args: job.args,
            env: Object.entries(job.env || {}).map(([envName, value]) => ({ name: envName, value })),
          }],
        } } } } },
      }));
    },
  },
  'run jobs deploy': {
    write: true,
    run: ([name], f) => {
      const [path, tag] = splitImage(f.image);
      if (!(state.images[path] || []).includes(tag)) fail(`Image '${f.image}' not found`);
      (state.runJobs ||= {})[name] = {
        region: f.region,
        image: f.image,
        account: f['service-account'],
        command: [].concat(f.command ?? []),
        args: String(f.args ?? '').split(',').filter(Boolean),
        env: f['env-vars-file'] ? readEnvFile(f['env-vars-file']) : {},
        timeoutSeconds: Number(String(f['task-timeout']).replace(/s$/, '')),
        maxRetries: Number(f['max-retries']),
        tasks: Number(f.tasks),
      };
      save();
      out('');
    },
  },
  'run jobs delete': {
    write: true,
    run: ([name]) => { delete state.runJobs?.[name]; save(); out(''); },
  },
  // The schedule, in Cloud Scheduler's API form as `gcloud scheduler jobs describe --format=json` prints it.
  'scheduler jobs describe': {
    write: false,
    run: ([name], f) => {
      const s = state.schedules?.[name];
      if (!s || s.location !== f.location) fail('NOT_FOUND');
      if (f.format !== 'json') return out(name);
      return out(JSON.stringify({
        name: `projects/${f.project}/locations/${f.location}/jobs/${name}`,
        schedule: s.schedule,
        timeZone: s.timeZone,
        state: s.state || 'ENABLED',
        httpTarget: { uri: s.uri, httpMethod: s.httpMethod, oauthToken: { serviceAccountEmail: s.account, scope: s.scope } },
      }));
    },
  },
  'scheduler jobs create http': {
    write: true,
    run: ([name], f) => {
      if (!state.services.includes('cloudscheduler.googleapis.com')) fail('Cloud Scheduler API has not been used in this project before or it is disabled');
      if (state.schedules?.[name]) fail('ALREADY_EXISTS');
      (state.schedules ||= {})[name] = scheduleFrom(f);
      save();
      out('');
    },
  },
  'scheduler jobs update http': {
    write: true,
    run: ([name], f) => {
      if (!state.schedules?.[name]) fail('NOT_FOUND');
      state.schedules[name] = { ...scheduleFrom(f), state: state.schedules[name].state };
      save();
      out('');
    },
  },
  'scheduler jobs delete': {
    write: true,
    run: ([name]) => { delete state.schedules?.[name]; save(); out(''); },
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

/** The value after a curl option, e.g. option('-o'). */
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** Every value of a curl option given more than once (-H). */
const options = (name) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));

/** What Vertex AI answers generateContent with, by the names state.modelAnswers uses. */
const MODEL_ANSWERS = {
  ok: { candidates: [{ content: { role: 'model', parts: [{ text: 'Ready' }] }, finishReason: 'STOP' }] },
  quota: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-4-argon.' } },
  'not-found': { error: { code: 404, status: 'NOT_FOUND', message: 'Publisher Model `projects/your-gcp-project/locations/global/publishers/google/models/gemini-4-argon` was not found or your project does not have access to it.' } },
  disabled: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Vertex AI API has not been used in project 123456789012 before or it is disabled.' } },
};

/** An HTTP error with its body, as curl --fail-with-body reports it. */
function httpError(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.stderr.write('curl: (22) The requested URL returned an error\n');
  process.exit(22);
}

/** users/<email> in Firestore: reading it, or creating it only where none exists. */
function firestoreUser(url, email, query) {
  const name = `projects/${state.project}/databases/(default)/documents/users/${email}`;
  const encode = (record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { stringValue: value }]));
  const noDatabase = { error: { code: 404, status: 'NOT_FOUND', message: `The database (default) does not exist for project ${state.project}` } };
  if (option('-X') !== 'PATCH') {
    log('firestore get user', false);
    if (!state.database) return out(JSON.stringify(noDatabase));
    const record = state.users[email];
    return out(JSON.stringify(record ? { name, fields: encode(record) } : { error: { code: 404, status: 'NOT_FOUND', message: `Document "${name}" not found.` } }));
  }
  log('firestore create user', true);
  if (query !== '?currentDocument.exists=false') fail(`only create-only writes are modelled: ${url}`, 3);
  const headers = options('-H').flatMap((h) => (h.startsWith('@') ? readFileSync(h.slice(1), 'utf8').split('\n') : [h]));
  if (!headers.includes('Authorization: Bearer fake-token') || !headers.includes(`x-goog-user-project: ${state.project}`)) {
    return httpError({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } });
  }
  if (!state.database) return httpError(noDatabase);
  if (state.users[email]) return httpError({ error: { code: 409, status: 'ALREADY_EXISTS', message: `Document already exists: ${name}` } });
  const body = JSON.parse(readFileSync(option('--data-binary').slice(1), 'utf8'));
  state.users[email] = Object.fromEntries(Object.entries(body.fields).map(([key, value]) => [key, value.stringValue]));
  save();
  return out(JSON.stringify({ name, fields: body.fields }));
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
    const path = url.slice('https://raw.githubusercontent.com/'.length);
    if (!state.rawFiles.includes(path)) return fail('The requested URL returned error: 404', 22);
    const target = option('-o');
    // Git Bash hands a native program `/dev/null` as `nul`, which Node would create as a file.
    if (target && !/^(\/dev\/null|nul)$/i.test(target)) writeFileSync(target, path.endsWith('/dashboard/cloudbuild.json') ? CLOUDBUILD_JSON : '');
    return out('');
  }
  if (url.startsWith('https://aiplatform.googleapis.com/') && url.endsWith(':generateContent')) {
    log('vertex generateContent', false);
    const answers = state.modelAnswers || ['ok'];
    const answer = answers[Math.min(state.modelCalls || 0, answers.length - 1)];
    state.modelCalls = (state.modelCalls || 0) + 1;
    save();
    if (answer === 'unreachable') return fail('Could not resolve host: aiplatform.googleapis.com', 6);
    return out(JSON.stringify(MODEL_ANSWERS[answer]));
  }
  const userDoc = /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents\/users\/([^/?]+)(\?.*)?$/.exec(url);
  if (userDoc) return firestoreUser(url, decodeURIComponent(userDoc[1]), userDoc[2]);
  const settingsDoc = /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents\/config\/settings\?(.*)$/.exec(url);
  if (settingsDoc && option('-X') === 'PATCH') {
    // Only a field-masked write is modelled: the fields it names change, every other one stays.
    log('firestore patch settings', true);
    const mask = new URLSearchParams(settingsDoc[1]).getAll('updateMask.fieldPaths');
    if (mask.length === 0) fail(`only field-masked writes of config/settings are modelled: ${url}`, 3);
    if (!state.database) return httpError({ error: { code: 404, status: 'NOT_FOUND', message: 'The database (default) does not exist' } });
    const body = JSON.parse(readFileSync(option('--data-binary').slice(1), 'utf8'));
    const decode = (v) => ('booleanValue' in v ? v.booleanValue : v.stringValue);
    state.settings = { ...(state.settings || {}) };
    for (const field of mask) {
      if (body.fields[field]) state.settings[field] = decode(body.fields[field]);
      else delete state.settings[field];
    }
    save();
    return out(JSON.stringify({ name: 'config/settings' }));
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
