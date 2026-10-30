// install/lib/preflight.mjs: what would stop an install in a project, found before anything changes:
// the caller's permissions, billing, the organization, the organization policies that break what the
// install does, and which APIs it would turn on. Every check is a read. install.sh runs this file in
// step 1 of every install (a blocker stops the run there) and on its own with --preflight (every
// result is reported, and nothing changes), so the two never disagree.
//
// It talks to Google's REST APIs through curl, with the access token on curl's standard input
// (`-H @-`), so the token is never on a command line. No call names a project to bill
// (x-goog-user-project) unless --quota-project does: the target project usually has the Cloud Billing
// and Organization Policy APIs off, and a call billed to it would fail. Without one, a call is billed
// to the token's own project: gcloud's for a person in Cloud Shell, the caller's for a web app's
// token. A check whose call cannot be made is `unknown`, never a blocker.
//
//   node install/lib/preflight.mjs --project <id> --region <region> --zone <zone> --apis <a,b,...>
//     --permissions <p,q,...> [--account <email>] [--quota-project <id>] [--json]   (token on stdin)
//
// It prints one line per check, <state> TAB <id> TAB <text> TAB <fix>, or with --json one object,
// { checks: [{ id, state, text, fix }] }. state is ok, note, unknown or blocker. Exit 0 when nothing
// blocks, 1 when something does, 2 for a usage mistake.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What a value in an organization policy rule names, without its `is:` prefix. */
const bare = (value) => String(value).replace(/^is:/, '');

/**
 * The organization policies that break the install, each with what it breaks and how to read its
 * effective policy. evaluate(rules, ctx) returns null when the policy allows the install, or a reason.
 */
export const ORG_POLICY_CHECKS = Object.freeze([
  {
    constraint: 'iam.disableServiceAccountCreation',
    breaks: "step 3 creates the agent's and the dashboard's service accounts",
    evaluate: (rules) => (rules.some((r) => r.enforce === true) ? 'creating service accounts is turned off' : null),
  },
  {
    constraint: 'compute.vmExternalIpAccess',
    breaks: "the agent's VM reaches GitHub and Google's APIs through an external IP address",
    evaluate: (rules, ctx) => listDenies(rules, (v) => v === `projects/${ctx.project}/zones/${ctx.zone}/instances/paraclete`)
      && `the VM paraclete may not have an external IP address`,
  },
  {
    constraint: 'compute.trustedImageProjects',
    breaks: "the agent's VM boots debian-cloud's Debian 12 image",
    evaluate: (rules) => listDenies(rules, (v) => v === 'projects/debian-cloud') && 'debian-cloud is not a trusted image project',
  },
  {
    constraint: 'run.allowedIngress',
    breaks: "the dashboard's Cloud Run ingress is `all`, with Identity-Aware Proxy in front of it",
    evaluate: (rules) => listDenies(rules, (v) => v === 'all') && 'Cloud Run ingress `all` is not allowed',
  },
  {
    constraint: 'gcp.restrictServiceUsage',
    breaks: 'step 2 turns on the APIs the agent and the dashboard use',
    evaluate: (rules, ctx) => {
      const refused = ctx.apis.filter((api) => listDenies(rules, (v) => v === api));
      return refused.length ? `these APIs may not be used: ${refused.join(' ')}` : null;
    },
  },
  {
    constraint: 'cloudbuild.allowedWorkerPools',
    breaks: "the dashboard's image is built on Cloud Build's default pool",
    evaluate: (rules) => (rules.some((r) => r.denyAll || r.values?.allowedValues?.length) ? 'builds must run on named private pools' : null),
  },
  {
    constraint: 'gcp.resourceLocations',
    breaks: "the database, bucket, VM, dashboard and image repositories live in the region",
    evaluate: (rules, ctx) => listDenies(rules, (v) => locationAllows(v, ctx.region)) && `${ctx.region} is not an allowed location`,
  },
]);

/**
 * Whether list rules refuse every value `allowed` accepts: a deny-all, a denied value it accepts, or
 * allowed values none of which it accepts. Rules with a condition are left to a person.
 */
function listDenies(rules, allowed) {
  for (const rule of rules) {
    if (rule.condition) continue;
    if (rule.allowAll) return false;
    if (rule.denyAll) return true;
    const values = rule.values || {};
    if ((values.deniedValues || []).map(bare).some(allowed)) return true;
    if ((values.allowedValues || []).length && !(values.allowedValues || []).map(bare).some(allowed)) return true;
  }
  return false;
}

/**
 * Whether a gcp.resourceLocations value takes in a region: the region, its `in:<region>-locations`
 * group, or a multi-region group such as `in:us-locations` for a us-* region.
 */
