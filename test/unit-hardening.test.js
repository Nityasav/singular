// Regression tests for the 2026-10-13 security review of /singular init:
//   1. quotedNames must be linear (an unterminated quote used to backtrack polynomially);
//   2. the project walk must not load a whole huge directory before the file cap applies;
//   3. --project installs must never follow a symlinked .claude or .claude/skills out of the project.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quotedNames, readDirBounded, inspectProject, MAX_QUOTED_BLOCK } from '../lib/needs.js';
import { runAdd, symlinkBetween } from '../lib/commands/add.js';

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `singular-hardening-${label}-`));

describe('quotedNames is linear and bounded', () => {
  test('still extracts names and tolerates version suffixes inside the quotes', () => {
    assert.deepEqual(quotedNames('"fastapi", \'uvicorn[standard]>=0.30\', "x"'), ['fastapi', 'uvicorn', 'x']);
    assert.deepEqual(quotedNames('"-bad"'), []);
  });
  test('an unterminated 300 KB quote returns in well under 100 ms (input capped, no polynomial backtracking)', () => {
    const evil = `"${'a'.repeat(300 * 1024)}`;
    const t0 = performance.now();
    const out = quotedNames(evil);
    const ms = performance.now() - t0;
    assert.deepEqual(out, []);
    assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
    assert.ok(MAX_QUOTED_BLOCK <= 16 * 1024);
  });
  test('many starts with no closing quote stay fast', () => {
    const evil = ('"abc' + '.'.repeat(60)).repeat(2000);
    const t0 = performance.now();
    quotedNames(evil);
    assert.ok(performance.now() - t0 < 100);
  });
});

describe('directory reads are bounded', () => {
  test('readDirBounded stops at the limit; inspectProject marks the scan truncated at maxFiles', async () => {
    const dir = tmp('bigdir');
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), '');
    assert.equal(readDirBounded(dir, 50).length, 50);
    assert.equal(readDirBounded(dir, 0).length, 0);
    assert.equal(readDirBounded(path.join(dir, 'missing'), 10), null);
    const t0 = performance.now();
    const r = await inspectProject(dir, { maxFiles: 100 });
    assert.equal(r.truncated, true);
    assert.equal(r.filesScanned, 100);
    assert.ok(performance.now() - t0 < 1000);
  });
});

describe('--project installs never follow symlinks out of the project', () => {
  test('symlinkBetween flags a linked .claude, a linked skills dir, a file in the chain, and an outside root', () => {
    const proj = tmp('proj');
    const outside = tmp('outside');
    fs.symlinkSync(outside, path.join(proj, '.claude'));
    assert.match(symlinkBetween(proj, path.join(proj, '.claude', 'skills')), /\.claude is a symlink/);
    fs.unlinkSync(path.join(proj, '.claude'));
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.symlinkSync(outside, path.join(proj, '.claude', 'skills'));
    assert.match(symlinkBetween(proj, path.join(proj, '.claude', 'skills')), /skills is a symlink/);
    fs.unlinkSync(path.join(proj, '.claude', 'skills'));
    fs.writeFileSync(path.join(proj, '.claude', 'skills'), 'not a dir');
    assert.match(symlinkBetween(proj, path.join(proj, '.claude', 'skills')), /not a directory/);
    fs.unlinkSync(path.join(proj, '.claude', 'skills'));
    assert.equal(symlinkBetween(proj, path.join(proj, '.claude', 'skills')), '', 'missing components are fine: mkdir creates real dirs');
    assert.match(symlinkBetween(proj, outside), /not inside/);
  });
  test('runAdd refuses a symlinked target before any network or git activity, and writes nothing outside', async () => {
    const proj = tmp('proj2');
    const outside = tmp('outside2');
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.symlinkSync(outside, path.join(proj, '.claude', 'skills'));
    const home = tmp('home');
    let gitCalls = 0;
    const execFileImpl = (...args) => { gitCalls++; const cb = args[args.length - 1]; cb(new Error('must not be called')); };
    const r = await runAdd({
      ref: 'multica-ai/andrej-karpathy-skills#2c606141936f1eeef17fa3043a72095b4765b9c2@karpathy-guidelines',
      env: { ...process.env, SINGULAR_HOME: home, HOME: home },
      deps: { execFileImpl, fetchImpl: async () => { throw new Error('must not be called'); } },
      targetDir: path.join(proj, '.claude', 'skills'),
      targetBase: proj,
    });
    assert.equal(r.status, 'error');
    assert.match(r.message, /REFUSED: .*skills is a symlink/);
    assert.equal(gitCalls, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});
