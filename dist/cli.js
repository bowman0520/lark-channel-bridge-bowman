// src/cli/index.ts
import { Command } from "commander";

// package.json
var package_default = {
  name: "lark-channel-bridge",
  version: "0.1.31",
  description: "Bridge Feishu/Lark messenger with local CLI coding agents (Claude Code, ...)",
  type: "module",
  bin: {
    "lark-channel-bridge": "./bin/lark-channel-bridge.mjs"
  },
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    }
  },
  files: [
    "dist",
    "bin",
    "README.md",
    "README.zh.md",
    "LICENSE"
  ],
  scripts: {
    dev: "tsup --watch",
    build: "tsup",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    prepublishOnly: "pnpm typecheck && pnpm build"
  },
  dependencies: {
    "@clack/prompts": "^1.4.0",
    "@larksuiteoapi/node-sdk": "^1.65.0",
    commander: "^12.1.0",
    "https-proxy-agent": "^9.0.0",
    "qrcode-terminal": "^0.12.0"
  },
  devDependencies: {
    "@types/node": "^22.10.0",
    "@types/qrcode-terminal": "^0.12.2",
    tsup: "^8.3.5",
    typescript: "^5.6.3",
    vitest: "^2.1.8"
  },
  engines: {
    node: ">=20.0.0"
  },
  pnpm: {
    onlyBuiltDependencies: [
      "esbuild",
      "protobufjs"
    ]
  },
  keywords: [
    "feishu",
    "lark",
    "claude",
    "claude-code",
    "cli",
    "channel",
    "bridge"
  ],
  license: "MIT"
};

// src/cli/commands/migrate.ts
import { mkdir as mkdir2, readFile as readFile2, readdir, rename as rename2, rm, stat } from "fs/promises";
import { join as join2 } from "path";

// src/config/paths.ts
import { homedir } from "os";
import { join } from "path";
var appDir = join(homedir(), ".lark-channel");
var paths = {
  appDir,
  cacheDir: appDir,
  configFile: join(appDir, "config.json"),
  sessionsFile: join(appDir, "sessions.json"),
  workspacesFile: join(appDir, "workspaces.json"),
  processesFile: join(appDir, "processes.json"),
  secretsFile: join(appDir, "secrets.enc"),
  keystoreSaltFile: join(appDir, ".keystore.salt"),
  /**
   * Thin shell wrapper that lark-cli (and other openclaw-exec-protocol
   * consumers) invoke to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
  secretsGetterScript: join(appDir, "secrets-getter"),
  mediaDir: join(appDir, "media")
};
var legacyPaths = {
  appDir: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "lark-channel-bridge"
  ),
  cacheDir: join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "lark-channel-bridge"
  )
};

// src/config/schema.ts
function isComplete(cfg) {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}
function hasSecret(s) {
  if (!s) return false;
  if (typeof s === "string") return s.length > 0;
  return Boolean(s.source && s.id);
}
function isSecretRef(s) {
  return typeof s === "object" && s !== null;
}
function secretKeyForApp(appId) {
  return `app-${appId}`;
}
function getMessageReplyMode(cfg) {
  const raw = cfg.preferences?.messageReply;
  if (raw === "text" && cfg.preferences?.messageReplyMigrated !== true) {
    return "markdown";
  }
  if (raw === "card" || raw === "markdown" || raw === "text") return raw;
  return "markdown";
}
function getShowToolCalls(cfg) {
  return cfg.preferences?.showToolCalls !== false;
}
function getMaxConcurrentRuns(cfg) {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}
function getRequireMentionInGroup(cfg) {
  return cfg.preferences?.requireMentionInGroup !== false;
}
function getAgentStopGraceMs(cfg) {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5e3;
  return Math.min(3e4, Math.max(100, Math.floor(raw)));
}
function isUserAllowed(cfg, senderId) {
  const list = cfg.preferences?.access?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}
function isChatAllowed(cfg, chatId) {
  const list = cfg.preferences?.access?.allowedChats;
  if (!list || list.length === 0) return true;
  return list.includes(chatId);
}
function isAdmin(cfg, senderId) {
  const list = cfg.preferences?.access?.admins;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}
function getRunIdleTimeoutMs(cfg) {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return void 0;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 6e4;
}

// src/config/store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
async function loadConfig(path = paths.configFile) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}
async function buildEncryptedAccountConfig(appId, tenant, preferences) {
  const wrapperPath = await ensureSecretsGetterWrapper();
  return {
    accounts: {
      app: {
        id: appId,
        secret: {
          source: "exec",
          provider: "bridge",
          id: secretKeyForApp(appId)
        },
        tenant
      }
    },
    secrets: {
      providers: {
        bridge: {
          source: "exec",
          command: wrapperPath,
          // The wrapper has args baked in; pass none here.
          args: []
        }
      }
    },
    ...preferences ? { preferences } : {}
  };
}
async function ensureSecretsGetterWrapper() {
  const wrapperPath = paths.secretsGetterScript;
  const node = process.execPath;
  const bridgeEntry = process.argv[1] ?? "";
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const content = `#!/bin/sh
# Auto-generated by lark-channel-bridge. Do not edit.
# Forwards exec-provider requests to: node bridge secrets get
exec ${sq(node)} ${sq(bridgeEntry)} secrets get "$@"
`;
  await mkdir(dirname(wrapperPath), { recursive: true });
  const tmp = `${wrapperPath}.tmp-${process.pid}`;
  await writeFile(tmp, content, "utf8");
  await chmod(tmp, 448);
  await rename(tmp, wrapperPath);
  return wrapperPath;
}
async function saveConfig(cfg, path = paths.configFile) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}
`, "utf8");
  await chmod(tmp, 384);
  await rename(tmp, path);
}

// src/runtime/registry.ts
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { mkdir as mkdir3, rename as rename3, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2 } from "path";
function readRaw(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isValidEntry) };
  } catch (err) {
    if (err.code === "ENOENT") return { entries: [] };
    return { entries: [] };
  }
}
function isValidEntry(e) {
  if (!e || typeof e !== "object") return false;
  const x = e;
  return typeof x.id === "string" && typeof x.pid === "number" && typeof x.appId === "string" && (x.tenant === "feishu" || x.tenant === "lark") && typeof x.configPath === "string" && typeof x.startedAt === "string" && typeof x.version === "string";
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function readAndPrune(path = paths.processesFile) {
  const raw = readRaw(path);
  return raw.entries.filter((e) => isAlive(e.pid));
}
async function writeAtomic(entries, path) {
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ entries }, null, 2)}
`;
  await mkdir3(dirname2(path), { recursive: true });
  await writeFile2(tmp, body, "utf8");
  await rename3(tmp, path);
}
function writeAtomicSync(entries, path) {
  const tmp = `${path}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ entries }, null, 2)}
`;
  mkdirSync(dirname2(path), { recursive: true });
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}
function generateShortId() {
  return randomBytes(2).toString("hex");
}
async function register(args) {
  const live = readAndPrune();
  const entry = {
    id: generateShortId(),
    pid: process.pid,
    appId: args.appId,
    tenant: args.tenant,
    configPath: args.configPath,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    version: args.version
  };
  await writeAtomic([...live, entry], paths.processesFile);
  return entry;
}
async function updateEntry(id, patch) {
  const live = readAndPrune();
  let changed = false;
  const next = live.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, ...patch };
  });
  if (!changed) return;
  await writeAtomic(next, paths.processesFile);
}
function unregisterSync(id) {
  try {
    const live = readRaw(paths.processesFile).entries.filter((e) => isAlive(e.pid));
    const next = live.filter((e) => e.id !== id);
    if (next.length === live.length) return;
    writeAtomicSync(next, paths.processesFile);
  } catch {
  }
}
function cleanupTmpFiles() {
  try {
    unlinkSync(`${paths.processesFile}.tmp-${process.pid}`);
  } catch {
  }
}
function sameAppOthers(appId, excludePid = process.pid) {
  return readAndPrune().filter((e) => e.appId === appId && e.pid !== excludePid);
}
function resolveTarget(target) {
  const live = readAndPrune();
  const byId = live.find((e) => e.id === target);
  if (byId) return byId;
  const n = Number.parseInt(target, 10);
  if (Number.isFinite(n) && n >= 1 && n <= live.length) {
    return live[n - 1];
  }
  return void 0;
}

// src/cli/commands/ps.ts
function runPs() {
  const live = readAndPrune();
  if (live.length === 0) {
    console.log("\u5F53\u524D\u6CA1\u6709 bot \u5728\u8FD0\u884C\u3002");
    return;
  }
  console.log(`# \u5F53\u524D\u5171 ${live.length} \u4E2A bot \u5728\u8FD0\u884C
`);
  const rows = live.map((e, idx) => {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const app = e.botName ? `${e.botName} (${e.appId})` : e.appId;
    return {
      idx: String(idx + 1),
      id: e.id,
      pid: String(e.pid),
      app,
      started: ago,
      version: e.version
    };
  });
  const headers = { idx: "#", id: "ID", pid: "PID", app: "Bot", started: "\u542F\u52A8", version: "\u7248\u672C" };
  printTable([headers, ...rows]);
}
async function runKillCli(target) {
  if (!target) {
    console.error("\u7528\u6CD5: lark-channel-bridge kill <bot id \u6216\u5E8F\u53F7>");
    process.exit(1);
  }
  const entry = resolveTarget(target);
  if (!entry) {
    console.error(`\u2717 \u6CA1\u627E\u5230\u5339\u914D\u7684 bot:${target}`);
    console.error("  \u7528 `lark-channel-bridge ps` \u770B\u53EF\u9009\u76EE\u6807\u3002");
    process.exit(1);
  }
  console.log(`\u6B63\u5728\u5173\u95ED bot ${entry.id}\u2026`);
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (err) {
    console.error(`\u2717 \u5173\u95ED\u5931\u8D25:${err.message}`);
    process.exit(1);
  }
  const deadline = Date.now() + 2e3;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      console.log(`\u2713 \u5DF2\u5173\u95ED bot ${entry.id}\u3002`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn("\u26A0\uFE0F 2 \u79D2\u5185\u6CA1\u9000\u51FA,\u5F3A\u5236\u5173\u95ED\u3002");
  try {
    process.kill(entry.pid, "SIGKILL");
  } catch (err) {
    console.error(`\u2717 \u5F3A\u5236\u5173\u95ED\u5931\u8D25:${err.message}`);
    process.exit(1);
  }
}
function formatAgo(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)}s \u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)}m \u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)}h \u524D`;
  return `${Math.floor(ms / 864e5)}d \u524D`;
}
function printTable(rows) {
  if (rows.length === 0) return;
  const headerRow = rows[0];
  if (!headerRow) return;
  const cols = Object.keys(headerRow);
  const widths = {};
  for (const col of cols) {
    widths[col] = Math.max(...rows.map((r) => displayWidth(r[col] ?? "")));
  }
  for (const r of rows) {
    const line = cols.map((c) => padEndDisplay(r[c] ?? "", widths[c] ?? 0)).join("  ");
    console.log(line);
  }
}
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 11904 ? 2 : 1;
  }
  return w;
}
function padEndDisplay(s, target) {
  const pad = target - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// src/cli/commands/secrets.ts
import { createInterface } from "readline";
import { Writable } from "stream";

// src/config/keystore.ts
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes as randomBytes2 } from "crypto";
import { chmod as chmod2, mkdir as mkdir4, readFile as readFile4, rename as rename4, writeFile as writeFile3 } from "fs/promises";
import { hostname, userInfo } from "os";
import { dirname as dirname3 } from "path";
var KEY_LEN = 32;
var IV_LEN = 12;
var TAG_LEN = 16;
var PBKDF2_ITER = 1e5;
var FILE_VERSION = 1;
var EMPTY = { version: FILE_VERSION, entries: {} };
async function readStore() {
  try {
    const text = await readFile4(paths.secretsFile, "utf8");
    const parsed = JSON.parse(text);
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return { ...EMPTY };
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if (err.code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}
async function writeStore(store) {
  await mkdir4(dirname3(paths.secretsFile), { recursive: true });
  const tmp = `${paths.secretsFile}.tmp-${process.pid}`;
  await writeFile3(tmp, `${JSON.stringify(store, null, 2)}
`, "utf8");
  await chmod2(tmp, 384);
  await rename4(tmp, paths.secretsFile);
}
async function loadOrCreateSalt() {
  try {
    const buf = await readFile4(paths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const salt = randomBytes2(KEY_LEN);
  await mkdir4(dirname3(paths.keystoreSaltFile), { recursive: true });
  const tmp = `${paths.keystoreSaltFile}.tmp-${process.pid}`;
  await writeFile3(tmp, salt);
  await chmod2(tmp, 384);
  await rename4(tmp, paths.keystoreSaltFile);
  return salt;
}
async function deriveKey() {
  const salt = await loadOrCreateSalt();
  const seed = `${hostname()}|${userInfo().username}`;
  return pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, "sha256");
}
function encrypt(key, plaintext) {
  const iv = randomBytes2(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: enc.toString("base64"),
    tag: tag.toString("base64")
  };
}
function decrypt(key, env) {
  const iv = Buffer.from(env.iv, "base64");
  const data = Buffer.from(env.data, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_LEN) throw new Error("invalid IV length");
  if (tag.length !== TAG_LEN) throw new Error("invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}
async function getSecret(id) {
  const store = await readStore();
  const env = store.entries[id];
  if (!env) return void 0;
  const key = await deriveKey();
  return decrypt(key, env);
}
async function setSecret(id, plaintext) {
  const key = await deriveKey();
  const env = encrypt(key, plaintext);
  const store = await readStore();
  store.entries[id] = env;
  await writeStore(store);
}
async function removeSecret(id) {
  const store = await readStore();
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  await writeStore(store);
  return true;
}
async function listSecretIds() {
  const store = await readStore();
  return Object.keys(store.entries);
}

// src/cli/commands/secrets.ts
var PROTOCOL_VERSION = 1;
async function runSecretsGet() {
  const input = await readAllStdin();
  let req;
  try {
    req = JSON.parse(input || "{}");
  } catch (err) {
    console.error(`secrets get: invalid stdin JSON: ${err.message}`);
    process.exit(2);
  }
  const ids = req.ids ?? [];
  const resp = {
    protocolVersion: PROTOCOL_VERSION,
    values: {}
  };
  for (const id of ids) {
    try {
      const v = await getSecret(id);
      if (v !== void 0) {
        resp.values[id] = v;
      } else {
        (resp.errors ??= {})[id] = { message: "not found" };
      }
    } catch (err) {
      (resp.errors ??= {})[id] = { message: err.message };
    }
  }
  process.stdout.write(`${JSON.stringify(resp)}
`);
}
async function runSecretsSet(appId) {
  if (!appId) {
    console.error("\u7528\u6CD5: lark-channel-bridge secrets set --app-id <id>");
    process.exit(1);
  }
  const id = `app-${appId}`;
  const plaintext = await promptPassword(`\u8F93\u5165 ${appId} \u7684 App Secret: `);
  if (!plaintext) {
    console.error("\u2717 \u53D6\u6D88(secret \u4E3A\u7A7A)");
    process.exit(1);
  }
  await setSecret(id, plaintext);
  console.log(`\u2713 \u5DF2\u52A0\u5BC6\u5B58\u5230 ~/.lark-channel/secrets.enc`);
}
async function runSecretsList() {
  const ids = await listSecretIds();
  if (ids.length === 0) {
    console.log("\u5F53\u524D\u6CA1\u6709\u52A0\u5BC6\u5B58\u50A8\u7684 secret\u3002");
    return;
  }
  console.log(`# \u5F53\u524D\u5171 ${ids.length} \u4E2A secret \u5728\u52A0\u5BC6\u5B58\u50A8\u91CC
`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}
async function runSecretsRemove(appId) {
  if (!appId) {
    console.error("\u7528\u6CD5: lark-channel-bridge secrets remove --app-id <id>");
    process.exit(1);
  }
  const id = `app-${appId}`;
  const removed = await removeSecret(id);
  if (!removed) {
    console.error(`\u2717 \u6CA1\u627E\u5230 secret: ${id}`);
    process.exit(1);
  }
  console.log(`\u2713 \u5DF2\u5220\u9664 ${id}`);
}
async function readAllStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
async function promptPassword(prompt) {
  const isTTY = Boolean(process.stdin.isTTY);
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, _enc, cb) {
        cb();
      }
    });
    process.stdout.write(prompt);
    const rl = createInterface({
      input: process.stdin,
      output: isTTY ? muted : process.stdout,
      terminal: isTTY
    });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// src/agent/claude/adapter.ts
import { spawn } from "child_process";
import { createInterface as createInterface2 } from "readline";
import { readFileSync as readFileSyncForImage, openSync as openSyncForSniff, readSync as readSyncForSniff, closeSync as closeSyncForSniff } from "fs";

// src/core/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import { createWriteStream, mkdirSync as mkdirSync2 } from "fs";
import { open, readdir as readdir2, rm as rm2, stat as stat2 } from "fs/promises";
import { join as join3 } from "path";
var LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LARK_CHANNEL_LOG_DAYS ?? 7) || 7
);
var STDOUT_INFO_ALLOWLIST = /* @__PURE__ */ new Set([
  "ws.connected",
  "ws.reconnecting",
  "ws.reconnected",
  "intake.enter",
  "card.final"
]);
var als = new AsyncLocalStorage();
var stream = null;
var currentDate = "";
function todayKey() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function logsDir() {
  return join3(paths.appDir, "logs");
}
function getStream() {
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
    }
  }
  try {
    mkdirSync2(logsDir(), { recursive: true });
    stream = createWriteStream(join3(logsDir(), `${today}.log`), { flags: "a" });
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}
var RESERVED_KEYS = /* @__PURE__ */ new Set([
  "ts",
  "level",
  "phase",
  "event",
  "traceId",
  "chatId",
  "msgId"
]);
function emit(level, phase, event, fields = {}) {
  const ctx = als.getStore() ?? {};
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    phase,
    event,
    ...ctx
  };
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = v;
    } else {
      entry[k] = v;
    }
  }
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}
`);
    } catch {
    }
  }
  const showOnStdout = level !== "info" || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(formatStdout(level, phase, event, ctx, fields));
}
function formatStdout(level, phase, event, ctx, fields) {
  if (phase === "ws") {
    if (event === "connected") {
      const bot = fields.bot ?? "-";
      const appId = fields.appId ? ` (${fields.appId})` : "";
      const agent = fields.agent ?? "-";
      const proc = fields.procId ? `  \u8FDB\u7A0B: ${fields.procId}` : "";
      return `\u2713 \u5DF2\u8FDE\u63A5  bot: ${bot}${appId}  agent: ${agent}${proc}`;
    }
    if (event === "reconnecting") return "\u21BB \u6B63\u5728\u91CD\u8FDE\u2026";
    if (event === "reconnected") return "\u2713 \u5DF2\u91CD\u8FDE";
    if (event === "fail") return `\u2717 WS \u9519\u8BEF: ${fields.err ?? ""}`;
  }
  if (phase === "intake" && event === "enter") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const sender = fields.sender ?? "-";
    const preview2 = fields.preview ?? "";
    return `\u25B8 ${fields.chatType ?? "?"}/${c} ${sender}: ${preview2}`;
  }
  if (phase === "card" && event === "final") {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : "-";
    const t = fields.terminal;
    const mark = t === "done" ? "\u2713" : t === "interrupted" ? "\u23F9" : "\u2717";
    return `  ${mark} ${c} ${t}`;
  }
  const ctxBits = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(" ")}` : "";
  const summary = formatFields(fields);
  const tag = level === "error" ? "\u2717" : level === "warn" ? "\u26A0" : "\xB7";
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ""}`;
}
function formatFields(fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";
  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === void 0 || v === null) continue;
    if (k === "stack") continue;
    if (typeof v === "string") {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}\u2026` : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}\u2026` : s}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(" ");
}
var log = {
  info(phase, event, fields) {
    emit("info", phase, event, fields);
  },
  warn(phase, event, fields) {
    emit("warn", phase, event, fields);
  },
  fail(phase, err, fields) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : void 0;
    const apiData = err?.response?.data;
    const apiStatus = err?.response?.status;
    emit("error", phase, "fail", {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack
    });
  }
};
function withTrace(ctx, fn) {
  const traceId = ctx.traceId ?? newTraceId();
  return als.run({ ...ctx, traceId }, fn);
}
function newTraceId() {
  return Math.random().toString(36).slice(2, 10);
}
function sanitizeLogsForDoctor(logs) {
  let out = logs;
  out = out.replace(
    /"(chatId|senderId|sender|openId|operatorId|userId|msgId|messageId)":"([^"]{8,})"/g,
    (_, key, val) => `"${key}":"\u2026${val.slice(-6)}"`
  );
  out = out.replace(
    /"(secret|app_secret|appSecret|token|access_token|tenant_access_token|app_access_token|authorization)":"[^"]*"/gi,
    (_, key) => `"${key}":"[REDACTED]"`
  );
  out = out.replace(
    /\b(access_token|tenant_access_token|app_access_token)=[A-Za-z0-9._\-+/=]+/g,
    "$1=[REDACTED]"
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [REDACTED]");
  out = out.replace(/\bAuthorization\s*[:=]\s*\S+/gi, "Authorization=[REDACTED]");
  return out;
}
async function readRecentLogs(opts) {
  const today = todayKey();
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const todayPath = join3(logsDir(), `${today}.log`);
  const yesterdayPath = join3(logsDir(), `${yesterday}.log`);
  const tail = await readTail(todayPath, opts.maxBytes);
  if (tail.length >= opts.maxBytes / 2) return tail;
  const remaining = opts.maxBytes - Buffer.byteLength(tail, "utf8");
  const earlier = await readTail(yesterdayPath, remaining);
  return earlier + tail;
}
async function gcOldLogs() {
  const dir = logsDir();
  let entries;
  try {
    entries = await readdir2(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 864e5;
  let removed = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const fileMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(fileMs) || fileMs >= cutoff) continue;
    try {
      await rm2(join3(dir, name));
      removed++;
    } catch {
    }
  }
  if (removed > 0) {
    log.info("logger", "gc", { removed, retentionDays: LOG_RETENTION_DAYS });
  }
  return removed;
}
async function readTail(path, maxBytes) {
  try {
    const st = await stat2(path);
    const start = Math.max(0, st.size - maxBytes);
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      let content = buf.toString("utf8");
      if (start > 0) {
        const nl = content.indexOf("\n");
        if (nl !== -1) content = content.slice(nl + 1);
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

// src/agent/claude/stream-json.ts
function* translateEvent(raw) {
  if (!raw || typeof raw !== "object") return;
  const evt = raw;
  if (evt.type === "system" && evt.subtype === "init") {
    yield {
      type: "system",
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model
    };
    return;
  }
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        yield { type: "text", delta: block.text };
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        yield { type: "thinking", delta: block.thinking };
      } else if (block.type === "tool_use" && block.id && block.name) {
        yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }
  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        yield {
          type: "tool_result",
          id: block.tool_use_id,
          output,
          isError: block.is_error === true
        };
      }
    }
    return;
  }
  if (evt.type === "result") {
    if (evt.usage) {
      yield {
        type: "usage",
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        costUsd: evt.total_cost_usd
      };
    }
    yield { type: "done", sessionId: evt.session_id };
  }
}

// src/agent/claude/adapter.ts
var BRIDGE_SYSTEM_PROMPT = `# lark-channel-bridge \u8FD0\u884C\u7EA6\u5B9A

