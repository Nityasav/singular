// lib/context.js — compose the additionalContext text and the hook JSON envelope.
//
//   composeContext({stack, localMatches, candidates, mode, budgetChars, loaded?, pinned?}) -> string
//   fitLoadedText(text, reservedChars) -> {text, truncated}   (budget a skill body against the spill threshold)
//   spillIfNeeded(text, home) -> text | short note with the spill file path (when > 9,500 chars)
//   hookOutput(eventName, additionalContext, {systemMessage?}) -> JSON string for stdout
//
// The context is factual and short. It names things; it never says "you must use".
// Format (sections omitted when empty; the first line carries the [skill-scout] tag):
//   [skill-scout] Stack: <summary>
//   Installed skills likely relevant: <name> (<why>), <name> (<why>)
//   If one of the third-party candidates below fits the request, end your reply with exactly one line ...
//   Third-party candidates (not loaded): <owner/repo#sha7@skill> (<installs> installs, audit <status>) — load with /scout-load owner/repo@skill
//   <notes: extra factual one-liners such as the skill-scout command list>
//
// The relay instruction sits BEFORE the candidate list and names the exact line to add (measured
// 2026-10-07: the old trailing "tell the user ... how to load it" line was relayed in 0 of 6 runs with
// candidates); the hook additionally announces fresh candidates to the user through `systemMessage`
// (bin/on-prompt.js), so the user learns about /scout-load even when the model stays silent.

import fs from 'node:fs';
import path from 'node:path';

export const TAG = '[skill-scout]';
export const SPILL_THRESHOLD = 9500;
export const HOOK_HARD_CAP = 10000;
export const TRUNCATION_MARKER = '\n[skill-scout: truncated]';
export const RELAY_LINE = 'If one of the third-party candidates below fits the request, end your reply with exactly one line `Load with /scout-load <ref>` naming the single best fit; omit that line if none fits.';

function fmtInstalls(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  return String(v);
}

function skillLabel(m) {
  const s = m && m.skill ? m.skill : m;
  if (!s || typeof s !== 'object') return String(s ?? '');
  return s.invocableName || (s.pluginName ? `${s.pluginName}:${s.name}` : s.name) || '';
}

function whyOf(m) {
  if (!m || typeof m !== 'object') return '';
  const matched = Array.isArray(m.matched) ? m.matched.filter(Boolean).slice(0, 4) : [];
  if (matched.length) return `matches ${matched.join(', ')}`;
  return typeof m.why === 'string' ? m.why : '';
}

/**
 * Candidate line: owner/repo#sha7@skill (N installs, audit S) — load with /scout-load owner/repo@skill
 * The command is the short unpinned form (the first /scout-load pins HEAD and records it); the
 * `#sha7` suffix is display only, shown when a sha is already known from the cache.
 */
function candidateLine(c) {
  const source = c.source ?? (c.owner && c.repo ? `${c.owner}/${c.repo}` : '');
  const skill = c.skill ?? '';
  if (!source || !skill) return '';
  const sha = typeof c.sha === 'string' && /^[0-9a-f]{40}$/.test(c.sha) ? c.sha : null;
  const display = `${source}${sha ? `#${sha.slice(0, 7)}` : ''}@${skill}`;
  const audit = c.audit && typeof c.audit === 'object' ? c.audit.status : c.audit;
  const auditText = audit ? `, audit ${audit}` : '';
  return `${display} (${fmtInstalls(c.installs)} installs${auditText}) — load with /scout-load ${source}@${skill}`;
}

/**
 * Fit a loaded skill body into what remains under SPILL_THRESHOLD once `reservedChars` (the rest of
 * the context, header and wrapper) are accounted for. Never returns more than `room` chars.
 */
export function fitLoadedText(text, reservedChars = 0) {
  const s = String(text ?? '');
  const room = SPILL_THRESHOLD - Math.max(0, Math.floor(Number(reservedChars) || 0));
  if (s.length <= room) return { text: s, truncated: 0 };
  const keep = Math.max(0, room - TRUNCATION_MARKER.length);
  return { text: `${s.slice(0, keep)}${TRUNCATION_MARKER}`, truncated: s.length - keep };
}

/**
 * @param {object} p
 * @param {{summary?: string, tags?: string[]}|string} [p.stack]
 * @param {{skill: object, score: number, matched: string[]}[]} [p.localMatches]
 * @param {object[]} [p.candidates]  gated candidates: {source|owner+repo, skill, installs, sha?, audit?}
 * @param {string} [p.mode]
 * @param {number} [p.budgetChars]   default 2000
 * @param {{ref: string, text: string, stripped?: string[], reason?: string}} [p.loaded]  auto-mode / pinned payload, appended last
 * @param {string[]} [p.pinned]      installed skills the user pinned in config (one hint line)
 * @param {string[]} [p.notes]       extra factual one-liners appended after the candidates (never dropped by the budget)
 */
