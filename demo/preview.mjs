#!/usr/bin/env node
/**
 * preview.mjs — render the statusline in your terminal with every row lit up,
 * without waiting for a real session to hit all the states at once.
 *
 *   node demo/preview.mjs
 *
 * It builds a throwaway project (git repo with uncommitted changes, a transcript
 * with an active skill), a data-layer dir with
 * a running tool, two live agents and session counters, then pipes a realistic
 * stdin payload into ../statusline.mjs. Hook/MCP/skill/rule counts are read from
 * your real ~/.claude, so that row shows your own setup.
 *
 * Nothing outside os.tmpdir()/claude-statusline-demo is touched.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const STATUSLINE = join(here, '..', 'statusline.mjs');
const ROOT = join(tmpdir(), 'claude-statusline-demo');
const PROJECT = join(ROOT, 'my-app');
const DATA = join(ROOT, 'data');
const now = Math.floor(Date.now() / 1000);

const git = (...args) => execFileSync('git', ['-C', PROJECT, ...args], { stdio: 'pipe', encoding: 'utf8' });

// ── Throwaway project: git repo with a dirty tree ────────────────────────────
mkdirSync(join(PROJECT, 'src'), { recursive: true });
if (!existsSync(join(PROJECT, '.git'))) {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', 'demo');
  writeFileSync(join(PROJECT, 'src', 'index.js'), Array.from({ length: 20 }, (_, i) => `console.log(${i});`).join('\n') + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
}
writeFileSync(join(PROJECT, 'src', 'index.js'),
  Array.from({ length: 32 }, (_, i) => (i < 3 ? `// changed ${i}` : `console.log(${i});`)).join('\n') + '\n');

// ── Transcript with an active skill (row 3, "skill:") ────────────────────────
const transcript = join(ROOT, 'transcript.jsonl');
writeFileSync(transcript, JSON.stringify({ type: 'assistant', attributionSkill: 'commit' }) + '\n');

// ── Data layer: running tool, two agents, counters ───────────────────────────
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'tool-now.json'), JSON.stringify({
  ts: now - 7, cat: 'CMD', detail: 'npm test -- --coverage', tool: 'Bash', status: 'running',
}));
writeFileSync(join(DATA, 'agents-running.json'), JSON.stringify([
  { id: 'a1', type: 'Explore', label: 'find auth call sites', start_ts: now - 41 },
  { id: 'a2', type: 'code-reviewer', label: 'code-reviewer', start_ts: now - 12 },
]));
writeFileSync(join(DATA, 'session.json'), JSON.stringify({
  started: now - 1800, counters: { total: 58, success: 54, fail: 2, pending: 1 },
}));

// ── stdin payload, shaped like Claude Code's statusLine input ────────────────
const stdin = {
  cwd: PROJECT,
  transcript_path: transcript,
  model: { id: 'claude-fable-5-1', display_name: process.env.DEMO_MODEL || 'Fable 5.1' },
  effort: { level: process.env.DEMO_EFFORT || 'high' },
  context_window: { context_window_size: 1_000_000, used_percentage: Number(process.env.DEMO_CTX || 37) },
  rate_limits: {
    five_hour: { used_percentage: Number(process.env.DEMO_5H || 47), resets_at: now + 2 * 3600 + 14 * 60 },
    seven_day: { used_percentage: Number(process.env.DEMO_7D || 63), resets_at: now + 3 * 86400 + 5 * 3600 },
  },
};

const res = spawnSync(process.execPath, [STATUSLINE], {
  input: JSON.stringify(stdin),
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_STATUSLINE_DIR: DATA,
         COLUMNS: process.env.COLUMNS || String(process.stdout.columns || 160) },
});
process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