\u4F60\u6B63\u5728 lark-channel-bridge \u91CC\u8DD1\uFF1A\u628A\u98DE\u4E66/Lark \u7528\u6237\u6D88\u606F\u6865\u5230\u672C\u5730 \`claude\` CLI\u3002

## bridge_context

\u6BCF\u6761 user message \u9876\u90E8\u4F1A\u5E26\u4E00\u4E2A \`<bridge_context>\` \u5757\uFF1A

\`\`\`
<bridge_context>
chat_id: oc_xxx
chat_type: p2p
sender_id: ou_xxx
sender_name: ...
</bridge_context>
\`\`\`

\u91CC\u9762\u662F\u5F53\u524D\u5BF9\u8BDD\u7684 chat_id\u3001chat \u7C7B\u578B\uFF08p2p / group\uFF09\u3001\u53D1\u9001\u8005\u3002\u8FD9\u4E9B\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284\u3001\u4E0D\u8981\u5728\u4F60\u7684\u56DE\u590D\u91CC\u6E32\u67D3**\u2014\u2014\u5B83\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## quoted_message

\u5982\u679C\u7528\u6237\u7528"\u5F15\u7528\u56DE\u590D"\u6307\u5411\u67D0\u6761\u6D88\u606F\uFF0Cbridge \u4F1A\u5728 \`<bridge_context>\` \u540E\u6CE8\u5165\u4E00\u4E2A \`<quoted_message>\` \u5757\uFF1A

\`\`\`
<quoted_message id="om_xxx" sender_id="ou_xxx" sender_name="..." created_at="..." type="text|merge_forward|...">
\uFF08\u88AB\u5F15\u7528\u6D88\u606F\u7684\u5185\u5BB9\uFF1Bmerge_forward \u7C7B\u578B\u4F1A\u5C55\u5F00\u6210 <forwarded_messages>...</forwarded_messages>\uFF09
</quoted_message>
\`\`\`

\u8FD9\u662F\u7528\u6237**\u6307\u5411\u7684\u5BF9\u8C61**\u2014\u2014\u7528\u6237\u7684\u5B9E\u9645\u95EE\u9898\u5728\u5B83\u4E4B\u540E\u3002\u56DE\u7B54\u65F6\u56F4\u7ED5\u8FD9\u6BB5\u5185\u5BB9\u5C55\u5F00\uFF1B\u5B83\u4E5F\u662F bridge \u6CE8\u5165\u7684\u5143\u6570\u636E\uFF0C**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E**\u5230\u56DE\u590D\u91CC\u3002

## interactive_card

\u7528\u6237\u53D1 / \u5F15\u7528\u4EA4\u4E92\u5361\u7247\u65F6,bridge \u4F1A\u628A\u5361\u7684\u771F\u5B9E JSON \u6CE8\u5165\u5230 \`<interactive_card>\` \u5757:

\`\`\`
<interactive_card>
{ "schema": "2.0", "config": { ... }, "body": { ... } }
</interactive_card>
\`\`\`

\u4E24\u79CD\u6765\u6E90:

- **v2 CardKit (schema 2.0)**:\u98DE\u4E66\u5728 raw event \u91CC\u53CC\u53D1\u2014\u2014\`elements\` \u662F v1 \u517C\u5BB9\u964D\u7EA7("\u8BF7\u5347\u7EA7\u81F3\u6700\u65B0\u7248\u672C\u5BA2\u6237\u7AEF"),\`user_dsl\` \u662F\u771F\u6B63\u7684 schema 2.0 DSL\u3002bridge \u4F18\u5148\u53D6 \`user_dsl\`,\u6240\u4EE5\u4F60\u770B\u5230\u7684\u5C31\u662F**\u771F\u5361\u5185\u5BB9**,\u4E0D\u8981\u88AB elements \u7684\u964D\u7EA7\u6587\u6848\u8BEF\u5BFC
- **\u96F6\u6587\u5B57 v1 \u5361**:\u7EAF\u6309\u94AE / \u56FE\u7247 / \u88C5\u9970\u5361,SDK \u6241\u5E73\u5316\u6293\u4E0D\u5230\u5B57\u65F6,bridge \u628A\u6574\u6BB5 raw JSON \u704C\u8FDB\u6765

\u65E0\u8BBA\u54EA\u79CD,\u5757\u91CC\u90FD\u662F\u5361\u7684\u5B8C\u6574 JSON\u3002\u89E3\u6790\u5B83\u6765\u7406\u89E3\u7ED3\u6784(\u6309\u94AE\u3001\u5B57\u6BB5\u3001\u5E03\u5C40)\u3002**\u4E0D\u8981\u7167\u6284 XML \u6807\u7B7E\u5230\u56DE\u590D**\u2014\u2014\u5BF9\u7528\u6237\u4E0D\u53EF\u89C1\u3002

## \u53D1\u4EA4\u4E92\u5361\u7247\uFF08\u6309\u94AE\u3001\u8868\u5355\uFF09\u7684\u56DE\u8C03\u7EA6\u5B9A

\u4F60\u60F3\u53D1\u4E00\u5F20\u53EF\u4EA4\u4E92\u7684\u5361\u7247\u8BA9\u7528\u6237\u70B9\u9009\u65F6\uFF1A

1. \u7528 \`lark-cli\` \u628A\u5361\u53D1\u5230 \`bridge_context.chat_id\`\uFF1A
   \`lark-cli im send-card --chat-id <chat_id> --card '<json>'\`
2. \u5361\u7247\u7528 CardKit 2.0 schema\uFF08\`schema: "2.0"\`\uFF09\u3002
3. **\u5982\u679C\u4F60\u5E0C\u671B\u7528\u6237\u70B9\u6309\u94AE\u540E\u56DE\u8C03\u5230\u4F60\uFF08\u8BA9\u4F60\u5728\u540C\u4E00\u4F1A\u8BDD\u91CC\u7EE7\u7EED\u5904\u7406\uFF09**\uFF1A
   - \u6309\u94AE\u7684 \`value\` \u5BF9\u8C61**\u5FC5\u987B**\u5305\u542B \`__claude_cb: true\`
   - \u540C\u65F6\u53EF\u4EE5\u585E\u4EFB\u610F\u5176\u5B83\u5B57\u6BB5\uFF0C\u4F5C\u4E3A\u4F60\u9700\u8981\u5728\u56DE\u8C03\u65F6\u8BB0\u4F4F\u7684\u72B6\u6001\uFF08\u6BD4\u5982 \`{"__claude_cb": true, "choice": "a", "ticket_id": "T-123"}\`\uFF09
4. \u7528\u6237\u70B9\u51FB\u540E\uFF0Cbridge \u4F1A\u628A payload\uFF08\u53BB\u6389 \`__claude_cb\` marker\uFF09\u4F5C\u4E3A \`[card-click] {...}\` \u6D88\u606F\u53D1\u56DE\u7ED9\u4F60\uFF1B\u4F60\u7684 session \u81EA\u52A8\u7EED\u4E0A\uFF0C\u80FD\u770B\u5230\u81EA\u5DF1\u4E0A\u8F6E\u53D1\u4E86\u4EC0\u4E48\u5361\u3002
5. **\u5982\u679C\u53EA\u662F\u5C55\u793A\u5361\uFF08\u4E0D\u9700\u8981\u56DE\u8C03\uFF09**\uFF0C\u4E0D\u8981\u52A0 \`__claude_cb\`\uFF0C\u5426\u5219\u70B9\u51FB\u5C31\u4F1A\u89E6\u53D1\u989D\u5916\u7684\u4F1A\u8BDD\u8F6E\u6B21\u3002

\u793A\u4F8B button\uFF1A
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "\u65B9\u6848 A" },
  "behaviors": [{
    "type": "callback",
    "value": { "__claude_cb": true, "choice": "a" }
  }]
}
\`\`\`

## \u98DE\u4E66 OAuth \u6388\u6743\uFF08\`lark-cli auth login\`\uFF09

\u6388\u6743\u6D41\u7A0B\u8981\u8BA9 \`lark-cli\` \u8FDB\u7A0B\u4E00\u76F4\u6D3B\u5230\u7528\u6237\u5728\u6D4F\u89C8\u5668\u91CC\u70B9\u5B8C\u4E3A\u6B62\u3002bridge \u5728\u4F60\u7684 run \u7ED3\u675F\u4E4B\u540E\u4F1A\u56DE\u6536 claude\uFF0C**\u4F60 spawn \u7684\u4EFB\u4F55\u540E\u53F0 bash \u4E5F\u4F1A\u8DDF\u7740\u6B7B**\u2014\u2014\u6240\u4EE5\u6388\u6743\u5FC5\u987B\u7528"\u524D\u53F0\u963B\u585E"\u7684\u65B9\u5F0F\u8DD1\uFF1A

1. **\u4EC5\u5728 p2p \u91CC\u53D1\u8D77\u6388\u6743**\u3002\u4ECE \`bridge_context.chat_type\` \u770B\uFF1A
   - \`chat_type: p2p\` \u2014\u2014 \u6B63\u5E38\u6309\u4E0B\u9762\u6D41\u7A0B\u8D70\u3002
   - \`chat_type: group\`\uFF08\u542B topic \u7FA4\uFF09\u2014\u2014 **\u4E0D\u8981**\u8C03 \`lark-cli auth login\`\u3002device flow \u628A \`verification_url\` \u53D1\u5230\u7FA4\u91CC\uFF0C\u8C01\u5148\u70B9\u8C01\u62FF\u8D70 token\u2014\u2014\u4F1A\u7ED1\u5B9A\u5230\u9519\u7684\u8EAB\u4EFD\u3002\u6B63\u786E\u505A\u6CD5\u662F\u56DE\u590D\u7528\u6237\uFF1A"\u6388\u6743\u8981\u5728\u79C1\u804A\u91CC\u505A\uFF0C\u8BF7\u5355\u72EC\u79C1\u4FE1\u6211\u3002"
2. **\u7981\u6B62** \u7528 \`run_in_background: true\` \u8C03 \`lark-cli auth login\`\u2014\u2014\u5B83\u4F1A\u88AB\u4F60 exit \u65F6\u4E00\u8D77\u5E26\u8D70\uFF0C\u7528\u6237\u8FD8\u6CA1\u70B9\u5B8C\u5C31\u4E22\u4E86\u3002
3. **\u63A8\u8350\u4E24\u9636\u6BB5\u6D41**\uFF08lark-cli \u5728 \`--no-wait\` \u7684\u8F93\u51FA\u91CC\u4E5F\u4F1A\u544A\u8BC9\u4F60\u8FD9\u5957\uFF09\uFF1A
   - \u5148\u8DD1 \`lark-cli auth login --no-wait --json [--recommend | --domain ... | --scope ...]\`\uFF0C**\u8FD9\u4E00\u6B65\u79D2\u8FD4\u56DE**\uFF0Cstdout \u91CC\u6709 \`verification_url\` \u548C \`device_code\`\u3002
   - \u628A \`verification_url\` **\u539F\u6837**\u7528\u4EE3\u7801\u5757\u53D1\u7ED9\u7528\u6237\uFF08\u4E0D\u8981 Markdown \u94FE\u63A5\u5316\u3001\u4E0D\u8981 URL \u7F16\u7801\uFF09\u3002
   - \u7D27\u63A5\u7740\u540C\u4E00\u8F6E\u91CC\u8DD1 \`lark-cli auth login --device-code <code>\`\uFF0C**\u8FD9\u4E00\u6B65\u524D\u53F0\u963B\u585E**\u76F4\u5230\u7528\u6237\u70B9\u5B8C\u6216 10 \u5206\u949F\u8D85\u65F6\u2014\u2014\u8FD9\u662F\u4F60\u5E94\u8BE5\u7B49\u7684\u5730\u65B9\uFF0C\u4E0D\u8981\u4E22\u5230\u540E\u53F0\u3002
4. \u4F60\u524D\u53F0\u963B\u585E\u671F\u95F4\uFF0C\u7528\u6237\u53D1\u7684\u65B0\u6D88\u606F bridge \u4F1A\u81EA\u52A8\u6392\u961F\uFF0C**\u4E0D\u4F1A\u6253\u65AD\u4F60**\uFF1B\u7B49\u4F60 tool_result \u4E00\u56DE\u6765\uFF0C\u4E0B\u4E00\u6279\u6D88\u606F\u518D\u8FDB\u6765\u3002\u6240\u4EE5\u653E\u5FC3\u963B\u585E\u3002
5. \u5982\u679C\u7528\u6237\u4E2D\u9014\u60F3\u53D6\u6D88\uFF0C\u4ED6\u4EEC\u4F1A\u53D1 \`/stop\`\u2014\u2014\u90A3\u65F6\u88AB kill \u662F\u9884\u671F\u884C\u4E3A\uFF0C\u4E0D\u7528\u515C\u5E95\u3002
`;
var ClaudeAdapter = class {
  id = "claude";
  displayName = "Claude Code";
  binary;
  constructor(opts = {}) {
    this.binary = opts.binary ?? "claude";
  }
  async isAvailable() {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }
  run(opts) {
    const images = Array.isArray(opts.images) ? opts.images : [];
    const useMultimodalInput = images.length > 0;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      opts.permissionMode ?? "bypassPermissions",
      "--append-system-prompt",
      BRIDGE_SYSTEM_PROMPT
    ];
    if (useMultimodalInput) {
      args.push("--input-format", "stream-json");
    } else {
      args.splice(1, 0, opts.prompt);
    }
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: "1" },
      stdio: [useMultimodalInput ? "pipe" : "ignore", "pipe", "pipe"]
    });
    if (useMultimodalInput) {
      const content = [];
      let attachedCount = 0;
      let skippedCount = 0;
      const pathFallbacks = [];
      for (const img of images) {
        try {
          const bytes = readFileSyncForImage(img.path);
          const b64 = bytes.toString("base64");
          content.push({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: b64 }
          });
          attachedCount++;
        } catch (err) {
          skippedCount++;
          pathFallbacks.push(`- ${img.path}${img.originalName ? ` (${img.originalName})` : ""} — 图片（请用 Read 工具读取）`);
          log.warn("agent", "image-read-failed", {
            path: img.path,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      let textPrompt = opts.prompt;
      if (pathFallbacks.length > 0) {
        textPrompt = `${textPrompt}

以下附件未能直接加载为多模态输入，请用 Read 工具读取：
${pathFallbacks.join("\n")}`;
      }
      content.push({ type: "text", text: textPrompt });
      const userMessage = {
        type: "user",
        message: { role: "user", content }
      };
      try {
        child.stdin.write(JSON.stringify(userMessage) + "\n");
        child.stdin.end();
      } catch (err) {
        log.warn("agent", "stdin-write-failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
      log.info("agent", "multimodal-input", {
        imagesAttached: attachedCount,
        imagesFallback: skippedCount,
        textChars: textPrompt.length
      });
    }
    log.info("agent", "spawn", {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      images: images.length,
      inputMode: useMultimodalInput ? "stream-json" : "text",
      model: opts.model
    });
    const stderrChunks = [];
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString("utf8");
      let nl = stderrBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn("agent", "stderr", { line });
        nl = stderrBuffer.indexOf("\n");
      }
    });
    let runtimeError = null;
    child.on("error", (err) => {
      runtimeError = err;
    });
    child.on("exit", (code, signal) => {
      log.info("agent", "exit", { pid: child.pid ?? null, code, signal });
    });
    const stopGraceMs = opts.stopGraceMs ?? 5e3;
    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info("agent", "stop-sigterm", { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn("agent", "stop-sigkill", {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: "grace-period-expired"
              });
              child.kill("SIGKILL");
            }
            resolve();
          }, stopGraceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs) {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const onExit = () => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
          }, timeoutMs);
          child.once("exit", onExit);
        });
      }
    };
  }
};
async function* createEventStream(child, stderrChunks, getError) {
  if (!child.pid) {
    const err = getError();
    yield {
      type: "error",
      message: err ? `failed to spawn claude: ${err.message}` : "spawn returned no pid"
    };
    return;
  }
  const rl = createInterface2({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }
  const exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once("exit", (code) => resolve(code));
    }
  });
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
    yield { type: "error", message: `claude exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: "error", message: `claude runtime error: ${runtimeError.message}` };
  }
}

// src/daemon/paths.ts
import { homedir as homedir2 } from "os";
import { join as join4 } from "path";
var SERVICE_NAME = "lark-channel-bridge.bot";
var LAUNCH_AGENT_LABEL = `ai.${SERVICE_NAME}`;
function launchAgentPlistPath() {
  return join4(homedir2(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}
var SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;
function systemdUnitPath() {
  const base = process.env.XDG_CONFIG_HOME ?? join4(homedir2(), ".config");
  return join4(base, "systemd", "user", SYSTEMD_UNIT_NAME);
}
var WINDOWS_TASK_NAME = "LarkChannelBridge.Bot";
function windowsLauncherCmdPath() {
  return join4(paths.appDir, "daemon-launcher.cmd");
}
function daemonLogDir() {
  return join4(paths.appDir, "logs");
}
function daemonStdoutPath() {
  return join4(daemonLogDir(), "daemon-stdout.log");
}
function daemonStderrPath() {
  return join4(daemonLogDir(), "daemon-stderr.log");
}

// src/daemon/launchd.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir as mkdir5, rm as rm3, writeFile as writeFile4 } from "fs/promises";
import { userInfo as userInfo2 } from "os";
import { dirname as dirname4 } from "path";
function buildPlist(inputs) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escape(inputs.nodePath)}</string>
        <string>${escape(inputs.bridgeEntryPath)}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escape(daemonStdoutPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escape(daemonStderrPath())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(inputs.envPath)}</string>
    </dict>
</dict>
</plist>
`;
}
async function writePlist() {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildPlist({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? ""
  });
  const plistPath = launchAgentPlistPath();
  await mkdir5(dirname4(plistPath), { recursive: true });
  await mkdir5(daemonLogDir(), { recursive: true });
  await writeFile4(plistPath, content, "utf8");
}
function plistExists() {
  return existsSync(launchAgentPlistPath());
}
function userTarget() {
  return `gui/${userInfo2().uid}`;
}
function serviceTarget() {
  return `${userTarget()}/${LAUNCH_AGENT_LABEL}`;
}
function runLaunchctl(args) {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
function bootstrap() {
  return runLaunchctl(["bootstrap", userTarget(), launchAgentPlistPath()]);
}
function bootout() {
  return runLaunchctl(["bootout", serviceTarget()]);
}
function kickstart() {
  return runLaunchctl(["kickstart", "-k", serviceTarget()]);
}
function isLoaded() {
  const r = spawnSync("launchctl", ["print", serviceTarget()], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
async function waitUntilUnloaded(timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function describeService() {
  const r = runLaunchctl(["print", serviceTarget()]);
  return r.stdout || r.stderr || "";
}
async function deletePlist() {
  await rm3(launchAgentPlistPath(), { force: true });
}

// src/daemon/schtasks.ts
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync2 } from "fs";
import { mkdir as mkdir6, rm as rm4, writeFile as writeFile5 } from "fs/promises";
import { dirname as dirname5 } from "path";
function buildLauncherCmd(inputs) {
  return [
    "@echo off",
    `set "PATH=${inputs.envPath}"`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" run >> "${daemonStdoutPath()}" 2>> "${daemonStderrPath()}"`,
    ""
  ].join("\r\n");
}
async function writeLauncherCmd() {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? ""
  });
  const cmdPath = windowsLauncherCmdPath();
  await mkdir6(dirname5(cmdPath), { recursive: true });
  await mkdir6(daemonLogDir(), { recursive: true });
  await writeFile5(cmdPath, content, "utf8");
}
function runSchtasks(args) {
  const r = spawnSync2("schtasks", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
async function installTask() {
  await writeLauncherCmd();
  return runSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    WINDOWS_TASK_NAME,
    "/TR",
    `"${windowsLauncherCmdPath()}"`
  ]);
}
function runTask() {
  return runSchtasks(["/Run", "/TN", WINDOWS_TASK_NAME]);
}
function endTask() {
  return runSchtasks(["/End", "/TN", WINDOWS_TASK_NAME]);
}
function disableTask() {
  return runSchtasks(["/Change", "/TN", WINDOWS_TASK_NAME, "/Disable"]);
}
function endAndDisable() {
  const ended = endTask();
  const disabled = disableTask();
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}
async function restartTask() {
  endTask();
  await waitUntilStopped();
  return runTask();
}
function isTaskRegistered() {
  const r = spawnSync2("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
function isTaskRunning() {
  const r = runSchtasks(["/Query", "/V", "/FO", "LIST", "/TN", WINDOWS_TASK_NAME]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}
function describeTask() {
  const r = runSchtasks(["/Query", "/V", "/FO", "LIST", "/TN", WINDOWS_TASK_NAME]);
  return r.stdout || r.stderr || "";
}
async function waitUntilStopped(timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function deleteTask() {
  const r = runSchtasks(["/Delete", "/F", "/TN", WINDOWS_TASK_NAME]);
  if (existsSync2(windowsLauncherCmdPath())) {
    await rm4(windowsLauncherCmdPath(), { force: true });
  }
  return r;
}

// src/daemon/systemd.ts
import { spawnSync as spawnSync3 } from "child_process";
import { existsSync as existsSync3 } from "fs";
import { mkdir as mkdir7, rm as rm5, writeFile as writeFile6 } from "fs/promises";
import { dirname as dirname6 } from "path";
function buildUnit(inputs) {
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[Unit]
Description=Lark Channel Bridge bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${escape(inputs.nodePath)}" "${escape(inputs.bridgeEntryPath)}" run
Restart=always
RestartSec=5
StandardOutput=append:${daemonStdoutPath()}
StandardError=append:${daemonStderrPath()}
Environment="PATH=${escape(inputs.envPath)}"

[Install]
WantedBy=default.target
`;
}
async function writeUnit() {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error("cannot determine bridge entry path (process.argv[1] is empty)");
  }
  const content = buildUnit({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? ""
  });
  const unitPath = systemdUnitPath();
  await mkdir7(dirname6(unitPath), { recursive: true });
  await mkdir7(daemonLogDir(), { recursive: true });
  await writeFile6(unitPath, content, "utf8");
}
function unitExists() {
  return existsSync3(systemdUnitPath());
}
function runSystemctl(args) {
  const r = spawnSync3("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? ""
  };
}
function daemonReload() {
  return runSystemctl(["daemon-reload"]);
}
function enableAndStart() {
  return runSystemctl(["enable", "--now", SYSTEMD_UNIT_NAME]);
}
function stop() {
  return runSystemctl(["stop", SYSTEMD_UNIT_NAME]);
}
function disableAndStop() {
  return runSystemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
}
function restart() {
  return runSystemctl(["restart", SYSTEMD_UNIT_NAME]);
}
function isActive() {
  const r = spawnSync3("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return r.status === 0;
}
function describeService2() {
  const r = runSystemctl(["status", SYSTEMD_UNIT_NAME, "--no-pager"]);
  return r.stdout || r.stderr || "";
}
async function waitUntilInactive(timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function deleteUnit() {
  await rm5(systemdUnitPath(), { force: true });
}

// src/daemon/service-adapter.ts
function makeLaunchdAdapter() {
  return {
    platformName: "launchd (macOS)",
    fileExists: plistExists,
    isRunning: isLoaded,
    servicePath: launchAgentPlistPath,
    install: writePlist,
    start: bootstrap,
    stop: bootout,
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: bootout,
    restart: kickstart,
    waitUntilStopped: waitUntilUnloaded,
    deleteFile: deletePlist,
    describeStatus: describeService,
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1]
    })
  };
}
function makeSystemdAdapter() {
  return {
    platformName: "systemd (Linux user)",
    fileExists: unitExists,
    isRunning: isActive,
    servicePath: systemdUnitPath,
    install: async () => {
      await writeUnit();
      daemonReload();
    },
    start: enableAndStart,
    stop,
    stopAndDisableAutostart: disableAndStop,
    restart,
    waitUntilStopped: waitUntilInactive,
    deleteFile: async () => {
      await deleteUnit();
      daemonReload();
    },
    describeStatus: describeService2,
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1]
    })
  };
}
function makeSchtasksAdapter() {
  return {
    platformName: "Task Scheduler (Windows)",
    fileExists: isTaskRegistered,
    isRunning: isTaskRunning,
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => WINDOWS_TASK_NAME,
    install: async () => {
      const r = await installTask();
      if (!r.ok) throw new Error(r.stderr || "schtasks /Create failed");
    },
    start: runTask,
    stop: endTask,
    stopAndDisableAutostart: endAndDisable,
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    restart: restartTask,
    waitUntilStopped,
    deleteFile: async () => {
      await deleteTask();
    },
    describeStatus: describeTask,
    parseStatus: (text) => ({
      // `Process ID: <n>` shows up in verbose listing only when task is running.
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      // `Last Result: <0|nonzero>` — `0` means last run succeeded.
      // Filter the `1056` ("task already running") and `267011` ("task hasn't
      // run") sentinels that aren't real exit codes.
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1]
    })
  };
}
function getServiceAdapter() {
  if (process.platform === "darwin") return makeLaunchdAdapter();
  if (process.platform === "linux") return makeSystemdAdapter();
  if (process.platform === "win32") return makeSchtasksAdapter();
  return null;
}

// src/cli/preflight.ts
import { spawn as spawn2, spawnSync as spawnSync4 } from "child_process";
import * as p from "@clack/prompts";
var INSTALL_TIMEOUT_MS = 5 * 60 * 1e3;
var BIND_TIMEOUT_MS = 30 * 1e3;
var BOLD = "\x1B[1m";
var RESET = "\x1B[0m";
var MANUAL_INSTALL_HINT = [
  "\u624B\u52A8\u5B89\u88C5\u547D\u4EE4:",
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  `  ${BOLD}lark-cli config bind --source lark-channel --identity bot-only${RESET}`,
  "",
  "\u5B8C\u6574\u6587\u6863: https://github.com/larksuite/cli"
].join("\n");
async function preFlightChecks(opts) {
  await checkLarkCli(opts);
}
async function checkLarkCli(opts) {
  if (opts.skipCheckLarkCli) return;
  if (isLarkCliInstalled()) return;
  console.log(
    [
      "",
      "\u2139\uFE0F  lark-cli \u672A\u5B89\u88C5",
      "",
      "lark-cli \u662F\u98DE\u4E66\u7684\u547D\u4EE4\u884C\u5DE5\u5177,\u88C5\u4E0A\u540E Claude \u53EF\u4EE5:",
      "  \u2022 \u4E3B\u52A8\u53D1\u9001\u4EA4\u4E92\u5361\u7247 / \u8868\u5355",
      "  \u2022 \u67E5\u8BE2\u65E5\u5386\u3001\u6587\u6863\u3001\u5F85\u529E\u3001OKR\u3001\u8003\u52E4",
      "  \u2022 200+ \u98DE\u4E66 API \u547D\u4EE4",
      ""
    ].join("\n")
  );
  if (!process.stdin.isTTY) {
    console.log(`(\u975E\u4EA4\u4E92\u6A21\u5F0F,\u8DF3\u8FC7\u81EA\u52A8\u5B89\u88C5)

${MANUAL_INSTALL_HINT}
`);
    return;
  }
  p.intro("Setting up lark-cli");
  const sInstall = p.spinner();
  sInstall.start("Installing lark-cli");
  const installResult = await runCapture(
    "npm",
    ["install", "-g", "@larksuite/cli"],
    INSTALL_TIMEOUT_MS
  );
  if (!installResult.success || !isLarkCliInstalled()) {
    sInstall.error("Install failed");
    if (installResult.output.trim()) {
      console.error(installResult.output);
    }
    p.outro("lark-cli \u5B89\u88C5\u672A\u5B8C\u6210");
    printInstallFailedWarning();
    return;
  }
  sInstall.stop("Installed");
  const sBind = p.spinner();
  sBind.start("Binding to bridge credentials");
  const bindResult = await runCapture(
    "lark-cli",
    ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"],
    BIND_TIMEOUT_MS
  );
  if (!bindResult.success) {
    sBind.error("Bind failed");
    if (bindResult.output.trim()) {
      console.log(bindResult.output);
    }
    p.outro("lark-cli \u5DF2\u88C5,\u4F46\u81EA\u52A8 bind \u5931\u8D25");
    console.log(
      `\u8BF7\u624B\u52A8\u6267\u884C:
  ${BOLD}lark-cli config bind --source lark-channel --identity bot-only${RESET}
`
    );
    return;
  }
  sBind.stop("Bound");
  p.outro("Done");
}
function printInstallFailedWarning() {
  console.error(
    [
      "",
      `${BOLD}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${RESET}`,
      `${BOLD}\u2551  \u26A0\uFE0F  lark-cli \u81EA\u52A8\u5B89\u88C5\u5931\u8D25                                     \u2551${RESET}`,
      `${BOLD}\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}`,
      "",
      "\u539F\u56E0\u53EF\u80FD\u662F:\u7F51\u7EDC\u4E0D\u901A / npm \u5168\u5C40\u5B89\u88C5\u65E0\u6743\u9650 / registry \u5F02\u5E38",
      "",
      "Bridge \u4ECD\u4F1A\u7EE7\u7EED\u542F\u52A8,\u4F46 Claude \u5DE5\u5177\u8C03\u7528\u4F1A\u53D7\u9650\u3002",
      "\u8BF7\u624B\u52A8\u6267\u884C:",
      "",
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      `  ${BOLD}lark-cli config bind --source lark-channel --identity bot-only${RESET}`,
      "",
      "\u5B8C\u6574\u6587\u6863: https://github.com/larksuite/cli",
      "\u88C5\u5B8C\u4E4B\u540E\u65E0\u9700\u91CD\u542F bridge(\u5B83\u53EA\u5728\u542F\u52A8\u65F6\u68C0\u6D4B\u4E00\u6B21)\u3002",
      ""
    ].join("\n")
  );
}
function isLarkCliInstalled() {
  try {
    const result = spawnSync4("lark-cli", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: process.platform === "win32"
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
async function runCapture(cmd, args, timeoutMs) {
  const onWindows = process.platform === "win32";
  let captured = "";
  let timedOut = false;
  const exitCode = await new Promise((resolve) => {
    const child = spawn2(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: onWindows
    });
    child.stdout?.on("data", (b) => {
      captured += b.toString("utf8");
    });
    child.stderr?.on("data", (b) => {
      captured += b.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { success: !timedOut && exitCode === 0, output: captured };
}

// src/cli/commands/service.ts
function requireAdapter(cmdName) {
  const adapter = getServiceAdapter();
  if (!adapter) {
    console.error(
      `${cmdName}: \u5F53\u524D\u7CFB\u7EDF\u4E0D\u652F\u6301\u540E\u53F0\u8FD0\u884C\u3002`
    );
    console.error("  \u76EE\u524D\u652F\u6301: macOS (launchd) / Linux (systemd)");
    console.error("  Windows \u652F\u6301\u540E\u7EED\u7248\u672C\u3002");
    process.exit(1);
  }
  return adapter;
}
function formatServiceStderr(stderr) {
  return stderr.split("\n").filter((line) => !/re-running the command as root/i.test(line)).join("\n").trim();
}
function printServiceFailure(verb, stderr) {
  const cleaned = formatServiceStderr(stderr);
  const action = verb === "started" ? "\u542F\u52A8" : "\u91CD\u542F";
  if (/bootstrap failed.*input\/output error/i.test(cleaned)) {
    console.error(`\u2717 bot ${action}\u5931\u8D25\u3002`);
    console.error("");
    console.error("\u6700\u5E38\u89C1\u539F\u56E0:\u65E7\u7684 bot \u5B9E\u4F8B\u8FD8\u5728\u6536\u5C3E\u3002\u8BF7\u8BD5\u4EE5\u4E0B\u4EFB\u4E00\u79CD:");
    console.error("  1. \u7A0D\u7B49\u51E0\u79D2,\u91CD\u65B0\u8FD0\u884C `start`");
    console.error("  2. \u6216\u5F7B\u5E95\u6E05\u9664\u6CE8\u518C\u518D\u542F\u52A8:");
    console.error("       unregister");
    console.error("       start");
    console.error("");
    console.error("\u539F\u59CB\u9519\u8BEF:");
    console.error(`  ${cleaned}`);
    return;
  }
  console.error(`\u2717 bot ${action}\u5931\u8D25:`);
  console.error(cleaned);
}
async function ensureBridgeConfigured() {
  const cfg = await loadConfig();
  if (!isComplete(cfg)) {
    console.error("bot \u8FD8\u6CA1\u914D\u7F6E app \u51ED\u636E\u3002");
    console.error("\u8BF7\u5148\u8FD0\u884C `run` \u5B8C\u6210\u9996\u6B21\u626B\u7801\u5411\u5BFC,\u518D\u56DE\u6765 `start`\u3002");
    process.exit(1);
  }
}
async function waitForServiceConnect(appId, beforePids, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readAndPrune();
    const fresh = live.find(
      (e) => e.appId === appId && !beforePids.has(e.pid) && Boolean(e.botName)
    );
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 500));
  }
  return void 0;
}
async function reportConnectAfter(verb, fn) {
  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id ?? "";
  const beforePids = new Set(
    readAndPrune().filter((e) => e.appId === appId).map((e) => e.pid)
  );
  const r = await fn();
  if (!r.ok) {
    printServiceFailure(verb, r.stderr);
    process.exit(1);
  }
  const action = verb === "started" ? "\u6B63\u5728\u7B49\u5F85 bot \u8FDE\u63A5..." : "\u6B63\u5728\u7B49\u5F85 bot \u91CD\u65B0\u8FDE\u63A5...";
  console.log(action);
  const entry = await waitForServiceConnect(appId, beforePids);
  if (entry) {
    const agent = new ClaudeAdapter();
    const verbZh = verb === "started" ? "\u5DF2\u542F\u52A8" : "\u5DF2\u91CD\u542F";
    console.log(
      `\u2713 ${verbZh}  bot: ${entry.botName} (${entry.appId})  agent: ${agent.displayName} (${agent.id})  \u8FDB\u7A0B: ${entry.id}`
    );
    return;
  }
  console.warn(`\u26A0 \u5DF2\u4E0B\u53D1\u6307\u4EE4,\u4F46 30 \u79D2\u5185\u672A\u89C2\u5BDF\u5230 bot \u8FDE\u63A5\u6210\u529F (${verb})\u3002`);
  console.warn(`  \u67E5\u770B\u65E5\u5FD7: tail -f ${daemonStderrPath()}`);
  console.warn(`              tail -f ${daemonStdoutPath()}`);
}
async function runServiceStart(opts = {}) {
  const adapter = requireAdapter("start");
  await ensureBridgeConfigured();
  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });
  await adapter.install();
  if (adapter.isRunning()) {
    console.log("\u68C0\u6D4B\u5230\u65E7 bot \u5B9E\u4F8B,\u5148\u505C\u6389\u518D\u91CD\u542F...");
    const r = await adapter.stop();
    if (!r.ok) {
      console.warn(`\u26A0 \u505C\u6B62\u65E7\u5B9E\u4F8B\u65F6\u6709\u8B66\u544A(\u7EE7\u7EED\u91CD\u542F):
${formatServiceStderr(r.stderr)}`);
    }
    const ok = await adapter.waitUntilStopped();
    if (!ok) {
      console.error("\u2717 \u65E7 bot \u5B9E\u4F8B\u6CA1\u6709\u5B8C\u5168\u505C\u6B62\u3002\u8BF7\u7A0D\u540E\u91CD\u8BD5,\u6216:");
      console.error("  unregister  # \u5F3A\u5236\u6E05\u9664\u6CE8\u518C");
      console.error("  start       # \u518D\u6B21\u542F\u52A8");
      process.exit(1);
    }
  }
  await reportConnectAfter("started", adapter.start);
}
async function runServiceStop() {
  const adapter = requireAdapter("stop");
  if (!adapter.fileExists()) {
    console.log("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7,\u65E0\u9700\u505C\u6B62\u3002");
    return;
  }
  if (!adapter.isRunning()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u3002");
    return;
  }
  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id;
  const entry = appId ? readAndPrune().find((e) => e.appId === appId && Boolean(e.botName)) : void 0;
  const r = await adapter.stopAndDisableAutostart();
  if (!r.ok) {
    console.error(`\u2717 \u505C\u6B62\u5931\u8D25:
${formatServiceStderr(r.stderr)}`);
    process.exit(1);
  }
  if (entry) {
    console.log(`\u2713 bot ${entry.botName} (${entry.appId}) \u5DF2\u505C\u6B62\u8FD0\u884C`);
  } else {
    console.log("\u2713 bot \u5DF2\u505C\u6B62\u8FD0\u884C");
  }
  console.log("  \u901A\u8FC7 `start` \u53EF\u518D\u6B21\u91CD\u542F");
}
async function runServiceRestart() {
  const adapter = requireAdapter("restart");
  if (!adapter.fileExists()) {
    console.error("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7\u3002\u8BF7\u5148\u8FD0\u884C `start` \u542F\u52A8\u3002");
    process.exit(1);
  }
  if (adapter.isRunning()) {
    await reportConnectAfter("restarted", adapter.restart);
    return;
  }
  await reportConnectAfter("started", adapter.start);
}
async function runServiceStatus() {
  const adapter = requireAdapter("status");
  if (!adapter.fileExists()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C(\u4ECE\u672A\u542F\u52A8\u8FC7)");
    console.log("  \u901A\u8FC7 `start` \u542F\u52A8 bot");
    return;
  }
  if (!adapter.isRunning()) {
    console.log("bot \u5F53\u524D\u6CA1\u5728\u540E\u53F0\u8FD0\u884C");
    console.log("  \u901A\u8FC7 `start` \u91CD\u65B0\u542F\u52A8");
    return;
  }
  const cfg = await loadConfig();
  const appId = cfg.accounts?.app?.id;
  const entry = appId ? readAndPrune().find((e) => e.appId === appId && Boolean(e.botName)) : void 0;
  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());
  if (entry) {
    console.log(`\u2713 bot ${entry.botName} (${entry.appId}) \u6B63\u5728\u540E\u53F0\u8FD0\u884C`);
  } else {
    console.log("\u2713 bot \u6B63\u5728\u540E\u53F0\u8FD0\u884C");
  }
  if (pid) console.log(`  \u8FDB\u7A0B ID: ${pid}`);
  console.log("  \u65E5\u5FD7:");
  console.log(`    ${daemonStdoutPath()}`);
  console.log(`    ${daemonStderrPath()}`);
  if (lastExit && lastExit !== "-1") console.log(`  \u4E0A\u6B21\u9000\u51FA\u7801: ${lastExit}`);
}
async function runServiceUnregister() {
  const adapter = requireAdapter("unregister");
  if (!adapter.fileExists()) {
    console.log("bot \u8FD8\u6CA1\u5728\u540E\u53F0\u8FD0\u884C\u8FC7,\u65E0\u9700\u6E05\u7406\u3002");
    return;
  }
  if (adapter.isRunning()) {
    const r = await adapter.stopAndDisableAutostart();
    if (!r.ok) {
      console.warn(`\u26A0 \u505C\u6B62 bot \u65F6\u6709\u8B66\u544A(\u7EE7\u7EED\u6E05\u7406):
${formatServiceStderr(r.stderr)}`);
    } else {
      console.log("\u2713 \u5DF2\u505C\u6B62 bot");
    }
  }
  await adapter.deleteFile();
  console.log("\u2713 \u5DF2\u6E05\u9664\u540E\u53F0\u8FD0\u884C\u6CE8\u518C");
  console.log("  (\u914D\u7F6E / \u65E5\u5FD7 / \u4F1A\u8BDD\u4FDD\u7559\u5728 ~/.lark-channel/)");
}

// src/cli/commands/start.ts
import dns from "dns";
import { createInterface as createInterface4 } from "readline";

// src/bot/channel.ts
import { homedir as homedir6 } from "os";
import { Domain, LoggerLevel, createLarkChannel } from "@larksuiteoapi/node-sdk";

// src/commands/index.ts
import { stat as stat4 } from "fs/promises";
import { homedir as homedir4 } from "os";

// src/card/account-cards.ts
function maskAppId(id) {
  if (id.length < 12) return id;
  return `${id.slice(0, 13)}****${id.slice(-2)}`;
}
function accountCurrentCard(info) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5F53\u524D\u5E94\u7528" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "\u{1F4CB} **\u5F53\u524D\u5E94\u7528**",
            "",
            `**App ID**: \`${maskAppId(info.appId)}\``,
            `**Bot \u540D**: ${info.botName ?? "(\u672A\u77E5)"}`,
            `**Tenant**: ${info.tenant}`
          ].join("\n")
        },
        { tag: "hr" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "\u66F4\u6362\u51ED\u636E" },
          type: "primary",
          behaviors: [{ type: "callback", value: { cmd: "account.change" } }]
        }
      ]
    }
  };
}
function accountFormCard(opts = {}) {
  const { initialTenant = "feishu", prefillAppId, errorMessage } = opts;
  const bodyElements = [];
  if (errorMessage) {
    bodyElements.push({
      tag: "markdown",
      content: `\u274C **\u6821\u9A8C\u5931\u8D25**\uFF1A${errorMessage}`
    });
  }
  bodyElements.push({
    tag: "form",
    name: "account_form",
    elements: [
      {
        tag: "input",
        name: "app_id",
        label: { tag: "plain_text", content: "App ID" },
        placeholder: { tag: "plain_text", content: "cli_xxxxxxxxxxxx" },
        ...prefillAppId ? { default_value: prefillAppId } : {},
        required: true
      },
      {
        tag: "input",
        name: "app_secret",
        label: { tag: "plain_text", content: "App Secret" },
        placeholder: { tag: "plain_text", content: "32 \u4F4D\u5B57\u7B26\u4E32" },
        // Never prefill secret — even on validation retry. Pre-filled secrets
        // can leak into Lark's server-side card cache.
        required: true
      },
      { tag: "markdown", content: "**Tenant**" },
      {
        tag: "select_static",
        name: "tenant",
        initial_option: initialTenant,
        options: [
          { text: { tag: "plain_text", content: "Feishu (\u56FD\u5185)" }, value: "feishu" },
          { text: { tag: "plain_text", content: "Lark (\u6D77\u5916)" }, value: "lark" }
        ]
      },
      {
        tag: "column_set",
        flex_mode: "flow",
        horizontal_spacing: "small",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "button",
                name: "submit_btn",
                text: { tag: "plain_text", content: "\u63D0\u4EA4" },
                type: "primary",
                form_action_type: "submit",
                behaviors: [{ type: "callback", value: { cmd: "account.submit" } }]
              }
            ]
          },
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "button",
                name: "cancel_btn",
                text: { tag: "plain_text", content: "\u53D6\u6D88" },
                behaviors: [{ type: "callback", value: { cmd: "account.cancel" } }]
              }
            ]
          }
        ]
      }
    ]
  });
  return {
    schema: "2.0",
    config: { summary: { content: "\u66F4\u6362\u51ED\u636E" } },
    body: { elements: bodyElements }
  };
}
function accountSuccessCard(info) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5DF2\u4FDD\u5B58" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "\u2705 **\u51ED\u636E\u5DF2\u4FDD\u5B58**",
            "",
            `**App ID**: \`${maskAppId(info.appId)}\``,
            info.botName ? `**Bot \u540D**: ${info.botName}` : "",
            `**Tenant**: ${info.tenant}`,
            "",
            "\u6B63\u5728\u7528\u65B0\u51ED\u636E\u91CD\u8FDE WebSocket...",
            "\u26A0\uFE0F \u5982\u679C\u65B0 bot \u4E0D\u5728\u6B64\u7FA4\uFF0C\u540E\u7EED\u6D88\u606F\u5C06\u7531\u65B0 bot \u63A5\u7BA1\uFF0C\u8001 bot \u4E0D\u4F1A\u518D\u56DE\u590D\u3002"
          ].filter(Boolean).join("\n")
        }
      ]
    }
  };
}
function accountFailureCard(reason) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u6821\u9A8C\u5931\u8D25" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `\u274C **\u6821\u9A8C\u5931\u8D25**

