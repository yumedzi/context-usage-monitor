import { describe, expect, it } from 'vitest';
import { encodeProjectDirName, cwdMatchesWorkspace } from '../src/core/workspace';

describe('encodeProjectDirName (RC3)', () => {
  it('replaces slashes, dots, and underscores alike', () => {
    expect(encodeProjectDirName('/Users/x/progs/claude_context_monitor')).toBe('-Users-x-progs-claude-context-monitor');
  });

  it('matches the real on-disk directory name for a dotted worktree path', () => {
    expect(encodeProjectDirName('/Users/x/progs/Foo/.claude/worktrees/bar-2fa2e0')).toBe(
      '-Users-x-progs-Foo--claude-worktrees-bar-2fa2e0',
    );
  });

  it('would have produced the upstream (buggy) result if only slashes were replaced', () => {
    const upstreamBuggy = '/Users/x/progs/claude_context_monitor'.replace(/\//g, '-');
    expect(upstreamBuggy).not.toBe(encodeProjectDirName('/Users/x/progs/claude_context_monitor'));
  });
});

describe('cwdMatchesWorkspace', () => {
  it('matches identical paths', () => {
    expect(cwdMatchesWorkspace('/Users/x/progs/demo', '/Users/x/progs/demo')).toBe(true);
  });

  it('matches a subdirectory (e.g. worktree) of the workspace root', () => {
    expect(cwdMatchesWorkspace('/Users/x/progs/demo/.claude/worktrees/w1', '/Users/x/progs/demo')).toBe(true);
  });

  it('matches when the workspace is a subdirectory of the recorded cwd', () => {
    expect(cwdMatchesWorkspace('/Users/x/progs', '/Users/x/progs/demo')).toBe(true);
  });

  it('rejects an unrelated path', () => {
    expect(cwdMatchesWorkspace('/Users/x/progs/other', '/Users/x/progs/demo')).toBe(false);
  });

  it('rejects a null cwd', () => {
    expect(cwdMatchesWorkspace(null, '/Users/x/progs/demo')).toBe(false);
  });

  it('ignores a trailing slash on either side', () => {
    expect(cwdMatchesWorkspace('/Users/x/progs/demo/', '/Users/x/progs/demo')).toBe(true);
  });
});
