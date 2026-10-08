// test/unit-context.test.js — node --test test/unit-context.test.js
//
// Unit tests for lib/context.js: composeContext (every section, every label form, the budget order,
// the loaded block and its truncation), fitLoadedText, spillIfNeeded (pass-through, spill, failure)
// and the exact hookOutput JSON envelopes. Pure functions; only spillIfNeeded touches the disk.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_ROOT = process.env.SKILL_SCOUT_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-context-${label}-`));
}

const ROOT = mkTmp('state');
process.env.SKILL_SCOUT_HOME = path.join(ROOT, 'scout-home');
process.env.HOME = path.join(ROOT, 'home');

const ctx = await import('../lib/context.js');
const { composeContext, fitLoadedText, spillIfNeeded, hookOutput, TAG, SPILL_THRESHOLD, HOOK_HARD_CAP, TRUNCATION_MARKER, RELAY_LINE } = ctx;

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const SHA = '2c606141936f1eeef17fa3043a72095b4765b9c2';
const stack = { summary: 'Next.js 16, Tailwind 4; branch main', tags: ['next', 'tailwind'] };

// ---------------------------------------------------------------------------

describe('constants', () => {
  test('TAG, thresholds, marker and the relay line are exactly what the docs promise', () => {
    assert.equal(TAG, '[skill-scout]');
    assert.equal(SPILL_THRESHOLD, 9500);
    assert.equal(HOOK_HARD_CAP, 10000);
    assert.equal(TRUNCATION_MARKER, '\n[skill-scout: truncated]');
    assert.equal(RELAY_LINE, 'If one of the third-party candidates below fits the request, end your reply with exactly one line `Load with /scout-load <ref>` naming the single best fit; omit that line if none fits.');
    assert.ok(SPILL_THRESHOLD < HOOK_HARD_CAP);
  });
});

// ---------------------------------------------------------------------------

