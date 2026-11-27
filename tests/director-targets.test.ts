import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EditSession, EditStore } from "@oh-my-pi/pi-natives";
import { directorTargets, type TargetEnv, type TargetResult } from "../src/policy/director-targets.ts";

/** A work tree, a directory next to it and the links between them, built once on the real file system. */
let base = "";
let root = "";
let outside = "";

beforeAll(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "storm-targets-")));
	root = path.join(base, "tree");
	outside = path.join(base, "elsewhere");
	for (const dir of ["src/deep", "docs", ".git/hooks", ".omp", "sub/.git", ".github", "tail"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	for (const file of ["a.txt", "b.txt", "c.txt", "src/a.ts", "src/b.ts", "src/deep/c.ts", "docs/readme.md", ".git/config", ".gitignore", ".github/ci.yml", "tail/x.txt"]) {
		fs.writeFileSync(path.join(root, file), "one\ntwo\nthree\n");
	}
	fs.writeFileSync(path.join(outside, "secret.txt"), "x\n");
	// A link whose target is inside the tree, one that leaves it, one at a file, one that dangles out of the tree, one into .git.
	fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));
	fs.symlinkSync(outside, path.join(root, "leave"));
	fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
	fs.symlinkSync(path.join(outside, "not-yet.txt"), path.join(root, "dangling.txt"));
	fs.symlinkSync(path.join(root, ".git"), path.join(root, "gitlink"));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const env = (over: Partial<TargetEnv> = {}): TargetEnv => ({ root, cwd: root, ...over });
const targets = (tool: string, input: unknown, over: Partial<TargetEnv> = {}): TargetResult => directorTargets(tool, input, env(over));
const paths = (tool: string, input: unknown, over: Partial<TargetEnv> = {}): string[] | string => {
	const result = targets(tool, input, over);
	return result.ok ? result.paths : result.cause;
};

describe("replace and patch forms", () => {
	test("a replace call names its one path, however it is spelled", () => {
		const call = (p: string) => ({ path: p, old_string: "a", new_string: "b" });
		expect(paths("edit", call("src/a.ts"))).toEqual(["src/a.ts"]);
		expect(paths("edit", call("./src/a.ts"))).toEqual(["src/a.ts"]);
		expect(paths("edit", call(path.join(root, "src/a.ts")))).toEqual(["src/a.ts"]);
		expect(paths("edit", call("src/not-yet.ts"))).toEqual(["src/not-yet.ts"]);
		expect(paths("edit", call("new/dir/f.ts"))).toEqual(["new/dir/f.ts"]);
	});

	test("a relative path resolves against the session's directory, not the root", () => {
		expect(paths("edit", { path: "a.ts", old_string: "a", new_string: "b" }, { cwd: path.join(root, "src") })).toEqual(["src/a.ts"]);
	});

	test("a patch call names its path, and the destination of a rename; a delete names the file it removes", () => {
		expect(paths("edit", { path: "a.txt", edits: [{ op: "update", rename: "z.txt", diff: "@@\n-one\n+1\n" }] })).toEqual(["a.txt", "z.txt"]);
		expect(paths("edit", { path: "c.txt", edits: [{ op: "delete" }] })).toEqual(["c.txt"]);
		expect(paths("edit", { path: "n.txt", edits: [{ op: "create", diff: "x\n" }] })).toEqual(["n.txt"]);
	});

	test("a rename whose destination leaves the tree is refused, not just its source", () => {
		expect(paths("edit", { path: "a.txt", edits: [{ op: "update", rename: "../elsewhere/z.txt", diff: "@@\n-one\n+1\n" }] })).toBe("outside");
	});

	test("a call whose path is missing or not a string names nothing, so it is refused", () => {
		for (const input of [{}, { path: 5, old_string: "a", new_string: "b" }, { path: "", old_string: "a", new_string: "b" }, null, "src/a.ts", []]) {
			expect(paths("edit", input), JSON.stringify(input)).toBe("unknown");
		}
	});
});