export function composeContext({ stack, localMatches, candidates, mode = 'suggest', budgetChars = 2000, loaded, pinned, notes } = {}) {
  const budget = Math.max(200, Math.floor(Number(budgetChars) || 2000));
  const extra = (Array.isArray(notes) ? notes : []).map((n) => String(n ?? '').trim()).filter(Boolean);
  const summary = typeof stack === 'string' ? stack : stack && typeof stack === 'object' ? String(stack.summary ?? '') : '';
  const stackLine = summary.trim() ? `Stack: ${summary.trim()}` : '';

  const locals = (Array.isArray(localMatches) ? localMatches : [])
    .map((m) => {
      const label = skillLabel(m);
      if (!label) return '';
      const why = whyOf(m);
      return why ? `${label} (${why})` : label;
    })
    .filter(Boolean);

  const pins = (Array.isArray(pinned) ? pinned : []).map((p) => String(p ?? '').trim()).filter(Boolean);

  const cands = mode === 'off' || mode === 'local'
    ? []
    : (Array.isArray(candidates) ? candidates : []).map(candidateLine).filter(Boolean);

  const build = (nLocal, nCand) => {
    const lines = [];
    if (stackLine) lines.push(stackLine);
    if (pins.length) lines.push(`Pinned installed skills (user-configured, consider invoking): ${pins.join(', ')}`);
    if (nLocal > 0) lines.push(`Installed skills likely relevant: ${locals.slice(0, nLocal).join(', ')}`);
    if (nCand > 0) lines.push(RELAY_LINE, `Third-party candidates (not loaded): ${cands.slice(0, nCand).join('; ')}`);
    lines.push(...extra);
    if (lines.length === 0) return '';
    lines[0] = `${TAG} ${lines[0]}`;
    return lines.join('\n');
  };

  let nLocal = locals.length;
  let nCand = cands.length;
  let text = build(nLocal, nCand);
  // Shrink to budget: drop candidates from the end first, then local matches, then hard-cut.
  while (text.length > budget && (nCand > 0 || nLocal > 0)) {
    if (nCand > 0) nCand--;
    else nLocal--;
    text = build(nLocal, nCand);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;

  if (loaded && typeof loaded === 'object' && typeof loaded.text === 'string' && loaded.text.trim()) {
    const strippedList = Array.isArray(loaded.stripped) ? [...loaded.stripped] : [];
    const reason = typeof loaded.reason === 'string' && loaded.reason.trim() ? loaded.reason.trim() : 'auto mode, user-configured';
    const wrap = (body, strippedText) => {
      const header = `Loaded third-party skill ${loaded.ref} (${reason}; text only, nothing installed).${strippedText}`;
      return `${text ? `${text}\n` : `${TAG} `}${header}\n<skill-scout-loaded ref="${loaded.ref}">\n${body}\n</skill-scout-loaded>`;
    };
    const strippedText = () => (strippedList.length ? ` Stripped: ${strippedList.join('; ')}.` : '');
    let block = wrap(loaded.text, strippedText());
    if (block.length > SPILL_THRESHOLD) {
      // Budget the skill body against the threshold; the stack / routing lines are more valuable than its tail.
      const probe = wrap('', ` Stripped: ${[...strippedList, `truncated 99999 chars to fit the 9,500-char hook budget`].join('; ')}.`);
      const fitted = fitLoadedText(loaded.text, probe.length);
      if (fitted.truncated > 0) strippedList.push(`truncated ${fitted.truncated} chars to fit the 9,500-char hook budget`);
      block = wrap(fitted.text, strippedText());
    }
    return block;
  }
  return text;
}

/**
 * Last-resort guard: Claude Code only shows the model a 2 KB preview of hook output past 10,000
 * chars, so anything still over SPILL_THRESHOLD (9,500) is written to $SKILL_SCOUT_HOME/spill-<ts>.md
 * and replaced by a short note with the path. composeContext() budgets the loaded body first, so this
 * fires only for oversized stack / routing text.
 */
export function spillIfNeeded(text, home) {
  const s = String(text ?? '');
  if (s.length <= SPILL_THRESHOLD) return s;
  const dir = String(home || '').trim() || process.cwd();
  const file = path.join(dir, `spill-${Date.now()}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, s);
    return `${TAG} Context was ${s.length} chars (over skill-scout's ${SPILL_THRESHOLD}-char threshold; Claude Code previews only 2 KB past ${HOOK_HARD_CAP}) and was written to ${file}. Read that file if the loaded skill text is needed.`;
  } catch (err) {
    return `${s.slice(0, SPILL_THRESHOLD - 120)}\n${TAG} [truncated: ${s.length} chars; spill to ${file} failed: ${String(err?.message ?? err).slice(0, 60)}]`;
  }
}

/** JSON envelope Claude Code expects on a hook's stdout. `systemMessage` (optional) is shown to the user. */
export function hookOutput(eventName, additionalContext, extra = {}) {
  const out = {
    hookSpecificOutput: {
      hookEventName: String(eventName),
      additionalContext: String(additionalContext ?? ''),
    },
  };
  if (extra && typeof extra.systemMessage === 'string' && extra.systemMessage.trim()) out.systemMessage = extra.systemMessage;
  return JSON.stringify(out);
}
