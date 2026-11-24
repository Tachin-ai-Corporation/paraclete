#!/usr/bin/env node
// roles/support-specialist/skills/support-triage/support-preflight.mjs: checks that every slot
// and external permission needed by support-triage works end-to-end before turning on the scheduled
// inbox poll, and can initialize an agent-owned SOC 2 Audit Log Google Sheet.

import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';
import { createCliRuntime } from '../../../../agent/cli/cli-runtime.mjs';
import { makeAddress } from '../../../../agent/providers/channel.mjs';
import { parseDriveLink } from '../../../../agent/providers/drive.mjs';
import { createDocsClient, renderDocument } from '../../../../agent/providers/workspace-docs.mjs';
import { createGmailClient, extractEmailAddress } from '../../../../agent/providers/workspace-gmail.mjs';
import { createSheetsClient, tabRange } from '../../../../agent/providers/workspace-sheets.mjs';
import { WORK_SCHEMA } from '../../../../agent/work/work-schema.mjs';
import { validate } from '../../../../agent/work/validate-schema.mjs';

export const USAGE = [
  'Usage: support-preflight --intake <address> --from <address> --space <spaces/id> --policy-doc <id-or-url>',
  '                         [--soc2-sheet <id-or-url> | --init-soc2-sheet "<title>"] [--soc2-tab "<tab>"] [--ping-chat] [--json]',
].join('\n');

const BARE_ID = /^[A-Za-z0-9_-]{10,}$/;
const SOC2_HEADERS_CSV = 'Timestamp,Message ID,Sender,Subject,Summary,Status,Response,Sent At\n';

/** Extracts a Google Drive / Docs / Sheets document id from a URL or bare id. */
export function resolveGoogleFileId(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const fromLink = parseDriveLink(s);
  if (fromLink) return fromLink;
  return BARE_ID.test(s) ? s : null;
}