describe("hashline, apply_patch, sloppy and magic forms", () => {
	test("hashline sections name every file, including a removed one and the destination of a move", () => {
		const input = "[a.txt#ABCD]\n2:two=2\n[b.txt#EF01]\nREM\n[c.txt#1234]\nMV d.txt\n";
		for (const editMode of [undefined, "hashline"]) {
			expect(paths("edit", { input }, editMode === undefined ? {} : { editMode }), String(editMode)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
		}
	});

	test("an apply_patch envelope names updates, additions, deletions and moves", () => {
		const input = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+1\n*** Add File: n.txt\n+hi\n*** Delete File: b.txt\n*** End Patch";
		for (const [tool, editMode] of [["edit", "apply_patch"], ["edit", undefined], ["apply_patch", undefined]] as const) {
			expect(paths(tool, { input }, editMode === undefined ? {} : { editMode }), `${tool} ${String(editMode)}`).toEqual(["a.txt", "b.txt", "moved.txt", "n.txt"]);
		}
	});

	test("magic mode names the files its sections are headed with; the model call itself is not refused here", () => {
		expect(paths("edit", { input: "# src/a.ts\nrename foo to bar\n# docs/readme.md\nadd a note" }, { editMode: "magic" })).toEqual(["docs/readme.md", "src/a.ts"]);
		// Without the mode every parser reads it: the sections are still found.
		expect(paths("edit", { input: "# src/a.ts\nrename foo to bar" })).toEqual(["src/a.ts"]);
	});

	test("a payload no parser reads is refused: the guess would be a writer the table cannot see", () => {
		for (const [input, editMode] of [["garbage", "hashline"], ["garbage", undefined], ["@a.txt\n2:two=2\n", "hashline"], ["*** Begin Patch\n*** End Patch", "apply_patch"], ["", undefined]] as const) {
			expect(paths("edit", { input }, editMode === undefined ? {} : { editMode }), `${input}/${String(editMode)}`).toBe("unknown");
		}
	});

	test("a mode that reads the payload another way does not hide a file the real grammar writes", () => {
		// Told it is hashline, an apply_patch envelope parses to nothing: refused, never read as the other grammar.
		expect(paths("edit", { input: "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** End Patch" }, { editMode: "hashline" })).toBe("unknown");
	});

	test("a section naming a path outside the tree is refused whichever section it is", () => {
		expect(paths("edit", { input: "[a.txt#ABCD]\n2:two=2\n[../elsewhere/secret.txt#EF01]\nREM\n" })).toBe("outside");
	});
});

describe("write", () => {
	const write = (p: unknown) => ({ path: p, content: "x" });

	test("a plain path is its own target, with the hashline wrapper peeled as omp peels it", () => {
		expect(paths("write", write("docs/new.md"))).toEqual(["docs/new.md"]);
		expect(paths("write", write("[docs/readme.md#ABCD]"))).toEqual(["docs/readme.md"]);
	});

	test("an address, a selector, a home prefix or a list is not a plain project path", () => {
		for (const [p, cause] of [
			["ssh://host/etc/x", "address"],
			["xd://edit/a.txt", "address"],
			["conflict://1", "address"],
			["vault://notes/x.md", "address"],
			["local://notes.md", "address"],
			["[ssh://host/x#ABCD]", "address"],
			["ssh:/host/x", "address"],
			["archive.zip:inner/file.txt", "unknown"],
			["a.txt:1-5", "unknown"],
			["db.sqlite3:table:1", "unknown"],
			["~/a.txt", "unknown"],
			["@a.txt", "unknown"],
			["a\\b.txt", "unknown"],
			[" a.txt", "unknown"],
			["a\nb.txt", "unknown"],
			["a b.txt", "unknown"],
			["", "unknown"],
			[`a${String.fromCharCode(0xa0)}b.txt`, "unknown"],
			[`a${String.fromCharCode(0x2028)}b.txt`, "unknown"],
			[7, "unknown"],
		] as const) {
			expect(paths("write", write(p)), String(p)).toBe(cause);
		}
	});

	test("a colon in the middle of a path is refused: omp may read it as an archive entry or a database row", () => {
		expect(paths("write", write("dir/a:b.txt"))).toBe("unknown");
	});
});

describe("ast_edit", () => {
	const ast = (...p: unknown[]) => ({ ops: [{ pat: "a", out: "b" }], paths: p });

	test("a file is its own scope and a directory is its own scope", () => {
		expect(paths("ast_edit", ast("src/a.ts"))).toEqual(["src/a.ts"]);
		expect(paths("ast_edit", ast("src"))).toEqual(["src"]);
		expect(paths("ast_edit", ast("src/", "docs"))).toEqual(["docs", "src"]);
	});

	test("a glob is the directory it starts in; a bare glob is the whole tree", () => {
		expect(paths("ast_edit", ast("src/**/*.ts"))).toEqual(["src"]);
		expect(paths("ast_edit", ast("src/deep/*.ts"))).toEqual(["src/deep"]);
		expect(paths("ast_edit", ast("src/{a,b}.ts"))).toEqual(["src"]);
		expect(paths("ast_edit", ast("**/*.ts"))).toEqual(["."]);
		expect(paths("ast_edit", ast("*.ts"))).toEqual(["."]);
		expect(paths("ast_edit", ast("src/**/*.ts", "docs/readme.md"))).toEqual(["docs/readme.md", "src"]);
	});

	test("an entry omp may split into several paths is refused: which files it means depends on the disk", () => {
		for (const entry of ["src/a.ts,src/b.ts", "src/a.ts;docs", "src/a.ts docs/readme.md", "src/a.ts\tdocs"]) {
			expect(paths("ast_edit", ast(entry)), entry).toBe("unknown");
		}
	});

	test("no paths, a non-string entry, an address or a glob that walks upward is refused", () => {
		expect(paths("ast_edit", { ops: [] })).toBe("unknown");
		expect(paths("ast_edit", ast())).toBe("unknown");
		expect(paths("ast_edit", ast(5))).toBe("unknown");
		expect(paths("ast_edit", ast("   "))).toBe("unknown");
		expect(paths("ast_edit", ast("src/**/../../*.ts"))).toBe("unknown");
		expect(paths("ast_edit", ast("local://x/*.md"))).toBe("address");
		expect(paths("ast_edit", ast("ssh://host/src"))).toBe("address");
	});

	test("one entry outside the tree refuses the call", () => {
		expect(paths("ast_edit", ast("src/a.ts", "/etc"))).toBe("outside");
		expect(paths("ast_edit", ast("../elsewhere/*.txt"))).toBe("outside");
		expect(paths("ast_edit", ast("leave/*.txt"))).toBe("outside");
	});
});

describe("where a target resolves", () => {
	const edit = (p: string) => ({ path: p, old_string: "a", new_string: "b" });

	test("outside the tree is refused, and the refusal names the path", () => {
		for (const p of ["/etc/passwd", "../elsewhere/secret.txt", `${outside}/new.txt`, "src/../../elsewhere/x.txt", "../../x"]) {
			const result = targets("edit", edit(p));
			expect(result.ok, p).toBe(false);
			if (!result.ok) {
				expect(result.cause, p).toBe("outside");
				expect(result.path, p).toBe(p);
			}
		}
		expect(paths("edit", edit(root))).toEqual(["."]);
		// A sibling whose name starts with the root's name is not inside it.
		fs.mkdirSync(`${root}-twin`, { recursive: true });
		expect(paths("edit", edit(`${root}-twin/x.txt`))).toBe("outside");
	});

	test("a link whose parent leaves the tree is refused, existing file or not", () => {
		expect(paths("edit", edit("leave/secret.txt"))).toBe("outside");
		expect(paths("edit", edit("leave/new.txt"))).toBe("outside");
		expect(paths("write", { path: "leave/deeper/new.txt", content: "x" })).toBe("outside");
		expect(paths("edit", { path: "a.txt", edits: [{ op: "update", rename: "leave/z.txt", diff: "@@\n-one\n+1\n" }] })).toBe("outside");
	});

	test("a file that is itself a link out of the tree is refused, and so is one that dangles", () => {
		expect(paths("edit", edit("leak.txt"))).toBe("outside");
		// Writing a dangling link creates its target wherever it points: not nameable.
		expect(paths("write", { path: "dangling.txt", content: "x" })).toBe("unknown");
	});

	test("a link inside the tree names the real file, which is the name a lane's file list is turned into", () => {
		expect(paths("edit", edit("alias/a.ts"))).toEqual(["src/a.ts"]);
		expect(paths("edit", edit("alias/not-yet.ts"))).toEqual(["src/not-yet.ts"]);
		expect(paths("ast_edit", { ops: [], paths: ["alias/**/*.ts"] })).toEqual(["src"]);
	});

	test("under .git or .omp, at any depth and in any case, or through a link to one, is refused; names that merely start with them pass", () => {
		for (const p of [".git/config", ".git/hooks/pre-commit", ".omp/settings.json", ".GIT/config", "sub/.git/config", "gitlink/config", "src/../.git/config", ".git"]) {
			expect(paths("edit", edit(p)), p).toBe("internal");
		}
		expect(paths("write", { path: ".omp/x", content: "x" })).toBe("internal");
		expect(paths("ast_edit", { ops: [], paths: [".git/**"] })).toBe("internal");
		expect(paths("edit", edit(".gitignore"))).toEqual([".gitignore"]);
		expect(paths("edit", edit(".github/ci.yml"))).toEqual([".github/ci.yml"]);
		expect(paths("edit", edit("src/git.ts"))).toEqual(["src/git.ts"]);
	});

	test("a path with .. is named by what the file system makes of it, or refused when that cannot be read", () => {
		expect(paths("edit", edit("src/../a.txt"))).toEqual(["a.txt"]);
		expect(paths("edit", edit("src/deep/../b.ts"))).toEqual(["src/b.ts"]);
		expect(paths("edit", edit("src/missing/../x.ts"))).toBe("unknown");
	});

	test("a root that cannot be resolved names nothing", () => {
		expect(directorTargets("edit", edit("a.txt"), { root: path.join(base, "no-such-root"), cwd: root }).ok).toBe(false);
	});

	test("the real path comes from the caller's function when one is given", () => {
		const seen: string[] = [];
		const result = directorTargets("edit", edit("a.txt"), {
			root,
			cwd: root,
			realpath: target => {
				seen.push(target);
				return fs.realpathSync(target);
			},
		});
		expect(result).toEqual({ ok: true, paths: ["a.txt"] });
		expect(seen.length).toBeGreaterThan(0);
	});
});

describe("who made the call, and which tool", () => {
	test("a call that another tool dispatched is refused whatever its paths are", () => {
		const result = targets("edit", { path: "a.txt", old_string: "a", new_string: "b" }, { parentToolCallId: "call-eval-1" });
		expect(result).toEqual({ ok: false, cause: "dispatched" });
		expect(paths("write", { path: "a.txt", content: "x" }, { parentToolCallId: "" })).toBe("dispatched");
		expect(paths("ast_edit", { ops: [], paths: ["src"] }, { parentToolCallId: "x" })).toBe("dispatched");
	});

	test("a tool that is not one Storm can read the targets of is refused", () => {
		for (const tool of ["multi_edit", "notebook_edit", "bash", "read", "eval", "constructor"]) {
			expect(paths(tool, { path: "a.txt", edits: [] }), tool).toBe("unknown");
		}
	});

	test("the answer is sorted and has no repeats", () => {
		expect(paths("edit", { input: "[b.txt#AAAA]\nREM\n[a.txt#BBBB]\nREM\n[b.txt#AAAA]\nREM\n" })).toEqual(["a.txt", "b.txt"]);
	});
});

describe("what the native edit session writes is inside what was named", () => {
	/** Runs the host's own edit engine on a payload against a copy of the tree and returns the files it asked the host to write. */
	async function written(mode: string, args: unknown, store = new EditStore()): Promise<string[]> {
		const policy = {
			cwd: root,
			mode,
			allowFuzzy: true,
			fuzzyThreshold: 0.9,
			enforceSeenLines: false,
			maxColumns: 0,
			blockAutoGenerated: false,
			planActive: false,
			urlSchemes: ["local", "agent"],
			urlAliasSchemes: [],
			planWritableRoots: [],
			homeDir: os.homedir(),
			rawInput: false,
		};
		const session = new EditSession(store, policy, undefined, async () => ({ error: "no", planWritable: false }));
		session.setArgsJson(JSON.stringify(args));
		session.finish();
		const out: string[] = [];
		await session.apply({ lspFlush: false }, async (_error, request) => {
			// Nothing is written to disk: the writer only records what the engine asked for.
			out.push(request.path);
			if (request.moveTo !== undefined) out.push(request.moveTo);
			return { written: request.content ?? "" };
		});
		session.close();
		return out.map(file => path.relative(root, file).split(path.sep).join("/"));
	}

	const store = (): { store: EditStore; tag: (file: string) => string } => {
		const s = new EditStore();
		return { store: s, tag: file => s.recordSnapshotFile(path.join(root, file)) ?? "0000" };
	};

	test("replace, patch, hashline and apply_patch payloads: every file the engine writes was named", async () => {
		const { store: s, tag } = store();
		const cases: Array<[string, string, Record<string, unknown>, EditStore?]> = [
			["replace", "edit", { path: "./src/a.ts", old_string: "two", new_string: "2" }],
			["replace", "edit", { path: "src/../a.txt", old_string: "two", new_string: "2" }],
			["patch", "edit", { path: "a.txt", edits: [{ op: "update", rename: "z.txt", diff: "@@\n-two\n+2\n" }] }],
			["patch", "edit", { path: "b.txt", edits: [{ op: "delete" }] }],
			["apply_patch", "edit", { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+2\n*** Add File: n.txt\n+hi\n*** Delete File: c.txt\n*** End Patch" }],
			["apply_patch", "edit", { input: "*** Begin Patch\n*** Update File: src/b.ts\n*** Move to: src/moved.ts\n@@\n-two\n+2\n*** End Patch" }],
			["hashline", "edit", { input: `[a.txt#${tag("a.txt")}]\n2:two=2\n[b.txt#${tag("b.txt")}]\nREM\n` }, s],
			["hashline", "edit", { input: `[c.txt#${tag("c.txt")}]\nMV moved-c.txt\n` }, s],
		];
		for (const [mode, tool, args, withStore] of cases) {
			const named = targets(tool, args, { editMode: mode });
			expect(named.ok, JSON.stringify(args)).toBe(true);
			if (!named.ok) continue;
			const wrote = await written(mode, args, withStore ?? new EditStore());
			// A call the engine refuses would write nothing and prove nothing.
			expect(wrote.length, JSON.stringify(args)).toBeGreaterThan(0);
			for (const file of wrote) {
				expect(
					named.paths.some(scope => scope === "." || file === scope || file.startsWith(`${scope}/`)),
					`${mode} ${JSON.stringify(args).slice(0, 60)}: the engine wrote ${file}, named ${named.paths.join(", ")}`,
				).toBe(true);
			}
		}
	});
});
