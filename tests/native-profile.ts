import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";

// Native agent discovery reads the live profile and marketplace roots, even for a fake session.
const home = mkdtempSync(join(tmpdir(), "storm-test-home-"));
process.env.HOME = home;
setAgentDir(join(home, "agent"));
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