function locationAllows(value, region) {
  if (value === region || value === `in:${region}-locations`) return true;
  const group = /^in:([a-z]+)-locations$/.exec(value);
  return Boolean(group && region.startsWith(`${group[1]}-`));
}

/** The reason a failed call failed: the ErrorInfo reason, else the status, else the HTTP code. */
function failure(response) {
  const error = response.json?.error || {};
  const info = (error.details || []).find((d) => String(d['@type'] || '').endsWith('ErrorInfo')) || {};
  const reason = info.reason || error.status || `HTTP ${response.status}`;
  const message = String(error.message || response.text || '').replace(/\s+/g, ' ').slice(0, 300);
  return { reason, message, service: info.metadata?.service };
}

/** An `unknown` result for a check whose call could not be made, with what to do about it. */
function unknown(id, what, response) {
  const { reason, message, service } = failure(response);
  const fix = reason === 'SERVICE_DISABLED'
    ? `turn on ${service || 'that API'} in the project this call is billed to (the token's own project, or --quota-project)`
    : 'check by hand';
  return { id, state: 'unknown', text: `could not read ${what} (${reason}${message ? `: ${message}` : ''})`, fix };
}

/** One REST call through curl, the token on curl's standard input. */
function curlRequest({ token, quotaProject, curl }) {
  return (method, url, body) => {
    // The status comes from the response's own headers (-i): a write-out format's braces and escapes
    // do not survive every platform's process boundary unchanged.
    const args = ['-sS', '-i', '-X', method, '-H', '@-', '-H', 'Content-Type: application/json'];
    if (body !== undefined) args.push('--data', JSON.stringify(body));
    args.push(url);
    const headers = `Authorization: Bearer ${token}\n${quotaProject ? `x-goog-user-project: ${quotaProject}\n` : ''}`;
    let output;
    try {
      output = curl(args, headers);
    } catch (err) {
      return { status: 0, json: null, text: `curl failed: ${String(err.stderr || err.message).trim()}` };
    }
    // Each header block starts with a status line; a 1xx (100 Continue) is followed by the real one.
    let rest = output;
    let status = 0;
    for (let line = /^HTTP\/[\d.]+ (\d{3})/.exec(rest); line; line = /^HTTP\/[\d.]+ (\d{3})/.exec(rest)) {
      status = Number(line[1]);
      const end = rest.search(/\r?\n\r?\n/);
      rest = end < 0 ? '' : rest.slice(end).replace(/^\r?\n\r?\n/, '');
    }
    const text = rest.trim();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status, json, text };
  };
}