\`${reason}\`

\u8BF7\u68C0\u67E5 App ID \u548C Secret \u662F\u5426\u6B63\u786E\uFF0C\u91CD\u53D1 \`/account change\` \u91CD\u8BD5\u3002`
        }
      ]
    }
  };
}

// src/card/config-card.ts
function configFormCard(opts) {
  return {
    schema: "2.0",
    config: { summary: { content: "\u504F\u597D\u8BBE\u7F6E" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "\u2699\uFE0F **\u504F\u597D\u8BBE\u7F6E**\n\n\u8C03\u6574 bot \u7684\u884C\u4E3A\u504F\u597D\u3002\u6539\u5B8C\u70B9\u63D0\u4EA4,**\u7ACB\u5373\u751F\u6548**(\u65E0\u9700\u91CD\u542F)\u5E76\u5199\u5165 `~/.lark-channel/config.json`\u3002"
        },
        { tag: "hr" },
        {
          tag: "form",
          name: "config_form",
          elements: [
            {
              tag: "markdown",
              content: "**\u6D88\u606F\u56DE\u590D\u65B9\u5F0F**\n_\u7EAF\u6587\u672C:agent \u8DD1\u5B8C\u4E00\u6B21\u6027\u53D1\u51FA,\u4E0D\u6D41\u5F0F,\u4F53\u611F\u6700\u8F7B_\n_\u6D88\u606F\u5361\u7247:\u8F7B\u91CF\u6D41\u5F0F markdown \u5361\u7247,\u98DE\u4E66\u539F\u751F\u6253\u5B57\u673A\u52A8\u753B_"
            },
            {
              tag: "select_static",
              name: "message_reply",
              // 'card' (交互卡片) is hidden from the picker for now; existing
              // configs with `messageReply: 'card'` still work — showConfigForm
              // displays them as 'markdown' in the form, but submitting only
              // overwrites if the user actually picks something.
              initial_option: opts.messageReply === "card" ? "markdown" : opts.messageReply,
              options: [
                { text: { tag: "plain_text", content: "\u7EAF\u6587\u672C" }, value: "text" },
                { text: { tag: "plain_text", content: "\u6D88\u606F\u5361\u7247(\u9ED8\u8BA4)" }, value: "markdown" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**\u5DE5\u5177\u8C03\u7528\u663E\u793A**\n_\u663E\u793A:\u53EF\u4EE5\u770B\u5230 bot \u8DD1\u4E86\u4EC0\u4E48\u547D\u4EE4\u3001\u8BFB\u4E86\u54EA\u4E9B\u6587\u4EF6\u7B49\u8FC7\u7A0B_\n_\u9690\u85CF:\u53EA\u770B agent \u6700\u7EC8\u7684\u6587\u5B57\u7B54\u590D,\u8DF3\u8FC7\u6240\u6709\u5DE5\u5177\u5757_"
            },
            {
              tag: "select_static",
              name: "show_tool_calls",
              initial_option: opts.showToolCalls ? "show" : "hide",
              options: [
                { text: { tag: "plain_text", content: "\u663E\u793A(\u9ED8\u8BA4)" }, value: "show" },
                { text: { tag: "plain_text", content: "\u9690\u85CF" }, value: "hide" }
              ]
            },
            {
              tag: "markdown",
              content: "\n**\u5E76\u53D1\u4E0A\u9650**\n_\u5168\u5C40\u540C\u65F6\u8FD0\u884C\u7684 agent \u8FDB\u7A0B\u6570(\u4E3B\u8981\u5F71\u54CD\u8BDD\u9898\u7FA4\u591A\u8BDD\u9898\u5E76\u884C\u573A\u666F)_\n_\u9ED8\u8BA4 10,\u8303\u56F4 1-50\u3002\u8D85\u51FA\u7684\u8BF7\u6C42\u4F1A FIFO \u6392\u961F_"
            },
            {
              tag: "input",
              name: "max_concurrent_runs",
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: "plain_text", content: "10" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: "\n**run \u63A2\u6D3B(\u5206\u949F)**\n_agent \u957F\u65F6\u95F4\u6CA1\u8F93\u51FA\u65F6\u81EA\u52A8 kill,\u9632\u6B62\u5047\u6B7B_\n_0 = \u5173\u95ED(\u9ED8\u8BA4),\u8303\u56F4 1-120\u3002\u53EF\u88AB `/timeout` \u5728\u5355\u4E2A scope \u8986\u76D6_"
            },
            {
              tag: "input",
              name: "run_idle_timeout_minutes",
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: "plain_text", content: "0" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: "\n**\u7FA4\u91CC\u9700\u8981 @ bot**\n_\u662F(\u9ED8\u8BA4):\u7FA4\u548C\u8BDD\u9898\u7FA4\u91CC,\u4E0D @ bot \u7684\u6D88\u606F\u4E0D\u4F1A\u89E6\u53D1\u56DE\u590D,bot \u4E0D\u63A5\u7FA4\u91CC\u804A\u5929_\n_\u5426:\u4EFB\u4F55\u6D88\u606F\u90FD\u4F1A\u53D1\u7ED9 agent(0.1.21 \u53CA\u66F4\u65E9\u7248\u672C\u7684\u884C\u4E3A)_\n_\u79C1\u804A\u6C38\u8FDC\u4E0D\u9700\u8981 @;`@\u5168\u5458` \u6C38\u8FDC\u4E0D\u54CD\u5E94_"
            },
            {
              tag: "select_static",
              name: "require_mention_in_group",
              initial_option: opts.requireMentionInGroup ? "yes" : "no",
              options: [
                { text: { tag: "plain_text", content: "\u662F(\u9ED8\u8BA4)" }, value: "yes" },
                { text: { tag: "plain_text", content: "\u5426" }, value: "no" }
              ]
            },
            { tag: "hr" },
            {
              tag: "markdown",
              content: "\u{1F512} **\u8BBF\u95EE\u63A7\u5236**\n\n_\u63A7\u5236\u8C01\u80FD\u8DDF bot \u4EA4\u4E92\u3001\u8C01\u80FD\u8DD1\u654F\u611F\u547D\u4EE4\u3002\u7559\u7A7A = \u4E0D\u9650\u5236\uFF08\u9ED8\u8BA4\uFF09_"
            },
            {
              tag: "markdown",
              content: "\n**\u7528\u6237\u767D\u540D\u5355**(`allowedUsers`)\n_\u53EA\u5141\u8BB8\u5217\u8868\u5185\u7684 open_id \u8DDF bot \u4EA4\u4E92\u3002\u591A\u4E2A\u7528\u82F1\u6587\u9017\u53F7\u5206\u9694\u3002\u7559\u7A7A = \u4E0D\u9650\u5236_\n_open_id \u53EF\u4ECE\u65E5\u5FD7 `~/.lark-channel/logs/*.log` \u91CC grep `senderId` \u5B57\u6BB5_"
            },
            {
              tag: "input",
              name: "allowed_users",
              default_value: opts.allowedUsers,
              placeholder: { tag: "plain_text", content: "ou_xxx, ou_yyy\uFF08\u7559\u7A7A=\u4E0D\u9650\u5236\uFF09" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: '\n**\u7FA4\u767D\u540D\u5355**(`allowedChats`)\n_\u53EA\u9650\u5236\u7FA4\uFF08\u542B\u8BDD\u9898\u7FA4\uFF09\u2014\u2014bot \u53EA\u5728\u540D\u5355\u5185\u7684\u7FA4\u54CD\u5E94\u3002\u591A\u4E2A\u7528\u82F1\u6587\u9017\u53F7\u5206\u9694\u3002\u7559\u7A7A = \u6240\u6709\u7FA4\u90FD\u54CD\u5E94_\n_\u26A0\uFE0F \u79C1\u804A\u4E0D\u53D7\u6B64\u7EA6\u675F,DM \u7684\u8BBF\u95EE\u6743\u7531"\u7528\u6237\u767D\u540D\u5355"\u51B3\u5B9A_'
            },
            {
              tag: "input",
              name: "allowed_chats",
              default_value: opts.allowedChats,
              placeholder: { tag: "plain_text", content: "oc_xxx, oc_yyy\uFF08\u7559\u7A7A=\u6240\u6709\u7FA4\uFF09" },
              input_type: "text"
            },
            {
              tag: "markdown",
              content: "\n**\u7BA1\u7406\u5458**(`admins`)\n_\u53EA\u5141\u8BB8\u8FD9\u4E9B open_id \u8DD1\u654F\u611F\u547D\u4EE4: `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws`_\n_\u7559\u7A7A = \u4E0D\u505A\u7BA1\u7406\u5458\u9650\u5236(\u6240\u6709\u653E\u884C\u7684\u7528\u6237\u90FD\u80FD\u8DD1)\u3002\u26A0\uFE0F \u6539\u4E3A\u975E\u7A7A\u65F6\u52A1\u5FC5\u628A\u81EA\u5DF1\u5305\u542B\u5728\u5185,\u5426\u5219\u4F1A\u81EA\u9501\u51FA /config_"
            },
            {
              tag: "input",
              name: "admins",
              default_value: opts.admins,
              placeholder: { tag: "plain_text", content: "ou_xxx, ou_yyy\uFF08\u7559\u7A7A=\u4E0D\u9650\u5236\uFF09" },
              input_type: "text"
            },
            {
              tag: "column_set",
              flex_mode: "flow",
              horizontal_spacing: "small",
              columns: [
                {
                  tag: "column",
                  width: "auto",
                  elements: [
                    {
                      tag: "button",
                      name: "submit_btn",
                      text: { tag: "plain_text", content: "\u63D0\u4EA4" },
                      type: "primary",
                      form_action_type: "submit",
                      behaviors: [{ type: "callback", value: { cmd: "config.submit" } }]
                    }
                  ]
                },
                {
                  tag: "column",
                  width: "auto",
                  elements: [
                    {
                      tag: "button",
                      name: "cancel_btn",
                      text: { tag: "plain_text", content: "\u53D6\u6D88" },
                      behaviors: [{ type: "callback", value: { cmd: "config.cancel" } }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}
function configSavedCard(opts) {
  const replyLabel = opts.messageReply === "card" ? "\u4EA4\u4E92\u5361\u7247" : opts.messageReply === "markdown" ? "\u6D88\u606F\u5361\u7247" : "\u7EAF\u6587\u672C";
  const summarizeList = (raw) => {
    const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return items.length === 0 ? "_(\u4E0D\u9650\u5236)_" : `${items.length} \u9879`;
  };
  return {
    schema: "2.0",
    config: { summary: { content: "\u504F\u597D\u5DF2\u4FDD\u5B58" } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `\u2705 **\u504F\u597D\u5DF2\u4FDD\u5B58**

**\u6D88\u606F\u56DE\u590D\u65B9\u5F0F**:${replyLabel}
**\u5DE5\u5177\u8C03\u7528\u663E\u793A**:\`${opts.showToolCalls ? "show" : "hide"}\`
**\u5E76\u53D1\u4E0A\u9650**:\`${opts.maxConcurrentRuns}\`
**run \u63A2\u6D3B**:\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} \u5206\u949F` : "\u5173\u95ED"}\`
**\u7FA4\u91CC\u9700\u8981 @ bot**:\`${opts.requireMentionInGroup ? "\u662F" : "\u5426"}\`

\u{1F512} **\u8BBF\u95EE\u63A7\u5236**
**\u7528\u6237\u767D\u540D\u5355**:${summarizeList(opts.allowedUsers)}
**\u7FA4\u767D\u540D\u5355**:${summarizeList(opts.allowedChats)}
**\u7BA1\u7406\u5458**:${summarizeList(opts.admins)}

\u4E0B\u6761\u6D88\u606F\u5F00\u59CB\u751F\u6548\u3002`
        }
      ]
    }
  };
}
function configCancelledCard() {
  return {
    schema: "2.0",
    config: { summary: { content: "\u5DF2\u53D6\u6D88" } },
    body: {
      elements: [{ tag: "markdown", content: "\u5DF2\u53D6\u6D88,\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\u3002" }]
    }
  };
}

// src/card/managed.ts
var byMessageId = /* @__PURE__ */ new Map();
async function sendManagedCard(channel, chatId, card, replyTo) {
  const created = await channel.rawClient.cardkit.v1.card.create({
    data: { type: "card_json", data: JSON.stringify(card) }
  });
  const cardId = created.data?.card_id;
  if (!cardId) {
    throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
  }
  const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
  let messageId;
  if (replyTo) {
    const sent = await channel.rawClient.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "interactive", content }
    });
    messageId = sent.data?.message_id;
  } else {
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content }
    });
    messageId = sent.data?.message_id;
  }
  if (!messageId) {
    throw new Error("send card-by-reference returned no message_id");
  }
  byMessageId.set(messageId, { cardId, sequence: 0 });
  return { messageId, cardId };
}
async function updateManagedCard(channel, messageId, card) {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: {
        card: { type: "card_json", data: JSON.stringify(card) },
        sequence: entry.sequence
      }
    });
  } catch (err) {
    log.fail("card", err, { step: "managed-update", cardId: entry.cardId, seq: entry.sequence });
    throw err;
  }
}
function forgetManagedCard(messageId) {
  byMessageId.delete(messageId);
}

// src/card/templates.ts
function button(spec) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: spec.text },
    type: spec.style ?? "default",
    value: spec.value
  };
}
function divMd(content) {
  return { tag: "div", text: { tag: "lark_md", content } };
}
function actions(buttons) {
  return { tag: "action", actions: buttons.map(button) };
}
var HR = { tag: "hr" };
function shell(title, elements) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: title } },
    elements
  };
}
function workspacesCard(current, named) {
  const entries = Object.entries(named);
  const elements = [];
  elements.push(divMd(`\u5F53\u524D cwd\uFF1A\`${escapeCode(current ?? "(\u672A\u8BBE\u7F6E\uFF0C\u4F7F\u7528 $HOME)")}\``));
  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd("\u6682\u65E0\u547D\u540D\u5DE5\u4F5C\u7A7A\u95F4\u3002"));
    elements.push(
      divMd("\u{1F4A1} \u53D1\u9001 `/ws save <name>` \u628A\u5F53\u524D cwd \u5B58\u4E3A\u547D\u540D\u5DE5\u4F5C\u7A7A\u95F4")
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? "  \u2190 \u5F53\u524D" : "";
      elements.push(divMd(`**${escapeMd(name)}** \u2192 \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: "\u5207\u6362\u5230\u6B64\u5904", value: { cmd: "ws.use", name }, style: "primary" },
          { text: "\u5220\u9664", value: { cmd: "ws.remove", name }, style: "danger" }
        ])
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }
  return shell("\u{1F4C2} \u5DE5\u4F5C\u7A7A\u95F4", elements);
}
function statusCard(info) {
  const sessionLine = info.sessionId ? `\`${info.sessionId.slice(0, 8)}\u2026\`${info.sessionStale ? " \u26A0\uFE0F \u65E7 cwd\uFF0C\u4E0B\u4E00\u6761\u4F1A\u65B0\u5EFA" : ""}` : "(\u65E0)";
  const scopeLine = info.chatMode === "topic" ? `\`${escapeCode(info.scope)}\` _\uFF08\u8BDD\u9898\u72EC\u7ACB session\uFF09_` : `\`${escapeCode(info.scope)}\``;
  const lines = [
    `\u{1F9ED} **scope**: ${scopeLine}`,
    `\u{1F4C1} **cwd**: \`${escapeCode(info.cwd)}\``,
    `\u{1F517} **session**: ${sessionLine}`,
    `\u{1F916} **agent**: ${escapeMd(info.agentName)}`
  ];
  return shell("\u{1F4CA} \u5F53\u524D\u72B6\u6001", [
    divMd(lines.join("\n")),
    HR,
    actions([
      { text: "\u{1F195} \u65B0\u4F1A\u8BDD", value: { cmd: "new" }, style: "primary" },
      { text: "\u{1F501} \u6062\u590D\u4F1A\u8BDD", value: { cmd: "resume" } },
      { text: "\u{1F4C2} \u5DE5\u4F5C\u7A7A\u95F4", value: { cmd: "ws.list" } },
      { text: "\u{1F4A1} \u5E2E\u52A9", value: { cmd: "help" } }
    ])
  ]);
}
function resumeCard(cwd, entries) {
  const elements = [];
  elements.push(divMd(`\u5F53\u524D cwd\uFF1A\`${escapeCode(cwd)}\``));
  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd("\u6B64 cwd \u4E0B\u6CA1\u6709\u5386\u53F2\u4F1A\u8BDD\u3002"));
    return shell("\u{1F501} \u6062\u590D\u5386\u53F2\u4F1A\u8BDD", elements);
  }
  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? "  \u2190 \u5F53\u524D" : "";
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}
\`${e.sessionId.slice(0, 8)}\u2026\` \xB7 ${e.relTime} \xB7 ${e.lineCount} \u6761`
      )
    );
    elements.push(
      actions([
        {
          text: e.current ? "\u5DF2\u662F\u5F53\u524D\u4F1A\u8BDD" : "\u25B8 \u6062\u590D\u6B64\u4F1A\u8BDD",
          value: { cmd: "resume.use", arg: e.sessionId },
          style: e.current ? "default" : "primary"
        }
      ])
    );
    if (i < entries.length - 1) elements.push(HR);
  });
  return shell("\u{1F501} \u6062\u590D\u5386\u53F2\u4F1A\u8BDD", elements);
}
function helpCard() {
  return shell("\u{1F4A1} \u4F7F\u7528\u5E2E\u52A9", [
    divMd(
      [
        "**\u547D\u4EE4\u5217\u8868**",
        "",
        "- `/new` `/reset` \u2014 \u6E05\u7A7A\u5F53\u524D chat \u7684\u4F1A\u8BDD",
        "- `/new chat [name]` \u2014 \u65B0\u5EFA\u7FA4+\u65B0\u4F1A\u8BDD\uFF0C\u81EA\u52A8\u62C9\u4F60\u8FDB\u7FA4",
        "- `/resume [N]` \u2014 \u5217\u51FA\u5E76\u6062\u590D\u5386\u53F2\u4F1A\u8BDD\uFF08\u6700\u591A N \u6761\uFF09",
        "- `/cd <path>` \u2014 \u5207\u6362\u5DE5\u4F5C\u76EE\u5F55\uFF08\u4F1A\u91CD\u7F6E session\uFF09",
        "- `/ws list|save <name>|use <name>|remove <name>` \u2014 \u5DE5\u4F5C\u7A7A\u95F4",
        "- `/account` \u2014 \u67E5\u770B\u5F53\u524D\u5E94\u7528\uFF1B`/account change` \u6362 appId/secret \u5E76\u91CD\u8FDE",
        "- `/config` \u2014 \u8C03\u6574\u504F\u597D\uFF08\u6D88\u606F\u56DE\u590D\u65B9\u5F0F\u3001\u5DE5\u5177\u8C03\u7528\u663E\u793A\uFF09",
        "- `/status` \u2014 \u5F53\u524D\u72B6\u6001",
        "- `/stop` \u2014 \u7ED3\u675F\u5F53\u524D\u6B63\u5728\u8DD1\u7684\u4EFB\u52A1\uFF08\u4E5F\u53EF\u70B9\u5361\u7247\u5E95\u90E8 \u23F9 \u7EC8\u6B62 \u6309\u94AE\uFF09",
        "- `/timeout [N|off|default]` \u2014 \u5F53\u524D session \u7684\u63A2\u6D3B\u5206\u949F\u6570,`/config` \u6539\u5168\u5C40\u9ED8\u8BA4",
        "- `/ps` \u2014 \u5217\u51FA\u672C\u673A\u6240\u6709 bot,\u6807\u8BC6\u5F53\u524D\u6B63\u5728\u56DE\u590D\u7684\u90A3\u4E2A",
        "- `/exit <id|#>` \u2014 \u5173\u6389\u6307\u5B9A bot(\u7528 `/ps` \u770B id/\u5E8F\u53F7)",
        "- `/reconnect` \u2014 \u5F3A\u5236\u91CD\u8FDE WebSocket(\u7F51\u7EDC\u6296\u52A8\u540E bot \u6CA1\u53CD\u5E94\u65F6\u7528)",
        "- `/doctor [\u63CF\u8FF0]` \u2014 \u628A\u65E5\u5FD7\u548C\u63CF\u8FF0\u5582\u7ED9 Claude \u81EA\u52A9\u8BCA\u65AD",
        "- `/help` \u2014 \u672C\u5E2E\u52A9",
        "",
        "\u5176\u4ED6\u5185\u5BB9\u76F4\u63A5\u4EA4\u7ED9 Claude\u3002"
      ].join("\n")
    ),
    HR,
    actions([
      { text: "\u{1F4CA} \u72B6\u6001", value: { cmd: "status" }, style: "primary" },
      { text: "\u{1F501} \u6062\u590D\u4F1A\u8BDD", value: { cmd: "resume" } },
      { text: "\u{1F4C2} \u5DE5\u4F5C\u7A7A\u95F4", value: { cmd: "ws.list" } },
      { text: "\u{1F195} \u65B0\u4F1A\u8BDD", value: { cmd: "new" } }
    ])
  ]);
}
function escapeMd(s) {
  return s.replace(/([*_`\\])/g, "\\$1");
}
function escapeCode(s) {
  return s.replace(/`/g, "'");
}

// src/card/tool-render.ts
var HEADER_SUMMARY_MAX = 80;
var BODY_FIELD_MAX = 600;
var OUTPUT_MAX = 1200;
var BODY_TOTAL_MAX = 2500;
function toolHeaderText(tool) {
  const icon = tool.status === "done" ? "\u2705" : tool.status === "error" ? "\u274C" : "\u23F3";
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** \u2014 ${summary}` : `${icon} **${tool.name}**`;
}
function toolBodyMd(tool) {
  const parts = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);
  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === "error") {
      parts.push(`**Error**
\`\`\`
${truncated}
\`\`\``);
    } else if (tool.name === "Bash") {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**
\`\`\`
${truncated}
\`\`\``);
    }
  } else if (tool.status === "running") {
    parts.push("_\u8FD0\u884C\u4E2D\u2026_");
  }
  const body = parts.join("\n\n");
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}\u2026

