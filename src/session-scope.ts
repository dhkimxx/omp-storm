/**
 * Where one native OMP main session keeps its Storm data inside a profile, and the guard that keeps writes there.
 *
 * Everything Storm persists for a session lives below this directory: its team config, approvals, run state and
 * history. The directory is derived only from the profile's agent dir and the host's opaque session id, never from
 * the target worktree, cwd or a session file path: two sessions started in the same checkout are independent, and
 * resuming the exact same native id opens the same data again. Because the id is hashed, a caller cannot supply a
 * path (or escape the profile) through it, and that directory is the only place Storm writes its own state.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "./config/canonical.ts";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SESSION_NAME = /^[0-9a-f]{64}$/;
/** Managed children of a session store whose existing symlinks must not leave it. */
const MANAGED_CHILDREN = ["config.json", "auto-delegation.json", "approvals", "state"] as const;

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * `<profile agentDir>/storm/sessions/<full sha256(utf8 sessionId)>`.
 *
 * The id is opaque and hashed whole, so the result is stable for a resume of the same native session and distinct
 * for a new session or fork. There is deliberately no parameter for an existing directory: callers cannot redirect
 * the store to the target or to an arbitrary path. The host must supply an absolute profile path; a relative one
 * would silently put state under the process cwd.
 */
export function sessionStoreDir(agentDir: string, sessionId: string): string {
	if (typeof agentDir !== "string" || agentDir.trim() === "" || CONTROL_CHARS.test(agentDir)) {
		throw new Error("에이전트 디렉터리가 없거나 올바르지 않습니다");
	}
	if (!path.isAbsolute(agentDir)) throw new Error("에이전트 디렉터리는 절대 경로여야 합니다");
	if (typeof sessionId !== "string" || sessionId.trim() === "" || CONTROL_CHARS.test(sessionId)) {
		throw new Error("세션 id가 없거나 올바르지 않습니다");
	}
	return path.join(agentDir, "storm", "sessions", sha256Hex(sessionId));
}

/**
 * `<sessionStoreDir>/state`: the run records, proposals and other working state of this native session. Runtime
 * persistence takes this directory, never the target worktree.
 */
export function sessionStateDir(sessionDir: string): string {
	if (typeof sessionDir !== "string" || sessionDir.trim() === "" || CONTROL_CHARS.test(sessionDir)) {
		throw new Error("세션 디렉터리가 없거나 올바르지 않습니다");
	}
	if (!path.isAbsolute(sessionDir)) throw new Error("세션 디렉터리는 절대 경로여야 합니다");
	return path.join(sessionDir, "state");
}

/** Whether `child` is `parent` itself or below it, compared on physical paths. */
function isWithin(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + path.sep);
}

/** The physical location of an existing managed path; undefined when no ordinary component exists. */
async function resolvedIfExists(target: string): Promise<string | undefined> {
	try {
		return await realpath(target);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw new Error("세션 저장소의 관리 경로를 안전하게 확인할 수 없습니다");
		const exists = await lstat(target).then(
			() => true,
			(e: unknown) => {
				if (errorCode(e) === "ENOENT") return false;
				throw new Error("세션 저장소의 관리 경로를 안전하게 확인할 수 없습니다");
			},
		);
		if (exists) throw new Error("세션 저장소의 관리 경로에 확인할 수 없는 연결이 있습니다");
		return undefined;
	}
}

/**
 * The physical location of `target`, following every symlink that exists and appending the not-yet-created tail.
 * A dangling symlink (or any path that exists but cannot be resolved) is unsafe: writing through it later could
 * land anywhere. Only ordinary components are allowed to be missing.
 */
