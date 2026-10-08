// test/e2e/lib/stream.mjs — parse a `claude -p --output-format stream-json --verbose --include-hook-events`
// transcript into the handful of facts the e2e cases assert on. Zero dependencies; pure.
//
//   parseStream(text) -> {
//     events, init, sessionId, model, permissionMode, plugins,
//     hookEvents: [{event, hookName, exitCode, outcome, output, stdout, stderr, context, systemMessage, json, raw}],
//     hooks(eventName) -> hookEvents for one hook_event (UserPromptSubmit | UserPromptExpansion | SubagentStart | ...),
//     toolUses: [tool names in order], toolUseBlocks: [{id, name, input, parentToolUseId}],
//     toolResults: [{toolUseId, text, isError, parentToolUseId}], toolResultText: every tool result joined,
//     skillUses: [skill names passed to the Skill tool], bashCommands: [command strings passed to Bash],
//     results: [result events], resultEvent: the LAST result event (a backgrounded subagent produces two),
//     result: its text, costUsd, numTurns, isError, assistantText, rateLimited, rateLimitResetsAt (unix seconds | null), unparsed
//   }
//
// Observed shapes (Claude Code 2.1.293):
//   {type:"system", subtype:"init", session_id, model, permissionMode, plugins:[{name, source, path, version}], ...}
//   {type:"system", subtype:"hook_started"|"hook_response", hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome}
//     `output` is stdout + stderr concatenated; for a context hook stdout is the hookSpecificOutput JSON.
//   {type:"assistant"|"user", message:{content:[{type:"text"|"tool_use"|"tool_result", ...}]}, parent_tool_use_id}
//   {type:"result", subtype:"success"|..., result, total_cost_usd, num_turns, is_error, session_id, duration_ms}
//   {type:"rate_limit_event", rate_limit_info:{status}}

export function parseStreamLines(text) {
  const events = [];
  let unparsed = 0;
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      unparsed++;
    }
  }
  return { events, unparsed };
}

function hookRecord(e) {
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const output = typeof e.output === 'string' ? e.output : '';
  let json = null;
  for (const candidate of [stdout, output]) {
    const s = candidate.trim();
    if (!s.startsWith('{')) continue;
    try {
      json = JSON.parse(s);
      break;
    } catch {
      // output may be stdout+stderr; try the first balanced JSON object on its own line
      const first = s.split('\n')[0];
      try {
        json = JSON.parse(first);
        break;
      } catch {
        json = null;
      }
    }
  }
  const hso = json && typeof json === 'object' ? json.hookSpecificOutput : null;
  return {
    event: String(e.hook_event ?? ''),
    hookName: String(e.hook_name ?? ''),
    exitCode: typeof e.exit_code === 'number' ? e.exit_code : e.exit_code == null ? null : Number(e.exit_code),
    outcome: e.outcome ?? null,
    output,
    stdout,
    stderr: typeof e.stderr === 'string' ? e.stderr : '',
    context: hso && typeof hso.additionalContext === 'string' ? hso.additionalContext : '',
    systemMessage: json && typeof json.systemMessage === 'string' ? json.systemMessage : '',
    json,
    raw: e,
  };
}

export function parseStream(text) {
  const { events, unparsed } = parseStreamLines(text);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
  const hookEvents = events.filter((e) => e.type === 'system' && e.subtype === 'hook_response').map(hookRecord);
  const hookStarted = events.filter((e) => e.type === 'system' && e.subtype === 'hook_started').map((e) => String(e.hook_event ?? ''));
  const toolUseBlocks = [];
  const toolResults = [];
  const assistantText = [];
  for (const e of events) {
    if (!e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (e.type === 'assistant' && block.type === 'tool_use') toolUseBlocks.push({ id: block.id ?? null, name: String(block.name ?? ''), input: block.input ?? {}, parentToolUseId: e.parent_tool_use_id ?? null });
      else if (e.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') assistantText.push(block.text);
      else if (e.type === 'user' && block.type === 'tool_result') {
        const c = block.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
        toolResults.push({ toolUseId: block.tool_use_id ?? null, text, isError: block.is_error === true, parentToolUseId: e.parent_tool_use_id ?? null });
      }
    }
  }
  const results = events.filter((e) => e.type === 'result');
  const resultEvent = results.length ? results[results.length - 1] : null;
  const costUsd = results.reduce((max, r) => Math.max(max, Number(r.total_cost_usd) || 0), 0);
  const rateLimited = events.some((e) => e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.status && e.rate_limit_info.status !== 'allowed');
  const rateLimitEvent = events.find((e) => e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.status && e.rate_limit_info.status !== 'allowed');
  const rateLimitResetsAt = rateLimitEvent && Number.isFinite(Number(rateLimitEvent.rate_limit_info.resetsAt)) ? Number(rateLimitEvent.rate_limit_info.resetsAt) : null;
  return {
    events,
    unparsed,
    init,
    sessionId: init?.session_id ?? resultEvent?.session_id ?? null,
    model: init?.model ?? null,
    permissionMode: init?.permissionMode ?? null,
    plugins: Array.isArray(init?.plugins) ? init.plugins.map((p) => p.source ?? p.name) : [],
    hookEvents,
    hookStarted,
    hooks(eventName) {
      return hookEvents.filter((h) => h.event === eventName || h.hookName === eventName);
    },
    toolUseBlocks,
    toolResults,
    toolResultText: toolResults.map((t) => t.text).join('\n'),
    toolUses: toolUseBlocks.map((b) => b.name),
    skillUses: toolUseBlocks.filter((b) => b.name === 'Skill').map((b) => String(b.input?.skill ?? '')),
    bashCommands: toolUseBlocks.filter((b) => b.name === 'Bash').map((b) => String(b.input?.command ?? '')),
    results,
    resultEvent,
    result: resultEvent ? String(resultEvent.result ?? '') : '',
    costUsd,
    numTurns: resultEvent ? Number(resultEvent.num_turns) || 0 : 0,
    isError: resultEvent ? resultEvent.is_error === true : false,
    assistantText: assistantText.join('\n'),
    rateLimited,
    rateLimitResetsAt,
  };
}