describe('composeContext: sections and label forms', () => {
  test('no arguments / all-empty arguments -> empty string', () => {
    assert.equal(composeContext(), '');
    assert.equal(composeContext({}), '');
    assert.equal(composeContext({ stack: null, localMatches: null, candidates: null, pinned: null, notes: null }), '');
    assert.equal(composeContext({ stack: { summary: '   ' }, localMatches: [], candidates: [], pinned: ['', '  '], notes: ['', null, undefined] }), '');
    assert.equal(composeContext({ stack: 'not-an-object-but-string-is-fine' }), `${TAG} Stack: not-an-object-but-string-is-fine`);
    assert.equal(composeContext({ stack: 42 }), '', 'a non-string, non-object stack is ignored');
  });

  test('stack accepts a string or {summary}; the summary is trimmed; tags are ignored', () => {
    assert.equal(composeContext({ stack: '  Go 1.24; branch main  ' }), `${TAG} Stack: Go 1.24; branch main`);
    assert.equal(composeContext({ stack: { summary: ' X ', tags: ['x'] } }), `${TAG} Stack: X`);
    assert.equal(composeContext({ stack: { tags: ['x'] } }), '');
  });

  test('local match labels: invocableName wins over pluginName:name over name; plain strings and bare skill objects work; matched capped at 4', () => {
    const out = composeContext({
      localMatches: [
        { skill: { name: 'a', invocableName: 'ns:a', pluginName: 'p' }, score: 1, matched: ['one', 'two', 'three', 'four', 'five'] },
        { skill: { name: 'b', pluginName: 'plug' }, score: 1, matched: [] , why: 'custom why' },
        { skill: { name: 'c' }, score: 1, matched: ['', null, 'kept'] },
        { name: 'bare-skill-object', score: 1 },
        'plain-string',
        { skill: { name: '' } },
        null,
      ],
    });
    assert.equal(out, `${TAG} Installed skills likely relevant: ns:a (matches one, two, three, four), plug:b (custom why), c (matches kept), bare-skill-object, plain-string`);
  });

  test('candidate lines: source or owner/repo, installs formatting, #sha7 display only when a valid sha is given, audit as string or object, invalid entries dropped', () => {
    const out = composeContext({
      candidates: [
        { source: 'a/b', skill: 'c', installs: 0 },
        { owner: 'o', repo: 'r', skill: 's', installs: 999, audit: 'warn' },
        { source: 'd/e', skill: 'f', installs: 1000, sha: SHA, audit: { status: 'pass' } },
        { source: 'g/h', skill: 'i', installs: 123456, sha: 'deadbeef' },
        { source: 'j/k', skill: 'l', installs: 1_500_000, sha: SHA.toUpperCase() },
        { source: 'm/n', skill: 'o', installs: 12_345_678 },
        { source: 'p/q', skill: 'r', installs: 'not a number' },
        { source: 'x/y' },
        { skill: 'no-source' },
        { owner: 'only-owner', skill: 'z' },
        'string',
        // Observation: a `null` entry makes candidateLine throw (c.source on null); unreachable from the hook
        // (discover() never yields null) but worth a guard in lib/context.js.
      ],
    });
    const lines = out.split('\n');
    assert.equal(lines[0], `${TAG} ${RELAY_LINE}`);
    assert.equal(lines[1], [
      'Third-party candidates (not loaded): a/b@c (0 installs) — load with /scout-load a/b@c',
      'o/r@s (999 installs, audit warn) — load with /scout-load o/r@s',
      `d/e#${SHA.slice(0, 7)}@f (1.0K installs, audit pass) — load with /scout-load d/e@f`,
      'g/h@i (123K installs) — load with /scout-load g/h@i',
      'j/k@l (1.5M installs) — load with /scout-load j/k@l',
      'm/n@o (12M installs) — load with /scout-load m/n@o',
      'p/q@r (0 installs) — load with /scout-load p/q@r',
    ].join('; '));
    assert.equal(lines.length, 2);
    assert.doesNotMatch(out, /no-source|only-owner|string|deadbeef/);
  });

  test('installs formatting boundaries: 999 -> 999, 1000 -> 1.0K, 99999 -> 100.0K, 100000 -> 100K, 999999 -> 1000K, 1000000 -> 1.0M, 10000000 -> 10M', () => {
    const line = (n) => composeContext({ candidates: [{ source: 'a/b', skill: 'c', installs: n }] }).split('\n')[1];
    assert.match(line(999), /\(999 installs\)/);
    assert.match(line(1000), /\(1\.0K installs\)/);
    assert.match(line(99999), /\(100\.0K installs\)/);
    assert.match(line(100000), /\(100K installs\)/);
    assert.match(line(999999), /\(1000K installs\)/);
    assert.match(line(1_000_000), /\(1\.0M installs\)/);
    assert.match(line(9_999_999), /\(10\.0M installs\)/);
    assert.match(line(10_000_000), /\(10M installs\)/);
    assert.match(line(-5), /\(-5 installs\)/);
  });

  test('mode off/local suppress candidates entirely (relay line included); suggest/auto/unknown modes list them', () => {
    const cands = [{ source: 'a/b', skill: 'c', installs: 5 }];
    assert.equal(composeContext({ stack, candidates: cands, mode: 'off' }), `${TAG} Stack: ${stack.summary}`);
    assert.equal(composeContext({ stack, candidates: cands, mode: 'local' }), `${TAG} Stack: ${stack.summary}`);
    for (const mode of ['suggest', 'auto', undefined, 'weird']) {
      const out = composeContext({ candidates: cands, mode });
      assert.match(out, /Third-party candidates \(not loaded\): a\/b@c/, String(mode));
      assert.match(out, /^\[skill-scout\] If one of the third-party candidates/);
    }
  });

  test('section order: stack, pinned, installed, relay, candidates, notes; the tag is on the first present line only', () => {
    const out = composeContext({
      stack,
      pinned: ['ns:pin-a', ' pin-b '],
      localMatches: [{ skill: { name: 'loc' }, score: 3, matched: ['x'] }],
      candidates: [{ source: 'a/b', skill: 'c', installs: 5 }],
      notes: ['note one', ' note two '],
    });
    assert.deepEqual(out.split('\n'), [
      `${TAG} Stack: ${stack.summary}`,
      'Pinned installed skills (user-configured, consider invoking): ns:pin-a, pin-b',
      'Installed skills likely relevant: loc (matches x)',
      RELAY_LINE,
      'Third-party candidates (not loaded): a/b@c (5 installs) — load with /scout-load a/b@c',
      'note one',
      'note two',
    ]);
    assert.equal((out.match(/\[skill-scout\]/g) || []).length, 1);
    assert.equal(composeContext({ pinned: ['only'] }), `${TAG} Pinned installed skills (user-configured, consider invoking): only`);
    assert.equal(composeContext({ notes: ['only a note'] }), `${TAG} only a note`);
  });
});

