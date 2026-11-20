import { basename } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Exec } from "./types.ts";

/** The running omp binary, so subcommands share its version and profile (omp exports the profile to child env). */
export function ompBinary(): string {
	const exe = process.execPath;
	return basename(exe).startsWith("omp") ? exe : "omp";
}

export function execPort(pi: ExtensionAPI): Exec {
	return (command, args, options) => pi.exec(command, args, options ?? {});
}
