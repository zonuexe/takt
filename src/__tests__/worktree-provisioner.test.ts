import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockLoadGlobalConfig } = vi.hoisted(() => ({ mockLoadGlobalConfig: vi.fn() }));
vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/global/globalConfig.js')>()),
  loadGlobalConfig: mockLoadGlobalConfig,
}));

import {
  provisionWorktree,
  provisionWorktreeAbortable,
  removeProvisionedWorktree,
} from '../infra/task/worktree-provisioner.js';
import { createSharedClone, createSharedCloneAbortable, removeClone } from '../infra/task/clone.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();

describe('worktree_provisioner (real git)', () => {
  let root: string;
  let project: string;
  let script: string;
  let removeScript: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-wtp-')));
    project = path.join(root, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 't@example.com');
    git(project, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');

    script = path.join(root, 'create.sh');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      'set -e',
      'echo "$TAKT_WORKTREE_MODE $TAKT_WORKTREE_BASE_BRANCH" > "$TAKT_PROJECT_DIR/../provisioner-args"',
      'if [ "$TAKT_WORKTREE_MODE" = existing ]; then',
      '  git worktree add -q "$TAKT_WORKTREE_PATH" "$TAKT_WORKTREE_BRANCH"',
      'else',
      '  git worktree add -q -b "$TAKT_WORKTREE_BRANCH" "$TAKT_WORKTREE_PATH" "$TAKT_WORKTREE_BASE_BRANCH"',
      'fi',
    ].join('\n'), { mode: 0o755 });
    removeScript = path.join(root, 'remove.sh');
    fs.writeFileSync(removeScript, [
      '#!/bin/sh',
      'git -C "$TAKT_WORKTREE_PATH" worktree remove --force "$TAKT_WORKTREE_PATH"',
    ].join('\n'), { mode: 0o755 });
    mockLoadGlobalConfig.mockReturnValue({
      worktreeProvisioner: { create: [script], remove: [removeScript] },
      worktreeDir: path.join(root, 'wts'),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a new branch from the base through the provisioner, then removes it', () => {
    const result = createSharedClone(project, { worktree: true, taskSlug: 'demo' });

    expect(git(result.path, 'symbolic-ref', '--short', 'HEAD')).toBe(result.branch);
    expect(git(result.path, 'rev-parse', '--git-common-dir')).toBe(path.join(project, '.git'));
    expect(fs.readFileSync(path.join(root, 'provisioner-args'), 'utf-8').trim()).toBe('new main');

    removeClone(result.path);
    expect(fs.existsSync(result.path)).toBe(false);
    expect(git(project, 'worktree', 'list', '--porcelain')).not.toContain(result.path);
  });

  it('passes mode=existing for an existing local branch (abortable path)', async () => {
    git(project, 'branch', 'feature/x');

    const result = await createSharedCloneAbortable(project, { worktree: true, branch: 'feature/x', taskSlug: 'x' });

    expect(result.branch).toBe('feature/x');
    expect(git(result.path, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x');
    expect(fs.readFileSync(path.join(root, 'provisioner-args'), 'utf-8').trim()).toBe('existing');
  });

  it('rejects a provisioner that leaves the wrong branch checked out', () => {
    const wrong = path.join(root, 'wrong.sh');
    fs.writeFileSync(wrong, '#!/bin/sh\nset -e\ngit worktree add -q -b other "$TAKT_WORKTREE_PATH" main\n', { mode: 0o755 });

    expect(() => provisionWorktree({ create: [wrong] }, {
      projectDir: project, path: path.join(root, 'w1'), branch: 'wanted', mode: 'new', baseBranch: 'main',
    })).toThrow(/left .* on 'other', expected branch 'wanted'/);
  });

  it('surfaces provisioner stderr when it exits non-zero', async () => {
    const bad = path.join(root, 'bad.sh');
    fs.writeFileSync(bad, '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });
    const request = { projectDir: project, path: path.join(root, 'w2'), branch: 'b', mode: 'new' as const };

    expect(() => provisionWorktree({ create: [bad] }, request)).toThrow(/create failed: boom/);
    await expect(provisionWorktreeAbortable({ create: [bad] }, request)).rejects.toThrow(/create failed: boom/);
  });

  it('removeProvisionedWorktree reports false without a remove command', () => {
    expect(removeProvisionedWorktree({ create: [script] }, path.join(root, 'nope'))).toBe(false);
  });
});