_\uFF08body \u5DF2\u622A\u65AD,\u5B8C\u6574\u5185\u5BB9\u67E5 \`/doctor\` \u6216\u65E5\u5FD7\uFF09_`;
}
function summarizeInput(name, input) {
  if (!input || typeof input !== "object") return "";
  const rec = input;
  const pick = (key, max = HEADER_SUMMARY_MAX) => {
    const v = rec[key];
    if (typeof v !== "string") return "";
    const oneLine = v.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}\u2026` : oneLine;
  };
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return shortenPath(pick("file_path"));
    case "Grep": {
      const pat = pick("pattern", 40);
      const path = pick("path", 30);
      return path ? `${pat} in ${shortenPath(path)}` : pat;
    }
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query", 60);
    case "Agent":
    case "Task":
      return pick("description") || pick("subagent_type");
    default:
      return pick("command") || pick("file_path") || pick("path") || pick("query");
  }
}
function renderInput(tool) {
  const input = tool.input;
  if (!input || typeof input !== "object") return "";
  const rec = input;
  const str = (k) => typeof rec[k] === "string" ? rec[k] : "";
  switch (tool.name) {
    case "Bash": {
      const cmd = str("command");
      return cmd ? `**Command**
\`\`\`bash
${truncate(cmd, BODY_FIELD_MAX)}
\`\`\`` : "";
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = str("file_path");
      return fp ? `**File** \`${fp}\`` : "";
    }
    case "Grep": {
      const lines = [];
      if (str("pattern")) lines.push(`**Pattern** \`${str("pattern")}\``);
      if (str("path")) lines.push(`**Path** \`${str("path")}\``);
      return lines.join("\n");
    }
    case "WebFetch":
      return str("url") ? `**URL** ${str("url")}` : "";
    case "WebSearch":
      return str("query") ? `**Query** \`${truncate(str("query"), BODY_FIELD_MAX)}\`` : "";
    default:
      return "";
  }
}
function renderBashOutput(out) {
  return `**Output**
\`\`\`
${out}
\`\`\``;
}
function shortenPath(p2) {
  if (!p2) return p2;
  const home = process.env.HOME || "";
  if (home && p2.startsWith(home)) return `~${p2.slice(home.length)}`;
  return p2;
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

// src/card/run-renderer.ts
var REASONING_MAX = 1500;
var COLLAPSE_TOOL_THRESHOLD = 3;
function renderCard(state) {
  const elements = [];
  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === "text") {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== "running"));
    }
  }
  if (state.terminal === "interrupted") {
    elements.push(noteMd("_\u23F9 \u5DF2\u88AB\u4E2D\u65AD_"));
  } else if (state.terminal === "idle_timeout") {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_\u23F1 ${mins} \u5206\u949F\u65E0\u54CD\u5E94,\u5DF2\u81EA\u52A8\u7EC8\u6B62_`));
  } else if (state.terminal === "error" && state.errorMsg) {
    elements.push(noteMd(`\u26A0\uFE0F agent \u5931\u8D25\uFF1A${state.errorMsg}`));
  } else if (state.terminal === "done" && elements.length === 0) {
    elements.push(noteMd("_\uFF08\u672A\u8FD4\u56DE\u5185\u5BB9\uFF09_"));
  }
  if (state.terminal === "running") {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton());
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: state.terminal === "running",
      summary: { content: summaryText(state) }
    },
    body: { elements }
  };
}
function* groupBlocks(blocks) {
  let toolBuf = [];
  for (const b of blocks) {
    if (b.kind === "tool") {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: "tools", tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: "text", content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: "tools", tools: toolBuf };
}
function renderToolGroup(tools, finalized) {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}
function reasoningPanel(content, active) {
  const title = active ? "\u{1F9E0} **\u601D\u8003\u4E2D**" : "\u{1F9E0} **\u601D\u8003\u5B8C\u6210\uFF0C\u70B9\u51FB\u67E5\u770B**";
  return collapsiblePanel({
    title,
    expanded: active,
    border: "grey",
    body: truncate2(content, REASONING_MAX)
  });
}
function toolPanel(tool, expanded) {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === "error" ? "red" : "grey",
    body: toolBodyMd(tool) || "_\u65E0\u8F93\u51FA_"
  });
}
function collapsedToolSummary(tools, finalized) {
  const suffix = finalized ? "\uFF08\u5DF2\u7ED3\u675F\uFF09" : "";
  const title = `\u2615 **${tools.length} \u4E2A\u5DE5\u5177\u8C03\u7528${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join("\n");
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: panelHeader(title),
    border: { color: "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: headerList, text_size: "notation" }]
  };
}
function collapsiblePanel(opts) {
  return {
    tag: "collapsible_panel",
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: opts.body, text_size: "notation" }]
  };
}
function panelHeader(titleMd) {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180
  };
}
function markdown(content) {
  return { tag: "markdown", content };
}
function noteMd(content) {
  return { tag: "markdown", content, text_size: "notation" };
}
function stopButton() {
  return {
    tag: "button",
    text: { tag: "plain_text", content: "\u23F9 \u7EC8\u6B62" },
    type: "danger",
    behaviors: [{ type: "callback", value: { cmd: "stop" } }]
  };
}
function footerStatus(status) {
  const text = status === "thinking" ? "\u{1F9E0} \u6B63\u5728\u601D\u8003" : status === "tool_running" ? "\u{1F9F0} \u6B63\u5728\u8C03\u7528\u5DE5\u5177" : "\u270D\uFE0F \u6B63\u5728\u8F93\u51FA";
  return noteMd(text);
}
function summaryText(state) {
  if (state.terminal === "interrupted") return "\u5DF2\u4E2D\u65AD";
  if (state.terminal === "idle_timeout") return "\u5DF2\u8D85\u65F6";
  if (state.terminal === "error") return "\u51FA\u9519";
  if (state.terminal === "done") return "\u5DF2\u5B8C\u6210";
  if (state.footer === "tool_running") return "\u6B63\u5728\u8C03\u7528\u5DE5\u5177";
  if (state.footer === "streaming") return "\u6B63\u5728\u8F93\u51FA";
  return "\u601D\u8003\u4E2D";
}
function truncate2(s, max) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

