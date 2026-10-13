#!/usr/bin/env node
// test/e2e/run.mjs — live end-to-end runner for singular (zero dependencies, Node >= 20).
//
//   node test/e2e/run.mjs [--list] [--filter <tag>[,<tag>]] [--case <substring>[,<substring>]] [--model <haiku|sonnet>]
//                         [--max-cost <usd>] [--no-sonnet] [--keep] [--tmp <dir>]
//
// Discovers test/e2e/cases/*.mjs (each exports {name, tags, costCapUsd, run(ctx)}), runs them in order against a
// REAL `claude -p` with the plugin loaded for that session only (test/e2e/README.md recipe), and prints
// PASS / FAIL / SKIP per case with the reason, INFO lines for non-asserting observations, the cost of every
// case and the total. Exit 1 when any case FAILs or when the global state fingerprint changed.
//
// Isolation guarantees (enforced here, not by the cases): every case gets a fresh SINGULAR_HOME outside its
// cwd; the plugin is loaded with --plugin-dir --setting-sources project --strict-mcp-config; the real
// ~/.claude/settings*.json, ~/.claude/plugins/installed_plugins.json, ~/.claude/skills listing AND the real
// ~/.claude/singular state are fingerprinted before and after; ~/.claude/projects/<temp cwd> directories that a
// persisted or subagent run creates are removed (only those derived from this run's temp cwds).
//
// Env: E2E_MAX_COST_USD (global cap, default 3), SINGULAR_E2E_MODEL (default haiku), SINGULAR_E2E_BUDGET
//      (per-call --max-budget-usd, default 0.5), SINGULAR_E2E_TMP (work dir, default $TMPDIR/singular-e2e),
//      SINGULAR_E2E_SONNET=0 (skip cases tagged sonnet).
// Cost caps: the global cap SKIPs a case that would exceed it and throws SKIP inside a case that reaches it; a case's
// own costCapUsd bounds every call it makes (--max-budget-usd = min(budget, cap - spent so far, >= 0.01)) and reaching
// it mid-case, or ending above it, is a FAIL of that case (a model loop must not starve the later cases).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROOT } from './lib/catalog.mjs';
import { runClaude, promptHook, promptContext } from './lib/claude.mjs';
import { Checker } from './lib/check.mjs';
import { CaseFailure, SkipError } from './lib/errors.mjs';
import { buildGitBase } from './lib/gitbase.mjs';
import { startRegistry } from './lib/registry.mjs';
import { diffSnapshots, globalSnapshot, singularSnapshot } from './lib/snapshot.mjs';
import { cacheEntry, cacheValues, makeWorld, projectDirName, readLog, readJsonFile, realHome, runNode, waitFor, writeConfig } from './lib/world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgv(argv) {
  const out = { list: false, filter: [], cases: [], model: process.env.SINGULAR_E2E_MODEL || 'haiku', maxCost: Number(process.env.E2E_MAX_COST_USD) || 3, sonnet: process.env.SINGULAR_E2E_SONNET !== '0', keep: false, tmp: process.env.SINGULAR_E2E_TMP || null, help: false, budget: Number(process.env.SINGULAR_E2E_BUDGET) || 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--filter') out.filter.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--case') out.cases.push(...String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    else if (a === '--model') out.model = String(argv[++i] ?? 'haiku');
    else if (a === '--max-cost') out.maxCost = Number(argv[++i]) || out.maxCost;
    else if (a === '--budget') out.budget = Number(argv[++i]) || out.budget;
    else if (a === '--no-sonnet') out.sonnet = false;
    else if (a === '--keep') out.keep = true;
    else if (a === '--tmp') out.tmp = String(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function loadCases() {
  const dir = path.join(HERE, 'cases');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort();
  const cases = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const c = mod.default ?? mod;
    if (typeof c.run !== 'function' || !c.name) throw new Error(`${f}: a case must export {name, tags, costCapUsd, run}`);
    cases.push({ file: f, name: c.name, tags: Array.isArray(c.tags) ? c.tags : [], costCapUsd: Number(c.costCapUsd) || 0.05, run: c.run });
  }
  return cases;
}

function usd(n) {
  return `$${(Number(n) || 0).toFixed(4)}`;
}

// The smallest --max-budget-usd handed to one call when a case is close to its cap (a single haiku turn costs
// $0.001-0.004; Claude Code checks the budget between turns, so one turn may still overshoot it slightly).
const MIN_CALL_BUDGET_USD = 0.01;

function removeProjectDirs(cwds, runDir) {
  const removed = [];
  for (const cwd of cwds) {
    if (!cwd || !cwd.startsWith(runDir + path.sep)) continue; // only this run's temp cwds, never a real project
    const name = projectDirName(cwd);
    for (const base of [path.join(realHome(), '.claude', 'projects'), path.join(os.tmpdir(), 'claude-' + (process.getuid?.() ?? '')), '/private/tmp/claude-' + (process.getuid?.() ?? '')]) {
      const dir = path.join(base, name);
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        /* report nothing: best effort */
      }
    }
  }
  return removed;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('usage: node test/e2e/run.mjs [--list] [--filter tag[,tag]] [--case substr[,substr]] [--model haiku|sonnet] [--max-cost usd] [--no-sonnet] [--keep] [--tmp dir]\n');
    return 0;
  }
  const cases = await loadCases();
  const selected = cases.filter((c) => (args.filter.length === 0 || args.filter.some((t) => c.tags.includes(t))) && (args.cases.length === 0 || args.cases.some((sub) => c.name.includes(sub) || c.file.includes(sub))));
  if (args.list) {
    for (const c of cases) process.stdout.write(`${c.file.padEnd(34)} ${c.name.padEnd(48)} tags=${c.tags.join(',')}  cap=${usd(c.costCapUsd)}\n`);
    process.stdout.write(`${cases.length} cases; ${selected.length} selected\n`);
    return 0;
  }

  // --- preflight: tools on PATH
  for (const tool of ['claude', 'git']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stdout.write(`SKIP  ${tool} not found on PATH; the e2e suite needs Claude Code >= 2.1.282 (logged in), git and node\n`);
      return 0;
    }
  }
  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();

  const workRoot = args.tmp ? path.resolve(args.tmp) : path.join(os.tmpdir(), 'singular-e2e');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(workRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  process.stdout.write(`singular e2e  plugin=${ROOT}  claude=${claudeVersion}  model=${args.model}  cap=${usd(args.maxCost)}  work=${runDir}\n`);

  const before = { global: globalSnapshot(), singular: singularSnapshot() };
  fs.writeFileSync(path.join(runDir, 'before.txt'), `${before.global}\n---\n${before.singular}\n`);

  // --- shared fixtures: one git base for the whole run (outside every cwd), rebuilt per run
  const gitBase = await buildGitBase(path.join(runDir, 'gitbase'));

  // --- login probe (one cheap haiku call; its cost counts)
  let totalCost = 0;
  const costs = [];
  {
    const w = makeWorld(path.join(runDir, '_probe'), 'login', { cwd: 'empty', config: { mode: 'local' } });
    try {
      const r = await runClaude('Reply with the word OK only. Do not use any tools.', { root: ROOT, cwd: w.cwd, home: w.home, model: 'haiku', maxBudgetUsd: args.budget, outFile: path.join(w.base, 'probe.jsonl') });
      totalCost += r.costUsd;
      costs.push(['login-probe', r.costUsd]);
      removeProjectDirs([w.cwd], runDir); // the probe's transcript dir under ~/.claude/projects, like every case's
      process.stdout.write(`      login ok (session ${r.sessionId}, ${usd(r.costUsd)}, ${r.wallMs} ms, plugins: ${r.plugins.join(' ')})\n`);
    } catch (e) {
      if (e instanceof SkipError) {
        process.stdout.write(`SKIP  ${e.message}\n`);
        return 0;
      }
      throw e;
    }
  }

  const summary = { pass: 0, fail: 0, skip: 0 };
  const lines = [];
  for (const c of selected) {
    const caseDir = path.join(runDir, c.file.replace(/\.mjs$/, ''));
    fs.mkdirSync(caseDir, { recursive: true });
    const checker = new Checker();
    const servers = [];
    const worlds = [];
    let callCount = 0;
    let caseCost = 0;
    const model = c.tags.includes('sonnet') ? 'sonnet' : args.model;
    const started = Date.now();
    let status = 'PASS';
    let reason = '';

    const ctx = {
      root: ROOT,
      runDir,
      caseDir,
      model,
      budget: args.budget,
      gitBase,
      claudeVersion,
      check: checker.check.bind(checker),
      eq: checker.eq.bind(checker),
      match: checker.match.bind(checker),
      noMatch: checker.noMatch.bind(checker),
      includes: checker.includes.bind(checker),
      excludes: checker.excludes.bind(checker),
      info: checker.info.bind(checker),
      fail: checker.fail.bind(checker),
      skip: checker.skip.bind(checker),
      world(label, opts) {
        const w = makeWorld(caseDir, label, opts);
        worlds.push(w);
        return w;
      },
      writeConfig,
      readLog,
      readJson: readJsonFile,
      cacheEntry,
      cacheValues,
      waitFor,
      runNode,
      promptHook,
      promptContext,
      projectDirName,
      async registry(opts = {}) {
        const s = await startRegistry({ ...opts, root: ROOT });
        servers.push(s);
        return s;
      },
      async claude(prompt, opts = {}) {
        if (totalCost + caseCost >= args.maxCost) throw new SkipError(`global cost cap ${usd(args.maxCost)} reached before this call`);
        // The case's own cap (costCapUsd) is enforced per call too: a model loop in one case must not spend the
        // global budget of every later case. Reaching it is a FAIL (the case declared the cap), not a SKIP.
        if (caseCost >= c.costCapUsd) throw new CaseFailure(`case cost cap ${usd(c.costCapUsd)} reached after ${callCount} call(s) (${usd(caseCost)} spent)`);
        if (opts.model && opts.model !== 'haiku' && !args.sonnet) throw new SkipError('sonnet runs disabled (--no-sonnet)');
        callCount++;
        const w = opts.world;
        const perCall = Math.min(opts.maxBudgetUsd ?? args.budget, Math.max(MIN_CALL_BUDGET_USD, c.costCapUsd - caseCost));
        const r = await runClaude(prompt, {
          root: ROOT,
          cwd: opts.cwd ?? w?.cwd,
          home: opts.home ?? w?.home,
          model: opts.model ?? model,
          outFile: path.join(caseDir, `${String(callCount).padStart(2, '0')}-${(opts.label ?? 'run').replace(/[^A-Za-z0-9-]+/g, '-')}.jsonl`),
          ...opts,
          maxBudgetUsd: perCall,
        });
        caseCost += r.costUsd;
        return r;
      },
    };

    try {
      if (!args.sonnet && c.tags.includes('sonnet')) throw new SkipError('sonnet case skipped (--no-sonnet / SINGULAR_E2E_SONNET=0)');
      if (totalCost + c.costCapUsd > args.maxCost) throw new SkipError(`would exceed the global cost cap (${usd(totalCost)} spent + ${usd(c.costCapUsd)} cap > ${usd(args.maxCost)})`);
      await c.run(ctx);
      if (caseCost > c.costCapUsd) checker.failures.push(`case cost ${usd(caseCost)} exceeded its declared cap ${usd(c.costCapUsd)} (the last call overshot its --max-budget-usd)`);
      if (checker.failures.length) {
        status = 'FAIL';
        reason = `${checker.failures.length} assertion(s) failed`;
      }
    } catch (e) {
      if (e instanceof SkipError) {
        status = 'SKIP';
        reason = e.message;
      } else if (e instanceof CaseFailure) {
        status = 'FAIL';
        reason = e.message;
      } else {
        status = 'FAIL';
        reason = `threw ${e?.stack ?? e}`;
      }
    } finally {
      for (const s of servers) await s.close().catch(() => {});
      const removed = removeProjectDirs(worlds.map((w) => w.cwd), runDir);
      if (removed.length) checker.info(`removed ${removed.length} transcript dir(s) derived from this case's temp cwd`);
    }
    totalCost += caseCost;
    costs.push([c.name, caseCost]);
    summary[status.toLowerCase()]++;
    const wall = ((Date.now() - started) / 1000).toFixed(1);
    const head = `${status.padEnd(5)} ${c.name}  (${usd(caseCost)}, ${wall} s, ${callCount} call${callCount === 1 ? '' : 's'})${reason ? `: ${reason}` : ''}`;
    process.stdout.write(`${head}\n`);
    lines.push(head);
    for (const f of checker.failures) {
      process.stdout.write(`      FAILED  ${f}\n`);
      lines.push(`      FAILED  ${f}`);
    }
    for (const i of checker.infos) {
      process.stdout.write(`      INFO    ${i}\n`);
      lines.push(`      INFO    ${i}`);
    }
  }

  // --- global state must be untouched
  const after = { global: globalSnapshot(), singular: singularSnapshot() };
  fs.writeFileSync(path.join(runDir, 'after.txt'), `${after.global}\n---\n${after.singular}\n`);
  let stateOk = true;
  if (after.global !== before.global) {
    stateOk = false;
    process.stdout.write('FAIL  global state changed (~/.claude/settings*.json, installed_plugins.json or ~/.claude/skills):\n');
    for (const l of diffSnapshots(before.global, after.global)) process.stdout.write(`      ${l}\n`);
  } else process.stdout.write('PASS  ~/.claude/settings*.json, installed_plugins.json and ~/.claude/skills unchanged\n');
  if (after.singular !== before.singular) {
    stateOk = false;
    process.stdout.write('FAIL  the real ~/.claude/singular state changed (isolation leak):\n');
    for (const l of diffSnapshots(before.singular, after.singular)) process.stdout.write(`      ${l}\n`);
  } else process.stdout.write('PASS  real ~/.claude/singular untouched\n');

  const totalLine = `e2e: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped; total cost ${usd(totalCost)} (cap ${usd(args.maxCost)}); artifacts: ${runDir}`;
  process.stdout.write(`\n${totalLine}\n`);
  fs.writeFileSync(path.join(runDir, 'summary.txt'), `${lines.join('\n')}\n${totalLine}\ncosts:\n${costs.map(([n, c]) => `  ${usd(c)}  ${n}`).join('\n')}\n`);
  if (!args.keep && summary.fail === 0 && stateOk) {
    // keep artifacts by default: they are the evidence; --keep is accepted for symmetry with run.sh
  }
  return summary.fail === 0 && stateOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`e2e runner crashed: ${err?.stack ?? err}\n`);
    process.exit(2);
  },
);
