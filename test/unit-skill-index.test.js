// test/unit-skill-index.test.js — node --test test/unit-skill-index.test.js
//
// Exhaustive unit tests for lib/skill-index.js: every scan root and its invocableName namespacing, depth
// limits, dedupe precedence, the frontmatter fixtures driven through buildIndex (not only parseFrontmatter),
// broken / huge / frontmatter-less / symlinked / unreadable files, plugin.json `skills` and `commands`
// entries, claude.ai-synced plugins with and without generations, config-dir resolution and the mtime
// cache signature. Everything runs on throwaway HOMEs under the scratchpad; the real ~/.claude is never read.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, parseFrontmatter, clearIndexCache, findProjectDirs, INDEX_TTL_MS } from '../lib/skill-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTMATTER = path.join(HERE, 'fixtures', 'frontmatter');
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-skill-index-${label}-`));
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function skillMd(name, description, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } };
const invocables = (index) => index.map((s) => s.invocableName).sort();
const byInvocable = (index) => new Map(index.map((s) => [s.invocableName, s]));

// ---------------------------------------------------------------------------
// Scan roots and namespacing
// ---------------------------------------------------------------------------
describe('scan roots and invocableName namespacing', () => {
  let root; let home; let cfg; let skills; let plugins; let repo; let cwd; let index; let by;

  before(async () => {
    root = mkTmp('roots');
    home = path.join(root, 'home');
    cfg = path.join(home, '.claude');
    skills = path.join(cfg, 'skills');
    plugins = path.join(cfg, 'plugins');

    // 1. <cfg>/skills: bare, nested (one level), depth-3 (ignored), bare-with-children (children ignored)
    write(path.join(skills, 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha user skill.'));
    write(path.join(skills, 'group', 'nested', 'SKILL.md'), skillMd('nested', 'Nested user skill.'));
    write(path.join(skills, 'deep', 'a', 'b', 'SKILL.md'), skillMd('b', 'depth 3: never indexed'));
    write(path.join(skills, 'parent', 'SKILL.md'), skillMd('parent', 'Parent skill.'));
    write(path.join(skills, 'parent', 'child', 'SKILL.md'), skillMd('child', 'child of a bare skill: never indexed'));
    write(path.join(skills, 'node_modules', 'pkg', 'SKILL.md'), skillMd('pkg', 'node_modules: never indexed'));
    write(path.join(skills, 'temp_git_123', 'SKILL.md'), skillMd('temp', 'temp_git_*: never indexed'));
    write(path.join(skills, '.trash', 'old', 'SKILL.md'), skillMd('old', 'dot dir: never indexed'));

    // 2. synced skills: a bucket with a manifest (anthropic + account + a malformed entry + an unlisted
    //    dir) and a bucket without one
    const b1 = path.join(skills, 'synced', 'bucket-1');
    write(path.join(b1, 'manifest.json'), JSON.stringify({ skills: [
      { name: 'pdf', source: 'anthropic' }, { name: 'my-notes', source: 'account' }, { name: 42, source: 'account' }, null,
    ] }));
    write(path.join(b1, 'pdf', 'SKILL.md'), skillMd('pdf', 'PDF skill.'));
    write(path.join(b1, 'my-notes', 'SKILL.md'), skillMd('my-notes', 'Account skill.'));
    write(path.join(b1, 'unlisted', 'SKILL.md'), skillMd('unlisted', 'Not in the manifest.'));
    write(path.join(b1, '.last-complete-round'), '1');
    write(path.join(b1, 'README.md'), 'a file, not a skill dir');
    const b2 = path.join(skills, 'synced', 'bucket-2');
    write(path.join(b2, 'docx', 'SKILL.md'), skillMd('docx', 'No manifest at all.'));

    // 3. skills-dir plugins under <cfg>/skills: named, unnamed (dir name), with string `skills`, disabled
    const superset = path.join(skills, 'superset');
    write(path.join(superset, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superset' }));
    write(path.join(superset, 'skills', '10x', 'SKILL.md'), skillMd('10x', 'Ten-x.'));
    write(path.join(superset, 'commands', 'automation.md'), '---\ndescription: Manage an automation\n---\n');
    const unnamed = path.join(skills, 'dirnamed');
    write(path.join(unnamed, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 42, skills: './extra/one' }));
    write(path.join(unnamed, 'skills', 'x', 'SKILL.md'), skillMd('x', 'X.'));
    write(path.join(unnamed, 'extra', 'one', 'SKILL.md'), skillMd('one', 'Declared as a string skills entry.'));
    const off = path.join(skills, 'off-plugin');
    write(path.join(off, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'off-plugin' }));
    write(path.join(off, 'skills', 'nope', 'SKILL.md'), skillMd('nope', 'disabled'));

    // 4. marketplace plugins via installed_plugins.json
    const cache = path.join(plugins, 'cache');
    const cave = path.join(cache, 'mk', 'caveman', '2.0.0');
    write(path.join(cave, 'skills', 'compress', 'SKILL.md'), skillMd('caveman-compress', 'Compress.'));
    write(path.join(cave, 'skills', 'caveman:prefixed', 'SKILL.md'), skillMd('prefixed', 'Dir name already carries the prefix.'));
    write(path.join(cave, 'skills', 'nothing-here', 'README.md'), 'no SKILL.md');
    write(path.join(cave, 'skills', 'caveman:', 'SKILL.md'), skillMd('empty-bare', 'dir name is exactly the prefix: no bare name'));
    write(path.join(cave, 'commands', 'talk.md'), '---\ndescription: Talk like a caveman\n---\n');
    write(path.join(cave, 'commands', '.hidden.md'), '---\ndescription: dotfile\n---\n');
    write(path.join(cave, 'commands', 'notes.txt'), 'not a command');
    write(path.join(cave, 'commands', '_partial.md'), '---\ndescription: partial\n---\n');
    write(path.join(cave, 'extra-cmds', 'one.md'), '---\ndescription: cmd one\n---\n');
    write(path.join(cave, 'single.md'), '---\ndescription: single cmd\n---\n');
    write(path.join(cache, 'mk', 'escape.md'), '---\ndescription: outside the plugin root\n---\n');
    fs.symlinkSync(path.join(cave, 'extra-cmds', 'one.md'), path.join(cave, 'commands', 'linked.md'));
    fs.symlinkSync(path.join(cave, 'extra-cmds'), path.join(cave, 'commands', 'dirlink.md'));
    fs.symlinkSync(path.join(cave, 'nowhere.md'), path.join(cave, 'commands', 'dangling.md'));
    write(path.join(cave, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'caveman',
      commands: ['./extra-cmds', './single.md', '../escape.md', '../../escape.md', 7, ''],
      skills: [null, '', './skills/compress', '../../../escape'],
    }));
    write(path.join(home, 'tplug', 'skills', 'tskill', 'SKILL.md'), skillMd('tskill', 'Install path with ~/.'));
    write(path.join(home, 'skills', 'hskill', 'SKILL.md'), skillMd('hskill', 'Install path ~ (home as root).'));
    const ghost = path.join(cache, 'mk', 'ghost', '1.0.0');
    write(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'caveman@mk': { scope: 'user', installPath: cave },           // object, not array
      'tilde@mk': [{ installPath: '~/tplug' }],
      'tilde2@mk': [{ installPath: '~' }],
      'ghost@mk': [{ installPath: ghost }],                         // path does not exist
      'bad-string@mk': 'not an entry',
      'bad-empty@mk': [{ installPath: '' }],
      'bad-shape@mk': [{}],
      'bad-null@mk': null,
      'off@mk': [{ installPath: cave }],                            // disabled in settings
    } }));

    // 5. claude.ai-synced plugins
    const psync = path.join(plugins, 'synced', 'bucket-p');
    write(path.join(psync, 'manifest.json'), JSON.stringify({ plugins: [] }));
    write(path.join(psync, 'analytics', 'skills', 'create-viz', 'SKILL.md'), skillMd('create-viz', 'Unsuffixed synced plugin.'));
    write(path.join(psync, 'marketing', 'skills', 'ancient', 'SKILL.md'), skillMd('ancient', 'generation 0'));
    write(path.join(psync, 'marketing~g1', 'skills', 'old', 'SKILL.md'), skillMd('old', 'generation 1'));
    write(path.join(psync, 'marketing~g2', 'skills', 'brand-review', 'SKILL.md'), skillMd('brand-review', 'generation 2'));
    write(path.join(psync, 'marketing~g2.meta.json'), '{}');
    write(path.join(psync, 'design~g3', 'skills', 'critique', 'SKILL.md'), skillMd('critique', 'disabled synced plugin'));
    write(path.join(psync, 'meta-only', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'meta-only' }));
    write(path.join(psync, 'meta-only', 'commands', 'hi.md'), '---\ndescription: a command-only synced plugin\n---\n');
    write(path.join(psync, 'junk', 'README.md'), 'neither skills/ nor .claude-plugin/');
    write(path.join(plugins, 'synced', 'bucket-empty', 'manifest.json'), '{}');

    // 6. settings: enabledPlugins with explicit false entries
    write(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: {
      'off@mk': false, 'off-plugin@skills-dir': false, 'design@synced': false, 'caveman@mk': true,
    } }));

    // 7. project: repo root with .git; skills at the root, nested, a skills-dir plugin and a `synced` dir
    repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(repo, '.claude', 'skills', 'proj', 'SKILL.md'), skillMd('proj', 'Project skill.'));
    write(path.join(repo, '.claude', 'skills', 'sub', 'thing', 'SKILL.md'), skillMd('thing', 'Nested project skill.'));
    write(path.join(repo, '.claude', 'skills', 'pp', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pp' }));
    write(path.join(repo, '.claude', 'skills', 'pp', 'skills', 'ps', 'SKILL.md'), skillMd('ps', 'Project skills-dir plugin.'));
    write(path.join(repo, '.claude', 'skills', 'synced', 'bucket', 'SKILL.md'), skillMd('bucket', 'A project dir called synced is just a nested dir.'));
    cwd = path.join(repo, 'packages', 'web');
    write(path.join(cwd, '.claude', 'skills', 'web', 'SKILL.md'), skillMd('web', 'Nearest project skill.'));
    write(path.join(root, '.claude', 'skills', 'above', 'SKILL.md'), skillMd('above', 'above the repo root: never indexed'));

    clearIndexCache();
    index = await buildIndex({ cwd, home });
    by = byInvocable(index);
  });
  after(() => rm(root));

  test('the complete list of invocable names, each exactly once', () => {
    assert.deepEqual(invocables(index), [
      'alpha',
      'analytics:create-viz',
      'anthropic-skills:docx',
      'anthropic-skills:pdf',
      'anthropic-skills:unlisted',
      'caveman:compress',
      'caveman:linked',
      'caveman:one',
      'caveman:prefixed',
      'caveman:single',
      'caveman:talk',
      'claude-ai:my-notes',
      'dirnamed:one',
      'dirnamed:x',
      'group:nested',
      'marketing:brand-review',
      'meta-only:hi',
      'parent',
      'pp:ps',
      'proj',
      'sub:thing',
      'superset:10x',
      'superset:automation',
      'synced:bucket',
      'tilde2:hskill',
      'tilde:tskill',
      'web',
    ]);
    assert.equal(new Set(invocables(index)).size, index.length);
  });

  test('user scope: bare, nested one level, never deeper, never below a bare skill, never dot/node_modules/temp_git', () => {
    assert.equal(by.get('alpha').scope, 'user');
    assert.equal(by.get('alpha').kind, 'skill');
    assert.equal(by.get('group:nested').scope, 'user');
    assert.equal(by.get('group:nested').name, 'nested');
    assert.ok(by.get('group:nested').path.endsWith(path.join('group', 'nested', 'SKILL.md')));
    assert.equal(by.get('parent').description, 'Parent skill.');
    for (const bad of ['b', 'child', 'pkg', 'temp', 'old', 'above']) assert.ok(!index.some((s) => s.name === bad), bad);
    assert.ok(!index.some((s) => s.path.includes(path.join('deep', 'a', 'b'))));
  });

  test('synced skills: anthropic-skills unless the manifest says source "account" (claude-ai); unlisted and manifest-less buckets default to anthropic-skills', () => {
    assert.equal(by.get('anthropic-skills:pdf').scope, 'synced');
    assert.equal(by.get('anthropic-skills:pdf').pluginName, 'anthropic-skills');
    assert.equal(by.get('anthropic-skills:pdf').pluginId, undefined);
    assert.equal(by.get('claude-ai:my-notes').pluginName, 'claude-ai');
    assert.equal(by.get('anthropic-skills:unlisted').scope, 'synced');
    assert.equal(by.get('anthropic-skills:docx').scope, 'synced');
  });

  test('skills-dir plugins: plugin.json name, else the directory name; string `skills` entry; disabled via settings', () => {
    assert.equal(by.get('superset:10x').pluginId, 'superset@skills-dir');
    assert.equal(by.get('superset:automation').kind, 'command');
    assert.equal(by.get('dirnamed:x').pluginName, 'dirnamed');
    assert.equal(by.get('dirnamed:x').pluginId, 'dirnamed@skills-dir');
    assert.equal(by.get('dirnamed:one').description, 'Declared as a string skills entry.');
    assert.ok(!by.has('off-plugin:nope'));
  });

  test('marketplace plugins: object entries, ~ and ~/ install paths, broken entries, disabled ids, prefix-carrying dir names', () => {
    const c = by.get('caveman:compress');
    assert.equal(c.scope, 'plugin');
    assert.equal(c.pluginId, 'caveman@mk');
    assert.equal(c.frontmatterName, 'caveman-compress');
    assert.deepEqual(c.aliases, ['caveman-compress']);
    assert.equal(by.get('caveman:prefixed').name, 'prefixed', 'skills/caveman:prefixed -> caveman:prefixed, not caveman:caveman:prefixed');
    assert.equal(by.get('tilde:tskill').path, path.join(home, 'tplug', 'skills', 'tskill', 'SKILL.md'));
    assert.equal(by.get('tilde2:hskill').path, path.join(home, 'skills', 'hskill', 'SKILL.md'));
    for (const id of ['ghost', 'bad-string', 'bad-empty', 'bad-shape', 'bad-null', 'off']) {
      assert.ok(![...by.keys()].some((k) => k.startsWith(`${id}:`)), id);
    }
    assert.ok(!by.has('caveman:nothing-here'), 'a skill dir needs a SKILL.md');
    assert.ok(!by.has('caveman:') && !by.has('caveman:caveman:'), 'a dir named exactly "<plugin>:" has no bare name');
  });

  test('commands: commands/*.md, plugin.json `commands` dirs and .md files inside the root; symlinked files yes, dirs/dangling/dotfiles/partials no', () => {
    for (const k of ['caveman:talk', 'caveman:one', 'caveman:single', 'caveman:linked']) {
      assert.equal(by.get(k).kind, 'command', k);
      assert.equal(by.get(k).scope, 'plugin', k);
    }
    assert.equal(by.get('caveman:single').description, 'single cmd');
    assert.equal(by.get('caveman:linked').description, 'cmd one');
    for (const k of ['caveman:escape', 'caveman:dirlink', 'caveman:dangling', 'caveman:notes', 'caveman:.hidden', 'caveman:_partial']) assert.ok(!by.has(k), k);
  });

  test('claude.ai-synced plugins: unsuffixed dirs count as generation 0, highest generation wins, .claude-plugin/ alone makes a plugin, junk ignored, disabled honoured', () => {
    assert.equal(by.get('analytics:create-viz').pluginId, 'analytics@synced');
    assert.equal(by.get('analytics:create-viz').scope, 'plugin');
    assert.ok(by.get('marketing:brand-review').path.includes('marketing~g2'));
    assert.ok(!by.has('marketing:ancient') && !by.has('marketing:old'));
    assert.equal(by.get('meta-only:hi').pluginId, 'meta-only@synced');
    assert.ok(![...by.keys()].some((k) => k.startsWith('junk:') || k.startsWith('design:')));
  });

  test('project scope: nearest first up to the repo root, nested <sub>:<name>, skills-dir plugins inside the project, `synced` is an ordinary dir there', () => {
    assert.equal(by.get('web').scope, 'project');
    assert.equal(by.get('proj').scope, 'project');
    assert.equal(by.get('sub:thing').scope, 'project');
    assert.equal(by.get('pp:ps').pluginId, 'pp@skills-dir');
    assert.equal(by.get('synced:bucket').scope, 'project');
    assert.ok(!by.has('above'));
  });

  test('Skill shape is identical across scopes', () => {
    for (const s of index) {
      assert.deepEqual(Object.keys(s).filter((k) => !['pluginName', 'pluginId', 'frontmatterName', 'whenToUse'].includes(k)).sort(),
        ['aliases', 'description', 'invocableName', 'kind', 'modelInvocable', 'name', 'path', 'scope', 'userInvocable']);
      assert.ok(path.isAbsolute(s.path));
      assert.ok(Array.isArray(s.aliases));
      assert.ok(['skill', 'command'].includes(s.kind));
    }
  });
});

// ---------------------------------------------------------------------------
// Dedupe precedence
// ---------------------------------------------------------------------------
describe('dedupe precedence', () => {
  let root;
  before(() => { root = mkTmp('dedupe'); });
  after(() => rm(root));
  beforeEach(() => clearIndexCache());

  test('bare names: user beats project; nearest project dir beats the repo root', async () => {
    const home = path.join(root, 'h1');
    write(path.join(home, '.claude', 'skills', 'dup', 'SKILL.md'), skillMd('dup', 'USER'));
    const repo = path.join(root, 'r1');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(repo, '.claude', 'skills', 'dup', 'SKILL.md'), skillMd('dup', 'ROOT'));
    write(path.join(repo, '.claude', 'skills', 'near', 'SKILL.md'), skillMd('near', 'ROOT'));
    const cwd = path.join(repo, 'pkg');
    write(path.join(cwd, '.claude', 'skills', 'near', 'SKILL.md'), skillMd('near', 'NEAREST'));
    const by = byInvocable(await buildIndex({ cwd, home }));
    assert.equal(by.get('dup').description, 'USER');
    assert.equal(by.get('dup').scope, 'user');
    assert.equal(by.get('near').description, 'NEAREST');
    assert.equal(by.size, 2);
  });

  test('namespaced names: the first plugin root wins (skills-dir, then installed_plugins.json, then synced plugins)', async () => {
    const home = path.join(root, 'h2');
    const cfg = path.join(home, '.claude');
    const sd = path.join(cfg, 'skills', 'same');
    write(path.join(sd, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'same' }));
    write(path.join(sd, 'skills', 'x', 'SKILL.md'), skillMd('x', 'SKILLS-DIR'));
    const mk = path.join(cfg, 'plugins', 'cache', 'mk', 'same', '1.0.0');
    write(path.join(mk, 'skills', 'x', 'SKILL.md'), skillMd('x', 'MARKETPLACE'));
    write(path.join(mk, 'skills', 'y', 'SKILL.md'), skillMd('y', 'MARKETPLACE'));
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'same@mk': [{ installPath: mk }] } }));
    const sy = path.join(cfg, 'plugins', 'synced', 'b', 'same~g1');
    write(path.join(sy, 'skills', 'x', 'SKILL.md'), skillMd('x', 'SYNCED'));
    write(path.join(sy, 'skills', 'y', 'SKILL.md'), skillMd('y', 'SYNCED'));
    write(path.join(sy, 'skills', 'z', 'SKILL.md'), skillMd('z', 'SYNCED'));
    const by = byInvocable(await buildIndex({ cwd: root, home }));
    assert.equal(by.get('same:x').description, 'SKILLS-DIR');
    assert.equal(by.get('same:x').pluginId, 'same@skills-dir');
    assert.equal(by.get('same:y').description, 'MARKETPLACE');
    assert.equal(by.get('same:z').description, 'SYNCED');
    assert.equal(by.size, 3);
  });

  test('a plugin.json skills entry that repeats the default skills dir is indexed once', async () => {
    const home = path.join(root, 'h3');
    const cfg = path.join(home, '.claude');
    const mk = path.join(cfg, 'plugins', 'cache', 'mk', 'p', '1.0.0');
    write(path.join(mk, 'skills', 'a', 'SKILL.md'), skillMd('a', 'A'));
    write(path.join(mk, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['./skills', './skills/a', 'skills/a/'] }));
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@mk': [{ installPath: mk }] } }));
    const index = await buildIndex({ cwd: root, home });
    assert.deepEqual(invocables(index), ['p:a']);
  });

  test('a nested user skill and a plugin skill with the same invocable name: the user entry comes first (both are kept today)', async () => {
    const home = path.join(root, 'h4');
    const cfg = path.join(home, '.claude');
    write(path.join(cfg, 'skills', 'group', 'nested', 'SKILL.md'), skillMd('nested', 'USER'));
    const mk = path.join(cfg, 'plugins', 'cache', 'mk', 'group', '1.0.0');
    write(path.join(mk, 'skills', 'nested', 'SKILL.md'), skillMd('nested', 'PLUGIN'));
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'group@mk': [{ installPath: mk }] } }));
    const index = await buildIndex({ cwd: root, home });
    const hits = index.filter((s) => s.invocableName === 'group:nested');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].scope, 'user');
    assert.equal(hits[0].description, 'USER');
  });
});

// ---------------------------------------------------------------------------
// Frontmatter variants through buildIndex
// ---------------------------------------------------------------------------
describe('frontmatter variants (test/fixtures/frontmatter) through buildIndex', () => {
  let root; let by;
  before(async () => {
    root = mkTmp('frontmatter');
    const home = path.join(root, 'home');
    const skills = path.join(home, '.claude', 'skills');
    for (const f of fs.readdirSync(FRONTMATTER)) {
      const n = f.split('-')[0];
      write(path.join(skills, `fm-${n}`, 'SKILL.md'), fs.readFileSync(path.join(FRONTMATTER, f)));
    }
    write(path.join(skills, 'synth-true', 'SKILL.md'), skillMd('synth-true', 'd', 'disable-model-invocation: true\nuser-invocable: no\nwhen_to_use: >-\n  Use when\n  folding.\n'));
    write(path.join(skills, 'synth-yes', 'SKILL.md'), skillMd('synth-yes', 'd', 'disable-model-invocation: YES\nuser-invocable: OFF\nwhen_to_use:\n'));
    write(path.join(skills, 'synth-on', 'SKILL.md'), skillMd('synth-on', 'd', 'disable-model-invocation: on\nuser-invocable: FALSE\nwhen_to_use: |\n  literal\n  block\n'));
    write(path.join(skills, 'synth-junk', 'SKILL.md'), skillMd('synth-junk', 'd', 'disable-model-invocation: maybe\nuser-invocable: 0\n'));
    write(path.join(skills, 'synth-noname', 'SKILL.md'), '---\ndescription: only a description\n---\nbody\n');
    write(path.join(skills, 'synth-blank-desc', 'SKILL.md'), '---\nname: synth-blank-desc\ndescription:   \n---\n\nFirst body line wins when the description is blank.\n');
    write(path.join(skills, 'synth-indented-desc', 'SKILL.md'), '---\nname: synth-indented-desc\ndescription:\n  Indented plain\n  continuation.   # not a comment marker without a space before #? it is\n---\n');
    clearIndexCache();
    by = byInvocable(await buildIndex({ cwd: root, home }));
  });
  after(() => rm(root));

  test('1: single-line description; frontmatter name differs from the dir -> alias', () => {
    const s = by.get('fm-1');
    assert.equal(s.name, 'fm-1');
    assert.equal(s.frontmatterName, 'karpathy-guidelines');
    assert.deepEqual(s.aliases, ['karpathy-guidelines']);
    assert.match(s.description, /^Behavioral guidelines to reduce common LLM coding mistakes\./);
    assert.equal(s.userInvocable, true);
    assert.equal(s.modelInvocable, true);
    assert.equal(s.whenToUse, undefined);
  });

  test('2: folded ">" description is one paragraph', () => {
    const s = by.get('fm-2');
    assert.equal(s.frontmatterName, 'cowork-plugin-customizer');
    assert.ok(!s.description.includes('\n'));
    assert.match(s.description, /^Customize a Claude Code plugin for a specific organization's tools and workflows\. Use when: customize plugin,/);
  });

  test('3: double-quoted description with colons and unicode; nested metadata does not leak into the Skill', () => {
    const s = by.get('fm-3');
    assert.equal(s.frontmatterName, 'verification');
    assert.match(s.description, /end-to-end: browser → API → data → response\./);
    assert.equal(s.metadata, undefined);
    assert.equal(s.retrieval, undefined);
  });

  test('4: unquoted description with "localhost:3000"; allowed-tools is not part of the Skill', () => {
    const s = by.get('fm-4');
    assert.equal(s.frontmatterName, 'browser');
    assert.match(s.description, /"open localhost:3000"/);
    assert.equal(s['allowed-tools'], undefined);
  });

  test('5: disable-model-invocation: false -> modelInvocable true', () => {
    const s = by.get('fm-5');
    assert.equal(s.frontmatterName, 'figma-create-new-file');
    assert.equal(s.modelInvocable, true);
    assert.equal(s.userInvocable, true);
  });

  test('6: user-invocable: false -> userInvocable false', () => {
    const s = by.get('fm-6');
    assert.equal(s.frontmatterName, 'sql-queries');
    assert.equal(s.userInvocable, false);
    assert.equal(s.modelInvocable, true);
  });

  test('booleans accept true/yes/on and false/no/off in any case; anything else keeps the default', () => {
    assert.equal(by.get('synth-true').modelInvocable, false);
    assert.equal(by.get('synth-true').userInvocable, false);
    assert.equal(by.get('synth-yes').modelInvocable, false);
    assert.equal(by.get('synth-yes').userInvocable, false);
    assert.equal(by.get('synth-on').modelInvocable, false);
    assert.equal(by.get('synth-on').userInvocable, false);
    assert.equal(by.get('synth-junk').modelInvocable, true);
    assert.equal(by.get('synth-junk').userInvocable, true);
  });

  test('when_to_use: folded, literal, empty', () => {
    assert.equal(by.get('synth-true').whenToUse, 'Use when folding.');
    assert.equal(by.get('synth-on').whenToUse, 'literal\nblock');
    assert.equal(by.get('synth-yes').whenToUse, undefined, 'an empty value is not set');
  });

  test('name equal to the dir -> no alias; missing name -> no frontmatterName; blank description -> first body line', () => {
    assert.deepEqual(by.get('synth-true').aliases, []);
    assert.equal(by.get('synth-noname').frontmatterName, undefined);
    assert.deepEqual(by.get('synth-noname').aliases, []);
    assert.equal(by.get('synth-noname').description, 'only a description');
    assert.equal(by.get('synth-blank-desc').description, 'First body line wins when the description is blank.');
    assert.equal(by.get('synth-indented-desc').description, 'Indented plain continuation.', 'an empty `key:` followed by indented plain lines folds them');
  });
});

describe('parseFrontmatter scalar edge cases', () => {
  test('quoted scalars: unterminated quotes run to the end of the block; every double-quote escape', () => {
    assert.equal(parseFrontmatter('---\ndescription: "never closed\n  continues here\n---\n').description, 'never closed continues here');
    assert.equal(parseFrontmatter("---\ndescription: 'never closed\n  either\n---\n").description, 'never closed either');
    assert.equal(parseFrontmatter("---\ndescription: 'it''s ''quoted'''\n---\n").description, "it's 'quoted'");
    const esc = parseFrontmatter('---\ndescription: "a\\tb\\rc\\nd\\/e\\\\f\\"g\\x41\\u00e9\\ h\\qz"\n---\n');
    assert.equal(esc.description, 'a\tb\rc\nd/e\\f"gAé hqz');
    assert.equal(parseFrontmatter('---\nx: "nul\\0byte"\n---\n').fields.x, 'nul\0byte');
    assert.equal(parseFrontmatter('---\nx: "multi\n\n  paragraph"\n---\n').fields.x, 'multi\nparagraph', 'a blank line inside a quoted scalar is a newline');
  });

  test('block scalars: chomping indicators, more-indented lines in a folded block, literal blocks', () => {
    const clip = parseFrontmatter('---\nd: >\n  first\n    indented\n  after\n\n  para\n---\n').fields.d;
    assert.equal(clip, 'first\n  indented\nafter\npara', 'YAML folding: one blank line becomes one newline; more-indented lines keep their own line');
    assert.equal(parseFrontmatter('---\nd: >-\n  a\n  b\n---\n').fields.d, 'a b');
    assert.equal(parseFrontmatter('---\nd: >+\n  a\n  b\n---\n').fields.d, 'a b', '+ keeps trailing newlines, of which the collector leaves none');
    assert.equal(parseFrontmatter('---\nd: |\n  a\n  b\n---\n').fields.d, 'a\nb');
    assert.equal(parseFrontmatter('---\nd: |+\n  a\n\n  b\n---\n').fields.d, 'a\n\nb');
    assert.equal(parseFrontmatter('---\nd: |-\n  a\n---\n').fields.d, 'a');
    assert.equal(parseFrontmatter('---\nd: >\n---\n').fields.d, '', 'an empty block');
  });

  test('empty `key:` followed by a block: list and map stay structured (raw, dedented), plain lines fold, blanks-only is empty', () => {
    assert.equal(parseFrontmatter('---\nd:\n  - one\n  - two\n---\n').fields.d, '- one\n- two');
    assert.equal(parseFrontmatter('---\nd:\n    k: v\n    k2: v2\n---\n').fields.d, 'k: v\nk2: v2');
    assert.equal(parseFrontmatter('---\nd:\n  plain words\n  more words\n---\n').fields.d, 'plain words more words');
    assert.equal(parseFrontmatter('---\nd:\n\n   \nn: x\n---\n').fields.d, '');
    assert.equal(parseFrontmatter('---\nd:\n\n   \nn: x\n---\n').fields.n, 'x');
  });

  test('plain scalars: continuation stops at a blank line; stray indented lines, `key:value` without a space and comments are ignored', () => {
    const r = parseFrontmatter('---\n# top comment\nsummary: a   # trailing comment\n  b\n\n  stray: indented\nkey:value\nmy-key.sub_1: ok\nhash: a#b\n---\nbody');
    assert.equal(r.fields.summary, 'a b');
    assert.equal(r.fields.key, undefined, 'YAML: "key:value" is a plain scalar, not a mapping entry');
    assert.equal(r.fields.stray, undefined);
    assert.equal(r.fields['my-key.sub_1'], 'ok');
    assert.equal(r.fields.hash, 'a#b', 'a # without a preceding space is not a comment');
    assert.deepEqual(Object.keys(r.fields), ['summary', 'my-key.sub_1', 'hash']);
    assert.equal(r.body, 'body');
  });

  test('name / description are trimmed and null when blank; BOM and CRLF; "..." terminator; frontmatter-only text', () => {
    const r = parseFrontmatter('\uFEFF---\r\nname:   spaced  \r\ndescription:\r\n...\r\nbody\r\n');
    assert.equal(r.name, 'spaced');
    assert.equal(r.description, null);
    assert.equal(r.hasFrontmatter, true);
    assert.equal(r.body, 'body\r\n'.replace('\r\n', '\n'));
    assert.deepEqual(parseFrontmatter('---\n---\n'), { name: null, description: null, fields: {}, hasFrontmatter: true, body: '' });
    assert.equal(parseFrontmatter('---').hasFrontmatter, false);
    assert.equal(parseFrontmatter(12).body, '');
  });
});

// ---------------------------------------------------------------------------
// Broken, huge, frontmatter-less, symlinked and unreadable files
// ---------------------------------------------------------------------------
describe('broken / huge / no-frontmatter / symlink / unreadable', () => {
  let root; let home; let skills; let by; let index;
  before(async () => {
    root = mkTmp('broken');
    home = path.join(root, 'home');
    skills = path.join(home, '.claude', 'skills');
    write(path.join(skills, 'ok', 'SKILL.md'), skillMd('ok', 'Fine.'));
    write(path.join(skills, 'unterminated', 'SKILL.md'), '---\nname: unterminated\ndescription: never closed\n\nBody text.\n');
    write(path.join(skills, 'headings-only', 'SKILL.md'), '# Title\n\n## Sub\n\n<div>html</div>\n\n```\n```\n');
    write(path.join(skills, 'fenced-body', 'SKILL.md'), '# Title\n\n```\nnpm test\n```\n');
    write(path.join(skills, 'markdown-first-line', 'SKILL.md'), '# T\n\n**Bold** _em_ `code` > quote and more.\n');
    write(path.join(skills, 'long-first-line', 'SKILL.md'), `# T\n\n${'x'.repeat(500)}\n`);
    write(path.join(skills, 'bom-crlf', 'SKILL.md'), '﻿---\r\nname: bom-crlf\r\ndescription: Windows line endings.\r\n---\r\n\r\nbody\r\n');
    write(path.join(skills, 'empty', 'SKILL.md'), '');
    write(path.join(skills, 'yaml-dots', 'SKILL.md'), '---\nname: yaml-dots\ndescription: closed with dots\n...\nbody\n');
    write(path.join(skills, 'big-body', 'SKILL.md'), `---\nname: big-body\ndescription: Big body.\n---\n\n${'lorem ipsum '.repeat(4000)}`);
    write(path.join(skills, 'big-no-fm', 'SKILL.md'), `First line of a huge frontmatter-less file.\n${'é'.repeat(30000)}`);
    const hugeMeta = 'metadata:\n' + Array.from({ length: 900 }, (_, i) => `  key${i}: "value number ${i} padded ......"`).join('\n') + '\n';
    write(path.join(skills, 'big-fm', 'SKILL.md'), `---\nname: big-fm\n${hugeMeta}description: After a 16 KB+ metadata block.\n---\nbody\n`);
    const openFm = `---\nname: open-fm\n${hugeMeta}description: frontmatter never closes\n`;
    write(path.join(skills, 'big-open-fm', 'SKILL.md'), openFm);
    fs.mkdirSync(path.join(skills, 'dir-as-file', 'SKILL.md'), { recursive: true });
    fs.symlinkSync(skills, path.join(skills, 'loop'));
    fs.symlinkSync(path.join(skills, 'ok'), path.join(skills, 'alias-link'));
    fs.symlinkSync(path.join(skills, 'nowhere'), path.join(skills, 'dangling'));
    fs.symlinkSync(path.join(skills, 'ok', 'SKILL.md'), path.join(skills, 'file-link'));
    if (!IS_ROOT) {
      write(path.join(skills, 'unreadable', 'SKILL.md'), skillMd('unreadable', 'x'));
      fs.chmodSync(path.join(skills, 'unreadable', 'SKILL.md'), 0o000);
      write(path.join(skills, 'locked-dir', 'inner', 'SKILL.md'), skillMd('inner', 'x'));
      fs.chmodSync(path.join(skills, 'locked-dir'), 0o000);
    }
    clearIndexCache();
    index = await buildIndex({ cwd: root, home });
    by = byInvocable(index);
  });
  after(() => {
    if (!IS_ROOT) {
      try { fs.chmodSync(path.join(skills, 'unreadable', 'SKILL.md'), 0o644); } catch { /* ignore */ }
      try { fs.chmodSync(path.join(skills, 'locked-dir'), 0o755); } catch { /* ignore */ }
    }
    rm(root);
  });

  test('unterminated frontmatter: indexed as a frontmatter-less file (no name, body-derived description)', () => {
    const s = by.get('unterminated');
    assert.ok(s);
    assert.equal(s.frontmatterName, undefined);
    assert.equal(typeof s.description, 'string');
    assert.equal(parseFrontmatter(fs.readFileSync(s.path, 'utf8')).hasFrontmatter, false);
  });

  test('frontmatter-less bodies: headings/html/fences skipped; markdown stripped; 200-char cap; empty file', () => {
    assert.equal(by.get('headings-only').description, '');
    assert.match(by.get('markdown-first-line').description, /^Bold em code\s+quote and more\.$/);
    assert.equal(by.get('long-first-line').description.length, 200);
    assert.equal(by.get('empty').description, '');
    assert.equal(by.get('empty').frontmatterName, undefined);
  });

  test('a leading code fence is skipped entirely: neither the markers nor the fence body become the description', () => {
    assert.equal(by.get('fenced-body').description, '');
  });

  test('BOM + CRLF and a "..." terminator parse normally', () => {
    assert.equal(by.get('bom-crlf').description, 'Windows line endings.');
    assert.equal(by.get('bom-crlf').frontmatterName, 'bom-crlf');
    assert.equal(by.get('yaml-dots').description, 'closed with dots');
  });

  test('huge files: head read for big bodies, full read for >16 KB frontmatter, multibyte-safe, open frontmatter beyond the head', () => {
    assert.equal(by.get('big-body').description, 'Big body.');
    assert.equal(by.get('big-no-fm').description, 'First line of a huge frontmatter-less file.');
    assert.equal(by.get('big-fm').description, 'After a 16 KB+ metadata block.');
    const open = by.get('big-open-fm');
    assert.ok(open, 'still indexed');
    assert.equal(open.frontmatterName, undefined, 'never closed -> no frontmatter');
  });

  test('a directory named SKILL.md, a dangling symlink and a file symlink at the skill level are skipped', () => {
    assert.ok(!by.has('dir-as-file'));
    assert.ok(!by.has('dangling'));
    assert.ok(!by.has('file-link'));
  });

  test('a symlink to a skill dir is indexed under the link name; a symlink loop terminates after one nested level', () => {
    assert.equal(by.get('alias-link').description, 'Fine.');
    assert.ok(by.has('ok'));
    const loopNames = [...by.keys()].filter((k) => k.startsWith('loop:'));
    assert.ok(loopNames.includes('loop:ok'), 'the loop dir is treated as a nesting dir');
    assert.ok(loopNames.every((k) => k.split(':').length === 2), 'never loop:loop:...');
    assert.ok(!by.has('loop'));
  });

  test('unreadable SKILL.md and an unreadable parent dir are skipped, the rest is indexed', { skip: IS_ROOT && 'running as root' }, () => {
    assert.ok(!by.has('unreadable'));
    assert.ok(!by.has('locked-dir:inner'));
    assert.ok(by.has('ok'));
  });
});

