import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, ".data");
const dbPath = path.join(dataDir, "db.json");
const secretPath = path.join(dataDir, "secret");
const adminPasswordPath = path.join(dataDir, "admin-password");
const port = Number(process.env.PORT || 5100);
const cfstBinFromEnv = process.env.CFST_BIN;
const cfstTimeoutMs = Number(process.env.CFST_TIMEOUT_MS || 15 * 60 * 1000);
const cloudflareTimeoutMs = Number(process.env.CLOUDFLARE_TIMEOUT_MS || 30 * 1000);
const maxRequestBodyBytes = Number(process.env.MAX_REQUEST_BODY_BYTES || 1024 * 1024);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const defaultDb = {
  tasks: [],
  logs: []
};

let db = structuredClone(defaultDb);
let secretKey;
let adminPassword;
const timers = new Map();
const sessions = new Map();
let quickRunActive = false;
let activeRun = Promise.resolve();

await ensureStorage();
await loadDb();
scheduleAllTasks();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (!canServeStatic(req, url)) {
      await serveStaticFile(res, path.join(publicDir, "login.html"));
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "服务器错误" });
  }
});

server.listen(port, () => {
  console.log(`Atuo CF panel listening on http://127.0.0.1:${port}`);
});

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(secretPath, fsConstants.R_OK);
  } catch {
    await fs.writeFile(secretPath, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  const rawSecret = (process.env.APP_SECRET || await fs.readFile(secretPath, "utf8")).trim();
  secretKey = crypto.createHash("sha256").update(rawSecret).digest();
  adminPassword = await loadAdminPassword();

  try {
    await fs.access(dbPath, fsConstants.R_OK);
  } catch {
    await saveDb();
  }
}

async function loadDb() {
  const raw = await fs.readFile(dbPath, "utf8");
  const parsed = JSON.parse(raw || "{}");
  db = {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    logs: Array.isArray(parsed.logs) ? parsed.logs : []
  };
}

async function saveDb() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/session") {
    await handleSessionApi(req, res);
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: "请先登录" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      cfst: await detectCfstStatus(),
      now: new Date().toISOString()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, {
      tasks: db.tasks.map(publicTask),
      logs: db.logs.slice(0, 100)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/quick-preview") {
    const body = await readJson(req);
    const preview = await buildQuickPreview(body);
    sendJson(res, 200, preview);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/quick-run") {
    if (quickRunActive) {
      sendJson(res, 409, { error: "已有快查优选正在运行" });
      return;
    }
    const body = await readJson(req);
    quickRunActive = true;
    try {
      const result = await runQuickOptimize(body);
      sendJson(res, 200, result);
    } finally {
      quickRunActive = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJson(req);
    const task = normalizeTask(body);
    db.tasks.unshift(task);
    scheduleTask(task);
    await saveDb();
    sendJson(res, 201, { task: publicTask(task) });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === "PUT") {
    const task = findTask(taskMatch[1]);
    const body = await readJson(req);
    const updated = normalizeTask(body, task);
    Object.assign(task, updated, {
      id: task.id,
      createdAt: task.createdAt,
      token: body.apiToken ? encrypt(body.apiToken) : task.token
    });
    scheduleTask(task);
    await saveDb();
    sendJson(res, 200, { task: publicTask(task) });
    return;
  }

  if (taskMatch && req.method === "DELETE") {
    const id = taskMatch[1];
    db.tasks = db.tasks.filter((task) => task.id !== id);
    db.logs = db.logs.filter((log) => log.taskId !== id);
    clearTaskTimer(id);
    await saveDb();
    sendJson(res, 200, { ok: true });
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(run|toggle|test)$/);
  if (actionMatch && req.method === "POST") {
    const task = findTask(actionMatch[1]);
    const action = actionMatch[2];

    if (action === "toggle") {
      task.enabled = !task.enabled;
      scheduleTask(task);
      await saveDb();
      sendJson(res, 200, { task: publicTask(task) });
      return;
    }

    if (action === "test") {
      const cloudflare = await resolveCloudflareRecord(task, { createIfMissing: false });
      task.updatedAt = new Date().toISOString();
      task.lastMessage = `连接成功：${cloudflare.zone.name}`;
      await saveDb();
      sendJson(res, 200, {
        ok: true,
        zoneName: cloudflare.zone.name,
        record: cloudflare.record
      });
      return;
    }

    const queued = queueRun(task.id, "manual");
    sendJson(res, queued ? 202 : 409, {
      ok: queued,
      message: queued ? "任务已加入队列" : "任务正在排队或运行中"
    });
    return;
  }

  sendJson(res, 404, { error: "接口不存在" });
}

async function loadAdminPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  if (process.env.APP_PASSWORD_FILE) {
    return (await fs.readFile(process.env.APP_PASSWORD_FILE, "utf8")).trim();
  }

  try {
    return (await fs.readFile(adminPasswordPath, "utf8")).trim();
  } catch {
    const generated = crypto.randomBytes(12).toString("base64url");
    await fs.writeFile(adminPasswordPath, `${generated}\n`, { mode: 0o600 });
    console.log(`Admin password generated at ${adminPasswordPath}`);
    return generated;
  }
}

