import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const runtimeDir = resolve(process.env.ARCOVIA_LOCAL_RUNTIME_DIR || join(root, "data", "local-runtime"));
const pidPath = join(runtimeDir, "supervisor.pid");
const statePath = join(runtimeDir, "runtime-state.json");

if (!existsSync(pidPath) || !existsSync(statePath)) {
  console.log("Arcovia local runtime is not running.");
  process.exit(1);
}

const pid = Number(readFileSync(pidPath, "utf8").trim());
let running = false;
try {
  process.kill(pid, 0);
  running = true;
} catch {
  running = false;
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
console.log(JSON.stringify({ running, ...state }, null, 2));
process.exit(running ? 0 : 1);