// ---------------------------------------------------------------------------
// Config dir resolution and project discovery
// ---------------------------------------------------------------------------
describe('config dir resolution', () => {
  let root;
  before(() => { root = mkTmp('cfgdir'); });
  after(() => rm(root));
  beforeEach(() => clearIndexCache());

  function seed(label) {
    const home = path.join(root, label, 'home');
    const cfg = path.join(root, label, 'cfg');
    write(path.join(home, '.claude', 'skills', `${label}-from-home`, 'SKILL.md'), skillMd('h', 'home'));
    write(path.join(cfg, 'skills', `${label}-from-cfg`, 'SKILL.md'), skillMd('c', 'cfg'));
    return { home, cfg };
  }

  test('home option -> <home>/.claude, ignoring CLAUDE_CONFIG_DIR', async () => {
    const { home, cfg } = seed('a');
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      assert.deepEqual(invocables(await buildIndex({ cwd: root, home })), ['a-from-home']);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  test('configDir option wins over both', async () => {
    const { home, cfg } = seed('b');
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home, configDir: cfg })), ['b-from-cfg']);
  });

  test('no home option: CLAUDE_CONFIG_DIR, else $HOME/.claude (both pointed at scratch here)', async () => {
    const { home, cfg } = seed('c');
    const savedCfg = process.env.CLAUDE_CONFIG_DIR;
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      process.env.CLAUDE_CONFIG_DIR = cfg;
      assert.deepEqual(invocables(await buildIndex({ cwd: root })), ['c-from-cfg']);
      clearIndexCache();
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.deepEqual(invocables(await buildIndex({ cwd: root })), ['c-from-home']);
    } finally {
      process.env.HOME = savedHome;
      if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    }
  });

  test('cwd defaults to process.cwd(); relative cwd is resolved', async () => {
    const { home } = seed('d');
    const a = await buildIndex({ home });
    clearIndexCache();
    const b = await buildIndex({ home, cwd: process.cwd() });
    clearIndexCache();
    const c = await buildIndex({ home, cwd: '.' });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  test('findProjectDirs: stops at the first .git (dir or worktree file), else just the resolved cwd', () => {
    const repo = path.join(root, 'fp', 'repo');
    write(path.join(repo, '.git'), 'gitdir: /elsewhere\n');
    const deep = path.join(repo, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    assert.deepEqual(findProjectDirs(deep), [deep, path.join(repo, 'a'), repo]);
    assert.deepEqual(findProjectDirs(repo), [repo]);
    const lonely = path.join(root, 'fp', 'lonely');
    fs.mkdirSync(lonely, { recursive: true });
    const dirs = findProjectDirs(lonely);
    assert.equal(dirs[0], lonely);
    assert.ok(dirs.length >= 1);
    assert.deepEqual(findProjectDirs(path.join(root, 'fp', 'missing')), [path.join(root, 'fp', 'missing')].concat(findProjectDirs(path.join(root, 'fp', 'missing')).slice(1)));
    assert.equal(findProjectDirs(path.join(root, 'fp', 'missing'))[0], path.join(root, 'fp', 'missing'));
  });
});

// ---------------------------------------------------------------------------
// installed_plugins.json fallback and robustness
// ---------------------------------------------------------------------------
describe('installed_plugins.json fallback and robustness', () => {
  let root;
  before(() => { root = mkTmp('fallback'); });
  after(() => rm(root));
  beforeEach(() => clearIndexCache());

  function cacheHome(label, installedJson) {
    const home = path.join(root, label);
    const cfg = path.join(home, '.claude');
    const pl = path.join(cfg, 'plugins', 'cache', 'mk', 'pl');
    write(path.join(pl, '1.0.0', 'skills', 'old', 'SKILL.md'), skillMd('old', 'v1'));
    write(path.join(pl, '2.0.0', 'skills', 'new', 'SKILL.md'), skillMd('new', 'v2'));
    const past = new Date(Date.now() - 100_000);
    fs.utimesSync(path.join(pl, '1.0.0'), past, past);
    write(path.join(cfg, 'plugins', 'cache', 'mk', 'off', '1.0.0', 'skills', 'o', 'SKILL.md'), skillMd('o', 'disabled'));
    write(path.join(cfg, 'plugins', 'cache', 'mk', 'empty-plugin', '.keep'), '');
    write(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@mk': false } }));
    if (installedJson !== undefined) write(path.join(cfg, 'plugins', 'installed_plugins.json'), installedJson);
    return home;
  }

  test('missing installed_plugins.json -> newest cached version per plugin, disabled ids skipped', async () => {
    const res = await buildIndex({ cwd: root, home: cacheHome('missing') });
    assert.deepEqual(invocables(res), ['pl:new']);
    assert.equal(res[0].pluginId, 'pl@mk');
    assert.ok(res[0].path.includes('2.0.0'));
  });

  test('installed_plugins.json without a plugins object, or as an array, also falls back', async () => {
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home: cacheHome('noplugins', '{"version": 2}') })), ['pl:new']);
    clearIndexCache();
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home: cacheHome('array', '[1,2,3]') })), ['pl:new']);
    clearIndexCache();
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home: cacheHome('scalar', '"str"') })), ['pl:new']);
  });

  test('a present installed_plugins.json disables the cache fallback entirely', async () => {
    const home = cacheHome('present', JSON.stringify({ plugins: {} }));
    assert.deepEqual(await buildIndex({ cwd: root, home }), []);
  });

  test('settings.json: non-object enabledPlugins means everything is enabled; unreadable settings too', async () => {
    const home = cacheHome('settings');
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: 'nope' }));
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home })), ['off:o', 'pl:new']);
    clearIndexCache();
    write(path.join(home, '.claude', 'settings.json'), '{{{');
    assert.deepEqual(invocables(await buildIndex({ cwd: root, home })), ['off:o', 'pl:new']);
  });

  test('never throws: configDir that is a file, nonexistent cwd, empty home', async () => {
    const file = path.join(root, 'a-file');
    write(file, 'x');
    assert.deepEqual(await buildIndex({ cwd: path.join(root, 'no-such-dir'), configDir: file, home: path.join(root, 'nohome') }), []);
    assert.deepEqual(await buildIndex({ cwd: root, home: path.join(root, 'nohome') }), []);
  });
});

