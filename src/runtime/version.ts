/** "x.y.z" (prerelease/build suffix ignored) → numbers; undefined when malformed. */
function parseVersion(version: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** The version in the installed package.json when it is newer than the loaded one; otherwise (or malformed) undefined. */
export function newerInstalledVersion(loaded: string, installedPackageJson: string | undefined): string | undefined {
	if (installedPackageJson === undefined) return undefined;
	let installed: unknown;
	try {
		installed = (JSON.parse(installedPackageJson) as { version?: unknown } | null)?.version;
	} catch {
		return undefined;
	}
	if (typeof installed !== "string") return undefined;
	const a = parseVersion(installed);
	const b = parseVersion(loaded);
	if (!a || !b) return undefined;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0) ? installed.trim() : undefined;
	}
	return undefined;
}
