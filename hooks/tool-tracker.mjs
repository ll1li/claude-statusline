#!/usr/bin/env node
/**
 * tool-tracker.mjs — the data layer behind the statusline's "active tool" row,
 * the running-agents list and the ✓ ✗ ⏳ session counters.
 *
 * One script, several hook events. Wire it (see README) for:
 *   PreToolUse          → tool-now.json {status:"running"}, pending++
 *   PostToolUse         → tool-now.json {status:"success"}, success++
 *   PostToolUseFailure  → tool-now.json {status:"fail"},    fail++
 *   SubagentStart/Stop  → agents-running.json add/remove
 *   SessionStart        → reset session counters (startup / clear only)
 *
 * Files live in the statusline data dir:
 *   CLAUDE_STATUSLINE_DIR if set, else %TEMP%\claude-statusline on Windows,
 *   else /tmp/claude-statusline.
 * Everything is best-effort: any failure exits 0 so a hook can never block Claude.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DATA_DIR = process.env.CLAUDE_STATUSLINE_DIR
  || (process.platform === 'win32' ? join(tmpdir(), 'claude-statusline') : '/tmp/claude-statusline');

const NOW_FILE     = join(DATA_DIR, 'tool-now.json');
const AGENTS_FILE  = join(DATA_DIR, 'agents-running.json');
const SESSION_FILE = join(DATA_DIR, 'session.json');
const LOG_FILE     = join(DATA_DIR, 'tool-activity.jsonl');
const LOG_KEEP     = 200;

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(data)); } catch {}
};
const appendLog = (entry) => {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > LOG_KEEP) writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP).join('\n') + '\n');
  } catch {}
};
const freshSession = () => ({
  started: Math.floor(Date.now() / 1000),
  counters: { total: 0, success: 0, fail: 0, pending: 0 },
});
const bumpCounters = (fn) => {
  const s = readJson(SESSION_FILE, null) ?? freshSession();
  s.counters ??= freshSession().counters;
  fn(s.counters);
  writeJson(SESSION_FILE, s);
};
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const base = (p) => String(p ?? '').split(/[\\/]/).pop();

// ── Classify a tool call into a category + short detail ──────────────────────
function classify(name, input = {}) {
  if (name === 'Skill') return ['SKL', input.skill || '?'];
  if (name.startsWith('mcp__')) {
    const [server, ...rest] = name.slice(5).split('__');
    return ['MCP', rest.length ? `${server}:${rest.join('/')}` : server];
  }
  if (name === 'Agent') {
    const t = input.subagent_type;
    return ['AGT', (t && t !== 'general-purpose') ? t : clip(input.description, 40) || 'agent'];
  }
  if (name === 'WebSearch') return ['WEB', `search:${clip(input.query, 50) || '?'}`];
  if (name === 'WebFetch') {
    const host = String(input.url ?? '').replace(/^https?:\/\//, '').split('/')[0];
    return ['WEB', `fetch:${clip(host, 35) || '?'}`];
  }
  if (name === 'ToolSearch') return ['DSC', clip(input.query, 35) || '?'];
  if (/^Task(Create|Update|Get|List|Output|Stop)$/.test(name)) return ['TASK', name.slice(4)];
  if (/^Todo(Read|Write)$/.test(name)) return ['TODO', name.slice(4)];
  if (/^Notebook(Read|Edit)$/.test(name)) return ['NB', name.slice(8)];
  if (/^Cron(Create|Delete|List)$/.test(name)) return ['CRON', name.slice(4)];
  if (name === 'Bash' || name === 'PowerShell') {
    const first = String(input.command ?? '').split('\n').find(l => l.trim() && !/^\s*#(?!!)/.test(l)) ?? '';
    return ['CMD', clip(first, 60) || name];
  }
  if (name === 'Read')  return ['SYS', `read:${base(input.file_path)}`];
  if (name === 'Write') return ['SYS', `write:${base(input.file_path)}`];
  if (name === 'Edit' || name === 'MultiEdit') return ['SYS', `edit:${base(input.file_path)}`];
  if (name === 'Grep')  return ['SYS', `grep:${clip(input.pattern, 30)}`];
  if (name === 'Glob')  return ['SYS', `glob:${clip(input.pattern, 30)}`];
  if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return ['SYS', `plan:${name}`];
  if (name === 'EnterWorktree' || name === 'ExitWorktree') return ['SYS', 'worktree'];
  return ['OTH', name];
}

// ── Event handlers ────────────────────────────────────────────────────────────
function onToolStart(ev, ts) {
  const [cat, detail] = classify(ev.tool_name, ev.tool_input);
  // A previous call that never reported back (permission denied, interrupted)
  // still holds a pending slot — release it so ⏳ cannot drift upwards forever.
  const abandoned = readJson(NOW_FILE, null)?.status === 'running';
  writeJson(NOW_FILE, { ts, cat, detail, tool: ev.tool_name, status: 'running' });
  appendLog({ ts, cat, detail, tool: ev.tool_name, event: 'start' });
  bumpCounters(c => { if (abandoned) c.pending = Math.max(0, c.pending - 1); c.pending++; c.total++; });
}

function onToolEnd(ev, ts, status) {
  const prev = readJson(NOW_FILE, null);
  const duration = prev?.ts ? ts - prev.ts : 0;
  writeJson(NOW_FILE, { ts, cat: '', detail: '', tool: ev.tool_name, status, duration, completed_at: ts });
  appendLog({ ts, tool: ev.tool_name, event: 'end', status, duration });
  bumpCounters(c => { c.pending = Math.max(0, c.pending - 1); c[status === 'success' ? 'success' : 'fail']++; });
}

function onAgent(ev, ts) {
  const agents = readJson(AGENTS_FILE, []);
  const list = Array.isArray(agents) ? agents : [];
  const label = clip(ev.description, 40) || ev.agent_type || 'agent';
  if (ev.hook_event_name === 'SubagentStart') {
    list.push({ id: ev.agent_id || `agent-${ts}`, type: ev.agent_type || 'general-purpose', label, start_ts: ts });
    writeJson(AGENTS_FILE, list);
    appendLog({ ts, cat: 'AGT', event: 'agent_start', detail: label, agent_id: ev.agent_id });
  } else {
    const me = list.find(a => a.id === ev.agent_id);
    writeJson(AGENTS_FILE, list.filter(a => a.id !== ev.agent_id));
    appendLog({ ts, cat: 'AGT', event: 'agent_stop', detail: label, agent_id: ev.agent_id,
                duration: me?.start_ts ? ts - me.start_ts : 0 });
  }
}

function onSessionStart(ev) {
  if (ev.source === 'startup' || ev.source === 'clear' || !existsSync(SESSION_FILE)) {
    writeJson(SESSION_FILE, freshSession());
    writeJson(AGENTS_FILE, []);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  if (!ev || typeof ev !== 'object') return;
  const ts = Math.floor(Date.now() / 1000);
  switch (ev.hook_event_name) {
    case 'PreToolUse':         if (ev.tool_name) onToolStart(ev, ts); break;
    case 'PostToolUse':        if (ev.tool_name) onToolEnd(ev, ts, 'success'); break;
    case 'PostToolUseFailure': if (ev.tool_name) onToolEnd(ev, ts, 'fail'); break;
    case 'SubagentStart':
    case 'SubagentStop':       onAgent(ev, ts); break;
    case 'SessionStart':       onSessionStart(ev); break;
  }
}

main().catch(() => {}).finally(() => process.exit(0));