async function handleSessionApi(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { authenticated: isAuthenticated(req) });
    return;
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    if (!verifyPassword(body.password || "")) {
      sendJson(res, 401, { error: "密码错误" });
      return;
    }

    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": buildSessionCookie(req, token)
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "DELETE") {
    const token = readCookie(req, "auto_cf_session");
    if (token) sessions.delete(token);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": buildSessionCookie(req, "", 0)
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  sendJson(res, 405, { error: "方法不支持" });
}

function isAuthenticated(req) {
  const token = readCookie(req, "auto_cf_session");
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function buildSessionCookie(req, token, maxAge = 7 * 24 * 60 * 60) {
  const secure = isHttps(req) ? "; Secure" : "";
  return `auto_cf_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function isHttps(req) {
  return Boolean(req.socket.encrypted || req.headers["x-forwarded-proto"] === "https");
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((item) => item.trim());
  const prefix = `${name}=`;
  const cookie = cookies.find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function verifyPassword(value) {
  const expected = Buffer.from(String(adminPassword));
  const actual = Buffer.from(String(value));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));

  if (!isInsidePublicDir(filePath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not file");
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = path.join(publicDir, "index.html");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    createReadStream(fallback).pipe(res);
  }
}

function canServeStatic(req, url) {
  if (url.pathname === "/styles.css" || url.pathname === "/app.js") return true;
  if (url.pathname === "/login.html") return true;
  return isAuthenticated(req);
}

function isInsidePublicDir(filePath) {
  return filePath === publicDir || filePath.startsWith(`${publicDir}${path.sep}`);
}

async function serveStaticFile(res, filePath) {
  res.writeHead(200, {
    "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

function normalizeTask(input, existing = null) {
  const hostname = cleanHostname(input.hostname);
  const authType = input.authType === "globalKey" ? "globalKey" : "token";
  const authEmail = String(input.authEmail || existing?.authEmail || "").trim();
  const recordType = input.recordType === "AAAA" ? "AAAA" : "A";
  const intervalValue = Math.max(1, Number.parseInt(input.intervalValue, 10) || 1);
  const intervalUnit = ["seconds", "minutes", "hours", "days"].includes(input.intervalUnit)
    ? input.intervalUnit
    : "hours";
  const ttl = Math.max(1, Number.parseInt(input.ttl, 10) || 1);
  const cfstArgs = typeof input.cfstArgs === "string" ? input.cfstArgs.trim() : "";

  if (!hostname) throw badRequest("请填写要解析的域名");
  if (!existing && !input.apiToken) throw badRequest("请填写 Cloudflare 凭据");
  if (authType === "globalKey" && !authEmail) throw badRequest("Global API Key 模式需要填写 Cloudflare 邮箱");

  return {
    id: existing?.id || crypto.randomUUID(),
    name: String(input.name || hostname).trim().slice(0, 80),
    authType,
    authEmail,
    testTarget: cleanTestTarget(input.testTarget || existing?.testTarget || hostname),
    hostname,
    recordType,
    ttl,
    proxied: Boolean(input.proxied),
    intervalValue,
    intervalUnit,
    enabled: Boolean(input.enabled ?? true),
    minSpeed: toNullableNumber(input.minSpeed),
    maxLatency: toNullableNumber(input.maxLatency),
    cfstArgs,
    token: input.apiToken ? encrypt(input.apiToken) : existing?.token,
    zoneId: existing?.zoneId || null,
    zoneName: existing?.zoneName || null,
    recordId: existing?.recordId || null,
    currentIp: existing?.currentIp || null,
    lastIp: existing?.lastIp || null,
    lastRunAt: existing?.lastRunAt || null,
    nextRunAt: existing?.nextRunAt || null,
    status: existing?.status || "idle",
    lastMessage: existing?.lastMessage || "",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function publicTask(task) {
  return {
    ...task,
    token: undefined,
    hasToken: Boolean(task.token),
    intervalLabel: formatInterval(task),
    nextRunAt: task.enabled ? task.nextRunAt : null
  };
}

function cleanHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function cleanTestTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return cleanHostname(raw);
}

function toNullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatInterval(task) {
  const unitMap = {
    seconds: "秒",
    minutes: "分钟",
    hours: "小时",
    days: "天"
  };
  return `每 ${task.intervalValue} ${unitMap[task.intervalUnit] || "小时"}`;
}

function testTargetToUrl(value) {
  const target = cleanTestTarget(value);
  if (!target) return "";
  if (/^https?:\/\//i.test(target)) return target;
  return `https://${target}/cdn-cgi/trace`;
}

async function buildQuickPreview(input) {
  const testTarget = cleanTestTarget(input.testTarget);
  const recordType = input.recordType === "AAAA" ? "AAAA" : "A";
  if (!testTarget) throw badRequest("请填写要优选的域名");

  return {
    testTarget,
    testUrl: testTargetToUrl(testTarget),
    recordType,
    cfst: await detectCfstStatus(),
    message: "这是临时快查，不会保存任务或更新 DNS"
  };
}

async function runQuickOptimize(input) {
  const preview = await buildQuickPreview(input);
  const result = await runCfst({
    testTarget: preview.testTarget,
    recordType: preview.recordType,
    cfstArgs: typeof input.cfstArgs === "string" ? input.cfstArgs.trim() : ""
  });

  return {
    ...preview,
    result,
    message: result.ip ? "优选完成" : "没有返回可用 IP"
  };
}

function findTask(id) {
  const task = db.tasks.find((item) => item.id === id);
  if (!task) throw notFound("任务不存在");
  return task;
}

function scheduleAllTasks() {
  for (const task of db.tasks) {
    scheduleTask(task);
  }
}

function scheduleTask(task) {
  clearTaskTimer(task.id);
  if (!task.enabled) {
    task.nextRunAt = null;
    return;
  }

  const delay = intervalMs(task);
  const nextRunAt = new Date(Date.now() + delay).toISOString();
  task.nextRunAt = nextRunAt;
  timers.set(task.id, setTimeout(() => {
    queueRun(task.id, "schedule");
  }, delay));
}

function clearTaskTimer(id) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function intervalMs(task) {
  const multipliers = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000
  };
  return Math.max(1000, task.intervalValue * (multipliers[task.intervalUnit] || multipliers.hours));
}

