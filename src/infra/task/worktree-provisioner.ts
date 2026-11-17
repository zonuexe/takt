import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { loadGlobalConfig } from '../config/global/globalConfig.js';
import type { WorktreeProvisionerConfig } from '../../core/models/config-types.js';

const PROVISIONER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface ProvisionRequest {
  readonly projectDir: string;
  readonly path: string;
  readonly branch: string;
  /** `new`: create `branch` from `baseBranch`; `existing`: check out the already-existing `branch`. */
  readonly mode: 'new' | 'existing';
  readonly baseBranch?: string;
}

export function getWorktreeProvisioner(): WorktreeProvisionerConfig | undefined {
  return loadGlobalConfig().worktreeProvisioner;
}

function provisionerEnv(request: ProvisionRequest): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAKT_PROJECT_DIR: request.projectDir,
    TAKT_WORKTREE_PATH: request.path,
    TAKT_WORKTREE_BRANCH: request.branch,
    TAKT_WORKTREE_MODE: request.mode,
    TAKT_WORKTREE_BASE_BRANCH: request.baseBranch ?? '',
  };
}

function splitArgv(argv: readonly string[]): [string, string[]] {
  const [file, ...args] = argv;
  return [file!, args];
}

function describeFailure(action: string, err: unknown): Error {
  const e = err as { stderr?: unknown; message?: string };
  const detail = typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr.trim() : (e.message ?? String(err));
  return new Error(`worktree_provisioner ${action} failed: ${detail}`);
}

/** The provisioner must leave `path` as a work tree whose HEAD is the requested branch. */
function verifyProvisioned(request: ProvisionRequest): void {
  let head: string;
  try {
    head = execFileSync('git', ['-C', request.path, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch (err) {
    throw describeFailure('verification', err);
  }
  if (head !== request.branch) {
    throw new Error(
      `worktree_provisioner create left ${request.path} on '${head}', expected branch '${request.branch}'`,
    );
  }
}

export function provisionWorktree(config: WorktreeProvisionerConfig, request: ProvisionRequest): void {
  const [file, args] = splitArgv(config.create);
  try {
    execFileSync(file, args, {
      cwd: request.projectDir,
      env: provisionerEnv(request),
      stdio: 'pipe',
      timeout: PROVISIONER_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf-8',
    });
  } catch (err) {
    throw describeFailure('create', err);
  }
  verifyProvisioned(request);
}

export async function provisionWorktreeAbortable(
  config: WorktreeProvisionerConfig,
  request: ProvisionRequest,
  abortSignal?: AbortSignal,
): Promise<void> {
  const [file, args] = splitArgv(config.create);
  try {
    await promisify(execFile)(file, args, {
      cwd: request.projectDir,
      env: provisionerEnv(request),
      timeout: PROVISIONER_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf-8',
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    throw describeFailure('create', err);
  }
  verifyProvisioned(request);
}

/** Runs the configured `remove` command; returns false when none is configured (caller deletes the directory). */
export function removeProvisionedWorktree(config: WorktreeProvisionerConfig, clonePath: string): boolean {
  if (!config.remove) return false;
  const [file, args] = splitArgv(config.remove);
  try {
    execFileSync(file, args, {
      env: { ...process.env, TAKT_WORKTREE_PATH: clonePath },
      stdio: 'pipe',
      timeout: PROVISIONER_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf-8',
    });
  } catch (err) {
    throw describeFailure('remove', err);
  }
  return true;
}