/**
 * Parses CLI arguments for `support-preflight`.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: {
        intake: { type: 'string' },
        from: { type: 'string' },
        space: { type: 'string' },
        'policy-doc': { type: 'string' },
        'soc2-sheet': { type: 'string' },
        'init-soc2-sheet': { type: 'string' },
        'soc2-tab': { type: 'string' },
        'ping-chat': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length) return { error: 'support-preflight takes flags only, no positional arguments' };
  const intake = extractEmailAddress(values.intake || '');
  if (!intake) return { error: '--intake <address> must be a valid email address' };
  const from = extractEmailAddress(values.from || '');
  if (!from) return { error: '--from <address> must be a valid email address' };
  const space = String(values.space || '').trim();
  if (!space) return { error: '--space <spaces/id> is required' };
  const policyDoc = resolveGoogleFileId(values['policy-doc']);
  if (!policyDoc) return { error: '--policy-doc <id-or-url> is required' };
  if (values['soc2-sheet'] && values['init-soc2-sheet']) {
    return { error: 'use either --soc2-sheet or --init-soc2-sheet, not both' };
  }
  const soc2Sheet = values['soc2-sheet'] ? resolveGoogleFileId(values['soc2-sheet']) : null;
  if (values['soc2-sheet'] && !soc2Sheet) {
    return { error: '--soc2-sheet must be a valid Google Sheets URL or id' };
  }
  const initSoc2Title = values['init-soc2-sheet'] ? String(values['init-soc2-sheet']).trim() : null;
  if (values['init-soc2-sheet'] !== undefined && !initSoc2Title) {
    return { error: '--init-soc2-sheet requires a non-empty spreadsheet title' };
  }
  if (!soc2Sheet && !initSoc2Title) {
    return { error: 'provide --soc2-sheet <id-or-url> or --init-soc2-sheet "<title>"' };
  }
  return {
    intake,
    from,
    space,
    policyDoc,
    soc2Sheet,
    initSoc2Title,
    soc2Tab: values['soc2-tab'] ? String(values['soc2-tab']).trim() : null,
    pingChat: values['ping-chat'] === true,
    json: values.json === true,
  };
}

/**
 * Entry point for `support-preflight`.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || Date.now;
  const fail = (msg, code = 1) => { stderr.write(`support-preflight: ${msg}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`, 2);

  try {
    const needsRuntime = !deps.gmail || !deps.docs || !deps.sheets || (args.pingChat && !deps.db);
    const runtime = deps.runtime || (needsRuntime ? createCliRuntime({ stderr }) : null);
    const gmail = deps.gmail || createGmailClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const docs = deps.docs || createDocsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const sheets = deps.sheets || createSheetsClient({ instance: runtime.instance, getAccessToken: runtime.getAccessToken, fetch: runtime.fetch });
    const checks = [];

    // 1. Intake mailbox search
    try {
      const search = await gmail.search({ query: `to:${args.intake} newer_than:7d`, limit: 5 });
      const count = Array.isArray(search?.messages) ? search.messages.length : 0;
      checks.push({
        check: 'intake_mailbox',
        ok: true,
        detail: count > 0
          ? `Found ${count} recent message(s) addressed to ${args.intake} in Gmail.`
          : `Gmail search works for to:${args.intake} (0 messages in the last 7d; verify the Google Group delivers mail to ${gmail.account} if messages are expected).`,
      });
    } catch (err) {
      checks.push({ check: 'intake_mailbox', ok: false, error: err.message });
    }

    // 2. Outbound Send-As alias verification
    try {
      const { aliases } = await gmail.listSendAs();
      const verified = (aliases || []).filter((a) => a.isPrimary || a.verificationStatus === 'accepted');
      const match = verified.find((a) => extractEmailAddress(a.sendAsEmail) === args.from);
      if (match) {
        checks.push({
          check: 'send_as_alias',
          ok: true,
          detail: `${args.from} is verified in Gmail Send-As (${match.isPrimary ? 'primary account' : 'accepted alias'}).`,
        });
      } else {
        const list = verified.map((a) => a.sendAsEmail).filter(Boolean).join(', ') || 'none';
        checks.push({
          check: 'send_as_alias',
          ok: false,
          error: `${args.from} is NOT a verified Send-As alias on ${gmail.account} (verified: ${list}). Sign into Gmail as ${gmail.account}, open Settings -> Accounts -> Send mail as, add ${args.from}, and verify it.`,
        });
      }
    } catch (err) {
      checks.push({ check: 'send_as_alias', ok: false, error: err.message });
    }

    // 3. Policy & Procedures Google Doc
    try {
      const doc = await docs.get(args.policyDoc);
      const rendered = renderDocument(doc, { format: 'md' }).trim();
      checks.push({
        check: 'policy_doc',
        ok: Boolean(rendered),
        detail: rendered
          ? `Readable Policy Doc "${doc?.title || args.policyDoc}" (${rendered.length} chars).`
          : `Policy Doc ${args.policyDoc} opened, but contains no readable text.`,
        ...(rendered ? {} : { error: `Policy Doc ${args.policyDoc} has no readable content.` }),
      });
    } catch (err) {
      checks.push({ check: 'policy_doc', ok: false, error: err.message });
    }

    // 4. SOC 2 Audit Log Google Sheet (init owned copy or verify ownership + readability)
    let createdSheet = null;
    try {
      if (args.initSoc2Title) {
        createdSheet = await sheets.create({ title: args.initSoc2Title, csv: SOC2_HEADERS_CSV });
        checks.push({
          check: 'soc2_sheet',
          ok: true,
          spreadsheetId: createdSheet.id,
          webViewLink: createdSheet.webViewLink || null,
          detail: `Created agent-owned SOC 2 Sheet "${createdSheet.name}" (${createdSheet.id}). Save this id in the support project and working memory.`,
        });
      } else {
        const file = await sheets.file(args.soc2Sheet);
        if (!sheets.owns(file)) {
          checks.push({
            check: 'soc2_sheet',
            ok: false,
            error: `Sheet "${file?.name || args.soc2Sheet}" is not owned by ${sheets.account}, so sheets-append/sheets-update will refuse writes. Run support-preflight with --init-soc2-sheet "SOC 2 Support Audit Log" so the agent owns its audit sheet, or transfer Drive ownership to ${sheets.account}.`,
          });
        } else {
          const info = await sheets.info(args.soc2Sheet);
          const tab = args.soc2Tab || info?.sheets?.[0]?.properties?.title || 'Sheet1';
          const vals = await sheets.values(args.soc2Sheet, tabRange(tab, '1:5'));
          checks.push({
            check: 'soc2_sheet',
            ok: true,
            spreadsheetId: args.soc2Sheet,
            tab,
            detail: `Agent owns SOC 2 Sheet "${info?.properties?.title || args.soc2Sheet}" (tab "${tab}", ${vals?.values?.length || 0} header/sample row(s)).`,
          });
        }
      }
    } catch (err) {
      checks.push({ check: 'soc2_sheet', ok: false, error: err.message });
    }

    // 5. Google Chat review space validation (and optional test notification)
    const address = makeAddress('gchat', { space: args.space });
    if (!address.space || !/^spaces\/[A-Za-z0-9_-]+$/.test(address.space)) {
      checks.push({ check: 'chat_space', ok: false, error: `'${args.space}' is not a valid Google Chat space (expected spaces/<id>).` });
    } else if (args.pingChat) {
      try {
        const db = deps.db || runtime.db;
        const workCollection = deps.workCollection || runtime.collections.work;
        const at = new Date(now()).toISOString();
        const workId = `w-support-preflight-${now()}`;
        const envelope = {
          id: workId,
          type: 'R',
          parent_id: null,
          status: 'complete',
          intent: 'notification',
          title: 'Support triage preflight check',
          instruction: `Post support preflight check to ${address.space}`,
          accept_criteria: null,
          context_summary: null,
          output: `Support triage preflight check for ${args.intake} — posting here works cleanly.`,
          error: null,
          children: [],
          depends_on: [],
          source_channel: 'gchat',
          source_meta: { notification_type: 'preflight', address },
          source_text: null,
          created_at: at,
          started_at: at,
          completed_at: at,
          updated_at: at,
          iteration: 0,
          project_id: null,
          memory_written: true,
          delivery_status: 'pending',
          delivery_address: address,
          platform_version: null,
        };
        const checked = validate(WORK_SCHEMA, envelope);
        if (!checked.valid) throw new Error(checked.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
        await db.write(`${workCollection}/${workId}`, envelope);
        checks.push({ check: 'chat_space', ok: true, detail: `Space ${address.space} is valid; queued test ping (${workId}).` });
      } catch (err) {
        checks.push({ check: 'chat_space', ok: false, error: err.message });
      }
    } else {
      checks.push({ check: 'chat_space', ok: true, detail: `Review space ${address.space} format is valid (pass --ping-chat to send a test message).` });
    }

    const ok = checks.every((c) => c.ok);
    const out = { ok, agent: gmail.account, createdSheet, checks };
    if (args.json) {
      stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      stdout.write(`Support preflight (${gmail.account}): ${ok ? 'PASS' : 'FAIL'}\n`);
      for (const c of checks) {
        stdout.write(`- ${c.check}: ${c.ok ? 'PASS' : 'FAIL'} — ${c.ok ? c.detail : c.error}\n`);
      }
    }
    return ok ? 0 : 1;
  } catch (err) {
    return fail(err.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