// src/card/run-state.ts
var initialState = {
  blocks: [],
  reasoning: { content: "", active: false },
  footer: "thinking",
  terminal: "running"
};
function closeStreamingText(blocks) {
  return blocks.map(
    (b) => b.kind === "text" && b.streaming ? { ...b, streaming: false } : b
  );
}
function reduce(state, evt) {
  switch (evt.type) {
    case "text": {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === "text" && last.streaming) {
        const next = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: "streaming"
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: "text", content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: "streaming"
      };
    }
    case "thinking": {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: "thinking"
      };
    }
    case "tool_use": {
      const tool = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: "running"
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: "tool", tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: "tool_running"
      };
    }
    case "tool_result": {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== "tool" || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? "error" : "done",
            output: evt.output
          }
        };
      });
      return { ...state, blocks };
    }
    case "error": {
      return { ...state, terminal: "error", errorMsg: evt.message, footer: null };
    }
    case "done": {
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: "done",
        footer: null
      };
    }
    default:
      return state;
  }
}
function markInterrupted(state) {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "interrupted",
    footer: null
  };
}
function markIdleTimeout(state, minutes) {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "idle_timeout",
    footer: null,
    idleTimeoutMinutes: minutes
  };
}
function finalizeIfRunning(state) {
  if (state.terminal !== "running") return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: "done",
    footer: null
  };
}

// src/session/history.ts
import { createReadStream } from "fs";
import { readdir as readdir3, stat as stat3 } from "fs/promises";
import { homedir as homedir3 } from "os";
import { join as join5 } from "path";
import { createInterface as createInterface3 } from "readline";
function encodeCwd(cwd) {
  return cwd.replace(/\//g, "-");
}
function claudeProjectDir(cwd) {
  return join5(homedir3(), ".claude", "projects", encodeCwd(cwd));
}
async function listRecentSessions(cwd, limit = 5) {
  const dir = claudeProjectDir(cwd);
  let files;
  try {
    files = await readdir3(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const jsonls = files.filter((f) => f.endsWith(".jsonl"));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join5(dir, f);
      try {
        const st = await stat3(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sorted = withStats.filter((x) => x !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, "");
      const { preview: preview2, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview: preview2, lineCount };
    })
  );
}
async function summarize(path) {
  const stream2 = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface3({ input: stream2 });
  let preview2 = "";
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview2 && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user" && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview2 = text.slice(0, 80);
          }
        } catch {
        }
      }
      if (lineCount > 2e4) break;
    }
  } finally {
    rl.close();
    stream2.destroy();
  }
  return { preview: preview2 || "(\u7A7A\u4F1A\u8BDD)", lineCount };
}
function extractUserText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }
  return "";
}
function formatRelTime(mtime) {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 6e4);
  if (min < 1) return "\u521A\u521A";
  if (min < 60) return `${min} \u5206\u949F\u524D`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} \u5C0F\u65F6\u524D`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "\u6628\u5929";
  if (day < 30) return `${day} \u5929\u524D`;
  const mo = Math.floor(day / 30);
  return `${mo} \u4E2A\u6708\u524D`;
}

// src/utils/feishu-auth.ts
var ENDPOINTS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
async function validateAppCredentials(appId, appSecret, tenant) {
  const base = ENDPOINTS[tenant];
  let resp;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
  } catch (err) {
    return { ok: false, reason: `\u7F51\u7EDC\u9519\u8BEF\uFF1A${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, reason: "\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON" };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? "?"} msg=${data.msg ?? "<no msg>"}` };
  }
  const info = await fetchBotInfo(base, data.tenant_access_token).catch(() => void 0);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id };
}
async function fetchBotInfo(base, token) {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return void 0;
  return await resp.json();
}

// src/bot/group.ts
async function createBoundChat(opts) {
  const { channel, name, inviteOpenId, description } = opts;
  const result = await channel.rawClient.im.v1.chat.create({
    data: {
      name,
      description,
      chat_mode: "group",
      chat_type: "private",
      user_id_list: [inviteOpenId]
    },
    params: {
      user_id_type: "open_id"
    }
  });
  const chatId = result.data?.chat_id;
  if (!chatId) {
    throw new Error(`chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { chatId, name };
}
function defaultChatName() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => `${n}`.padStart(2, "0");
  return `Claude \xB7 ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// src/commands/index.ts
var handlers = {
  "/new": handleNew,
  "/reset": handleNew,
  "/cd": handleCd,
  "/ws": handleWs,
  "/resume": handleResume,
  "/status": handleStatus,
  "/help": handleHelp,
  "/account": handleAccount,
  "/config": handleConfig,
  "/stop": handleStop,
  "/timeout": handleTimeout,
  "/ps": handlePs,
  "/exit": handleExit,
  "/doctor": handleDoctor,
  "/reconnect": handleReconnect
};
var ADMIN_COMMANDS = /* @__PURE__ */ new Set([
  "/account",
  "/config",
  "/exit",
  "/reconnect",
  "/doctor",
  "/cd",
  "/ws"
]);
function isAdminCommand(cmd) {
  return ADMIN_COMMANDS.has(cmd.startsWith("/") ? cmd : `/${cmd}`);
}
async function tryHandleCommand(ctx) {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith("/")) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? "";
  const args = parts.slice(1).join(" ");
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info("command", "admin-deny", {
      cmd,
      sender: ctx.msg.senderId.slice(-6)
    });
    await reply(ctx, "\u274C \u6B64\u547D\u4EE4\u4EC5\u7BA1\u7406\u5458\u53EF\u7528\u3002");
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail("command", err, { cmd });
  }
  return true;
}
async function runCommandHandler(name, args, ctx) {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info("command", "admin-deny", {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: "card"
    });
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail("command", err, { cmd: name });
  }
  return true;
}
async function reply(ctx, markdown2) {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown: markdown2 }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail("command", err, { step: "reply" });
  }
}
function expandTilde(p2) {
  if (p2 === "~") return homedir4();
  if (p2.startsWith("~/")) return `${homedir4()}${p2.slice(1)}`;
  return p2;
}
async function handleNew(args, ctx) {
  const trimmed = args.trim();
  if (trimmed === "chat" || trimmed.startsWith("chat ")) {
    const rawName = trimmed === "chat" ? "" : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, wasRunning ? "\u5DF2\u4E2D\u65AD\u5F53\u524D\u4EFB\u52A1\u5E76\u5F00\u59CB\u65B0\u4F1A\u8BDD\u3002" : "\u5DF2\u5F00\u59CB\u65B0\u4F1A\u8BDD\u3002");
}
async function handleNewChat(rawName, ctx) {
  const sourceCwd = ctx.workspaces.cwdFor(ctx.scope);
  const name = rawName || defaultChatName();
  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `\u274C \u521B\u5EFA\u7FA4\u5931\u8D25\uFF1A${msg}

\u786E\u8BA4 bot \u5DF2\u5F00\u542F \`im:chat\` \u6743\u9650\u3002`);
    return;
  }
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }
  const welcome = sourceCwd ? `\u{1F389} \u7FA4\u5DF2\u5EFA\u597D\uFF0Ccwd \u7EE7\u627F\u81EA\u539F\u7FA4\uFF1A\`${sourceCwd}\`

@\u6211 + \u4EFB\u610F\u6D88\u606F\u5F00\u59CB\u5BF9\u8BDD\u3002` : "\u{1F389} \u7FA4\u5DF2\u5EFA\u597D\u3002\n\n@\u6211 + \u4EFB\u610F\u6D88\u606F\u5F00\u59CB\u5BF9\u8BDD\u3002";
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn("[new-chat] welcome message failed:", err);
  }
  await reply(
    ctx,
    `\u2713 \u5DF2\u521B\u5EFA\u7FA4 **${created.name}**\uFF0C\u53BB\u65B0\u7FA4\u91CC\u7EE7\u7EED\u3002`
  );
}
async function handleCd(args, ctx) {
  const input = args.trim();
  if (!input) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/cd <\u7EDD\u5BF9\u8DEF\u5F84>` \u6216 `/cd ~/xxx`");
    return;
  }
  if (!input.startsWith("/") && !input.startsWith("~")) {
    await reply(ctx, "\u8BF7\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216 `~/xxx` \u8868\u793A home \u4E0B\u7684\u5B50\u8DEF\u5F84\u3002");
    return;
  }
  const absolute = expandTilde(input);
  try {
    const st = await stat4(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55\uFF1A\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, absolute);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `\u2713 \u5DF2\u5207\u6362 cwd \u5230 \`${absolute}\`
\uFF08session \u5DF2\u91CD\u7F6E\uFF09`);
}
async function handleWs(args, ctx) {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";
  const name = parts.slice(1).join(" ").trim();
  switch (sub) {
    case "":
    case "list":
      return handleWsList(ctx);
    case "save":
      return handleWsSave(name, ctx);
    case "use":
      return handleWsUse(name, ctx);
    case "remove":
    case "rm":
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, "\u7528\u6CD5\uFF1A`/ws [list|save <name>|use <name>|remove <name>]`");
  }
}
async function handleWsList(ctx) {
  const named = ctx.workspaces.listNamed();
  const currentCwd = ctx.workspaces.cwdFor(ctx.scope);
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
async function handleWsSave(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws save <name>`");
    return;
  }
  const cwd = ctx.workspaces.cwdFor(ctx.scope);
  if (!cwd) {
    await reply(ctx, "\u5F53\u524D chat \u672A\u8BBE\u7F6E cwd\uFF0C\u5148\u7528 `/cd` \u8BBE\u7F6E\u518D\u4FDD\u5B58\u3002");
    return;
  }
  ctx.workspaces.saveNamed(name, cwd);
  await reply(ctx, `\u2713 \u5DE5\u4F5C\u7A7A\u95F4\u5DF2\u4FDD\u5B58\uFF1A\`${name}\` \u2192 ${cwd}`);
}
async function handleWsUse(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws use <name>`");
    return;
  }
  const cwd = ctx.workspaces.getNamed(name);
  if (!cwd) {
    await reply(ctx, `\u672A\u627E\u5230\u5DE5\u4F5C\u7A7A\u95F4\uFF1A\`${name}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, cwd);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `\u2713 \u5DF2\u5207\u6362\u5230 \`${name}\` (${cwd})
\uFF08session \u5DF2\u91CD\u7F6E\uFF09`);
}
async function handleWsRemove(name, ctx) {
  if (!name) {
    await reply(ctx, "\u7528\u6CD5\uFF1A`/ws remove <name>`");
    return;
  }
  if (!ctx.workspaces.removeNamed(name)) {
    await reply(ctx, `\u672A\u627E\u5230\u5DE5\u4F5C\u7A7A\u95F4\uFF1A\`${name}\``);
    return;
  }
  await reply(ctx, `\u2713 \u5DF2\u5220\u9664\u5DE5\u4F5C\u7A7A\u95F4\uFF1A\`${name}\``);
}
async function handleResume(args, ctx) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";
  const rest = parts.slice(1).join(" ").trim();
  if (sub === "use" && rest) {
    return applyResume(rest, ctx);
  }
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir4();
  const sessions = await listRecentSessions(cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const entries = sessions.map((s) => ({
    sessionId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
async function applyResume(sessionId, ctx) {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir4();
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(
    ctx,
    `\u2713 \u5DF2\u6062\u590D\u4F1A\u8BDD \`${sessionId.slice(0, 8)}\u2026\`\u3002\u63A5\u7740\u53D1\u6D88\u606F\u5C31\u884C\u3002`
  );
}
async function handleStatus(_args, ctx) {
  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir4();
  const sess = ctx.sessions.getRaw(ctx.scope);
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
async function handleStop(_args, ctx) {
  const ok = ctx.activeRuns.interrupt(ctx.scope);
  log.info("command", "stop", { interrupted: ok });
}
async function handleTimeout(args, ctx) {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 6e4) : 0;
  const formatGlobal = () => globalMinutes > 0 ? `${globalMinutes} \u5206\u949F` : "\u672A\u542F\u7528";
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage = "\n\n\u7528\u6CD5:\n- `/timeout 15` \u5F53\u524D session \u8BBE 15 \u5206\u949F\n- `/timeout off` \u5F53\u524D session \u5173\u95ED\u63A2\u6D3B\n- `/timeout default` \u6E05\u9664 session \u8986\u76D6,\u56DE\u9000\u5168\u5C40\n\n_\u6CE8:`/new` \u4F1A\u6E05\u6389\u5F53\u524D session \u7684\u8986\u76D6,\u56DE\u5230\u5168\u5C40_";
    if (scopeMinutes !== void 0) {
      const effective = scopeMinutes > 0 ? `${scopeMinutes} \u5206\u949F` : "\u5DF2\u5173\u95ED\uFF08\u5F53\u524D session\uFF09";
      await reply(ctx, `\u23F1 \u5F53\u524D session \u63A2\u6D3B:${effective}
\u5168\u5C40\u9ED8\u8BA4:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `\u23F1 \u5F53\u524D session \u63A2\u6D3B:\u8DDF\u968F\u5168\u5C40(${formatGlobal()})${usage}`);
    return;
  }
  if (trimmed === "default") {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info("command", "timeout-clear", { scope: ctx.scope, cleared });
    await reply(
      ctx,
      cleared ? `\u2705 \u5DF2\u6E05\u9664 session \u8986\u76D6,\u56DE\u9000\u5230\u5168\u5C40(${formatGlobal()})\u3002` : `\u5F53\u524D session \u672C\u6765\u5C31\u6CA1\u8BBE\u8FC7\u8986\u76D6,\u8DDF\u968F\u5168\u5C40(${formatGlobal()})\u3002`
    );
    return;
  }
  if (trimmed === "off" || trimmed === "0") {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info("command", "timeout-off", { scope: ctx.scope });
    await reply(ctx, "\u2705 \u5DF2\u5173\u95ED\u5F53\u524D session \u7684\u63A2\u6D3B\u3002");
    return;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, "\u274C \u7528\u6CD5:`/timeout <1-120>` / `/timeout off` / `/timeout default`");
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info("command", "timeout-set", { scope: ctx.scope, minutes: n });
  await reply(ctx, `\u2705 \u5F53\u524D session \u63A2\u6D3B\u5DF2\u8BBE\u4E3A ${n} \u5206\u949F\u3002`);
}
async function handlePs(_args, ctx) {
  const live = readAndPrune();
  log.info("command", "ps", { count: live.length });
  if (live.length === 0) {
    await reply(ctx, "\u5F53\u524D\u6CA1\u6709 bot \u5728\u8FD0\u884C(\u7406\u8BBA\u4E0A\u4E0D\u53EF\u80FD,\u4F60\u6B63\u5728\u8DDF\u5176\u4E2D\u4E4B\u4E00\u5BF9\u8BDD\u2026)");
    return;
  }
  const rows = [
    "| # | ID | Bot | \u542F\u52A8 |",
    "|---|---|---|---|"
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo2(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? " \u2190 \u5F53\u524D\u6B63\u5728\u56DE\u590D" : "";
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `\u{1F9ED} **\u5F53\u524D\u6709 ${live.length} \u4E2A bot \u5728\u8FD0\u884C**`,
    "",
    rows.join("\n"),
    "",
    "\u7528 `/exit <id|#>` \u5173\u6389\u67D0\u4E00\u4E2A;`/exit " + ctx.controls.processId + "` \u5173\u6389\u6B63\u5728\u56DE\u590D\u4F60\u7684\u8FD9\u4E2A bot\u3002"
  ].join("\n");
  await reply(ctx, body);
}
async function handleExit(args, ctx) {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      `\u7528\u6CD5:\`/exit <id|#>\` \u2014\u2014 \`id\` \u662F \`/ps\` \u663E\u793A\u7684\u77ED id,\`#\` \u662F\u5E8F\u53F7\u3002
\u5F53\u524D\u6B63\u5728\u56DE\u590D\u4F60\u7684\u662F \`${ctx.controls.processId}\`\u3002`
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `\u274C \u6CA1\u627E\u5230\u5339\u914D\u7684 bot:\`${target}\`\u3002\u53D1 \`/ps\` \u770B\u53EF\u9009\u76EE\u6807\u3002`);
    return;
  }
  if (entry.id === ctx.controls.processId) {
    log.info("command", "exit-self", { id: entry.id });
    await reply(ctx, `\u{1F44B} \u5373\u5C06\u5173\u95ED\u5F53\u524D bot \`${entry.id}\`,\u518D\u89C1\u3002`);
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {
      });
    })();
    return;
  }
  log.info("command", "exit-other", { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (err) {
    await reply(ctx, `\u274C \u5173\u6389 bot \`${entry.id}\` \u5931\u8D25:${err.message}`);
    return;
  }
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `\u{1F4E8} \u5DF2\u8BF7\u6C42\u5173\u95ED \`${entry.id}\`,\u4F46\u8FD8\u5728\u6536\u5C3E\u3002\u518D\u53D1 \`/ps\` \u590D\u67E5\u4E00\u4E0B\u3002`
    );
  } else {
    await reply(ctx, `\u2713 \u5DF2\u5173\u95ED bot \`${entry.id}\`\u3002`);
  }
}
function formatAgo2(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)}s \u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)}m \u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)}h \u524D`;
  return `${Math.floor(ms / 864e5)}d \u524D`;
}
async function handleReconnect(_args, ctx) {
  log.info("command", "reconnect");
  await reply(ctx, "\u23F3 \u6B63\u5728\u91CD\u8FDE\u2026");
  try {
    await ctx.controls.restart();
    log.info("command", "reconnect-ok");
  } catch (err) {
    log.fail("command", err, { step: "reconnect" });
    await reply(ctx, `\u274C \u91CD\u8FDE\u5931\u8D25:${err instanceof Error ? err.message : String(err)}`);
  }
}
var DOCTOR_INSTRUCTIONS = `\u4F60\u662F lark-channel-bridge \u7684\u8BCA\u65AD\u52A9\u7406\u3002\u4E0B\u9762\u4F1A\u7ED9\u4F60\u4E24\u6BB5\u8F93\u5165:
1. \u7528\u6237\u7684\u6545\u969C\u63CF\u8FF0
2. \u6700\u8FD1\u7684\u8FD0\u884C\u65E5\u5FD7(JSON line \u683C\u5F0F,\u65E7\u2192\u65B0)

\u65E5\u5FD7\u5B57\u6BB5\u542B\u4E49:
- ts: ISO \u65F6\u95F4\u6233
- level: info | warn | error
- phase: \u6A21\u5757\u9636\u6BB5\u3002\u5E38\u89C1\u503C: ws(WebSocket), intake(\u6D88\u606F\u5165\u7AD9), queue(\u53BB\u6296\u961F\u5217), flush(\u6279\u5904\u7406), media(\u9644\u4EF6\u4E0B\u8F7D), prompt(prompt \u7EC4\u88C5), session(\u4F1A\u8BDD), agent(claude \u5B50\u8FDB\u7A0B), card(\u5361\u7247\u6E32\u67D3), comment(\u6587\u6863\u8BC4\u8BBA), cardAction(\u5361\u7247\u56DE\u8C03), command(\u659C\u6760\u547D\u4EE4), sdk(\u98DE\u4E66 SDK \u5185\u90E8)
- event: enter | exit | transition | fail | \u5404 phase \u81EA\u5B9A\u4E49\u4E8B\u4EF6
- traceId: \u540C\u4E00\u903B\u8F91\u64CD\u4F5C\u7684\u4E32\u8054 ID(\u540C\u4E00\u6761\u6D88\u606F\u7684\u591A\u4E2A\u65E5\u5FD7\u4F1A\u5171\u4EAB)
- chatId: \u98DE\u4E66\u804A\u5929 ID(\u7528 chatId \u53CD\u67E5\u76F8\u5173\u65E5\u5FD7)