// ---------------------------------------------------------------------------
// mtime cache
// ---------------------------------------------------------------------------
describe('mtime cache signature', () => {
  let root; let home; let cfg; let skills; let repo; let cwd;
  const sigPaths = () => [
    skills,
    path.join(skills, 'synced', 'bucket'),
    path.join(cfg, 'plugins', 'installed_plugins.json'),
    path.join(cfg, 'plugins', 'synced', 'pbucket'),
    path.join(cfg, 'settings.json'),
    path.join(cwd, '.claude', 'skills'),
    path.join(repo, '.claude', 'skills'),
  ];
  let clock;
  const pinAll = () => { const t = Math.floor(Date.now() / 1000) - 100; for (const p of sigPaths()) fs.utimesSync(p, t, t); };
  const bump = (p) => { clock += 10; fs.utimesSync(p, clock, clock); };

  before(() => {
    root = mkTmp('cache');
    home = path.join(root, 'home');
    cfg = path.join(home, '.claude');
    skills = path.join(cfg, 'skills');
    repo = path.join(root, 'repo');
    cwd = path.join(repo, 'pkg');
    write(path.join(skills, 'u', 'SKILL.md'), skillMd('u', 'user'));
    write(path.join(skills, 'synced', 'bucket', 's', 'SKILL.md'), skillMd('s', 'synced'));
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
    write(path.join(cfg, 'plugins', 'synced', 'pbucket', 'p', 'skills', 'ps', 'SKILL.md'), skillMd('ps', 'synced plugin'));
    write(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: {} }));
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(repo, '.claude', 'skills', 'r', 'SKILL.md'), skillMd('r', 'repo'));
    write(path.join(cwd, '.claude', 'skills', 'w', 'SKILL.md'), skillMd('w', 'pkg'));
    clock = Math.floor(Date.now() / 1000) + 100;
  });
  after(() => rm(root));
  beforeEach(() => { clearIndexCache(); pinAll(); });

  test('INDEX_TTL_MS is 60 s', () => { assert.equal(INDEX_TTL_MS, 60_000); });

  test('each signature input invalidates on its own: settings.json, installed_plugins.json, synced skills bucket, synced plugins bucket, project skills dirs', async () => {
    const first = await buildIndex({ cwd, home });
    assert.deepEqual(invocables(first), ['anthropic-skills:s', 'p:ps', 'r', 'u', 'w']);
    let n = first.length;
    const addUserSkill = (label) => {
      write(path.join(skills, label, 'SKILL.md'), skillMd(label, label));
      const t = Math.floor(Date.now() / 1000) - 100;
      fs.utimesSync(skills, t, t); // hide the change from the skills-dir mtime
    };
    addUserSkill('hidden-1');
    assert.equal((await buildIndex({ cwd, home })).length, n, 'cache hit while every signature mtime is unchanged');
    for (const p of [
      path.join(cfg, 'settings.json'),
      path.join(cfg, 'plugins', 'installed_plugins.json'),
      path.join(skills, 'synced', 'bucket'),
      path.join(cfg, 'plugins', 'synced', 'pbucket'),
      path.join(cwd, '.claude', 'skills'),
      path.join(repo, '.claude', 'skills'),
    ]) {
      bump(p);
      n += 1;
      assert.equal((await buildIndex({ cwd, home })).length, n, `rescan after touching ${path.relative(root, p)}`);
      addUserSkill(`hidden-${n}`);
      assert.equal((await buildIndex({ cwd, home })).length, n, 'and cached again');
    }
    bump(skills);
    assert.equal((await buildIndex({ cwd, home })).length, n + 1, 'the skills dir itself');
  });

  test('cache entries are keyed by configDir + cwd + includeCommands', async () => {
    write(path.join(cfg, 'plugins', 'synced', 'pbucket', 'p', 'commands', 'c.md'), '---\ndescription: cmd\n---\n');
    const withCmd = await buildIndex({ cwd, home });
    const without = await buildIndex({ cwd, home, includeCommands: false });
    assert.ok(invocables(withCmd).includes('p:c'));
    assert.ok(!invocables(without).includes('p:c'));
    const otherCwd = await buildIndex({ cwd: repo, home });
    assert.ok(!invocables(otherCwd).includes('w'), 'different cwd, different project skills');
    assert.ok(invocables(await buildIndex({ cwd, home })).includes('w'), 'the first entry is still served');
  });

  test('ttlMs: 0 disables, an expired ttl rescans, clearIndexCache drops everything', async () => {
    const base = (await buildIndex({ cwd, home, ttlMs: 0 })).length;
    write(path.join(skills, 'ttl-a', 'SKILL.md'), skillMd('ttl-a', 'x'));
    pinAll();
    assert.equal((await buildIndex({ cwd, home, ttlMs: 0 })).length, base + 1);
    clearIndexCache(); // a sub-millisecond-old cache entry from the previous call would otherwise be served as fresh
    const seen = (await buildIndex({ cwd, home, ttlMs: 1 })).length;
    write(path.join(skills, 'ttl-b', 'SKILL.md'), skillMd('ttl-b', 'x'));
    pinAll();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await buildIndex({ cwd, home, ttlMs: 1 })).length, seen + 1);
    const cached = await buildIndex({ cwd, home });
    write(path.join(skills, 'ttl-c', 'SKILL.md'), skillMd('ttl-c', 'x'));
    pinAll();
    assert.equal((await buildIndex({ cwd, home })).length, cached.length);
    clearIndexCache();
    assert.equal((await buildIndex({ cwd, home })).length, cached.length + 1);
  });

  test('returned arrays are fresh copies of the cached list', async () => {
    const a = await buildIndex({ cwd, home });
    a.push({ fake: true });
    const b = await buildIndex({ cwd, home });
    assert.ok(!b.some((s) => s.fake));
    assert.notEqual(a, b);
  });
});