// ---------------------------------------------------------------------------

describe('composeContext: budget', () => {
  const local = Array.from({ length: 6 }, (_, i) => ({ skill: { name: `local-skill-${i}` }, score: 9 - i, matched: ['alpha', 'beta'] }));
  const cands = Array.from({ length: 12 }, (_, i) => ({ source: `owner${i}/repo${i}`, skill: `skill-number-${i}`, installs: 1000 * (i + 1), audit: { status: 'pass' } }));

  test('everything fits -> nothing dropped; the budget is inclusive', () => {
    const full = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: 100000 });
    assert.equal(full.split('\n').length, 4);
    const count = (s) => (s.match(/skill-number-\d+ \(/g) || []).length;
    assert.equal(count(full), 12, 'all 12 candidates');
    const exact = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: full.length });
    assert.equal(exact, full, 'a budget equal to the length keeps everything');
    const one = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: full.length - 1 });
    assert.notEqual(one, full);
    assert.equal(count(one), 11, 'one char short drops exactly one candidate');
  });

  test('candidates are dropped from the end first, then local matches from the end, then a hard cut with an ellipsis', () => {
    const steps = [];
    let prev = null;
    for (let b = 4000; b >= 200; b -= 25) {
      const out = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: b });
      assert.ok(out.length <= b, `budget ${b}: ${out.length}`);
      const nCand = (out.match(/skill-number-\d+ \(/g) || []).length;
      const nLocal = (out.match(/local-skill-\d+ \(/g) || []).length;
      if (prev) {
        assert.ok(nCand <= prev.nCand, 'candidates never grow as the budget shrinks');
        if (nCand > 0) assert.equal(nLocal, local.length, 'local matches are only dropped once no candidate is left');
      }
      // candidates kept are always the FIRST ones (dropped from the end)
      if (nCand > 0) assert.match(out, /skill-number-0 /);
      if (nCand > 1) assert.match(out, new RegExp(`skill-number-${nCand - 1} `));
      if (nLocal > 0) assert.match(out, /local-skill-0 /);
      prev = { nCand, nLocal };
      steps.push([b, nCand, nLocal]);
    }
    const tiny = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: 200 });
    assert.ok(tiny.length <= 200);
    assert.match(tiny, /^\[skill-scout\] Stack: /);
    assert.ok(steps.some(([, c]) => c === 0), 'some budget drops every candidate');
    assert.ok(steps.some(([, c, l]) => c === 0 && l < local.length), 'once no candidate is left, local matches start to go');
    assert.equal(steps[steps.length - 1][1], 0, 'at the 200 floor no candidate survives');
  });

  test('the budget floor is 200 and non-numeric budgets fall back to 2000; a hard cut ends with an ellipsis', () => {
    const longStack = { summary: 'x'.repeat(400), tags: [] };
    const floor = composeContext({ stack: longStack, budgetChars: 10 });
    assert.equal(floor.length, 200, 'never below 200');
    assert.ok(floor.endsWith('…'));
    assert.ok(floor.startsWith(`${TAG} Stack: xxx`));
    const dflt = composeContext({ stack: { summary: 'y'.repeat(3000) }, budgetChars: 'nope' });
    assert.equal(dflt.length, 2000);
    const nan = composeContext({ stack: { summary: 'y'.repeat(3000) }, budgetChars: NaN });
    assert.equal(nan.length, 2000);
    const frac = composeContext({ stack: { summary: 'y'.repeat(3000) }, budgetChars: 500.9 });
    assert.equal(frac.length, 500, 'floored');
  });

  test('notes are never dropped by the budget (candidates and locals go first)', () => {
    const out = composeContext({ stack, localMatches: local, candidates: cands, budgetChars: 200, notes: ['the note survives'] });
    assert.ok(out.length <= 200);
    assert.ok(out.endsWith('\nthe note survives'));
    assert.doesNotMatch(out, /Third-party/);
    assert.ok((out.match(/local-skill-\d+ \(/g) || []).length < local.length, 'local matches were cut to make room, the note was not');
    assert.match(out, /^\[skill-scout\] Stack: /);
  });
});