\u56DE\u590D\u4E25\u683C\u4E09\u6BB5,markdown \u6807\u9898\u7528\u4E8C\u7EA7:

## \u53EF\u80FD\u539F\u56E0
1-3 \u6761\u6700\u6709\u53EF\u80FD\u7684\u539F\u56E0,\u6BCF\u6761\u5E26\u5177\u4F53\u65E5\u5FD7\u7684\u65F6\u95F4\u6233\u6216 traceId \u5F15\u7528\u3002

## \u5173\u952E\u65E5\u5FD7\u7247\u6BB5
3-5 \u6761\u6700\u91CD\u8981\u7684\u65E5\u5FD7,\u76F4\u63A5\u8D34 JSON \u884C\u539F\u6587,\u540E\u8DDF\u4E00\u884C\u8BF4\u660E\u4E3A\u4EC0\u4E48\u91CD\u8981\u3002

## \u5EFA\u8BAE\u4E0B\u4E00\u6B65
1-3 \u6761\u5177\u4F53\u53EF\u6267\u884C\u7684\u52A8\u4F5C(\u68C0\u67E5 X / \u91CD\u542F Y / \u7B49\u5F85 Z \u4E4B\u7C7B)\u3002

\u5982\u679C\u65E5\u5FD7\u91CC\u6CA1\u6709\u4EFB\u4F55\u76F8\u5173\u7EBF\u7D22,\u76F4\u63A5\u8BF4"\u65E5\u5FD7\u4E0D\u8DB3\u4EE5\u5224\u65AD,\u5EFA\u8BAE:"\u518D\u5217\u52A8\u4F5C\u3002\u56DE\u590D\u8981\u76F4\u63A5,\u4E0D\u5BD2\u6684\u3002`;
function buildDoctorPrompt(description, logs) {
  const desc = description.trim() || "(\u7528\u6237\u6CA1\u5199\u63CF\u8FF0,\u81EA\u884C\u4ECE\u65E5\u5FD7\u627E\u6700\u663E\u773C\u7684\u5F02\u5E38\u3002)";
  return `${DOCTOR_INSTRUCTIONS}

---

\u7528\u6237\u6545\u969C\u63CF\u8FF0:
${desc}

\u6700\u8FD1\u7684\u8FD0\u884C\u65E5\u5FD7:
\`\`\`
${logs}
\`\`\``;
}
async function handleDoctor(args, ctx) {
  log.info("command", "doctor", {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode
  });
  ctx.activeRuns.interrupt(ctx.scope);
  const rawLogs = await readRecentLogs({ maxBytes: 6e4 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: "\u6CA1\u6709\u627E\u5230\u65E5\u5FD7\u6587\u4EF6 \u2014 bridge \u53EF\u80FD\u521A\u542F\u52A8\u6216\u65E5\u5FD7\u76EE\u5F55\u4E0D\u53EF\u5199\u3002" },
      { replyTo: ctx.msg.messageId }
    );
    return;
  }
  const logs = sanitizeLogsForDoctor(rawLogs);
  const isP2p = ctx.chatMode === "p2p";
  if (!isP2p) {
    await reply(ctx, "\u{1F50D} \u5DF2\u6536\u5230\u8BCA\u65AD\u8BF7\u6C42\uFF0C\u5206\u6790\u7ED3\u679C\u5C06\u79C1\u4FE1\u53D1\u7ED9\u4F60\u3002");
  }
  const prompt = buildDoctorPrompt(args, logs);
  const run = ctx.agent.run({
    prompt,
    cwd: homedir4(),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg)
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);
  try {
    if (isP2p) {
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state = initialState;
              const flush = () => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                if (evt.type === "system") continue;
                if (evt.type === "usage") {
                  if (evt.costUsd !== void 0) {
                    log.info("agent", "usage", { step: "doctor", costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                if (state.terminal !== "running") break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            }
          }
        },
        { replyTo: ctx.msg.messageId }
      );
    } else {
      let state = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === "system") continue;
        if (evt.type === "usage") {
          if (evt.costUsd !== void 0) {
            log.info("agent", "usage", { step: "doctor", costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== "running") break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: "interactive",
          content: JSON.stringify(renderCard(state))
        }
      });
    }
  } catch (err) {
    log.fail("command", err, { step: "doctor" });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}
async function handleHelp(_args, ctx) {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
async function handleAccount(args, ctx) {
  const sub = args.trim().split(/\s+/)[0] ?? "";
  switch (sub) {
    case "":
      return showCurrent(ctx);
    case "change":
      return showForm(ctx);
    case "submit":
      return submitAccount(ctx);
    case "cancel":
      return cancelAccount(ctx);
    default:
      await reply(ctx, "\u7528\u6CD5\uFF1A`/account` \u6216 `/account change`");
  }
}
async function showCurrent(ctx) {
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}
async function showForm(ctx) {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}
async function cancelAccount(ctx) {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}
var FORM_SETTLE_MS = 1e3;
async function submitAccount(ctx) {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? "").trim();
  const appSecret = String(fv.app_secret ?? "").trim();
  const tenant = fv.tenant === "lark" ? "lark" : "feishu";
  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart2 = ctx.controls.restart;
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async () => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };
    const finishSuccess = async (card) => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch(
        (err) => console.warn("[account] form update failed:", err)
      );
      forgetManagedCard(formMsgId);
    };
    const finishFailure = async (errorMessage) => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage)).catch((err) => console.warn("[account] mark old form failed:", err));
      forgetManagedCard(formMsgId);
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId
      });
      await sendManagedCard(channel, chatId, retry).catch(
        (err) => console.warn("[account] post retry form failed:", err)
      );
    };
    if (!appId || !appSecret) {
      await finishFailure("App ID \u6216 App Secret \u4E3A\u7A7A");
      return;
    }
    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? "unknown");
      return;
    }
    let newCfg;
    try {
      newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences
      );
      await setSecret(secretKeyForApp(appId), appSecret);
      await saveConfig(newCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`\u4FDD\u5B58\u51ED\u636E\u5931\u8D25\uFF1A${msg}`);
      return;
    }
    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));
    setTimeout(() => {
      void restart2().catch((err) => {
        console.error("[account] restart failed:", err);
        process.exit(1);
      });
    }, 1500);
  })();
}
async function recallMessage(ctx, messageId) {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId }
    });
  } catch (err) {
    console.warn("[recall failed]", err);
  }
}
async function handleConfig(args, ctx) {
  const sub = args.trim().split(/\s+/)[0] ?? "";
  switch (sub) {
    case "":
      return showConfigForm(ctx);
    case "submit":
      return submitConfig(ctx);
    case "cancel":
      return cancelConfig(ctx);
    default:
      await reply(ctx, "\u7528\u6CD5:`/config`");
  }
}
async function showConfigForm(ctx) {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 6e4) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(", "),
    allowedChats: (access.allowedChats ?? []).join(", "),
    admins: (access.admins ?? []).join(", ")
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}
async function cancelConfig(ctx) {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch(
        (err) => log.warn("command", "config-cancel-update-failed", { err: String(err) })
      );
      forgetManagedCard(formMsgId);
    })();
  }
}
async function submitConfig(ctx) {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? "").trim();
  const messageReply = rawReply === "markdown" || rawReply === "text" || rawReply === "card" ? rawReply : "card";
  const rawTools = String(fv.show_tool_calls ?? "").trim();
  const showToolCalls = rawTools !== "hide";
  const rawMaxCC = String(fv.max_concurrent_runs ?? "").trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns = Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1 ? Math.min(50, Math.floor(parsedMaxCC)) : getMaxConcurrentRuns(ctx.controls.cfg);
  const rawIdle = String(fv.run_idle_timeout_minutes ?? "").trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 6e4) : 0;
  let runIdleTimeoutMinutes;
  if (rawIdle === "") {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  const rawRequireMention = String(fv.require_mention_in_group ?? "").trim();
  let requireMentionInGroup;
  if (rawRequireMention === "yes") requireMentionInGroup = true;
  else if (rawRequireMention === "no") requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  const parseList = (raw) => {
    return [...new Set(
      String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn("command", "config-lockout-refused", {
      kind: "admins",
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length
    });
    await reply(
      ctx,
      `\u274C \u62D2\u7EDD\u63D0\u4EA4:\u4F60\u8BBE\u7F6E\u4E86\u975E\u7A7A\u7684\u7BA1\u7406\u5458\u5217\u8868,\u4F46\u5176\u4E2D\u4E0D\u5305\u542B\u4F60\u81EA\u5DF1\u7684 open_id (\`${ctx.msg.senderId}\`)\u3002\u8FD9\u4F1A\u7ACB\u5373\u628A\u4F60\u81EA\u5DF1\u9501\u51FA /config\u3002\u8BF7\u628A\u81EA\u5DF1\u7684 open_id \u52A0\u8FDB\u53BB\u518D\u63D0\u4EA4\u3002`
    );
    return;
  }
  if (ctx.chatMode !== "p2p" && allowedChats.length > 0 && !allowedChats.includes(ctx.msg.chatId)) {
    log.warn("command", "config-lockout-refused", {
      kind: "chats",
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length
    });
    await reply(
      ctx,
      `\u274C \u62D2\u7EDD\u63D0\u4EA4:\u4F60\u8BBE\u7F6E\u4E86\u975E\u7A7A\u7684\u7FA4\u767D\u540D\u5355,\u4F46\u5176\u4E2D\u4E0D\u5305\u542B\u5F53\u524D\u4F1A\u8BDD\u7684 chat_id (\`${ctx.msg.chatId}\`)\u3002\u63D0\u4EA4\u540E\u8FD9\u4E2A\u4F1A\u8BDD\u7684\u6D88\u606F\u4F1A\u88AB intake \u9759\u9ED8\u4E22\u5F03,bot \u4E0D\u518D\u54CD\u5E94\u3002\u8981\u4E48\u628A\u5F53\u524D chat_id \u52A0\u8FDB\u767D\u540D\u5355,\u8981\u4E48\u6E05\u7A7A"\u7FA4\u767D\u540D\u5355"\u7559\u5F85\u7A7A(=\u6240\u6709\u4F1A\u8BDD\u90FD\u54CD\u5E94)\u3002`
    );
    return;
  }
  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async () => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };
    ctx.controls.cfg.preferences = {
      ...ctx.controls.cfg.preferences ?? {},
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      // Empty arrays serialize fine but read identically to omitted ones
      // (isUserAllowed / isAdmin both treat length===0 as unrestricted).
      access: { allowedUsers, allowedChats, admins }
    };
    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail("command", err, { step: "config.save" });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {
      });
      forgetManagedCard(formMsgId);
      return;
    }
    log.info("command", "config-saved", {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(", "),
        allowedChats: allowedChats.join(", "),
        admins: admins.join(", ")
      })
    ).catch(
      (err) => log.warn("command", "config-save-update-failed", { err: String(err) })
    );
    forgetManagedCard(formMsgId);
  })();
}

// src/card/dispatcher.ts
var CLAUDE_CALLBACK_MARKER = "__claude_cb";
async function handleCardAction(deps) {
  const value = deps.evt.action.value;
  if (!value || typeof value !== "object") return;
  const payload = value;
  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;
  const raw = deps.evt.raw;
  const formValue = raw?.action?.form_value;
  const { scope, threadId, mode } = await resolveScope(deps);
  if (!isUserAllowed(deps.controls.cfg, operatorId)) {
    log.info("cardAction", "skip-not-allowed-user", {
      operator: operatorId.slice(-6)
    });
    return;
  }
  if (mode !== "p2p" && !isChatAllowed(deps.controls.cfg, chatId)) {
    log.info("cardAction", "skip-not-allowed-chat", {
      chatId: chatId.slice(-6)
    });
    return;
  }
  if (CLAUDE_CALLBACK_MARKER in payload) {
    forwardToClaude(deps, payload, formValue, scope, threadId);
    return;
  }
  const cmd = typeof payload.cmd === "string" ? payload.cmd : "";
  if (!cmd) return;
  log.info("cardAction", "cmd", { cmd, scope });
  const ctx = {
    channel: deps.channel,
    msg: makeFakeMsg(deps.evt, threadId),
    scope,
    chatMode: mode,
    sessions: deps.sessions,
    workspaces: deps.workspaces,
    activeRuns: deps.activeRuns,
    agent: deps.agent,
    controls: deps.controls,
    formValue,
    fromCardAction: true
  };
  const [name, ...rest] = cmd.split(".");
  const sub = rest.join(" ");
  const args = composeArgs(sub, payload);
  try {
    const ok = await runCommandHandler(name ?? "", args, ctx);
    if (!ok) log.warn("cardAction", "unknown", { cmd });
  } catch (err) {
    log.fail("cardAction", err, { cmd });
  }
}
async function resolveScope(deps) {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== "topic") {
    return { scope: chatId, threadId: void 0, mode };
  }
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    return { scope: chatId, threadId: void 0, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}
async function lookupMessageThreadId(channel, messageId) {
  try {
    const r = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId }
    });
    return r?.data?.items?.[0]?.thread_id;
  } catch (err) {
    log.warn("cardAction", "thread-id-lookup-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
function forwardToClaude(deps, payload, formValue, scope, threadId) {
  const { [CLAUDE_CALLBACK_MARKER]: _marker, ...claudePayload } = payload;
  const merged = formValue ? { ...claudePayload, form_value: formValue } : claudePayload;
  log.info("cardAction", "forward-claude", {
    scope,
    payload: JSON.stringify(merged).slice(0, 200)
  });
  const synthetic = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: "p2p",
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: "card_action",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now()
  };
  deps.pending.push(scope, synthetic);
}
function composeArgs(sub, payload) {
  if (!sub) return "";
  const arg = typeof payload.arg === "string" && payload.arg || typeof payload.name === "string" && payload.name || "";
  return arg ? `${sub} ${arg}` : sub;
}
function makeFakeMsg(evt, threadId) {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: "p2p",
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: "",
    rawContentType: "interactive",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now()
  };
}

// src/card/text-renderer.ts
function renderText(state) {
  const parts = [];
  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }
  if (state.terminal === "interrupted") {
    parts.push("_\u23F9 \u5DF2\u88AB\u4E2D\u65AD_");
  } else if (state.terminal === "idle_timeout") {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_\u23F1 ${mins} \u5206\u949F\u65E0\u54CD\u5E94,\u5DF2\u81EA\u52A8\u7EC8\u6B62_`);
  } else if (state.terminal === "error" && state.errorMsg) {
    parts.push(`\u26A0\uFE0F agent \u5931\u8D25:${state.errorMsg}`);
  } else if (state.terminal === "running" && state.footer) {
    parts.push(footerLine(state.footer));
  }
  return parts.join("\n\n");
}
function renderBlock(block) {
  if (block.kind === "text") {
    return block.content.trim();
  }
  return toolLine(block.tool);
}
function toolLine(tool) {
  return `> ${toolHeaderText(tool)}`;
}
function footerLine(status) {
  if (status === "thinking") return "_\u{1F9E0} \u6B63\u5728\u601D\u8003\u2026_";
  if (status === "tool_running") return "_\u{1F9F0} \u6B63\u5728\u8C03\u7528\u5DE5\u5177\u2026_";
  return "_\u270D\uFE0F \u6B63\u5728\u8F93\u51FA\u2026_";
}

// src/config/secret-resolver.ts
import { spawn as spawn3 } from "child_process";
import { readFile as readFile5 } from "fs/promises";
import { join as join6 } from "path";
var ENV_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
var DEFAULT_PROVIDER = "default";
var DEFAULT_EXEC_TIMEOUT_MS = 5e3;
var DEFAULT_EXEC_MAX_OUTPUT = 64 * 1024;
async function resolveAppSecret(cfg) {
  const appId = cfg.accounts.app.id;
  const secret = cfg.accounts.app.secret;
  return resolveSecretInput(secret, cfg.secrets, appId);
}
async function resolveSecretInput(input, secretsCfg, appId) {
  if (!input) {
    throw new Error("app secret is missing");
  }
  if (typeof input === "string") {
    return resolvePlainOrTemplate(input);
  }
  if (!isSecretRef(input)) {
    throw new Error(`unsupported secret form: ${JSON.stringify(input)}`);
  }
  switch (input.source) {
    case "env":
      return resolveEnvRef(input, lookupProvider(secretsCfg, input));
    case "file":
      return resolveFileRef(input, lookupProvider(secretsCfg, input));
    case "exec":
      return resolveExecRef(input, lookupProvider(secretsCfg, input), appId);
    default:
      throw new Error(`unknown secret source: ${input.source}`);
  }
}
function resolvePlainOrTemplate(value) {
  if (!value) throw new Error("app secret is empty");
  const m = ENV_TEMPLATE_RE.exec(value);
  if (m) {
    const name = m[1];
    const v = process.env[name];
    if (!v) throw new Error(`env var ${name} referenced by secret is not set`);
    return v;
  }
  return value;
}
function lookupProvider(secretsCfg, ref) {
  if (!secretsCfg?.providers) return void 0;
  const name = ref.provider ?? secretsCfg.defaults?.[ref.source] ?? DEFAULT_PROVIDER;
  return secretsCfg.providers[name];
}
function resolveEnvRef(ref, pc) {
  if (pc?.allowlist && pc.allowlist.length > 0 && !pc.allowlist.includes(ref.id)) {
    throw new Error(`env var ${ref.id} is not allowlisted in provider`);
  }
  const v = process.env[ref.id];
  if (!v) throw new Error(`env var ${ref.id} is not set`);
  return v;
}
async function resolveFileRef(ref, pc) {
  const path = pc?.path ? join6(pc.path, ref.id) : ref.id;
  const text = await readFile5(path, "utf8");
  return text.trim();
}
async function resolveExecRef(ref, pc, appId) {
  if (!pc?.command) {
    throw new Error("exec provider missing `command`");
  }
  if (isSelfBridgeCommand(pc.command, pc.args)) {
    const candidate = await getSecret(ref.id);
    if (candidate !== void 0) return candidate;
    const conventional = secretKeyForApp(appId);
    const fallback = await getSecret(conventional);
    if (fallback !== void 0) return fallback;
    throw new Error(`keystore has no entry for "${ref.id}" or "${conventional}"`);
  }
  return spawnExecProvider(pc, ref);
}
function isSelfBridgeCommand(command, args) {
  if (command === paths.secretsGetterScript) return true;
  if (args && args.length >= 2) {
    const a = args[args.length - 2];
    const b = args[args.length - 1];
    if (a === "secrets" && b === "get") return true;
  }
  return false;
}
async function spawnExecProvider(pc, ref) {
  const timeoutMs = pc.noOutputTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutput = pc.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT;
  const providerName = ref.provider ?? DEFAULT_PROVIDER;
  return new Promise((resolve, reject) => {
    const env = {};
    if (pc.passEnv) {
      for (const k of pc.passEnv) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    }
    if (pc.env) Object.assign(env, pc.env);
    const child = spawn3(pc.command, pc.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`exec provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      if (stdout.length + chunk.length > maxOutput) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`exec provider failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        reject(new Error(`exec provider stdout exceeded ${maxOutput} bytes`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : "";
        reject(new Error(`exec provider exited with code ${code}${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const value = parsed.values?.[ref.id];
        if (typeof value === "string") {
          resolve(value);
          return;
        }
        const err = parsed.errors?.[ref.id]?.message;
        reject(new Error(`exec provider did not return secret for ${ref.id}${err ? `: ${err}` : ""}`));
      } catch (err) {
        reject(new Error(`exec provider returned invalid JSON: ${err.message}`));
      }
    });
    const request = JSON.stringify({
      protocolVersion: 1,
      provider: providerName,
      ids: [ref.id]
    });
    child.stdin.end(request);
  });
}

// src/media/cache.ts
import { mkdir as mkdir8, readdir as readdir4, rm as rm6, stat as stat5 } from "fs/promises";
import { join as join7 } from "path";
var MediaCache = class {
  channel;
  constructor(channel) {
    this.channel = channel;
  }
  async resolve(chatId, items) {
    if (items.length === 0) return [];
    const dir = dirFor(chatId);
    await mkdir8(dir, { recursive: true });
    const results = [];
    for (const item of items) {
      try {
        const file = await this.resolveOne(dir, item);
        if (file) results.push(file);
      } catch (err) {
        log.fail("media", err, { fileKey: item.resource.fileKey });
      }
    }
    return results;
  }
  async resolveOne(dir, item) {
    const { messageId, resource: r } = item;
    if (r.type === "sticker") {
      log.info("media", "skip", { reason: "sticker", fileKey: r.fileKey });
      return null;
    }
    const kind = r.type;
    const fileName = pickFileName(r);
    const path = join7(dir, fileName);
    try {
      await stat5(path);
      log.info("media", "cache-hit", { path });
      return { path, kind, originalName: r.fileName };
    } catch {
    }
    const result = await this.channel.rawClient.im.v1.messageResource.get({
      params: { type: r.type },
      path: { message_id: messageId, file_key: r.fileKey }
    });
    await result.writeFile(path);
    const size = await stat5(path).then((s) => s.size).catch(() => 0);
    log.info("media", "downloaded", { path, size });
    return { path, kind, originalName: r.fileName };
  }
};
async function gcMediaCache(maxAgeMs) {
  const root = paths.mediaDir;
  try {
    await stat5(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const chats = await readdir4(root).catch(() => []);
  for (const chat of chats) {
    const dir = join7(root, chat);
    const files = await readdir4(dir).catch(() => []);
    for (const f of files) {
      const p2 = join7(dir, f);
      try {
        const st = await stat5(p2);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await rm6(p2);
          removed++;
        }
      } catch {
      }
    }
  }
  if (removed > 0) log.info("media", "gc", { removed });
}
function dirFor(chatId) {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join7(paths.mediaDir, safe);
}
function pickFileName(r) {
  const id = r.fileKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (r.fileName) {
    return `${id}-${sanitize(r.fileName)}`;
  }
  switch (r.type) {
    case "image":
      return `${id}.png`;
    case "audio":
      return `${id}.ogg`;
    case "video":
      return `${id}.mp4`;
    default:
      return `${id}.bin`;
  }
}
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

// src/bot/active-runs.ts
var ActiveRuns = class {
  handles = /* @__PURE__ */ new Map();
  register(chatId, run) {
    const handle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }
  unregister(chatId, run) {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }
  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId) {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
    });
    return true;
  }
  async stopAll() {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
};

// src/bot/chat-mode-cache.ts
var ChatModeCache = class {
  cache = /* @__PURE__ */ new Map();
  async resolve(channel, chatId) {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info("chat", "mode-resolved", { chatId, mode });
      return mode;
    } catch (err) {
      log.warn("chat", "mode-resolve-failed", {
        chatId,
        err: err instanceof Error ? err.message : String(err)
      });
      return "group";
    }
  }
  invalidate(chatId) {
    this.cache.delete(chatId);
  }
};

// src/bot/comments.ts
import { homedir as homedir5 } from "os";

