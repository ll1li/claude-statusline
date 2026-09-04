#!/usr/bin/env node
/**
 * Claude Code custom statusline
 * Dynamic rows: metrics + active tools/agents + environment
 * Truecolor per-character gradients, gradient dot meters, pink accents
 * Reads the data layer written by hooks/tool-tracker.mjs (active tool, agents, counters)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as https from 'https';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R   = '\x1b[0m';
const B   = '\x1b[1m';
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

// ── Gradient engine (truecolor) ──────────────────────────────────────────────
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function colorAt(stops, t) {
  const segments = stops.length - 1;
  const segFloat = t * segments;
  const segIdx = Math.min(Math.floor(segFloat), segments - 1);
  const segT = segFloat - segIdx;
  const [r1, g1, b1] = stops[segIdx];
  const [r2, g2, b2] = stops[segIdx + 1];
  return [lerp(r1, r2, segT), lerp(g1, g2, segT), lerp(b1, b2, segT)];
}

function gradientText(text, stops) {
  if (!text || stops.length < 2) return text;
  const n = text.length;
  let result = '';
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const [r, g, b] = colorAt(stops, t);
    result += rgb(r, g, b) + text[i];
  }
  return result + R;
}

function gradientBoldText(text, stops) {
  if (!text || stops.length < 2) return text;
  const n = text.length;
  let result = B;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const [r, g, b] = colorAt(stops, t);
    result += rgb(r, g, b) + text[i];
  }
  return result + R;
}

// ── Gradient dot meter ●●●○○○ ────────────────────────────────────────────────
function gradientDots(pct, n, filledStops, emptyRgb = [55, 55, 65]) {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * n);
  let result = '';
  for (let i = 0; i < n; i++) {
    if (i < filled) {
      const t = n === 1 ? 0 : i / (n - 1);
      const [r, g, b] = colorAt(filledStops, t);
      result += rgb(r, g, b) + '●';
    } else {
      result += rgb(...emptyRgb) + '○';
    }
  }
  return result + R;
}

// ── Color palettes ───────────────────────────────────────────────────────────
const GRAD = {
  // Model name: gold → hot pink → purple
  model:   [[232, 184, 75], [244, 114, 182], [192, 132, 252]],
  // Path: teal → cyan
  path:    [[78, 201, 201], [130, 240, 255]],
  // Context meter: green → yellow → coral
  ctx:     [[110, 220, 140], [250, 210, 70], [240, 100, 90]],
  // 5h meter: mint → gold → rose
  fiveHr:  [[100, 220, 160], [250, 200, 60], [240, 90, 90]],
  // 7d meter: sky blue → amber → rose
  sevenD:  [[110, 180, 250], [250, 190, 60], [240, 90, 90]],
  // Git: purple → pink
  git:     [[160, 140, 220], [244, 114, 182]],
  // Skill: lavender → pink
  skill:   [[179, 157, 219], [249, 168, 212]],
  // Hooks: sage → mint green
  hooks:   [[130, 200, 130], [167, 243, 208]],
  // MCPs: steel blue → light blue
  mcps:    [[120, 160, 210], [147, 197, 253]],
  // Skills: lavender → pink (match single-skill gradient)
  skills:  [[179, 157, 219], [249, 168, 212]],
  // Rules: amber → peach
  rules:   [[210, 160, 90], [250, 200, 140]],
  // CLAUDE.md: Claude orange → warm peach
  claudemd:[[230, 138, 80], [245, 188, 140]],
  // Separator: subtle warm
  sep:     [[80, 70, 90], [100, 80, 110]],
  // Label accents (dim versions of their meter gradients)
  ctxLbl:  [[80, 150, 100], [170, 150, 60]],
  fhLbl:   [[70, 150, 110], [170, 140, 50]],
  sdLbl:   [[80, 130, 180], [170, 140, 50]],
};

// Percentage text color — threshold-based gradient for functional readability
function pctColor(pct) {
  const [r, g, b] = colorAt(GRAD.ctx, Math.min(pct, 100) / 100);
  return rgb(r, g, b);
}

// Gradient separator
const SEP = `  ${rgb(80, 70, 90)}│${R}  `;

// ── Width-aware fitting ──────────────────────────────────────────────────────
// Claude Code sets COLUMNS to the live terminal width before each run (v2.1.153+);
// stdout is captured, so this env var is the only width source available.
const COLS = parseInt(process.env.COLUMNS, 10) || 0;
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const vw = s => stripAnsi(s).length;

// ANSI-aware hard crop to n visible chars — escape codes pass through uncounted.
function cropAnsi(str, n) {
  let out = '', vis = 0, i = 0;
  while (i < str.length && vis < n) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += str[i++]; vis++;
  }
  return out + R;
}

// Join segments with SEP; if the row overflows the terminal, drop segments —
// dropFirst entries in order, then from the right — and hard-crop with … as
// the last resort. Without COLUMNS (old CC), behaves exactly like join(SEP).
function fitRow(segs, dropFirst = []) {
  segs = segs.filter(Boolean);
  if (!segs.length) return '';
  if (COLS > 0) {
    const fits = () => vw(segs.join(SEP)) <= COLS;
    for (const d of dropFirst) {
      if (fits()) break;
      const i = segs.indexOf(d);
      if (i >= 0 && segs.length > 1) segs.splice(i, 1);
    }
    while (!fits() && segs.length > 1) segs.pop();
    const out = segs.join(SEP);
    if (vw(out) > COLS) return cropAnsi(out, Math.max(1, COLS - 1)) + rgb(120, 110, 130) + '…' + R;
    return out;
  }
  return segs.join(SEP);
}

// ── Read stdin ────────────────────────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  try { return JSON.parse(chunks.join('').trim()) || {}; } catch { return {}; }
}

// ── Usage API (5h / 7d) ───────────────────────────────────────────────────────
const HOME = homedir();
const USAGE_CACHE = join(HOME, '.claude', 'statusline-cache', 'usage.json');
const CACHE_TTL = 30_000;

// stale=true returns the cache regardless of age — used as fallback when a live
// fetch fails, so the meters hold their last-known values instead of vanishing.
function readCache(stale = false) {
  try {
    if (!existsSync(USAGE_CACHE)) return null;
    const c = JSON.parse(readFileSync(USAGE_CACHE, 'utf8'));
    if (stale || Date.now() - c.ts < CACHE_TTL) return c.data;
  } catch {}
  return null;
}

function writeCache(data) {
  try {
    mkdirSync(dirname(USAGE_CACHE), { recursive: true });
    writeFileSync(USAGE_CACHE, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

// Tiny file-backed TTL cache for expensive per-run work (dir walks, git
// subprocesses) — keeps the 2s refreshInterval timer cheap.
function ttlCache(name, key, ttlMs, compute) {
  // Normalize path-shaped keys: CC passes cwd with backslashes, other callers
  // may use forward slashes — a spelling mismatch must not bust the cache.
  key = String(key ?? '').replace(/\\/g, '/').toLowerCase();
  const file = join(HOME, '.claude', 'statusline-cache', name + '.json');
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c.key === key && Date.now() - c.ts < ttlMs) return c.data;
  } catch {}
  const data = compute();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ts: Date.now(), key, data }));
  } catch {}
  return data;
}

function getOAuthToken() {
  if (process.platform === 'darwin') {
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const svc = configDir
        ? `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
        : 'Claude Code-credentials';
      const raw = execFileSync('/usr/bin/security',
        ['find-generic-password', '-s', svc, '-w'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }).trim();
      return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
    } catch {}
  }
  try {
    const creds = JSON.parse(readFileSync(join(HOME, '.claude', '.credentials.json'), 'utf8'));
    return creds?.claudeAiOauth?.accessToken ?? creds?.accessToken ?? null;
  } catch {}
  return null;
}

function fetchUsageApi(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      timeout: 6000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) { try { resolve(JSON.parse(d)); } catch { resolve(null); } }
        else resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const toInt = v => (v != null && Number.isFinite(v)) ? Math.round(Math.max(0, Math.min(100, v))) : null;
const toDate = s => s ? new Date(s) : null;

// Claude Code (2.1.x) passes `rate_limits` on stdin — the documented, token-free
// source for the 5h / 7d meters. The OAuth usage endpoint is still consulted
// (cached, 30s) because it is the only place the per-model 7d limit lives; when
// stdin carries rate_limits they win for the two shared meters.
async function getUsage(stdin) {
  const rl = stdin?.rate_limits;
  const native = (rl?.five_hour || rl?.seven_day) ? {
    fiveHour:      toInt(rl.five_hour?.used_percentage),
    sevenDay:      toInt(rl.seven_day?.used_percentage),
    fiveHourReset: rl.five_hour?.resets_at ? new Date(rl.five_hour.resets_at * 1000) : null,
    sevenDayReset: rl.seven_day?.resets_at ? new Date(rl.seven_day.resets_at * 1000) : null,
  } : null;
  const api = await getApiUsage();
  if (!native && !api) return null;
  return { ...(api ?? {}), ...(native ?? {}) };
}

async function getApiUsage() {
  const cached = readCache();
  if (cached) return cached;
  const token = getOAuthToken();
  if (!token) return readCache(true);
  const data = await fetchUsageApi(token);
  if (!data) return readCache(true);
  // The `limits` array is the same data the claude.ai usage tab renders —
  // weekly_all = 7d across all models, weekly_scoped = 7d for one model (Fable).
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const weeklyScoped = limits.find(l => l.kind === 'weekly_scoped' && l.scope?.model);
  const result = {
    fiveHour:      toInt(data.five_hour?.utilization),
    sevenDay:      toInt(data.seven_day?.utilization),
    fiveHourReset: toDate(data.five_hour?.resets_at),
    sevenDayReset: toDate(data.seven_day?.resets_at),
    sevenDayScoped:      toInt(weeklyScoped?.percent),
    sevenDayScopedLabel: weeklyScoped?.scope?.model?.display_name ?? null,
    sevenDayScopedReset: toDate(weeklyScoped?.resets_at),
  };
  writeCache(result);
  return result;
}

// ── Reset countdown ───────────────────────────────────────────────────────────
function resetIn(date) {
  if (!date) return '';
  const ms = date instanceof Date ? date.getTime() - Date.now() : new Date(date).getTime() - Date.now();
  if (ms <= 0) return '';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// ── Git (only if cwd is a git repo) ──────────────────────────────────────────
function getGit(cwd) {
  if (!cwd) return null;
  try {
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1500 }).trim();
    if (!branch || branch === 'HEAD') return null;
    let dirty = false;
    try { execFileSync('git', ['-C', cwd, 'diff', '--quiet'], { timeout: 1000, stdio: 'pipe' }); }
    catch { dirty = true; }
    // Uncommitted diff magnitude vs HEAD (staged + unstaged tracked changes). Untracked
    // files don't show in --numstat; the `*` dirty flag still covers "something changed".
    let added = 0, removed = 0;
    try {
      const ns = execFileSync('git', ['-C', cwd, 'diff', 'HEAD', '--numstat'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1500 }).trim();
      if (ns) for (const line of ns.split('\n')) {
        const [a, r] = line.split('\t');
        if (a && a !== '-' && !Number.isNaN(+a)) added += +a;
        if (r && r !== '-' && !Number.isNaN(+r)) removed += +r;
      }
    } catch {}
    return { label: `${branch}${dirty ? '*' : ''}`, added, removed };
  } catch { return null; }
}

// ── Last skill (from transcript) ──────────────────────────────────────────────
// Reads Claude Code's own `attributionSkill` field off the most recent assistant
// message — the same live signal the harness itself uses to track which skill's
// context is currently in play. Present while a skill is active, absent once its
// influence ends, so this is naturally ephemeral with no staleness math needed.
// Also fires for slash-command-invoked skills (e.g. /powershell-expert), which
// never produce a `Skill` tool_use block — the old block-scanning approach only
// looked for that block shape, which is why slash-invoked skills never showed.
function getLastSkill(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    // Tail-read: transcripts grow to many MB and this runs on every refresh
    // tick, so only the last 128KB is read (the scan only needs ~50 lines).
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - 131072);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(transcriptPath, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }  // partial first line of the tail
      if (entry?.type !== 'assistant') continue;
      return entry.attributionSkill || null;
    }
  } catch {}
  return null;
}

// ── Config counts ─────────────────────────────────────────────────────────────
// Pure-JS walk, not a `find` shellout: execFileSync('/usr/bin/find', …) never
// resolves on native Windows (no shell/PATH translation for a literal POSIX
// path — coreutils' find.exe only resolves via bare-command PATH lookup), so
// this silently returned 0 every time and the skills/rules rows never showed.
// statSync (not lstatSync) so the walk follows symlinks/junctions — e.g. the
// powershell-expert skill is an NTFS junction into ~/.agents/skills, and a
// link-naive walk drops it, same class of bug as the /usr/bin/find one.
// Skips .git internals and temp_git_*/temp_subdir_* scratch clones (leftover
// from ad-hoc repo-vetting fetches under plugins/cache, not real plugins) —
// otherwise their bundled skills/ trees inflate the count with dead content.
function skipScratchDir(name) {
  // node_modules: plugins bundle deps that ship their own SKILL.md (e.g. chrome-devtools-mcp's
  // node_modules/chrome-devtools-frontend/.agents/skills/*, dotenv's skills/*) — not real,
  // loadable Claude skills, they just inflate the count. .git / temp_* are scratch clones.
  return name === '.git' || name === 'node_modules' || /^temp_git_|^temp_subdir_/.test(name);
}

function activePluginPaths(cwd) {
  const norm = p => String(p || '').split(String.fromCharCode(92)).join('/').replace(/[/]$/, '').toLowerCase();
  const here = norm(cwd);
  const paths = new Set();
  try {
    const reg = JSON.parse(readFileSync(join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const plugins = reg.plugins ?? reg;
    for (const rows of Object.values(plugins)) {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (!row?.installPath) continue;
        const scoped = row.scope === 'user' || (row.projectPath && norm(row.projectPath) === here);
        if (scoped && existsSync(row.installPath)) paths.add(row.installPath);
      }
    }
  } catch {}
  return [...paths];
}

function countMatchingFiles(roots, matchFn, maxDepth) {
  let count = 0;
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (skipScratchDir(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (matchFn(entry)) count++;
    }
  }
  for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
  }
  return count;
}

// Sum actual hook *commands* in a settings file — i.e. every runnable handler,
// not the matcher-group count. `hooks` is { Event: [ {matcher, hooks:[...]}, ... ] };
// the old code used the group array's .length, so a SessionStart with one group of
// two commands reported "1". Returns the parsed settings too (for mcpServers reuse).
function sumHookCommands(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    let n = 0;
    for (const groups of Object.values(s?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) n += Array.isArray(g?.hooks) ? g.hooks.length : 0;
    }
    return { hooks: n, settings: s };
  } catch { return { hooks: 0, settings: null }; }
}

