# claude-statusline

Custom status line for Claude Code (`statusline.mjs`, Node ESM, no dependencies).

## Install

1. Copy `statusline.mjs` to `~/.claude/statusline.mjs`.
2. In `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/statusline.mjs",
  "padding": 0,
  "refreshInterval": 5
}
```

3. Restart Claude Code (or open `/config` once) to reload.

The script keeps a small cache in `~/.claude/statusline-cache/` (git, usage, counts); it is created on first run.