// Through sh, so the curl that answers is the one the scripts find on PATH, on any platform (a node on
// Windows would otherwise skip a curl that is a shell script and run its own).
const defaultCurl = (args, input) => execFileSync('sh', ['-c', 'exec curl "$@"', 'curl', ...args],
  { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * Every check, in order. Never throws for an answer it did not like: each becomes a result.
 *
 * @param {object} o
 * @param {string} o.project
 * @param {string} o.region
 * @param {string} o.zone
 * @param {string[]} o.apis         the APIs the install needs, full names (bigquery.googleapis.com)
 * @param {string[]} o.permissions  what the caller must hold on the project
 * @param {string} o.token
 * @param {string} [o.account]      the caller, for the messages
 * @param {string} [o.quotaProject] the project to bill every call to
 * @param {Function} [o.curl]       (args, stdin) => stdout; execFileSync('curl') by default
 * @returns {{checks: {id: string, state: string, text: string, fix?: string}[]}}
 */
export function preflight({ project, region, zone, apis, permissions, token, account, quotaProject, curl = defaultCurl }) {
  const call = curlRequest({ token, quotaProject, curl });
  const checks = [];
  const crm = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;

  const granted = call('POST', `${crm}:testIamPermissions`, { permissions });
  if (granted.status !== 200) {
    checks.push(unknown('permissions', 'your permissions on the project', granted));
  } else {
    const have = new Set(granted.json?.permissions || []);
    const missing = permissions.filter((p) => !have.has(p));
    checks.push(missing.length
      ? { id: 'permissions', state: 'blocker', text: `${account || 'the caller'} needs roles/owner on ${project}. Missing: ${missing.join(' ')}`,
        fix: 'an owner of the project grants you roles/owner, or runs the install' }
      : { id: 'permissions', state: 'ok', text: `${account || 'the caller'} can do everything the install needs` });
  }

  const billing = call('GET', `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`);
  if (billing.status !== 200) checks.push(unknown('billing', "the project's billing", billing));
  else if (billing.json?.billingEnabled) checks.push({ id: 'billing', state: 'ok', text: 'billing is enabled' });
  else {
    checks.push({ id: 'billing', state: 'blocker', text: `billing is not enabled on ${project}`,
      fix: `link a billing account: https://console.cloud.google.com/billing/linkedaccount?project=${project}` });
  }

  const ancestry = call('POST', `${crm}:getAncestry`, {});
  if (ancestry.status !== 200) checks.push(unknown('organization', 'where the project sits in its organization', ancestry));
  else if ((ancestry.json?.ancestor || []).some((a) => a.resourceId?.type === 'organization')) {
    checks.push({ id: 'organization', state: 'ok', text: 'the project is inside an organization' });
  } else {
    checks.push({ id: 'organization', state: 'blocker',
      text: `${project} is not inside a Google Cloud organization. The dashboard's Google sign-in (Identity-Aware Proxy) needs one`,
      fix: "move the project into your Workspace's organization, then run this again" });
  }

  const ctx = { project, region, zone, apis };
  for (const check of ORG_POLICY_CHECKS) {
    const id = `policy:${check.constraint}`;
    const policy = call('GET', `https://orgpolicy.googleapis.com/v2/projects/${project}/policies/${check.constraint}:getEffectivePolicy`);
    if (policy.status !== 200) {
      // One reason (the API off, or no right to read policies) usually stops them all: say it once.
      checks.push(unknown('policy', 'the organization policies', policy));
      break;
    }
    const rules = policy.json?.spec?.rules || [];
    const reason = check.evaluate(rules, ctx);
    if (reason) {
      checks.push({ id, state: 'blocker', text: `${check.constraint}: ${reason}, and ${check.breaks}`,
        fix: 'an organization policy administrator exempts this project, or the install goes in another project' });
    } else if (rules.some((r) => r.condition)) {
      checks.push({ id, state: 'note', text: `${check.constraint} has rules with conditions: check by hand that they allow it (${check.breaks})` });
    }
  }
  if (!checks.some((c) => c.id === 'policy' || c.id.startsWith('policy:'))) {
    checks.push({ id: 'policy', state: 'ok', text: 'no organization policy blocks the install' });
  }

  const enabled = new Set();
  let page = '';
  let services;
  do {
    services = call('GET', `https://serviceusage.googleapis.com/v1/projects/${project}/services?filter=state:ENABLED&pageSize=200${page ? `&pageToken=${page}` : ''}`);
    for (const s of services.json?.services || []) enabled.add(s.config?.name);
    page = services.json?.nextPageToken || '';
  } while (services.status === 200 && page);
  if (services.status !== 200) checks.push(unknown('apis', 'which APIs are on', services));
  else {
    const off = apis.filter((api) => !enabled.has(api));
    checks.push({ id: 'apis', state: off.length ? 'note' : 'ok',
      text: off.length ? `step 2 turns on ${off.length} APIs: ${off.join(' ')}` : `all ${apis.length} APIs the install needs are on` });
  }
  return { checks };
}

/** The command line. Exported for the tests. */
export function cli(argv, { stdin, curl } = {}) {
  const opts = {};
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--json') { opts.json = true; continue; }
    if (!['--project', '--region', '--zone', '--apis', '--permissions', '--account', '--quota-project'].includes(key) || i + 1 >= argv.length) {
      return { status: 2, output: `install/lib/preflight.mjs: unknown or incomplete option ${key}` };
    }
    opts[key.slice(2)] = argv[++i];
  }
  const token = String(stdin || '').split('\n')[0].trim();
  if (!opts.project || !opts.region || !opts.zone || !token) {
    return { status: 2, output: 'install/lib/preflight.mjs: needs --project, --region and --zone, and the token on stdin' };
  }
  const { checks } = preflight({
    project: opts.project, region: opts.region, zone: opts.zone, apis: list(opts.apis), permissions: list(opts.permissions),
    token, account: opts.account, quotaProject: opts['quota-project'], ...(curl ? { curl } : {}),
  });
  const status = checks.some((c) => c.state === 'blocker') ? 1 : 0;
  const output = opts.json
    ? JSON.stringify({ checks })
    : checks.map((c) => [c.state, c.id, c.text, c.fix || ''].map((s) => String(s).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
  return { status, output };
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try { return realpathSync(path); } catch { return path; }
  };
  const norm = (path) => (process.platform === 'win32' ? real(path).toLowerCase() : real(path));
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  const { status, output } = cli(process.argv.slice(2), { stdin: readFileSync(0, 'utf8') });
  if (output) process.stdout.write(`${output}\n`);
  process.exit(status);
}
