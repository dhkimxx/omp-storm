/** A throwaway omp stats DB for tests of the usage reader and of what reads through it. */
import { Database } from "bun:sqlite";

export interface Msg {
	provider?: string;
	model?: string;
	agent_type?: string | null;
	purpose?: string | null;
	timestamp: number;
	duration?: number | null;
	ttft?: number | null;
	stop_reason?: string;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cost_total?: number;
	cost_unpriced?: number;
}

const TEXT = ["provider", "model", "agent_type", "purpose", "stop_reason"];
const REAL = [
	"timestamp",
	"duration",
	"ttft",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cost_total",
	"cost_unpriced",
];

/** Creates the `messages` table omp writes, without the columns in `omit`. */
export function createStatsDb(path: string, omit: string[] = []): Database {
	const cols = [
		"id INTEGER PRIMARY KEY AUTOINCREMENT",
		"entry_id TEXT NOT NULL",
		...TEXT.filter((c) => !omit.includes(c)).map((c) => `${c} TEXT`),
		...REAL.filter((c) => !omit.includes(c)).map((c) => `${c} REAL`),
	];
	const db = new Database(path, { create: true });
	db.run(`CREATE TABLE messages (${cols.join(", ")})`);
	return db;
}

let seq = 0;

export function insertMessage(db: Database, m: Msg): void {
	const row = {
		entry_id: `e${++seq}`,
		provider: "anthropic",
		model: "claude-a",
		agent_type: "main",
		purpose: null,
		duration: null,
		ttft: null,
		stop_reason: "stop",
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		cost_total: 0,
		cost_unpriced: 0,
		...m,
	};
	const keys = Object.keys(row);
	db.query(`INSERT INTO messages (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
		...(Object.values(row) as (string | number | null)[]),
	);
}
