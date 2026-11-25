export type Phase = "working" | "workers" | "verifying" | "waiting-user" | "between-rounds" | "stopping";
export type LaneState =
	| "reserved" | "waiting" | "running" | "quiet" | "submitted" | "reviewing"
	| "accepted" | "unmet" | "blocked" | "excluded" | "idle";
export type Role = "explorer" | "implementer" | "reviewer" | "quick" | "architect";
/** Milliseconds from run start. `to` absent means the span is still open at `now`. */
export interface LaneSpan { from: number; to?: number; state: LaneState }
export interface PhaseSpan { from: number; to?: number; phase: Phase }
export interface Lane {
	name: string;
	role: Role;
	job?: true;
	dependsOn: readonly string[];
	spans: readonly LaneSpan[];
	/** 0..1, how busy the worker is right now; drives flow speed. */
	activity?: number;
}
export interface RunSnapshot {
	now: number;
	phases: readonly PhaseSpan[];
	/** Offsets at which a new round started; the first is 0. */
	rounds: readonly number[];
	maxRounds?: number;
	lanes: readonly Lane[];
	counts: { accepted: number; inScope: number; excluded: number };
	costUsd: number;
}
export type Tone =
	| "fg" | "dim" | "muted" | "accent" | "bright" | "success" | "warning" | "error"
	| "role1" | "role2" | "role3" | "role4" | "role5";
export interface FrameOptions {
	ascii: boolean;
	motion: boolean;
	maxRows: number;
	/** Wraps text in the colour of a tone; the plain player and the omp demo supply different ones. */
	paint: (tone: Tone, text: string, bold?: boolean) => string;
	/** How a variant that draws its own colours may write them; absent means "tones" (everything goes through `paint`). */
	colour?: "truecolor" | "256" | "tones";
	/** Whether the terminal background is dark; absent means dark. */
	dark?: boolean;
}
/** Every variant exports `frame`: one whole view for the snapshot at animation time `t` (ms), `cols` wide. */
export type Frame = (snapshot: RunSnapshot, cols: number, t: number, options: FrameOptions) => readonly string[];