function queueRun(taskId, trigger) {
  const task = findTask(taskId);
  if (task.status === "queued" || task.status === "running") {
    return false;
  }

  clearTaskTimer(taskId);
  task.status = "queued";
  task.lastMessage = trigger === "manual" ? "手动任务已排队" : "定时任务已排队";
  saveDb().catch(console.error);

  activeRun = activeRun
    .catch(() => {})
    .then(() => runTask(taskId, trigger))
    .catch((error) => console.error(error))
    .finally(() => {
      const fresh = db.tasks.find((item) => item.id === taskId);
      if (fresh?.enabled) scheduleTask(fresh);
      saveDb().catch(console.error);
    });
  return true;
}

async function runTask(taskId, trigger) {
  const task = findTask(taskId);
  const startedAt = new Date().toISOString();
  let log = {
    id: crypto.randomUUID(),
    taskId: task.id,
    taskName: task.name,
    hostname: task.hostname,
    trigger,
    oldIp: task.currentIp,
    newIp: null,
    latency: null,
    speed: null,
    status: "running",
    message: "正在优选",
    startedAt,
    finishedAt: null
  };
  db.logs.unshift(log);
  db.logs = db.logs.slice(0, 300);
  task.status = "running";
  task.lastMessage = "正在运行 CloudflareSpeedTest";
  task.lastRunAt = startedAt;
  await saveDb();

  try {
    const result = await runCfst(task);
    if (!result.ip) throw new Error("CloudflareSpeedTest 没有返回可用 IP");

    log.newIp = result.ip;
    log.latency = result.latency;
    log.speed = result.speed;

    if (task.maxLatency !== null && result.latency !== null && result.latency > task.maxLatency) {
      throw new Error(`优选 IP 延迟 ${result.latency} ms，高于限制 ${task.maxLatency} ms`);
    }

    if (task.minSpeed !== null && result.speed !== null && result.speed < task.minSpeed) {
      throw new Error(`优选 IP 速度 ${result.speed} MB/s，低于限制 ${task.minSpeed} MB/s`);
    }

    const cf = await resolveCloudflareRecord(task, { createIfMissing: true, createContent: result.ip });
    log.oldIp = cf.record?.content || task.currentIp;

    if (cf.record?.content === result.ip) {
      task.currentIp = result.ip;
      task.lastIp = result.ip;
      task.status = "idle";
      task.lastMessage = "优选 IP 未变化，无需更新";
      log.status = "success";
      log.message = "IP 未变化";
    } else {
      const updated = await updateDnsRecord(task, cf, result.ip);
      task.zoneId = cf.zone.id;
      task.zoneName = cf.zone.name;
      task.recordId = updated.id;
      task.currentIp = updated.content;
      task.lastIp = result.ip;
      task.status = "idle";
      task.lastMessage = `已更新为 ${updated.content}`;
      log.status = "success";
      log.message = `DNS 已更新为 ${updated.content}`;
    }
  } catch (error) {
    task.status = "failed";
    task.lastMessage = error.message || "运行失败";
    log.status = "failed";
    log.message = task.lastMessage;
  } finally {
    task.updatedAt = new Date().toISOString();
    log.finishedAt = new Date().toISOString();
    await saveDb();
  }
}