// src/bot/reaction.ts
async function addWorkingReaction(channel, messageId) {
  try {
    const r = await channel.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "Typing" } }
    });
    const id = r?.data?.reaction_id;
    if (id) log.info("reaction", "added", { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn("reaction", "add-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
async function removeReaction(channel, messageId, reactionId) {
  try {
    await channel.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId }
    });
    log.info("reaction", "removed", { messageId, reactionId });
  } catch (err) {
    log.warn("reaction", "remove-failed", {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}
async function addCommentReaction(channel, fileToken, fileType, replyId) {
  return commentReaction(channel, fileToken, fileType, replyId, "add");
}
async function removeCommentReaction(channel, fileToken, fileType, replyId) {
  await commentReaction(channel, fileToken, fileType, replyId, "delete");
}
async function commentReaction(channel, fileToken, fileType, replyId, action) {
  const url = `/open-apis/drive/v2/files/${encodeURIComponent(fileToken)}/comments/reaction?file_type=${encodeURIComponent(fileType)}`;
  try {
    await channel.rawClient.request({
      method: "POST",
      url,
      data: { action, reply_id: replyId, reaction_type: "Typing" }
    });
    log.info("reaction", `comment-${action}ed`, { fileToken, replyId });
    return true;
  } catch (err) {
    log.warn("reaction", `comment-${action}-failed`, {
      fileToken,
      replyId,
      err: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

// src/bot/comments.ts
var SUPPORTED_FILE_TYPES = /* @__PURE__ */ new Set(["doc", "docx", "sheet", "file"]);
var REPLY_MAX_CHARS = 2e3;
async function handleCommentMention(deps) {
  const { channel, evt, agent, sessions, workspaces } = deps;
  log.info("comment", "enter", {
    doc: evt.fileToken,
    fileType: evt.fileType,
    commentId: evt.commentId,
    replyId: evt.replyId,
    mentionedBot: evt.mentionedBot,
    sender: evt.operator.openId
  });
  if (!evt.mentionedBot) {
    log.info("comment", "skip", { reason: "not-mentioned" });
    return;
  }
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
    log.info("comment", "skip", { reason: "unsupported-fileType", fileType: evt.fileType });
    return;
  }
  const target = await resolveTarget2(channel, evt);
  if (!target) {
    log.info("comment", "skip", { reason: "unsupported-target" });
    return;
  }
  const ctx = await fetchCommentContext(channel, target, evt).catch((err) => {
    const code = err?.response?.data?.code;
    if (code === 1069307) {
      log.warn("comment", "no-access", { token: target.fileToken });
    } else {
      log.fail("comment", err, { step: "fetchCommentContext" });
    }
    return null;
  });
  if (!ctx?.question) {
    log.info("comment", "skip", { reason: "empty-question" });
    return;
  }
  log.info("comment", "parsed", {
    isWhole: ctx.isWhole,
    questionPreview: preview(ctx.question),
    hasQuote: Boolean(ctx.quote)
  });
  const prompt = buildCommentPrompt(target, ctx);
  const synthChatId = `doc:${evt.fileToken}`;
  const cwd = workspaces.cwdFor(synthChatId) ?? homedir5();
  const resumeFrom = sessions.resumeFor(synthChatId, cwd);
  log.info("comment", "session", { synthChatId, resumeFrom: resumeFrom ?? null, cwd });
  const reactionAdded = ctx.targetReplyId ? await addCommentReaction(channel, target.fileToken, target.fileType, ctx.targetReplyId) : false;
  try {
    const run = agent.run({ prompt, sessionId: resumeFrom, cwd });
    let answer = "";
    let errorMsg;
    let terminal = false;
    for await (const e of run.events) {
      switch (e.type) {
        case "text":
          answer += e.delta;
          break;
        case "system":
          if (e.sessionId) {
            const effectiveCwd = e.cwd ?? cwd;
            sessions.set(synthChatId, e.sessionId, effectiveCwd);
          }
          break;
        case "error":
          errorMsg = e.message;
          terminal = true;
          break;
        case "usage":
          if (e.costUsd !== void 0) {
            log.info("comment", "usage", { costUsd: Number(e.costUsd.toFixed(4)) });
          }
          break;
        case "done":
          terminal = true;
          break;
      }
      if (terminal) break;
    }
    await run.stop();
    let reply2 = stripMarkdown(answer.trim());
    if (errorMsg) reply2 = `\u26A0\uFE0F Claude \u62A5\u9519\uFF1A${errorMsg}`;
    if (!reply2) reply2 = "\uFF08\u65E0\u56DE\u590D\u5185\u5BB9\uFF09";
    if (reply2.length > REPLY_MAX_CHARS) reply2 = `${reply2.slice(0, REPLY_MAX_CHARS - 1)}\u2026`;
    await postCommentReply(channel, target, evt, reply2).catch((err) => {
      log.fail("comment", err, { step: "postCommentReply" });
    });
  } finally {
    if (reactionAdded && ctx.targetReplyId) {
      await removeCommentReaction(
        channel,
        target.fileToken,
        target.fileType,
        ctx.targetReplyId
      );
    }
  }
}
async function resolveTarget2(channel, evt) {
  const passthrough = {
    fileToken: evt.fileToken,
    fileType: evt.fileType
  };
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) return null;
  try {
    const r = await channel.rawClient.wiki.v2.space.getNode({
      params: { token: evt.fileToken }
    });
    const node = r?.data?.node;
    if (node?.obj_token && node.obj_type && SUPPORTED_FILE_TYPES.has(node.obj_type)) {
      log.info("comment", "wiki-resolved", {
        objToken: node.obj_token,
        objType: node.obj_type
      });
      return {
        fileToken: node.obj_token,
        fileType: node.obj_type
      };
    }
  } catch {
  }
  return passthrough;
}
async function fetchCommentContext(channel, target, evt) {
  let replies = [];
  let quote;
  let isWhole = false;
  try {
    const r = await channel.rawClient.drive.v1.fileComment.get({
      params: { file_type: target.fileType },
      path: { file_token: target.fileToken, comment_id: evt.commentId }
    });
    replies = r?.data?.reply_list?.replies ?? [];
    quote = r?.data?.quote || void 0;
    isWhole = Boolean(r?.data?.is_whole);
  } catch (err) {
    const code = err?.response?.data?.code;
    log.warn("comment", "get-failed-fallback-list", { code });
    const found = await findCommentViaList(channel, target, evt.commentId);
    replies = found?.reply_list?.replies ?? [];
    quote = found?.quote || void 0;
    isWhole = Boolean(found?.is_whole);
  }
  const target_reply = (evt.replyId ? replies.find((rr) => rr.reply_id === evt.replyId) : null) ?? replies[replies.length - 1];
  const elements = target_reply?.content?.elements ?? [];
  const question = elements.map((el) => {
    if (el.type === "text_run") return el.text_run?.text ?? "";
    if (el.type === "docs_link") return el.docs_link?.url ?? "";
    return "";
  }).join("").trim();
  return { question, quote, isWhole, targetReplyId: target_reply?.reply_id };
}
async function findCommentViaList(channel, target, commentId) {
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const r = await channel.rawClient.drive.v1.fileComment.list({
      params: {
        file_type: target.fileType,
        page_size: 100,
        ...pageToken ? { page_token: pageToken } : {}
      },
      path: { file_token: target.fileToken }
    });
    const items = r?.data?.items ?? [];
    const hit = items.find((it) => it.comment_id === commentId);
    if (hit) return hit;
    if (!r?.data?.has_more || !r.data.page_token) break;
    pageToken = r.data.page_token;
  }
  return null;
}
function buildCommentPrompt(target, ctx) {
  const docUrl = `https://feishu.cn/${target.fileType}/${target.fileToken}`;
  const parts = [];
  parts.push("\u6211\u5728\u98DE\u4E66\u4E91\u6587\u6863\u91CC\u88AB @\u4E86\u3002\u6587\u6863\u4FE1\u606F\uFF1A");
  parts.push(`- \u94FE\u63A5\uFF1A${docUrl}`);
  parts.push(`- file_token\uFF1A${target.fileToken}`);
  parts.push(`- \u7C7B\u578B\uFF1A${target.fileType}`);
  parts.push(
    `- \u8BC4\u8BBA\u8303\u56F4\uFF1A${ctx.isWhole ? "\u5168\u6587\u8BC4\u8BBA\uFF08\u9488\u5BF9\u6574\u7BC7\uFF09" : "\u884C\u5185\u8BC4\u8BBA\uFF08\u9488\u5BF9\u9009\u4E2D\u6587\u5B57\uFF09"}`
  );
  if (ctx.quote) {
    parts.push("");
    parts.push(`\u7528\u6237\u9009\u4E2D\u7684\u539F\u6587\uFF1A
> ${ctx.quote.replace(/\n/g, "\n> ")}`);
  }
  parts.push("");
  parts.push(`\u7528\u6237\u7684\u95EE\u9898\uFF1A${ctx.question}`);
  parts.push("");
  parts.push(
    `\u9700\u8981\u8BFB\u6587\u6863\u5185\u5BB9\u65F6\uFF0C\u53EF\u4EE5\u7528 lark-cli\uFF1A
  \`lark-cli docs +fetch --doc ${target.fileToken}\``
  );
  parts.push("");
  parts.push(
    "\u56DE\u590D\u8981\u6C42\uFF1A\u76F4\u63A5\u7528\u7EAF\u6587\u672C\uFF0C\u4E0D\u8981 markdown\uFF08\u4E0D\u8981 ** __ # - * > ` \u4E4B\u7C7B\u7684\u6807\u8BB0\uFF09\uFF0C\u4E0D\u8981\u4EE3\u7801\u5757\u3002\u4E91\u6587\u6863\u8BC4\u8BBA\u6846\u4E0D\u6E32\u67D3 markdown\uFF0C\u4F1A\u539F\u6837\u663E\u793A\u8FD9\u4E9B\u7B26\u53F7\u3002"
  );
  return parts.join("\n");
}
function stripMarkdown(s) {
  return s.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1").replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^[-*]\s+/gm, "").replace(/^>\s?/gm, "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}
async function postCommentReply(channel, target, evt, text) {
  const url = `/open-apis/drive/v1/files/${encodeURIComponent(target.fileToken)}/comments/${encodeURIComponent(
    evt.commentId
  )}/replies?file_type=${encodeURIComponent(target.fileType)}`;
  try {
    await channel.rawClient.request({
      method: "POST",
      url,
      data: { content: { elements: [{ type: "text_run", text_run: { text } }] } }
    });
    log.info("comment", "replied", { mode: "in-thread" });
    return;
  } catch (err) {
    const code = err?.response?.data?.code;
    if (code !== 1069302) throw err;
    log.warn("comment", "reply-rejected-fallback-create", { code });
  }
  await channel.rawClient.drive.v1.fileComment.create({
    params: { file_type: target.fileType },
    path: { file_token: target.fileToken },
    data: {
      reply_list: {
        replies: [{ content: { elements: [{ type: "text_run", text_run: { text } }] } }]
      }
    }
  });
  log.info("comment", "replied", { mode: "new-top-level" });
}
function preview(text) {
  return text.length > 80 ? `${text.slice(0, 80)}\u2026` : text;
}

// src/bot/interactive-card.ts
var INTERACTIVE_CARD_PLACEHOLDER = "[interactive card]";
function expandInteractiveCard(flattenedContent, rawJsonContent) {
  if (!rawJsonContent) return flattenedContent;
  const parsed = tryParseJson(rawJsonContent);
  if (parsed && typeof parsed.user_dsl === "string" && parsed.user_dsl.trim().length > 0) {
    return `<interactive_card>
${parsed.user_dsl}
</interactive_card>`;
  }
  if (parsed && parsed.schema === "2.0") {
    return `<interactive_card>
${rawJsonContent}
</interactive_card>`;
  }
  if (flattenedContent === INTERACTIVE_CARD_PLACEHOLDER) {
    return `<interactive_card>
${rawJsonContent}
</interactive_card>`;
  }
  return flattenedContent;
}
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return void 0;
  }
}

// src/bot/keepalive.ts
var KEEPALIVE_INTERVAL_MS = 15e3;
var SLEEP_DETECT_MS = 3e4;
var TIMER_STORM_GUARD_MS = 5e3;
var HTTP_PROBE_TIMEOUT_MS = 5e3;
var DEAD_THRESHOLD = 3;
var NETWORK_DOWN_LOG_EVERY = 20;
function startKeepalive(deps) {
  const { channel, domain, forceReconnect } = deps;
  let lastTick = 0;
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const sinceLast = lastTick > 0 ? now - lastTick : 0;
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) {
      return;
    }
    if (sinceLast > SLEEP_DETECT_MS) {
      log.info("keepalive", "wake-up", { sleptMs: sinceLast });
      consecutiveDown = 0;
      networkDownTicks = 0;
      lastTick = now;
      return;
    }
    lastTick = now;
    const status = channel.getConnectionStatus();
    if (!status) {
      return;
    }
    if (status.state === "connected") {
      if (consecutiveDown > 0) {
        log.info("keepalive", "recovered", { afterTicks: consecutiveDown });
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }
    const reachable = await httpProbe(domain);
    if (!reachable) {
      networkDownTicks++;
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        log.warn("network", "unreachable", { domain, networkDownTicks });
      }
      consecutiveDown = 0;
      return;
    }
    if (networkDownTicks > 0) {
      log.info("network", "reachable-again", { afterTicks: networkDownTicks });
      networkDownTicks = 0;
    }
    consecutiveDown++;
    log.warn("keepalive", "ws-stuck", {
      state: status.state,
      reconnectAttempts: status.reconnectAttempts,
      consecutiveDown
    });
    if (consecutiveDown >= DEAD_THRESHOLD) {
      log.warn("keepalive", "force-reconnect", { state: status.state });
      consecutiveDown = 0;
      try {
        await forceReconnect();
      } catch (err) {
        log.fail("keepalive", err, { step: "force-reconnect" });
      }
    }
  };
  const timer = setInterval(() => {
    void tick().catch((err) => log.fail("keepalive", err, { step: "tick" }));
  }, KEEPALIVE_INTERVAL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
async function httpProbe(domain) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(domain, { method: "HEAD", signal: ctrl.signal });
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// src/bot/network-config.ts
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
var HTTP_TIMEOUT_MS = 3e4;
function configureNetwork() {
  const ax = defaultHttpInstance;
  ax.defaults.timeout = HTTP_TIMEOUT_MS;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!proxyUrl) return {};
  const agent = new HttpsProxyAgent(proxyUrl);
  ax.defaults.httpsAgent = agent;
  log.info("network", "proxy-detected", { proxy: redact(proxyUrl) });
  return { agent };
}
function redact(url) {
  return url.replace(/\/\/[^:@/]+:[^@/]+@/, "//[redacted]@");
}

// src/bot/pending-queue.ts
var PendingQueue = class {
  map = /* @__PURE__ */ new Map();
  blocked = /* @__PURE__ */ new Set();
  delayMs;
  onFlush;
  constructor(delayMs, onFlush) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }
  push(scope, msg) {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? void 0 : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? void 0 : this.armTimer(scope)
    });
    return 1;
  }
  cancel(scope) {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }
  cancelAll() {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }
  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope) {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = void 0;
    }
    log.info("queue", "blocked", { scope, queued: entry?.messages.length ?? 0 });
  }
  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope) {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info("queue", "unblocked", { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }
  armTimer(scope) {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }
  flush(scope) {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail("queue", err, { scope, batchSize: entry.messages.length });
    }
  }
};