async function physicalPath(target: string): Promise<string> {
	let current = path.resolve(target);
	const tail: string[] = [];
	for (;;) {
		try {
			const resolved = await realpath(current);
			return tail.length === 0 ? resolved : path.join(resolved, ...tail);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw new Error("세션 저장소 경로의 연결을 안전하게 확인할 수 없습니다");
			const exists = await lstat(current).then(
				() => true,
				(e: unknown) => {
					if (errorCode(e) === "ENOENT") return false;
					throw new Error("세션 저장소 경로의 연결을 안전하게 확인할 수 없습니다");
				},
			);
			if (exists) throw new Error("세션 저장소 경로에 확인할 수 없는 연결이 있습니다");
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * The physical session root after proving its lexical shape and that it resolves to this profile and session name.
 * A correctly symlinked profile is resolved; a session directory redirected to another session or outside the
 * profile fails here. It creates nothing.
 */
async function physicalSessionRoot(sessionDir: string): Promise<string> {
	if (typeof sessionDir !== "string" || !path.isAbsolute(sessionDir)) {
		throw new Error("세션 저장소는 절대 경로여야 합니다");
	}
	const name = path.basename(sessionDir);
	const sessions = path.dirname(sessionDir);
	const storm = path.dirname(sessions);
	const profile = path.dirname(storm);
	if (!SESSION_NAME.test(name) || path.basename(sessions) !== "sessions" || path.basename(storm) !== "storm") {
		throw new Error("세션 저장소 경로가 프로필의 storm/sessions/<id> 형식이 아닙니다");
	}

	const profileStat = await stat(profile).catch((error: unknown) => {
		if (errorCode(error) === "ENOENT") return undefined;
		throw new Error("프로필 경로를 안전하게 확인할 수 없습니다");
	});
	if (profileStat !== undefined && !profileStat.isDirectory()) throw new Error("프로필 경로가 디렉터리가 아닙니다");

	const [physicalSession, physicalProfile] = await Promise.all([physicalPath(sessionDir), physicalPath(profile)]);
	const expected = path.join(physicalProfile, "storm", "sessions", name);
	if (physicalSession !== expected) {
		throw new Error("세션 저장소가 이 프로필의 올바른 위치 밖이나 다른 세션으로 연결되어 있습니다. 프로필의 실제 경로와 세션 id를 확인하세요");
	}
	return physicalSession;
}

/**
 * Fails closed before Storm reads or writes a managed session store whose physical location is not the one this
 * profile and session id name, or which lies inside the target checkout. The check is deliberately small: the
 * session directory, its profile, and the store's managed children; it never scans the disk.
 *
 * A correctly placed profile may itself be a symlink (for example a user-home profile linked to another disk):
 * resolution happens before the boundary comparison. A session directory or managed child that redirects to another
 * session or outside the profile, a legacy profile path that aliases the target's `.omp/storm`, and a store under the
 * checkout are refused. A missing store is safe for reads and for the first write that will create it.
 */
export async function assertSessionStoreSafe(
	sessionDir: string,
	targetRoot?: string,
	managed: readonly string[] = [],
): Promise<void> {
	if (typeof targetRoot === "string" && !path.isAbsolute(targetRoot)) {
		throw new Error("대상 작업 트리는 절대 경로여야 합니다");
	}
	const physicalSession = await physicalSessionRoot(sessionDir);

	const target = targetRoot === undefined ? undefined : await physicalPath(targetRoot);
	if (target !== undefined && isWithin(physicalSession, target)) {
		throw new Error("세션 저장소가 작업 트리 안에 있습니다. 작업 트리 밖의 프로필을 쓰도록 에이전트 디렉터리를 확인하세요");
	}

	const sessionStat = await lstat(sessionDir).catch((error: unknown) => {
		if (errorCode(error) === "ENOENT") return undefined;
		throw new Error("세션 저장소 경로를 안전하게 확인할 수 없습니다");
	});
	if (sessionStat !== undefined && !sessionStat.isDirectory()) throw new Error("세션 저장소 경로가 디렉터리가 아닙니다");

	for (const file of [...MANAGED_CHILDREN.map(child => path.join(sessionDir, child)), ...managed]) {
		const resolved = await resolvedIfExists(file);
		if (resolved === undefined) continue;
		if (!isWithin(resolved, physicalSession)) {
			throw new Error("세션 저장소의 관리 파일이 다른 세션/프로필 밖으로 연결되어 있습니다");
		}
		if (target !== undefined && isWithin(resolved, target)) {
			throw new Error("세션 저장소의 관리 파일이 작업 트리 안을 가리킵니다");
		}
	}
}

/**
 * Fails closed before a known managed file or record directory inside one session store is read or written. The
 * minimal check resolves only the target path's existing ancestors: a pre-existing nested symlink (for example
 * `<session>/state/runs` pointing at an old worktree or another session) is refused because its physical location is
 * not below this session's physical root. Missing paths with safe ancestors are allowed for the first write; no
 * recursive scan is done and an ordinary private profile pays only a few realpath calls.
 */
export async function assertSessionPathSafe(sessionDir: string, managedPath: string): Promise<void> {
	if (typeof managedPath !== "string" || !path.isAbsolute(managedPath)) {
		throw new Error("관리 경로는 절대 경로여야 합니다");
	}
	const physicalSession = await physicalSessionRoot(sessionDir);
	const lexicalSession = path.resolve(sessionDir);
	if (!isWithin(path.resolve(managedPath), lexicalSession)) {
		throw new Error("관리 경로가 세션 저장소 밖을 가리킵니다");
	}
	const physical = await physicalPath(managedPath);
	if (!isWithin(physical, physicalSession)) {
		throw new Error("세션 저장소의 관리 경로가 다른 세션/프로필 밖이나 작업 트리로 연결되어 있습니다");
	}
}