async function runCfst(task) {
  const bin = await findCfstBinary();
  if (!bin) {
    throw new Error("当前环境未找到 CloudflareSpeedTest。Debian 菜单安装会自动安装；手动运行时请确认 bin/cfst 存在或设置 CFST_BIN。");
  }

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "atuo-cf-"));
  const outputPath = path.join(runDir, "result.csv");
  const args = [...splitArgs(task.cfstArgs), "-o", outputPath];
  const hasUrlArg = args.some((arg) => arg === "-url" || arg.startsWith("-url="));
  const testUrl = testTargetToUrl(task.testTarget);

  if (testUrl && !hasUrlArg) {
    args.unshift("-url", testUrl);
  }

  if (task.recordType === "AAAA" && !args.includes("-ipv6")) {
    args.unshift("-ipv6");
  }

  try {
    await spawnProcess(bin, args, { cwd: runDir, timeoutMs: cfstTimeoutMs });
    const csv = await fs.readFile(outputPath, "utf8");
    return parseCfstCsv(csv);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findCfstBinary() {
  const candidates = [
    cfstBinFromEnv,
    path.join(rootDir, "bin", "cfst"),
    path.join(rootDir, "bin", "CloudflareSpeedTest"),
    path.join(rootDir, "bin", "cfst.exe"),
    "cfst",
    "CloudflareSpeedTest"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await spawnProcess(candidate, ["-v"], { timeoutMs: 3000, allowFailure: true });
      return candidate;
    } catch {}
  }

  return null;
}

