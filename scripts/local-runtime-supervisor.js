import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(process.env.ARCOVIA_LOCAL_RUNTIME_DIR || join(root, "data", "local-runtime"));
const pidPath = join(runtimeDir, "supervisor.pid");
const statePath = join(runtimeDir, "runtime-state.json");
const node = process.execPath;
const cloudflared = process.env.CLOUDFLARED_EXE || "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const localBaseUrl = (process.env.ARCOVIA_LOCAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");
const children = new Map();
let stopping = false;

mkdirSync(runtimeDir, { recursive: true });
refuseDuplicateSupervisor();
writeFileSync(pidPath, String(process.pid), "utf8");
backupLocalData();
writeState();

startManaged("server", node, ["src/server.js"], process.env);
startManaged("worker", node, ["scripts/local-codex-worker.js"], {
  ...process.env,
  PUBLIC_BASE_URL: localBaseUrl,
  LOCAL_CODEX_WORKER_ENABLED: "true"
});

if (tunnelConfigured()) {
  startManaged("tunnel", cloudflared, tunnelArgs(), process.env);
} else {
  log("supervisor", "Cloudflare tunnel is not configured yet. The local server and sourcing agents are still running.");
}

const stateTimer = setInterval(writeState, 15000);
stateTimer.unref();
const backupTimer = setInterval(backupLocalData, 6 * 60 * 60 * 1000);
backupTimer.unref();

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
process.on("exit", cleanupFiles);

log("supervisor", `Arcovia local runtime started. Local API: ${localBaseUrl}`);

function startManaged(name, command, args, env) {
  if (!existsSync(command) && command !== node) {
    log(name, `Executable not found: ${command}`);
    return;
  }

  const logFd = openLog(name);
  let child;
  try {
    child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }
  children.set(name, child);
  log(name, `started with PID ${child.pid}`);
  writeState();

  child.on("exit", (code, signal) => {
    children.delete(name);
    log(name, `exited (code=${code ?? "none"}, signal=${signal ?? "none"})`);
    writeState();
    if (!stopping) {
      setTimeout(() => startManaged(name, command, args, env), 10000).unref();
    }
  });
}

function tunnelConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_TUNNEL_TOKEN
    || process.env.CLOUDFLARE_TUNNEL_NAME
    || process.env.CLOUDFLARE_TUNNEL_CONFIG
  );
}

function tunnelArgs() {
  if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    return ["tunnel", "run", "--url", localBaseUrl, "--token", process.env.CLOUDFLARE_TUNNEL_TOKEN];
  }
  const args = ["tunnel"];
  if (process.env.CLOUDFLARE_TUNNEL_CONFIG) {
    args.push("--config", process.env.CLOUDFLARE_TUNNEL_CONFIG);
  }
  args.push("run", process.env.CLOUDFLARE_TUNNEL_NAME || "arcovia-sourcing");
  return args;
}

function openLog(name) {
  return openSync(join(runtimeDir, `${name}.log`), "a");
}

function log(name, message) {
  const line = `[${new Date().toISOString()}] [${name}] ${message}`;
  process.stdout.write(`${line}\n`);
  writeFileSync(join(runtimeDir, "supervisor.log"), `${line}\n`, { flag: "a" });
}

function writeState() {
  const services = {};
  for (const [name, child] of children) {
    services[name] = { pid: child.pid, running: child.exitCode === null };
  }
  writeFileSync(statePath, JSON.stringify({
    supervisorPid: process.pid,
    updatedAt: new Date().toISOString(),
    localBaseUrl,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    emailProvider: process.env.EMAIL_PROVIDER || "auto",
    dataDir: process.env.ARCOVIA_DATA_DIR || "",
    services
  }, null, 2), "utf8");
}

function backupLocalData() {
  const dataDir = resolve(process.env.ARCOVIA_DATA_DIR || join(root, "data"));
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const name of ["jobs.json", "outbox.json"]) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(backupDir, `${name.replace(".json", "")}-${stamp}.json`));
  }
  const backups = readdirSync(backupDir).sort().reverse();
  for (const oldFile of backups.slice(60)) rmSync(join(backupDir, oldFile), { force: true });
}

function refuseDuplicateSupervisor() {
  if (!existsSync(pidPath)) return;
  const existingPid = Number(readFileSync(pidPath, "utf8").trim());
  if (existingPid && processExists(existingPid)) {
    throw new Error(`Arcovia local runtime is already running with PID ${existingPid}`);
  }
  rmSync(pidPath, { force: true });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  clearInterval(stateTimer);
  clearInterval(backupTimer);
  log("supervisor", "Stopping Arcovia local runtime...");
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2500).unref();
}

function cleanupFiles() {
  rmSync(pidPath, { force: true });
}