// ---------------------------------------------------------------------------

describe('composeContext: loaded block', () => {
  test('appended after the routing text with the ref, the default reason, the stripped list and the wrapper tags', () => {
    const out = composeContext({ stack, localMatches: [{ skill: { name: 'loc' }, score: 3, matched: ['x'] }], loaded: { ref: `a/b#${SHA}@c`, text: '---\nname: c\n---\nBody', stripped: ['frontmatter: hooks', 'inline shell x1'] } });
    assert.deepEqual(out.split('\n'), [
      `${TAG} Stack: ${stack.summary}`,
      'Installed skills likely relevant: loc (matches x)',
      `Loaded third-party skill a/b#${SHA}@c (auto mode, user-configured; text only, nothing installed). Stripped: frontmatter: hooks; inline shell x1.`,
      `<skill-scout-loaded ref="a/b#${SHA}@c">`,
      '---', 'name: c', '---', 'Body',
      '</skill-scout-loaded>',
    ]);
  });

  test('alone it carries the tag; custom reason; empty stripped list -> no "Stripped:" clause; blank or non-string text -> no block', () => {
    const alone = composeContext({ loaded: { ref: 'a/b@c', text: 'x' } });
    assert.equal(alone, `${TAG} Loaded third-party skill a/b@c (auto mode, user-configured; text only, nothing installed).\n<skill-scout-loaded ref="a/b@c">\nx\n</skill-scout-loaded>`);
    const reason = composeContext({ loaded: { ref: 'a/b@c', text: 'x', reason: '  pinned in config.pinnedSkills ' } });
    assert.match(reason, /\(pinned in config\.pinnedSkills; text only, nothing installed\)\./);
    const blankReason = composeContext({ loaded: { ref: 'a/b@c', text: 'x', reason: '   ' } });
    assert.match(blankReason, /\(auto mode, user-configured;/);
    const noStrip = composeContext({ loaded: { ref: 'a/b@c', text: 'x', stripped: [] } });
    assert.doesNotMatch(noStrip, /Stripped/);
    assert.equal(composeContext({ stack, loaded: { ref: 'a/b@c', text: '   \n ' } }), `${TAG} Stack: ${stack.summary}`);
    assert.equal(composeContext({ stack, loaded: { ref: 'a/b@c', text: 123 } }), `${TAG} Stack: ${stack.summary}`);
    assert.equal(composeContext({ stack, loaded: 'nope' }), `${TAG} Stack: ${stack.summary}`);
  });

  test('a body that would push the block past 9,500 chars is truncated (marker + stripped note), the routing lines are kept, and the result never exceeds the threshold', () => {
    const routing = { stack: { summary: 'S'.repeat(150) }, localMatches: Array.from({ length: 3 }, (_, i) => ({ skill: { name: `skill-${i}` }, score: 5, matched: ['a', 'b', 'c', 'd'] })) };
    for (const len of [9000, 9400, 9499, 9500, 9501, 12000, 50000]) {
      const text = 'z'.repeat(len);
      const out = composeContext({ ...routing, mode: 'auto', loaded: { ref: `o/r#${SHA}@s`, text, stripped: ['frontmatter: hooks'] } });
      assert.ok(out.length <= SPILL_THRESHOLD, `len ${len}: ${out.length} <= ${SPILL_THRESHOLD}`);
      assert.match(out, /^\[skill-scout\] Stack: S{150}\nInstalled skills likely relevant: skill-0/);
      assert.ok(out.endsWith('\n</skill-scout-loaded>'));
      const truncated = /truncated (\d+) chars to fit the 9,500-char hook budget/.exec(out);
      if (truncated) {
        assert.ok(out.includes(TRUNCATION_MARKER), 'marker present when truncated');
        assert.match(out, /Stripped: frontmatter: hooks; truncated \d+ chars to fit the 9,500-char hook budget\./, 'original stripped entries kept, note appended');
        const body = out.split('\n<skill-scout-loaded')[1].split('>\n')[1].split('\n</skill-scout-loaded>')[0];
        const kept = body.replace(TRUNCATION_MARKER, '').length;
        assert.equal(kept + Number(truncated[1]), len, 'kept + truncated = original length');
      } else {
        assert.ok(out.includes(text), `len ${len} fits untouched`);
      }
    }
    assert.ok(/truncated/.test(composeContext({ ...routing, mode: 'auto', loaded: { ref: 'o/r@s', text: 'z'.repeat(9500) } })), 'at 9500 the wrapper alone pushes it over');
  });

  test('a loaded block never spills: spillIfNeeded passes the composed result through', () => {
    const out = composeContext({ stack, loaded: { ref: 'o/r@s', text: 'q'.repeat(30000) } });
    assert.equal(spillIfNeeded(out, path.join(ROOT, 'never')), out);
    assert.ok(!fs.existsSync(path.join(ROOT, 'never')), 'no spill directory created');
  });
});

// ---------------------------------------------------------------------------

describe('fitLoadedText', () => {
  test('fits when text <= room; otherwise slices and appends the marker so the result is exactly `room` long', () => {
    assert.deepEqual(fitLoadedText('abc', 0), { text: 'abc', truncated: 0 });
    assert.deepEqual(fitLoadedText('', 100), { text: '', truncated: 0 });
    const exact = 'a'.repeat(SPILL_THRESHOLD - 50);
    assert.deepEqual(fitLoadedText(exact, 50), { text: exact, truncated: 0 });
    const over = 'a'.repeat(SPILL_THRESHOLD);
    const r = fitLoadedText(over, 500);
    assert.equal(r.text.length, SPILL_THRESHOLD - 500);
    assert.ok(r.text.endsWith(TRUNCATION_MARKER));
    assert.equal(r.truncated, over.length - (SPILL_THRESHOLD - 500 - TRUNCATION_MARKER.length));
  });

  test('reserved: negative, NaN, non-numeric and fractional values are clamped/floored; a room smaller than the marker yields only the marker', () => {
    const t = 'b'.repeat(20000);
    assert.equal(fitLoadedText(t, -100).text.length, SPILL_THRESHOLD);
    assert.equal(fitLoadedText(t, NaN).text.length, SPILL_THRESHOLD);
    assert.equal(fitLoadedText(t, 'x').text.length, SPILL_THRESHOLD);
    assert.equal(fitLoadedText(t, 100.9).text.length, SPILL_THRESHOLD - 100);
    const tight = fitLoadedText(t, SPILL_THRESHOLD - 5);
    assert.equal(tight.text, TRUNCATION_MARKER, 'nothing of the body fits: marker only');
    assert.equal(tight.truncated, t.length);
    const none = fitLoadedText(t, SPILL_THRESHOLD + 100);
    assert.equal(none.text, TRUNCATION_MARKER);
    assert.deepEqual(fitLoadedText(null, 0), { text: '', truncated: 0 });
    assert.deepEqual(fitLoadedText(12345, 0), { text: '12345', truncated: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('spillIfNeeded', () => {
  test('<= 9,500 chars (incl. exactly 9,500, empty, null) pass through unchanged and write nothing', () => {
    const home = path.join(ROOT, 'spill-none');
    assert.equal(spillIfNeeded('', home), '');
    assert.equal(spillIfNeeded(null, home), '');
    assert.equal(spillIfNeeded(undefined, home), '');
    assert.equal(spillIfNeeded(42, home), '42');
    const edge = 'e'.repeat(SPILL_THRESHOLD);
    assert.equal(spillIfNeeded(edge, home), edge);
    assert.ok(!fs.existsSync(home));
  });

  test('> 9,500 chars: written verbatim to <home>/spill-<ts>.md (home created), replaced by a short tagged note naming the file', () => {
    const home = path.join(ROOT, 'spill-yes', 'nested');
    const big = `${'y'.repeat(9600)}\nlast line`;
    const before = Date.now();
    const note = spillIfNeeded(big, home);
    assert.match(note, new RegExp(`^\\[skill-scout\\] Context was ${big.length} chars \\(over skill-scout's 9500-char threshold; Claude Code previews only 2 KB past 10000\\) and was written to (.+/spill-\\d+\\.md)\\. Read that file if the loaded skill text is needed\\.$`));
    const file = /written to (\S+)\./.exec(note)[1];
    assert.equal(path.dirname(file), home);
    const ts = Number(/spill-(\d+)\.md$/.exec(file)[1]);
    assert.ok(ts >= before && ts <= Date.now() + 1000);
    assert.equal(fs.readFileSync(file, 'utf8'), big);
    assert.ok(note.length < 400);
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('spill-')).length, 1);
  });

  test('when the spill file cannot be written the text is truncated in place with a tagged failure note (still under the threshold)', () => {
    const file = path.join(ROOT, 'spill-blocker');
    fs.writeFileSync(file, 'not a directory');
    const big = 'w'.repeat(12000);
    const out = spillIfNeeded(big, file);
    // Observation: the fallback reserves 120 chars for the note but the note embeds the spill path, so with a
    // long state dir (this scratchpad) the result lands a little over SPILL_THRESHOLD; it stays under the
    // 10,000-char hard cap Claude Code applies, which is the limit that matters.
    assert.ok(out.length <= HOOK_HARD_CAP, `${out.length} <= ${HOOK_HARD_CAP}`);
    assert.ok(out.length < big.length);
    assert.ok(out.startsWith('w'.repeat(SPILL_THRESHOLD - 120)));
    assert.equal(out.indexOf('\n'), SPILL_THRESHOLD - 120, 'the body is cut at threshold - 120');
    assert.match(out, /\n\[skill-scout\] \[truncated: 12000 chars; spill to .*spill-\d+\.md failed: .{1,60}\]$/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a directory', 'the blocker file is untouched');
  });
});

// ---------------------------------------------------------------------------

describe('hookOutput: exact JSON on stdout', () => {
  test('every event name yields the hookSpecificOutput envelope and nothing else (byte-exact)', () => {
    assert.equal(hookOutput('UserPromptSubmit', 'ctx'), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}');
    assert.equal(hookOutput('UserPromptExpansion', 'a\n"b"'), '{"hookSpecificOutput":{"hookEventName":"UserPromptExpansion","additionalContext":"a\\n\\"b\\""}}');
    assert.equal(hookOutput('SubagentStart', 'x'), '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"x"}}');
    assert.equal(hookOutput('SubagentStart', ''), '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":""}}');
    assert.equal(hookOutput('SubagentStart', null), '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":""}}');
    assert.equal(hookOutput('SubagentStart', undefined), '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":""}}');
    assert.equal(hookOutput(7, 8), '{"hookSpecificOutput":{"hookEventName":"7","additionalContext":"8"}}', 'coerced to strings');
    assert.ok(!hookOutput('UserPromptSubmit', 'ctx').endsWith('\n'), 'no trailing newline');
  });

  test('systemMessage is added at the top level only when it is a non-blank string', () => {
    assert.equal(hookOutput('UserPromptSubmit', 'ctx', { systemMessage: '[skill-scout] WARNING' }), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"},"systemMessage":"[skill-scout] WARNING"}');
    assert.equal(hookOutput('UserPromptSubmit', '', { systemMessage: 'note' }), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""},"systemMessage":"note"}', 'a message without context is still carried');
    for (const extra of [{ systemMessage: '' }, { systemMessage: '   ' }, { systemMessage: null }, { systemMessage: 5 }, { other: 'x' }, null, undefined, 'str']) {
      assert.equal(hookOutput('UserPromptSubmit', 'ctx', extra), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}', JSON.stringify(extra));
    }
    const parsed = JSON.parse(hookOutput('UserPromptSubmit', 'c', { systemMessage: 'm' }));
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput', 'systemMessage']);
    assert.deepEqual(Object.keys(parsed.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  });

  test('round-trips arbitrary context (unicode, control chars, 9,500-char bodies) through JSON.parse', () => {
    const ctxText = `[skill-scout] Stack: Next.js 16 — ü 🚀 \u0000 \t ${'x'.repeat(9400)}`;
    const back = JSON.parse(hookOutput('UserPromptSubmit', ctxText));
    assert.equal(back.hookSpecificOutput.additionalContext, ctxText);
  });
});