async function detectCfstStatus() {
  const bin = await findCfstBinary();
  return {
    found: Boolean(bin),
    path: bin || null
  };
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CloudflareSpeedTest 运行超时"));
    }, options.timeoutMs || 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `命令退出码 ${code}`));
      }
    });
  });
}

function splitArgs(input) {
  const matches = String(input || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

function parseCfstCsv(csv) {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map(parseCsvLine)
    .filter((row) => row.length > 0);

  if (rows.length < 2) return {};
  const headers = rows[0].map((header) => header.trim());
  const first = rows[1];
  const record = Object.fromEntries(headers.map((header, index) => [header, first[index]]));

  return {
    ip: first[0]?.trim(),
    latency: numberFromAny(record["平均延迟"] || record["平均延迟(ms)"] || record["延迟"] || first[4]),
    speed: numberFromAny(record["下载速度 (MB/s)"] || record["下载速度"] || first[first.length - 1]),
    raw: record
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function numberFromAny(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function resolveCloudflareRecord(task, { createIfMissing, createContent = null }) {
  const auth = cloudflareAuth(task);
  const zone = await findZone(task.hostname, auth);
  const records = await cfRequest(`/zones/${zone.id}/dns_records?type=${task.recordType}&name=${encodeURIComponent(task.hostname)}`, {
    auth
  });
  let record = records.result?.[0] || null;

  if (!record && createIfMissing) {
    record = await createDnsRecord(task, zone, createContent, auth);
  }

  if (!record) {
    throw new Error(`Cloudflare 中没有找到 ${task.hostname} 的 ${task.recordType} 记录`);
  }

  task.zoneId = zone.id;
  task.zoneName = zone.name;
  task.recordId = record.id;
  task.currentIp = record.content;
  return { auth, zone, record };
}

async function findZone(hostname, auth) {
  const labels = hostname.split(".");
  const candidates = [];

  for (let index = 0; index < labels.length - 1; index += 1) {
    candidates.push(labels.slice(index).join("."));
  }

  for (const name of candidates) {
    const data = await cfRequest(`/zones?name=${encodeURIComponent(name)}&status=active`, { auth });
    if (data.result?.[0]) return data.result[0];
  }

  throw new Error(`找不到 ${hostname} 对应的 Cloudflare Zone，请确认 Cloudflare 凭据有 Zone Read 权限`);
}

async function createDnsRecord(task, zone, content, auth) {
  const data = await cfRequest(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    auth,
    body: {
      type: task.recordType,
      name: task.hostname,
      content,
      ttl: task.ttl,
      proxied: task.proxied
    }
  });
  return data.result;
}

async function updateDnsRecord(task, cf, ip) {
  const data = await cfRequest(`/zones/${cf.zone.id}/dns_records/${cf.record.id}`, {
    method: "PATCH",
    auth: cf.auth,
    body: {
      type: task.recordType,
      name: task.hostname,
      content: ip,
      ttl: task.ttl,
      proxied: task.proxied
    }
  });
  return data.result;
}

async function cfRequest(pathname, options) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...cloudflareHeaders(options.auth),
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(cloudflareTimeoutMs),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    const message = data.errors?.map((item) => item.message).join("; ") || `Cloudflare API ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function cloudflareAuth(task) {
  return {
    type: task.authType === "globalKey" ? "globalKey" : "token",
    credential: decrypt(task.token),
    email: task.authEmail || ""
  };
}

function cloudflareHeaders(auth) {
  if (!auth?.credential) throw new Error("Cloudflare 凭据为空");

  if (auth.type === "globalKey") {
    if (!auth.email) throw new Error("Global API Key 模式需要 Cloudflare 邮箱");
    return {
      "x-auth-email": auth.email,
      "x-auth-key": auth.credential
    };
  }

  return {
    authorization: `Bearer ${auth.credential}`
  };
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decrypt(value) {
  const [ivRaw, tagRaw, encryptedRaw] = String(value || "").split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Token 无法解密");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxRequestBodyBytes) {
      throw badRequest("请求体过大");
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("JSON 格式错误");
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