// Count CLAUDE.md memory files Claude Code loads for this cwd: the user-global one
// plus every ancestor dir's CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md. Dedup by
// real path so the global (also hit when the walk reaches ~/.claude) isn't double-counted
// and junction/symlinked trees collapse to one entry. Plugin hooks are deliberately not
// counted — the on-disk plugin catalog carries duplicate marketplaces, multiple cached
// versions, and temp_* scratch clones that can't be reliably attributed to "active".
function countClaudeMd(cwd) {
  const seen = new Set();
  const real = (p) => { try { return realpathSync.native(p).toLowerCase(); } catch { return p.toLowerCase(); } };
  const globalPath = join(HOME, '.claude', 'CLAUDE.md');
  const globalReal = existsSync(globalPath) ? real(globalPath) : null;
  let global = 0, project = 0;
  if (globalReal) { seen.add(globalReal); global = 1; }
  let cur = cwd;
  for (let i = 0; cur && i < 12; i++) {
    for (const cand of [join(cur, 'CLAUDE.md'), join(cur, 'CLAUDE.local.md'), join(cur, '.claude', 'CLAUDE.md')]) {
      if (!existsSync(cand)) continue;
      const r = real(cand);
      if (seen.has(r)) continue;   // dedup; also skips the global when the walk hits ~/.claude
      seen.add(r);
      project++;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { total: seen.size, global, project };
}

function getCounts(cwd) {
  const mcpGlobal = new Set();
  const mcpProject = new Set();
  const collectMcp = (settings, set) => {
    if (settings) for (const k of Object.keys(settings?.mcpServers ?? {})) set.add(k);
  };

  // Hooks by scope: global = user (~/.claude); project = project settings + settings.local
  // (both live in the project tree). Sum commands, not matcher groups.
  const user = sumHookCommands(join(HOME, '.claude', 'settings.json'));
  collectMcp(user.settings, mcpGlobal);
  let hooksGlobal = user.hooks;
  let hooksProject = 0;
  if (cwd) {
    for (const f of [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]) {
      const r = sumHookCommands(f);
      hooksProject += r.hooks;
      collectMcp(r.settings, mcpProject);
    }
  }
  const hooks = hooksGlobal + hooksProject;

  // MCP servers by scope: global = ~/.claude.json + user settings; project = project
  // settings + .mcp.json at the repo root. Union deduped; project counts only names
  // not already provided globally.
  try { collectMcp(JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8')), mcpGlobal); } catch {}
  if (cwd) { try { collectMcp(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')), mcpProject); } catch {} }
  const mcpsGlobal = mcpGlobal.size;
  const mcpsProject = [...mcpProject].filter(n => !mcpGlobal.has(n)).length;
  const mcps = mcpsGlobal + mcpsProject;

  // Skills by scope: g = ~/.claude/skills (yours), pl = ACTIVE plugin versions only,
  // p = cwd/.claude/skills. The plugin cache keeps every version ever installed
  // (superpowers x4, ponytail x3, ...) so walking it whole reported 158 "global"
  // skills when 27 were yours and ~43 were loadable plugin skills (2026-08-28).
  // Active = installPath rows in installed_plugins.json whose scope is user, or
  // whose projectPath is this cwd; each path counted once.
  const isSkill = name => name === 'SKILL.md';
  const skillsGlobal = countMatchingFiles([join(HOME, '.claude', 'skills')], isSkill, 8);
  const skillsPlugin = countMatchingFiles(activePluginPaths(cwd), isSkill, 8);
  const skillsProject = cwd ? countMatchingFiles([join(cwd, '.claude', 'skills')], isSkill, 8) : 0;
  const skills = skillsGlobal + skillsPlugin + skillsProject;

  // Rules by scope: .md under ~/.claude/rules (global) + cwd/.claude/rules (project).
  const isMd = name => name.endsWith('.md');
  const rulesGlobal = countMatchingFiles([join(HOME, '.claude', 'rules')], isMd, 4);
  const rulesProject = cwd ? countMatchingFiles([join(cwd, '.claude', 'rules')], isMd, 4) : 0;
  const rules = rulesGlobal + rulesProject;

  const cmd = countClaudeMd(cwd);

  return {
    hooks, hooksGlobal, hooksProject,
    mcps, mcpsGlobal, mcpsProject,
    skills, skillsGlobal, skillsPlugin, skillsProject,
    rules, rulesGlobal, rulesProject,
    claudeMd: cmd.total, claudeMdGlobal: cmd.global, claudeMdProject: cmd.project,
  };
}

// Compact dim scope tag, e.g. "2g·16p" — g = global/user (~/.claude), p = project.
function scopeTag(global, project, plugin) {
  const parts = [];
  if (global)  parts.push(`${global}g`);
  if (plugin)  parts.push(`${plugin}pl`);
  if (project) parts.push(`${project}p`);
  return parts.length ? ` ${rgb(120, 110, 130)}${parts.join('·')}${R}` : '';
}

// ── Path display ──────────────────────────────────────────────────────────────
function showPath(cwd) {
  if (!cwd) return '';
  // Windows hands over backslashes; normalise so the shortening below applies there too.
  cwd = cwd.replace(/\\/g, '/');
  const home = HOME.replace(/\\/g, '/');
  const parts = cwd.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  const last = parts[parts.length - 1];

  // External volume: /Volumes/<name>/… → "<name>:…/<last>"
  // Makes drive-of-origin unambiguous vs internal SSD.
  if (parts[0] === 'Volumes' && parts.length >= 2) {
    const vol = parts[1];
    if (parts.length <= 3) return `${vol}:/${parts.slice(2).join('/')}`;
    return `${vol}:…/${last}`;
  }

  // Internal SSD, under $HOME: "~/…/<last>"
  if (cwd.toLowerCase().startsWith(home.toLowerCase())) {
    const rel = cwd.slice(home.length);
    const homeParts = rel.split('/').filter(Boolean);
    if (homeParts.length <= 2) return '~' + rel;
    return `~/…/${last}`;
  }

  // Everything else — absolute path, truncated.
  if (parts.length <= 2) return '/' + parts.join('/');
  return `/…/${last}`;
}

// ── Model name (suffixed with live effort level, e.g. "Sonnet 5 - Max") ─────
function showModel(stdin) {
  const name = stdin?.model?.display_name ?? stdin?.model?.id ?? '';
  if (!name) return 'Claude';
  const cleaned = name
    .replace(/claude[-\s]/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/sonnet-4-6/i, 'Sonnet 4.6')
    .replace(/opus-4-6/i, 'Opus 4.6')
    .replace(/haiku-4-5/i, 'Haiku 4.5')
    .replace(/\s*\([^)]*\)\s*$/, '')   // strip trailing parenthetical e.g. "(1M context)"
    .trim();
  const level = stdin?.effort?.level;
  const suffix = level ? level.charAt(0).toUpperCase() + level.slice(1) : null;
  return suffix ? `${cleaned} - ${suffix}` : cleaned;
}

// ── Data layer (written by hooks/tool-tracker.mjs) ───────────────────────────
// Same resolution as the hook: CLAUDE_STATUSLINE_DIR, else %TEMP%\claude-statusline
// on Windows, else /tmp/claude-statusline.
const DATA_DIR = process.env.CLAUDE_STATUSLINE_DIR
  || (process.platform === 'win32' ? join(tmpdir(), 'claude-statusline') : '/tmp/claude-statusline');
const TOOL_STALE = 300; // seconds before tool-now is considered stale

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function getActiveTool() {
  const t = readJson(join(DATA_DIR, 'tool-now.json'));
  if (!t || t.status !== 'running') return null;
  const now = Math.floor(Date.now() / 1000);
  if (t.ts && (now - t.ts) > TOOL_STALE) return null;
  return t;
}

function getRunningAgents() {
  const agents = readJson(join(DATA_DIR, 'agents-running.json'));
  return Array.isArray(agents) ? agents.filter(a => a && a.id) : [];
}

function getSession() {
  return readJson(join(DATA_DIR, 'session.json'));
}

// Spinner frames
const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function spinner() { return SPIN[Math.floor(Date.now() / 100) % SPIN.length]; }

// Tool category gradients
const CAT_GRAD = {
  SYS:  [[110, 200, 240], [130, 220, 255]],   // sky
  CMD:  [[240, 180, 120], [255, 200, 150]],    // peach
  AGT:  [[180, 140, 240], [210, 170, 255]],    // mauve
  WEB:  [[78, 201, 201], [130, 240, 255]],     // teal
  MCP:  [[110, 160, 240], [150, 200, 255]],    // sapphire
  SKL:  [[240, 140, 190], [255, 180, 220]],    // pink
  DSC:  [[179, 157, 219], [210, 190, 250]],    // lavender
  TASK: [[240, 210, 100], [255, 230, 140]],    // yellow
  TODO: [[130, 200, 130], [167, 243, 208]],    // green
  NB:   [[240, 200, 190], [255, 220, 210]],    // rosewater
  CRON: [[200, 140, 140], [230, 170, 170]],    // maroon
  OTH:  [[140, 140, 160], [170, 170, 190]],    // overlay
};
const CAT_ICON = {
  SYS: '▸', CMD: '⚡', AGT: '⚙', WEB: '◈', MCP: '⬡', SKL: '◆',
  DSC: '◇', TASK: '▣', TODO: '☑', NB: '▤', CRON: '⏱', OTH: '·',
};

function fmtDur(seconds) {
  if (!seconds || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const stdin = await readStdin();
  const usage = await getUsage(stdin);

  const model   = showModel(stdin);
  const cwd     = stdin?.cwd ?? '';
  const ctxPct  = (() => {
    const native = stdin?.context_window?.used_percentage;
    if (typeof native === 'number' && !Number.isNaN(native)) return Math.round(Math.min(100, Math.max(0, native)));
    const used = (stdin?.context_window?.current_usage?.input_tokens ?? 0)
               + (stdin?.context_window?.current_usage?.cache_creation_input_tokens ?? 0)
               + (stdin?.context_window?.current_usage?.cache_read_input_tokens ?? 0);
    const size = stdin?.context_window?.context_window_size ?? 0;
    return size > 0 ? Math.round(Math.min(100, (used / size) * 100)) : 0;
  })();

  const fiveHourPct  = usage?.fiveHour  ?? 0;
  const sevenDayPct  = usage?.sevenDay  ?? 0;
  const fiveHourLeft = resetIn(usage?.fiveHourReset);
  const sevenDayLeft = resetIn(usage?.sevenDayReset);
  const scopedPct    = usage?.sevenDayScoped ?? null;
  const scopedLabel  = usage?.sevenDayScopedLabel ?? null;

  const git      = ttlCache('git', cwd, 10_000, () => getGit(cwd));
  const skill    = getLastSkill(stdin?.transcript_path ?? '');
  const { hooks, hooksGlobal, hooksProject,
          mcps, mcpsGlobal, mcpsProject,
          skills, skillsGlobal, skillsPlugin, skillsProject,
          rules, rulesGlobal, rulesProject,
          claudeMd, claudeMdGlobal, claudeMdProject } =
    ttlCache('counts', cwd, 300_000, () => getCounts(cwd));

  // ── Row 1: key metrics (named segments so fitRow can drop by priority) ────
  const segModel = gradientBoldText(model, GRAD.model);
  const segPath  = cwd ? gradientText(showPath(cwd), GRAD.path) : null;
  const segCtx   =
    gradientText('ctx:', GRAD.ctxLbl) + ' ' +
    gradientDots(ctxPct, 6, GRAD.ctx) + ' ' +
    pctColor(ctxPct) + ctxPct + '%' + R;

  let seg5h = null, seg7dScoped = null, seg7dAll = null;
  if (usage) {
    const r5 = fiveHourLeft ? `  ${rgb(90, 80, 100)}${fiveHourLeft}${R}` : '';
    seg5h =
      gradientText('5h:', GRAD.fhLbl) + ' ' +
      gradientDots(fiveHourPct, 6, GRAD.fiveHr) + ' ' +
      pctColor(fiveHourPct) + fiveHourPct + '%' + R + r5;

    // 7d per-model quota (e.g. Fable), then 7d all-models — same split as the
    // claude.ai usage tab (weekly_scoped / weekly_all).
    if (scopedPct != null) {
      seg7dScoped =
        gradientText(`7d ${scopedLabel || 'model'}:`, GRAD.sdLbl) + ' ' +
        gradientDots(scopedPct, 6, GRAD.sevenD) + ' ' +
        pctColor(scopedPct) + scopedPct + '%' + R;
    }
    const r7 = sevenDayLeft ? `  ${rgb(90, 80, 100)}${sevenDayLeft}${R}` : '';
    seg7dAll =
      gradientText('7d all:', GRAD.sdLbl) + ' ' +
      gradientDots(sevenDayPct, 6, GRAD.sevenD) + ' ' +
      pctColor(sevenDayPct) + sevenDayPct + '%' + R + r7;
  }

  const row1 = [segModel, segPath, segCtx, seg5h, seg7dScoped, seg7dAll];
  // Narrow terminal: lose path first, then 7d all (the Fable-scoped limit is
  // the active/binding one), then 7d Fable, then 5h; model + ctx survive longest.
  const row1DropOrder = [segPath, seg7dAll, seg7dScoped, seg5h];

  // ── Data layer: active tools + agents ────────────────────────────────────
  const activeTool = getActiveTool();
  const runningAgents = getRunningAgents();
  const session = getSession();
  const nowTs = Math.floor(Date.now() / 1000);

  // ── Row 2: active tool (only when a tool is running) ─────────────────
  let toolRow = null;
  if (activeTool) {
    const cat = activeTool.cat || 'OTH';
    const grad = CAT_GRAD[cat] || CAT_GRAD.OTH;
    const icon = CAT_ICON[cat] || '·';
    const dur = activeTool.ts ? fmtDur(nowTs - activeTool.ts) : '';
    const detail = (activeTool.detail || activeTool.tool || '').slice(0, 40);
    const durStr = dur ? `  ${rgb(90, 80, 100)}${dur}${R}` : '';
    const parts = [
      `${rgb(180, 140, 240)}${spinner()}${R} ` +
      gradientText(`${icon} ${cat}`, grad) + ' ' +
      `${rgb(200, 200, 215)}${detail}${R}` + durStr
    ];
    // Running agents inline with tool
    if (runningAgents.length > 0) {
      const agentStr = runningAgents.slice(0, 3).map(a => {
        const d = a.start_ts ? fmtDur(nowTs - a.start_ts) : '';
        const ds = d ? ` ${rgb(90, 80, 100)}${d}${R}` : '';
        return `${rgb(180, 140, 240)}⚙${R} ${rgb(200, 200, 215)}${a.label || a.type || 'agent'}${R}${ds}`;
      }).join(`  ${rgb(60, 55, 70)}·${R}  `);
      const extra = runningAgents.length > 3 ? ` ${rgb(90, 80, 100)}+${runningAgents.length - 3}${R}` : '';
      parts.push(agentStr + extra);
    }
    toolRow = fitRow(parts);
  }

  // ── Row 3: environment + session stats (always) ────────────────────────
  const rowEnv = [];
  if (git) {
    let g = gradientText(`git:(${git.label})`, GRAD.git);
    if (git.added || git.removed) {
      g += ` ${rgb(130, 200, 130)}+${git.added}${R} ${rgb(240, 100, 90)}-${git.removed}${R}`;
    }
    rowEnv.push(g);
  }
  if (skill) rowEnv.push(gradientText(`skill: ${skill}`, GRAD.skill));
  if (hooks) rowEnv.push(gradientText(`hooks: ${hooks}`, GRAD.hooks) + scopeTag(hooksGlobal, hooksProject));
  if (mcps)  rowEnv.push(gradientText(`mcps: ${mcps}`, GRAD.mcps) + scopeTag(mcpsGlobal, mcpsProject));
  if (skills) rowEnv.push(gradientText(`skills: ${skills}`, GRAD.skills) + scopeTag(skillsGlobal, skillsProject, skillsPlugin));
  if (rules) rowEnv.push(gradientText(`rules: ${rules}`, GRAD.rules) + scopeTag(rulesGlobal, rulesProject));
  if (claudeMd) rowEnv.push(gradientText(`CLAUDE.md: ${claudeMd}`, GRAD.claudemd) + scopeTag(claudeMdGlobal, claudeMdProject));

  // Session stats on the same row as environment
  if (session?.counters) {
    const c = session.counters;
    const statParts = [];
    if (c.success > 0) statParts.push(`${rgb(130, 200, 130)}✓${R}${rgb(200, 200, 215)}${c.success}${R}`);
    if (c.fail > 0) statParts.push(`${rgb(240, 100, 90)}✗${R}${rgb(200, 200, 215)}${c.fail}${R}`);
    if (c.pending > 0) statParts.push(`${rgb(240, 210, 100)}⏳${R}${rgb(200, 200, 215)}${c.pending}${R}`);
    if (statParts.length) rowEnv.push(statParts.join(' '));
  }

  // Running agents on env row when no active tool
  if (!activeTool && runningAgents.length > 0) {
    const agentStr = runningAgents.slice(0, 2).map(a => {
      const label = a.label || a.type || 'agent';
      return `${rgb(180, 140, 240)}⚙${R}${rgb(200, 200, 215)}${label}${R}`;
    }).join(' ');
    const extra = runningAgents.length > 2 ? `${rgb(90, 80, 100)}+${runningAgents.length - 2}${R}` : '';
    rowEnv.push(agentStr + extra);
  }

  // ── Output (every row width-fitted; env row drops from the right) ───────
  console.log(fitRow(row1, row1DropOrder));
  if (toolRow) console.log(toolRow);
  if (rowEnv.length) {
    const env = fitRow(rowEnv);
    if (env) console.log(env);
  }
}

main().catch(() => process.exit(0));
