/**
 * Claude Code encodes a workspace's absolute path into its
 * ~/.claude/projects/<encoded>/ directory name.
 *
 * The upstream bug: it encoded with `replace(/\//g, '-')` — slashes only.
 * Claude Code also replaces '.' and '_'. Any path containing either (e.g.
 * `claude_context_monitor`, or a worktree path with `/.claude/`) computes
 * the wrong directory, finds nothing, and falls back to scanning *every*
 * project directory and picking whichever was touched most recently — so
 * the status bar can silently show a different project's usage entirely.
 *
 * Verified against real directories on this machine:
 *   /Users/x/progs/claude_context_monitor
 *     -> -Users-x-progs-claude-context-monitor
 *   /Users/x/progs/Foo/.claude/worktrees/bar-2fa2e0
 *     -> -Users-x-progs-Foo--claude-worktrees-bar-2fa2e0
 */
export function encodeProjectDirName(absPath: string): string {
  return absPath.replace(/[/._]/g, '-');
}

/**
 * Best-effort verification that a chosen project directory actually
 * corresponds to the intended workspace path, by comparing against the
 * `cwd` field Claude Code stamps on every transcript record. This is the
 * authoritative check — it doesn't depend on guessing the encoding scheme
 * correctly, so it stays correct even if Claude Code's encoding changes
 * again in the future.
 */
export function cwdMatchesWorkspace(recordCwd: string | null, workspacePath: string): boolean {
  if (!recordCwd) return false;
  // The record's cwd may be a subdirectory (e.g. a worktree) of the
  // workspace root, or vice versa — accept either direction.
  const a = normalize(recordCwd);
  const b = normalize(workspacePath);
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '');
}