// src/bot/process-pool.ts
var ProcessPool = class {
  active = 0;
  waiters = [];
  /** Snapshot of the cap captured at the moment acquire() decided to wait. */
  cap;
  constructor(cap) {
    this.cap = cap;
  }
  async acquire() {
    if (this.active < this.cap()) {
      this.active++;
      log.info("pool", "acquired", { active: this.active, cap: this.cap() });
      return () => this.release();
    }
    log.info("pool", "wait", { active: this.active, cap: this.cap(), waiting: this.waiters.length + 1 });
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
    log.info("pool", "acquired", { active: this.active, cap: this.cap() });
    return () => this.release();
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    log.info("pool", "released", { active: this.active });
    if (this.active < this.cap() && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }
  snapshot() {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
};

// src/bot/quote.ts
import { normalize } from "@larksuiteoapi/node-sdk";
function preExpandInteractive(item) {
  if (item.msg_type !== "interactive") return item;
  const raw = item.body?.content;
  if (typeof raw !== "string" || raw.length === 0) return item;
  const expanded = expandInteractiveCard("[interactive card]", raw);
  if (expanded === "[interactive card]") return item;
  const wrapper = JSON.stringify({ tag: "plain_text", content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}
async function fetchQuotedContext(channel, messageId) {
  let items;
  try {
    const r = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      // Ask for the original card JSON (incl. v2 user_dsl) instead of the
      // default v1-canonical fallback that strips it. Requires SDK ≥ 1.65.0.
      params: { card_msg_content_type: "user_card_content" }
    });
    items = r?.data?.items ?? [];
  } catch (err) {
    log.warn("quote", "fetch-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return void 0;
  const fetchSubMessages = async (mid) => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    try {
      const r = await channel.rawClient.im.v1.message.get({
        path: { message_id: mid },
        params: { card_msg_content_type: "user_card_content" }
      });
      return (r?.data?.items ?? []).map(preExpandInteractive);
    } catch {
      return [];
    }
  };
  const senderOpenId = parent.sender?.id;
  const fakeRaw = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: "",
      chat_type: "group",
      message_type: parent.msg_type ?? "text",
      content: parent.body?.content ?? "",
      create_time: parent.create_time !== void 0 ? String(parent.create_time) : void 0,
      mentions: parent.mentions
    }
  };
  const botIdentity = channel.botIdentity ?? { openId: "", name: "" };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false
    });
    const createMs = parent.create_time ? Number.parseInt(String(parent.create_time), 10) : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? "",
      senderName: normalized.senderName,
      createdAt: Number.isFinite(createMs) && createMs > 0 ? new Date(createMs).toISOString() : "",
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? "text"
    };
  } catch (err) {
    log.warn("quote", "normalize-failed", {
      messageId,
      err: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
function renderQuotedBlock(quotes) {
  if (quotes.length === 0) return "";
  const parts = quotes.map((q) => {
    const attrs = [
      `id="${q.messageId}"`,
      q.senderId ? `sender_id="${q.senderId}"` : "",
      q.senderName ? `sender_name="${q.senderName}"` : "",
      q.createdAt ? `created_at="${q.createdAt}"` : "",
      `type="${q.rawContentType}"`
    ].filter(Boolean).join(" ");
    return `<quoted_message ${attrs}>
${q.content}
</quoted_message>`;
  });
  return parts.join("\n");
}

// src/bot/channel.ts
var DEBOUNCE_MS = 600;
var SUPPRESSED_API_ERROR_CODES = /* @__PURE__ */ new Set([
  131005,
  // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307,
  // drive.fileComment.get "not exist" — fall back to .list
  1069302
  // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);
function buildQuietLogger() {
  const codeFromObj = (m) => {
    if (!m || typeof m !== "object") return void 0;
    const top = m.code;
    if (typeof top === "number") return top;
    const nested = m?.response?.data?.code;
    return typeof nested === "number" ? nested : void 0;
  };
  const isSuppressed = (msg) => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== void 0 && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args) => {
      if (args.some(isSuppressed)) return;
      log.warn("sdk", "error", { args: stringifyArgs(args) });
    },
    warn: (...args) => log.warn("sdk", "warn", { args: stringifyArgs(args) }),
    info: (...args) => log.info("sdk", "info", { args: stringifyArgs(args) }),
    debug: () => {
    },
    trace: () => {
    }
  };
}
function stringifyArgs(args) {
  return args.map((a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
}
async function startChannel(deps) {
  const { cfg, agent, sessions, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  const chatModeCache = new ChatModeCache();
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const netOverrides = configureNetwork();
  const appSecret = await resolveAppSecret(cfg);
  const opts = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === "lark" ? Domain.Lark : Domain.Feishu,
    source: "lark-channel-bridge",
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: "open",
      requireMention: false,
      respondToMentionAll: false
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false }
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8e3,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...netOverrides.agent ? { agent: netOverrides.agent } : {}
  };
  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel);
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info("flush", "start", { scope, batchSize: batch.length });
      const release = await pool.acquire();
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          batch,
          controls,
          scope,
          mode
        });
      } catch (err) {
        log.fail("flush", err);
      } finally {
        release();
        pending.unblock(scope);
        log.info("flush", "end");
      }
    });
  });
  let consecutiveReconnects = 0;
  channel.on({
    message: async (msg) => {
      await withTrace(
        { chatId: msg.chatId, msgId: msg.messageId },
        () => intakeMessage({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache
        })
      ).catch((err) => log.fail("intake", err));
    },
    reject: (evt) => {
      log.info("intake", "reject", { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          workspaces,
          activeRuns,
          agent,
          controls,
          pending,
          chatModeCache
        });
      }).catch((err) => log.fail("cardAction", err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: "comment" }, async () => {
        await handleCommentMention({ channel, evt, agent, sessions, workspaces }).catch(
          (err) => log.fail("comment", err)
        );
      }).catch((err) => log.fail("comment", err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn("ws", "reconnecting", { consecutive: consecutiveReconnects });
      if (consecutiveReconnects === 3) {
        console.error("\u26A0\uFE0F \u5DF2\u8FDE\u7EED\u91CD\u8FDE 3 \u6B21,\u7F51\u7EDC\u53EF\u80FD\u4E0D\u7A33\u3002");
      } else if (consecutiveReconnects === 10) {
        console.error("\u274C \u5DF2\u8FDE\u7EED\u91CD\u8FDE 10 \u6B21,\u5EFA\u8BAE\u5728\u98DE\u4E66\u53D1 /reconnect \u6216\u91CD\u542F bot\u3002");
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info("ws", "recovered", { afterAttempts: consecutiveReconnects });
      } else {
        log.info("ws", "reconnected");
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail("network", err, { kind: "dns", code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail("network", err, { kind: "handshake-timeout", code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail("network", err, { kind: "timeout", code: err.code });
      } else {
        log.fail("ws", err, { code: err.code });
      }
    }
  });
  await channel.connect();
  const identity = channel.botIdentity;
  log.info("ws", "connected", {
    bot: identity?.name ?? "unknown",
    openId: identity?.openId ?? "-",
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId
  });
  console.log("\u6B63\u5728\u76D1\u542C\u6D88\u606F\u3002\u6309 Ctrl+C \u9000\u51FA\u3002\n");
  const probeDomain = cfg.accounts.app.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart()
  });
  return {
    channel,
    disconnect: async () => {
      keepalive.stop();
      pending.cancelAll();
      await channel.disconnect();
      await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush()]);
    }
  };
}
async function intakeMessage(deps) {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache
  } = deps;
  const preview2 = msg.content.length > 80 ? `${msg.content.slice(0, 80)}\u2026` : msg.content;
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatMode === "topic" && msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
  log.info("intake", "enter", {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview: preview2,
    resources: msg.resources.length
  });
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info("intake", "skip-not-allowed-user", {
      scope,
      sender: msg.senderId.slice(-6)
    });
    return;
  }
  if (msg.chatType !== "p2p" && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info("intake", "skip-not-allowed-chat", {
      scope,
      chatId: msg.chatId.slice(-6)
    });
    return;
  }
  if (msg.chatType !== "p2p" && getRequireMentionInGroup(controls.cfg) && !msg.mentionedBot) {
    log.info("intake", "skip-no-mention", { scope, chatType: msg.chatType });
    return;
  }
  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    controls
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info("intake", "command", { scope, droppedPending: dropped.length });
    return;
  }
  const size = pending.push(scope, msg);
  log.info("intake", "queued", { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}
async function runAgentBatch(deps) {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;
  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;
  const resourceItems = batch.flatMap(
    (m) => m.resources.map((r) => ({ messageId: m.messageId, resource: r }))
  );
  const attachments = await media.resolve(chatId, resourceItems);
  if (attachments.length > 0) {
    log.info("media", "resolved", { count: attachments.length });
  }
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch.map((m) => m.replyToMessageId).filter((id) => Boolean(id) && !batchIds.has(id))
    )
  ];
  const quotes = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info("quote", "fetched", {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length
      });
    }
  }
  const { prompt, images } = buildPrompt(batch, attachments, quotes);
  log.info("prompt", "built", { promptChars: prompt.length, images: images.length, quotes: quotes.length });
  const cwd = workspaces.cwdFor(scope) ?? homedir6();
  const resumeFrom = sessions.resumeFor(scope, cwd);
  if (resumeFrom) {
    log.info("session", "resume", { sessionId: resumeFrom, cwd });
  } else {
    const stale = sessions.getRaw(scope);
    if (stale && stale.cwd !== cwd) {
      log.info("session", "stale-cleared", { staleCwd: stale.cwd, newCwd: cwd });
      sessions.clear(scope);
    } else {
      log.info("session", "fresh", { cwd });
    }
  }
  const run = agent.run({
    prompt,
    images,
    sessionId: resumeFrom,
    cwd,
    stopGraceMs: getAgentStopGraceMs(controls.cfg)
  });
  const handle = activeRuns.register(scope, run);
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs = scopeOverride !== void 0 ? scopeOverride > 0 ? scopeOverride * 6e4 : void 0 : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info("flush", "idle-watchdog", { idleTimeoutMs });
  }
  const replyMode = getMessageReplyMode(controls.cfg);
  log.info("flush", "reply-mode", { mode: replyMode });
  const filterForPrefs = (state) => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== "tool") };
  };
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...mode === "topic" && threadId ? { replyInThread: true } : {}
  };
  const reactionId = replyMode === "card" ? void 0 : await addWorkingReaction(channel, lastMsg.messageId);
  try {
    if (replyMode === "card") {
      await channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
                await ctrl.update(renderCard(filterForPrefs(state)));
              });
            }
          }
        },
        sendOpts
      );
    } else if (replyMode === "markdown") {
      await channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
              await ctrl.setContent(renderText(filterForPrefs(state)));
            });
          }
        },
        sendOpts
      );
    } else {
      let finalState = initialState;
      await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (state) => {
        finalState = state;
      });
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        await channel.send(chatId, { markdown: body }, sendOpts);
      }
    }
  } catch (err) {
    log.fail("stream", err);
  } finally {
    activeRuns.unregister(scope, run);
    if (reactionId) {
      await removeReaction(channel, lastMsg.messageId, reactionId);
    }
  }
}
async function processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, flush) {
  let state = initialState;
  let idleFired = false;
  let timer;
  const inFlightTools = /* @__PURE__ */ new Set();
  const armOrPauseIdle = () => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = void 0;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn("agent", "idle-timeout", { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();
  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;
      if (evt.type === "tool_use") {
        inFlightTools.add(evt.id);
        log.info("agent", "tool-in-flight", {
          tool: evt.name,
          inFlight: inFlightTools.size
        });
      } else if (evt.type === "tool_result") {
        inFlightTools.delete(evt.id);
        log.info("agent", "tool-done", { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();
      if (evt.type === "system") {
        if (evt.sessionId) {
          const effectiveCwd = evt.cwd ?? cwd;
          sessions.set(scope, evt.sessionId, effectiveCwd);
          log.info("session", "set", { sessionId: evt.sessionId });
        }
        continue;
      }
      if (evt.type === "usage") {
        if (evt.costUsd !== void 0) {
          log.info("agent", "usage", { costUsd: Number(evt.costUsd.toFixed(4)) });
        }
        continue;
      }
      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info("card", "transition", { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      if (state.terminal !== "running") break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (state.terminal === "running") {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs / 6e4));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info("card", "final", { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  } else {
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn("agent", "post-done-timeout", { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
}
var POST_DONE_EXIT_GRACE_MS = 2e3;
function expandedMessageContent(m) {
  if (m.rawContentType !== "interactive") return m.content;
  const rawContent = m.raw?.message?.content;
  if (typeof rawContent !== "string") return m.content;
  return expandInteractiveCard(m.content, rawContent);
}
function sniffImageMediaType(path) {
  try {
    const fd = openSyncForSniff(path, "r");
    try {
      const buf = Buffer.alloc(12);
      readSyncForSniff(fd, buf, 0, 12, 0);
      if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
      if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
      if ((buf[0] === 71 && buf[1] === 73 && buf[2] === 70 && buf[3] === 56) && (buf[4] === 55 || buf[4] === 57) && buf[5] === 97) return "image/gif";
      if (buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) return "image/webp";
      return "image/png";
    } finally {
      closeSyncForSniff(fd);
    }
  } catch {
    return "image/png";
  }
}
function buildPrompt(batch, attachments, quotes = []) {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = batch.map((m) => stripAttachmentRefs(expandedMessageContent(m), fileKeys).trim()).filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join("\n\n")}

` : "";
  const imageAttachments = attachments.filter((a) => a.kind === "image");
  const nonImageAttachments = attachments.filter((a) => a.kind !== "image");
  const images = imageAttachments.map((a) => ({
    path: a.path,
    originalName: a.originalName,
    mediaType: sniffImageMediaType(a.path)
  }));
  if (attachments.length === 0) {
    return { prompt: `${prefix}${texts.join("\n\n")}`, images };
  }
  const userPart = texts.length > 0 ? texts.join("\n\n") : "\u8BF7\u770B\u4E0B\u9762\u7684\u9644\u4EF6\u3002";
  if (nonImageAttachments.length === 0) {
    return { prompt: `${prefix}${userPart}`, images };
  }
  const attachLines = nonImageAttachments.map((a) => {
    const label = a.kind === "audio" ? "\u97F3\u9891" : a.kind === "video" ? "\u89C6\u9891" : "\u6587\u4EF6";
    const name = a.originalName ? ` (${a.originalName})` : "";
    return `- ${a.path}${name} \u2014 ${label}`;
  });
  return {
    prompt: `${prefix}${userPart}

\u9644\u4EF6\uFF08\u672C\u5730\u8DEF\u5F84\uFF09\uFF1A
${attachLines.join("\n")}`,
    images
  };
}
function buildBridgeContextHeader(batch) {
  const m = batch[0];
  if (!m) return "";
  const lines = [
    "<bridge_context>",
    `chat_id: ${m.chatId}`,
    `chat_type: ${m.chatType}`,
    `sender_id: ${m.senderId}`
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  lines.push("</bridge_context>");
  return lines.join("\n");
}
function stripAttachmentRefs(text, fileKeys) {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, "g"), "");
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

// src/bot/wizard.ts
import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";
async function runRegistrationWizard() {
  console.log("\n\u672A\u68C0\u6D4B\u5230\u98DE\u4E66\u5E94\u7528\u914D\u7F6E\uFF0C\u8FDB\u5165\u626B\u7801\u521B\u5EFA\u5411\u5BFC\u3002\n");
  const result = await registerApp({
    onQRCodeReady: (info) => {
      console.log("\u8BF7\u7528\u98DE\u4E66 App \u626B\u63CF\u4EE5\u4E0B\u4E8C\u7EF4\u7801\u5B8C\u6210\u5E94\u7528\u521B\u5EFA\uFF1A\n");
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`
\u4E8C\u7EF4\u7801\u6709\u6548\u671F\uFF1A\u7EA6 ${mins} \u5206\u949F`);
      console.log(`\u4E5F\u53EF\u4EE5\u76F4\u63A5\u5728\u6D4F\u89C8\u5668\u6253\u5F00\uFF1A${info.url}
`);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        console.log("\u8BC6\u522B\u5230\u56FD\u9645\u7248\u79DF\u6237\uFF0C\u5DF2\u5207\u6362\u5230 larksuite.com \u57DF\u540D\u3002");
      } else if (info.status === "slow_down") {
        console.log("\u8F6E\u8BE2\u901F\u5EA6\u8FC7\u5FEB\uFF0C\u5DF2\u81EA\u52A8\u964D\u901F\u3002");
      }
    }
  });
  const tenant = result.user_info?.tenant_brand ?? "feishu";
  const operatorOpenId = result.user_info?.open_id;
  console.log("\n\u2713 \u5E94\u7528\u521B\u5EFA\u6210\u529F");
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);
  const cfg = {
    accounts: {
      app: {
        id: result.client_id,
        secret: result.client_secret,
        tenant
      }
    }
  };
  if (operatorOpenId) {
    cfg.preferences = {
      access: { admins: [operatorOpenId] }
    };
    console.log(`  Admin:   ${operatorOpenId} (\u4F60\u81EA\u5DF1\uFF0C\u5DF2\u81EA\u52A8\u52A0\u5165\u7BA1\u7406\u5458\u540D\u5355)`);
  } else {
    console.log(
      "  \u26A0\uFE0F \u672A\u62FF\u5230\u626B\u7801\u7528\u6237\u7684 open_id\uFF1B\u7BA1\u7406\u5458\u5217\u8868\u7559\u7A7A = \u6240\u6709\u7528\u6237\u90FD\u80FD\u8DD1\u654F\u611F\u547D\u4EE4\u3002\n     \u4F60\u53EF\u4EE5\u7A0D\u540E\u5728\u98DE\u4E66\u53D1 /config \u624B\u52A8\u8BBE\u7F6E\u7BA1\u7406\u5458\u3002"
    );
  }
  console.log("");
  return cfg;
}

// src/session/store.ts
import { mkdir as mkdir9, readFile as readFile6, writeFile as writeFile7 } from "fs/promises";
import { dirname as dirname7 } from "path";
var SessionStore = class {
  data = {};
  saving = Promise.resolve();
  path;
  constructor(path = paths.sessionsFile) {
    this.path = path;
  }
  async load() {
    try {
      const text = await readFile6(this.path, "utf8");
      const raw = JSON.parse(text);
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== "number") continue;
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : void 0;
        const cwd = typeof entry.cwd === "string" ? entry.cwd : void 0;
        const idleTimeoutMinutes = typeof entry.idleTimeoutMinutes === "number" ? entry.idleTimeoutMinutes : void 0;
        const hasSession = sessionId !== void 0 && cwd !== void 0;
        if (!hasSession && idleTimeoutMinutes === void 0) continue;
        this.data[chatId] = {
          ...sessionId !== void 0 ? { sessionId } : {},
          ...cwd !== void 0 ? { cwd } : {},
          updatedAt: entry.updatedAt,
          ...idleTimeoutMinutes !== void 0 ? { idleTimeoutMinutes } : {}
        };
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId, cwd) {
    const entry = this.data[chatId];
    if (!entry) return void 0;
    if (entry.cwd !== cwd) return void 0;
    return entry.sessionId;
  }
  getRaw(chatId) {
    return this.data[chatId];
  }
  set(chatId, sessionId, cwd) {
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...prev?.idleTimeoutMinutes !== void 0 ? { idleTimeoutMinutes: prev.idleTimeoutMinutes } : {}
    };
    this.schedulePersist();
  }
  clear(chatId) {
    if (!(chatId in this.data)) return;
    delete this.data[chatId];
    this.schedulePersist();
  }
  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId) {
    return this.data[chatId]?.idleTimeoutMinutes;
  }
  setIdleTimeoutMinutes(chatId, minutes) {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...prev ?? { updatedAt: Date.now() },
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now()
    };
    this.schedulePersist();
  }
  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId) {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === void 0) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    this.saving = this.saving.then(async () => {
      await mkdir9(dirname7(this.path), { recursive: true });
      await writeFile7(this.path, `${JSON.stringify(this.data, null, 2)}
`, "utf8");
    }).catch((err) => {
      log.fail("session", err, { step: "persist" });
    });
  }
};

// src/workspace/store.ts
import { mkdir as mkdir10, readFile as readFile7, writeFile as writeFile8 } from "fs/promises";
import { dirname as dirname8 } from "path";
var WorkspaceStore = class {
  data = { chats: {}, named: {} };
  saving = Promise.resolve();
  path;
  constructor(path = paths.workspacesFile) {
    this.path = path;
  }
  async load() {
    try {
      const text = await readFile7(this.path, "utf8");
      const parsed = JSON.parse(text);
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {}
      };
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
  cwdFor(chatId) {
    return this.data.chats[chatId]?.cwd;
  }
  setCwd(chatId, cwd) {
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }
  listNamed() {
    return { ...this.data.named };
  }
  getNamed(name) {
    return this.data.named[name];
  }
  saveNamed(name, cwd) {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }
  removeNamed(name) {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }
  async flush() {
    await this.saving;
  }
  schedulePersist() {
    this.saving = this.saving.then(async () => {
      await mkdir10(dirname8(this.path), { recursive: true });
      await writeFile8(this.path, `${JSON.stringify(this.data, null, 2)}
`, "utf8");
    }).catch((err) => {
      log.fail("workspace", err, { step: "persist" });
    });
  }
};

// src/cli/commands/start.ts
dns.setDefaultResultOrder("ipv4first");
process.on("unhandledRejection", (reason) => {
  log.fail("process", reason, { kind: "unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  log.fail("process", err, { kind: "uncaughtException" });
});
var MEDIA_GC_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
async function runStart(opts) {
  const configPath = opts.config ?? paths.configFile;
  const existing = await loadConfig(configPath);
  let cfg;
  if (isComplete(existing)) {
    cfg = existing;
    cfg = await maybeMigratePlaintextSecret(cfg, configPath);
  } else {
    const fresh = await runRegistrationWizard();
    cfg = await persistEncrypted(fresh, configPath);
    console.log(`\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230 ${configPath}
`);
  }
  await preFlightChecks({ skipCheckLarkCli: opts.skipCheckLarkCli });
  const agent = new ClaudeAdapter();
  if (!await agent.isAvailable()) {
    console.error("\u2717 \u672A\u627E\u5230 claude CLI\u3002\u8BF7\u5148\u5B89\u88C5 Claude Code\uFF1A");
    console.error("  https://docs.anthropic.com/en/docs/claude-code/quickstart");
    process.exit(1);
  }
  const sessions = new SessionStore();
  await sessions.load();
  const workspaces = new WorkspaceStore();
  await workspaces.load();
  await gcMediaCache(MEDIA_GC_MAX_AGE_MS);
  await gcOldLogs();
  const conflicts = sameAppOthers(cfg.accounts.app.id);
  if (conflicts.length > 0) {
    const proceed = await resolveConflict(cfg, conflicts);
    if (!proceed) {
      console.log("\u5DF2\u53D6\u6D88\u542F\u52A8\u3002");
      process.exit(0);
    }
  }
  const entry = await register({
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
    configPath,
    version: package_default.version
  });
  log.info("registry", "registered", { id: entry.id, pid: process.pid });
  let bridge;
  let restarting = false;
  let stopping = false;
  const stop2 = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`
\u6536\u5230 ${sig}\uFF0C\u6B63\u5728\u5173\u95ED...`);
    try {
      await bridge.disconnect();
    } catch (err) {
      console.error("[disconnect-failed]", err);
    }
    unregisterSync(entry.id);
    process.exit(0);
  };
  const controls = {
    configPath,
    cfg,
    processId: entry.id,
    async exit() {
      await stop2("exit-command");
    },
    async restart() {
      if (restarting) return;
      restarting = true;
      try {
        const next = await loadConfig(configPath);
        if (!isComplete(next)) throw new Error("config incomplete after change");
        console.log(
          `[restart] connecting new bridge with appId=${next.accounts.app.id} tenant=${next.accounts.app.tenant}...`
        );
        const next_bridge = await startChannel({
          cfg: next,
          agent,
          sessions,
          workspaces,
          controls
        });
        console.log("[restart] disconnecting old bridge...");
        try {
          await bridge.disconnect();
        } catch (err) {
          console.warn("[restart] old disconnect failed:", err);
        }
        bridge = next_bridge;
        controls.cfg = next;
        await updateEntry(entry.id, {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath,
          botName: bridge.channel.botIdentity?.name
        }).catch(
          (err) => log.warn("registry", "update-failed", { err: String(err) })
        );
        console.log("\u2713 \u5DF2\u7528\u65B0\u51ED\u636E\u91CD\u8FDE");
      } finally {
        restarting = false;
      }
    }
  };
  bridge = await startChannel({ cfg, agent, sessions, workspaces, controls });
  const botName = bridge.channel.botIdentity?.name;
  if (botName) {
    await updateEntry(entry.id, { botName }).catch(
      (err) => log.warn("registry", "update-failed", { step: "botName", err: String(err) })
    );
  }
  process.on("SIGINT", () => void stop2("SIGINT"));
  process.on("SIGTERM", () => void stop2("SIGTERM"));
  process.on("exit", () => {
    unregisterSync(entry.id);
    cleanupTmpFiles();
  });
  await new Promise(() => {
  });
}
async function resolveConflict(cfg, conflicts) {
  console.log(
    `\u26A0\uFE0F  \u68C0\u6D4B\u5230\u8FD9\u4E2A\u98DE\u4E66\u5E94\u7528\u5DF2\u7ECF\u6709 ${conflicts.length} \u4E2A bot \u6B63\u5728\u8FD0\u884C:`
  );
  for (const e of conflicts) {
    const ago = formatAgo3(Date.now() - new Date(e.startedAt).getTime());
    const label = e.botName ? `bot ${e.botName} (${e.appId})` : `bot ${e.appId}`;
    console.log(`   - ${label},\u8FDB\u7A0B ${e.id},${ago}\u542F\u52A8`);
  }
  console.log("");
  if (!process.stdin.isTTY) {
    console.warn(
      "\u26A0\uFE0F  \u5F53\u524D\u4E0D\u662F\u4EA4\u4E92\u5F0F\u542F\u52A8,\u5DF2\u81EA\u52A8\u53D6\u6D88\u3002\u5982\u9700\u66FF\u6362,\u5148\u7528 `kill <bot id>` \u5173\u6389\u65E7\u7684\u3002\n"
    );
    return false;
  }
  const rl = createInterface4({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    const verb = conflicts.length > 1 ? "\u5B83\u4EEC" : "\u90A3\u4E2A";
    const answer = (await ask(`\u7EE7\u7EED\u542F\u52A8\u4F1A\u5148\u5173\u6389${verb},\u662F\u5426\u7EE7\u7EED? [y/N]: `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return false;
    }
    for (const e of conflicts) {
      try {
        process.kill(e.pid, "SIGTERM");
        console.log(`\u2713 \u5DF2\u5173\u6389 bot ${e.id}`);
      } catch (err) {
        console.warn(`\u2717 \u5173\u6389 bot ${e.id} \u5931\u8D25:${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  } finally {
    rl.close();
  }
}
function formatAgo3(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)} \u79D2\u524D`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)} \u5206\u949F\u524D`;
  if (ms < 864e5) return `${Math.floor(ms / 36e5)} \u5C0F\u65F6\u524D`;
  return `${Math.floor(ms / 864e5)} \u5929\u524D`;
}
async function maybeMigratePlaintextSecret(cfg, configPath) {
  const s = cfg.accounts.app.secret;
  if (typeof s === "string" && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
      await saveConfig(next, configPath);
      console.log("\u{1F512} \u5DF2\u628A App Secret \u52A0\u5BC6\u8FC1\u79FB\u5230 ~/.lark-channel/secrets.enc");
      return next;
    } catch (err) {
      log.warn("config", "migrate-encrypted-failed", {
        err: err instanceof Error ? err.message : String(err)
      });
      return cfg;
    }
  }
  if (typeof s === "string") return cfg;
  try {
    const wrapperPath = await ensureSecretsGetterWrapper();
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences
      );
      await saveConfig(next, configPath);
      console.log("\u{1F512} \u5DF2\u628A secrets provider \u5207\u5230 wrapper \u5F62\u6001");
      return next;
    }
  } catch (err) {
    log.warn("config", "wrapper-refresh-failed", {
      err: err instanceof Error ? err.message : String(err)
    });
  }
  return cfg;
}
function needsProviderRewrite(cfg, wrapperPath) {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}
async function persistEncrypted(cfg, configPath) {
  const s = cfg.accounts.app.secret;
  if (typeof s !== "string") {
    await saveConfig(cfg, configPath);
    return cfg;
  }
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), s);
  await saveConfig(next, configPath);
  return next;
}

// src/cli/index.ts
var program = new Command();
program.name("lark-channel-bridge").description("Bridge Feishu/Lark messenger with local CLI coding agents").version(package_default.version, "-v, --version");
program.command("run").description("Run the bridge in the foreground (was `start` in older versions)").option("-c, --config <path>", "path to config file").option("--skip-check-lark-cli", "skip lark-cli pre-flight check (auto-install + bind)").action(async (opts) => {
  await runStart(opts);
});
program.command("ps").description("List running bridge processes on this machine").action(() => {
  runPs();
});
program.command("kill <target>").description("Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.").action(async (target) => {
  await runKillCli(target);
});
program.command("start").description("Install (if needed) and start the bridge as an OS-managed daemon").option("--skip-check-lark-cli", "skip lark-cli pre-flight check (auto-install + bind)").action(async (opts) => {
  await runServiceStart(opts);
});
program.command("stop").description("Stop the OS-managed daemon (unload from launchd; plist stays)").action(async () => {
  await runServiceStop();
});
program.command("restart").description("Restart the OS-managed daemon").action(async () => {
  await runServiceRestart();
});
program.command("status").description("Show OS service status (pid, last exit, log paths)").action(async () => {
  await runServiceStatus();
});
program.command("unregister").description("Remove the OS service registration (bootout + delete plist)").action(async () => {
  await runServiceUnregister();
});
var secrets = program.command("secrets").description("Manage the bridge's encrypted secret keystore (~/.lark-channel/secrets.enc)");
secrets.command("get").description("Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.").action(async () => {
  await runSecretsGet();
});
secrets.command("set").description("Encrypt and store an App Secret. Prompts for the secret without echoing.").requiredOption("--app-id <id>", "App ID (e.g. cli_xxxxxxxxxxxx)").action(async (opts) => {
  await runSecretsSet(opts.appId);
});
secrets.command("list").description("List the IDs of secrets in the encrypted keystore (no secrets shown)").action(async () => {
  await runSecretsList();
});
secrets.command("remove").description("Delete an entry from the encrypted keystore").requiredOption("--app-id <id>", "App ID to remove").action(async (opts) => {
  await runSecretsRemove(opts.appId);
});
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
