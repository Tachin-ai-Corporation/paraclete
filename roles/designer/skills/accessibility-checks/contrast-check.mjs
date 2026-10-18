#!/usr/bin/env node
// roles/designer/skills/accessibility-checks/contrast-check.mjs: the contrast-check command. Computes
// the WCAG 2 contrast ratio of text and background color pairs, and whether each pair meets the levels
// for normal text, large text and non-text elements (icons, borders, chart marks). Pure arithmetic,
// no network and no files beyond an optional list of pairs: a ratio is computed, never estimated by eye.
// Documented in roles/designer/skills/accessibility-checks/SKILL.md.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseOptions } from 'node:util';

export const USAGE = [
  'Usage: contrast-check <foreground> <background> [<foreground> <background> ...] [--require aa|aa-large|aaa|aaa-large|non-text] [--json]',
  '       contrast-check --pairs <file.json> [--require <level>] [--json]',
  'A color is #rgb, #rrggbb, rgb(r, g, b) or srgb(r, g, b) with 0-255 channels, or a CSS name: black, white.',
  '<file.json> is a list of { "foreground", "background", "label" }.',
].join('\n');

/** The WCAG 2 thresholds, by level. */
export const LEVELS = Object.freeze({
  'aa': 4.5, // normal text, AA
  'aa-large': 3, // large text (24px, or 18.66px bold), AA
  'aaa': 7, // normal text, AAA
  'aaa-large': 4.5, // large text, AAA
  'non-text': 3, // icons, borders, focus rings, chart marks (WCAG 2.1, 1.4.11)
});

const NAMED = Object.freeze({ black: [0, 0, 0], white: [255, 255, 255] });

/**
 * A color as [r, g, b] in 0-255, or null when it is not one this command reads.
 *
 * @param {string} text
 * @returns {number[]|null}
 */
export function parseColor(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (NAMED[s]) return [...NAMED[s]];
  let m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^s?rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s);
  if (m) {
    const channels = m.slice(1, 4).map(Number);
    return channels.every((c) => c <= 255) ? channels : null;
  }
  return null;
}

/** The color as #rrggbb. */
export function toHex([r, g, b]) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function relativeLuminance([r, g, b]) {
  const linear = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The contrast ratio of two colors, 1 to 21, unrounded: whichever is lighter goes on top. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * One pair's result. The ratio is shown truncated to two decimals, never rounded up: WCAG compares the
 * exact ratio, so 4.497 fails 4.5 and must not print as 4.50.
 */
export function checkPair(foreground, background, label) {
  const ratio = contrastRatio(foreground, background);
  const passes = Object.fromEntries(Object.entries(LEVELS).map(([level, min]) => [level, ratio >= min]));
  return {
    ...(label ? { label } : {}),
    foreground: toHex(foreground),
    background: toHex(background),
    ratio: Math.floor(ratio * 100) / 100,
    passes,
  };
}

/**
 * @param {string[]} argv
 * @returns {object} { help } | { error } | { pairs: [{ fg, bg, label }] | null, pairsFile, require, json }
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseOptions({
      args: argv,
      allowPositionals: true,
      options: { pairs: { type: 'string' }, require: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.require !== undefined && !(values.require in LEVELS)) {
    return { error: `--require must be one of ${Object.keys(LEVELS).join(', ')}` };
  }
  const out = { require: values.require, json: values.json === true, pairsFile: values.pairs };
  if (values.pairs !== undefined) {
    if (positionals.length) return { error: 'give colors on the command line or in --pairs, not both' };
    return out;
  }
  if (positionals.length === 0 || positionals.length % 2 !== 0) {
    return { error: 'give colors in pairs: <foreground> <background> [<foreground> <background> ...]' };
  }
  out.pairs = [];
  for (let i = 0; i < positionals.length; i += 2) out.pairs.push({ fg: positionals[i], bg: positionals[i + 1] });
  return out;
}

/** Pairs from a --pairs file: a JSON list of { foreground, background, label }. */
export function readPairs(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list) || list.length === 0) throw new Error('the file must hold a non-empty JSON list of { "foreground", "background", "label" }');
  return list.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`item ${i + 1} is not an object`);
    return { fg: p.foreground ?? p.fg, bg: p.background ?? p.bg, label: typeof p.label === 'string' ? p.label : undefined };
  });
}

function line(result) {
  const verdict = (level) => `${result.passes[level] ? 'pass' : 'FAIL'}`;
  const name = result.label ? `${result.label}: ` : '';
  return `${name}${result.foreground} on ${result.background}: ${result.ratio.toFixed(2)}:1 | text AA ${verdict('aa')} (4.5) | large text AA ${verdict('aa-large')} (3) | text AAA ${verdict('aaa')} (7) | non-text ${verdict('non-text')} (3)`;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {{write: Function}} [deps.stdout]
 * @param {{write: Function}} [deps.stderr]
 * @param {Function} [deps.readText] (path) => string, for --pairs
 * @returns {Promise<number>} 0; 1 when a pair fails the --require level; 2 for a usage error or a color
 *   it cannot read
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fail = (message, code = 2) => { stderr.write(`contrast-check: ${message}\n`); return code; };

  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (args.error) return fail(`${args.error}\n${USAGE}`);

  let pairs = args.pairs;
  if (args.pairsFile !== undefined) {
    try {
      pairs = readPairs((deps.readText || ((path) => readFileSync(path, 'utf8')))(args.pairsFile));
    } catch (err) {
      return fail(`cannot read pairs from ${args.pairsFile}: ${err.message}`);
    }
  }

  const results = [];
  for (const [i, { fg, bg, label }] of pairs.entries()) {
    const foreground = parseColor(fg);
    const background = parseColor(bg);
    const bad = [!foreground && fg, !background && bg].filter((c) => c !== false);
    if (bad.length) return fail(`pair ${i + 1}: cannot read ${bad.map((c) => JSON.stringify(c ?? '')).join(' and ')} as a color (#rgb, #rrggbb, rgb(r, g, b))`);
    results.push(checkPair(foreground, background, label));
  }

  stdout.write(args.json ? `${JSON.stringify(results, null, 2)}\n` : `${results.map(line).join('\n')}\n`);
  if (args.require) {
    const failing = results.filter((r) => !r.passes[args.require]);
    if (failing.length) {
      stderr.write(`contrast-check: ${failing.length} of ${results.length} pair${results.length === 1 ? '' : 's'} below ${args.require} (${LEVELS[args.require]}:1)\n`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
