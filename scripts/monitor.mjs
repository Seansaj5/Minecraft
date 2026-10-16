#!/usr/bin/env node
// Pings every server in servers.json, appends the result to the uptime
// history file, and opens/closes a GitHub issue when a server goes down/up.
//
// Usage: node scripts/monitor.mjs [site/servers.json] [status/history.json]
// Uses only Node built-ins (Node 18+).

import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 3000;
const KEEP_SECONDS = 7 * 24 * 60 * 60;
const ISSUE_LABEL = "server-down";

// ---------------------------------------------------------------------------
// Address helpers

export function parseAddress(address, edition = "java") {
  const match = /^(.+?)(?::(\d{1,5}))?$/.exec(address.trim());
  if (!match) throw new Error(`Invalid address: ${address}`);
  return {
    host: match[1],
    port: match[2] ? Number(match[2]) : null,
    defaultPort: edition === "bedrock" ? 19132 : 25565,
  };
}

// Java servers can publish an SRV record (_minecraft._tcp.host) when no port is given.
async function resolveJavaTarget(host, port) {
  if (port) return { host, port };
  if (!net.isIP(host)) {
    try {
      const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (records.length) {
        records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        return { host: records[0].name, port: records[0].port };
      }
    } catch {
      // No SRV record: fall through to the default port.
    }
  }
  return { host, port: 25565 };
}

// ---------------------------------------------------------------------------
// Java Edition: Server List Ping (https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping)

function varInt(value) {
  const bytes = [];
  let n = value >>> 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value, size: i + 1 };
  }
  throw new Error("VarInt is too big");
}

function mcString(text) {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([varInt(bytes.length), bytes]);
}

function packet(id, ...parts) {
  const body = Buffer.concat([varInt(id), ...parts]);
  return Buffer.concat([varInt(body.length), body]);
}

export function pingJava(host, port, handshakeHost = host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let status = null;
    let requestedAt = 0;
    let pingSentAt = 0;

    const finish = (err, latency) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve({ status, latency });
    };

    const timer = setTimeout(() => finish(new Error("Timed out")), TIMEOUT_MS);
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);

    socket.on("connect", () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = packet(0x00, varInt(-1), mcString(handshakeHost), portBuf, varInt(1));
      requestedAt = Date.now();
      socket.write(Buffer.concat([handshake, packet(0x00)]));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const length = readVarInt(buffer, 0);
          if (!length) return;
          if (length.value > 4 * 1024 * 1024) throw new Error("Response too large");
          if (buffer.length < length.size + length.value) return;
          const payload = buffer.subarray(length.size, length.size + length.value);
          buffer = buffer.subarray(length.size + length.value);
          const id = readVarInt(payload, 0);

          if (id.value === 0x00 && !status) {
            const strLen = readVarInt(payload, id.size);
            const start = id.size + strLen.size;
            status = JSON.parse(payload.subarray(start, start + strLen.value).toString("utf8"));
            // Follow up with a ping packet to measure round-trip latency.
            const payloadLong = Buffer.alloc(8);
            payloadLong.writeBigInt64BE(BigInt(Date.now()));
            pingSentAt = Date.now();
            socket.write(packet(0x01, payloadLong));
          } else if (id.value === 0x01 && status) {
            finish(null, Date.now() - pingSentAt);
          }
        }
      } catch (err) {
        finish(err);
      }
    });

    socket.on("error", (err) => finish(err));
    // Some servers hang up after the status response instead of answering the ping.
    socket.on("close", () => {
      if (status) finish(null, pingSentAt ? pingSentAt - requestedAt : Date.now() - requestedAt);
      else finish(new Error("Connection closed before status response"));
    });
  });
}

function chatToText(component) {
  if (component == null) return "";
  if (typeof component === "string") return component;
  if (Array.isArray(component)) return component.map(chatToText).join("");
  return (component.text ?? "") + (component.extra ?? []).map(chatToText).join("");
}

export function stripFormatting(text) {
  return text.replace(/§[0-9a-fk-orx]/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Bedrock Edition: RakNet unconnected ping

const RAKNET_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

export function pingBedrock(host, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
    const sentAt = Date.now();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error("Timed out")), TIMEOUT_MS);

    socket.on("message", (msg) => {
      if (msg[0] !== 0x1c || msg.length < 35) return;
      const length = msg.readUInt16BE(33);
      const fields = msg.subarray(35, 35 + length).toString("utf8").split(";");
      finish(null, {
        motd: [fields[1], fields[7]].filter(Boolean).join("\n"),
        version: fields[3] ?? null,
        players: Number(fields[4]) || 0,
        max: Number(fields[5]) || 0,
        latency: Date.now() - sentAt,
      });
    });
    socket.on("error", (err) => finish(err));

    const request = Buffer.alloc(33);
    request[0] = 0x01;
    request.writeBigInt64BE(BigInt(sentAt), 1);
    RAKNET_MAGIC.copy(request, 9);
    request.writeBigInt64BE(2n, 25);
    socket.send(request, port, host, (err) => err && finish(err));
  });
}

// ---------------------------------------------------------------------------
// Checking servers

async function checkOnce(server) {
  const edition = server.edition === "bedrock" ? "bedrock" : "java";
  const { host, port, defaultPort } = parseAddress(server.address, edition);

  if (edition === "bedrock") {
    const result = await pingBedrock(host, port ?? defaultPort);
    return { online: true, ...result, motd: stripFormatting(result.motd) };
  }

  const target = await resolveJavaTarget(host, port);
  const { status, latency } = await pingJava(target.host, target.port, host);
  return {
    online: true,
    players: status.players?.online ?? 0,
    max: status.players?.max ?? 0,
    version: status.version?.name ? stripFormatting(status.version.name) : null,
    motd: stripFormatting(chatToText(status.description)),
    latency,
  };
}

export async function checkServer(server) {
  try {
    return await checkOnce(server);
  } catch {
    // One retry so a single dropped packet doesn't count as downtime.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      return await checkOnce(server);
    } catch (err) {
      return { online: false, error: err.code || err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// History file

async function readJson(path, fallback) {
  try {
    const text = await readFile(path, "utf8");
    return text.trim() ? JSON.parse(text) : fallback;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`Could not read ${path}: ${err.message}`);
    return fallback;
  }
}

export function historyKey(server) {
  return server.address.trim().toLowerCase();
}

export function recordResults(history, servers, results, now) {
  const next = { version: 1, updated: now, servers: {} };
  servers.forEach((server, i) => {
    const key = historyKey(server);
    const result = results[i];
    const previous = history.servers?.[key]?.checks ?? [];
    const checks = previous.filter((c) => c[0] >= now - KEEP_SECONDS);
    checks.push([now, result.online ? 1 : 0, result.online ? result.players : null, result.online ? result.latency : null]);
    next.servers[key] = {
      name: server.name || server.address,
      address: server.address,
      edition: server.edition || "java",
      latest: { t: now, ...result },
      checks,
    };
  });
  return next;
}

// ---------------------------------------------------------------------------
// GitHub issue alerts

function outageStart(checks) {
  let start = null;
  for (let i = checks.length - 1; i >= 0 && !checks[i][1]; i--) start = checks[i][0];
  return start;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}`;
}

const utc = (t) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export async function syncIssues(history, servers, alerts) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("Skipping issue alerts (GITHUB_TOKEN / GITHUB_REPOSITORY not set).");
    return;
  }
  const threshold = Math.max(1, alerts.failedChecksBeforeAlert ?? 2);

  const api = async (method, path, body) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "minecraft-status-monitor",
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };

  const openIssues = await api("GET", `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`);
  const marker = (key) => `<!-- mc-monitor:${key} -->`;

  for (const server of servers) {
    const key = historyKey(server);
    const entry = history.servers[key];
    const recent = entry.checks.slice(-threshold);
    const isDown = recent.length >= threshold && recent.every((c) => !c[1]);
    const issue = openIssues.find((i) => i.body?.includes(marker(key)));
    const name = entry.name;

    if (isDown && !issue) {
      const since = outageStart(entry.checks);
      await api("POST", "/labels", { name: ISSUE_LABEL, color: "d03b3b", description: "Opened by the server monitor" }).catch(() => {});
      const created = await api("POST", "/issues", {
        title: `🔴 ${name} (${server.address}) is down`,
        labels: [ISSUE_LABEL],
        body: [
          `**${name}** (\`${server.address}\`) is not responding.`,
          "",
          `- First failed check: ${utc(since)}`,
          `- Last error: \`${entry.latest.error ?? "unknown"}\``,
          "",
          "This issue closes itself when the server is back online.",
          "",
          marker(key),
        ].join("\n"),
      });
      console.log(`Opened issue #${created.number} for ${server.address}`);
    } else if (!isDown && entry.latest.online && issue) {
      const since = outageStart(entry.checks.slice(0, -1)) ?? Date.parse(issue.created_at) / 1000;
      const { players, max, version } = entry.latest;
      await api("POST", `/issues/${issue.number}/comments`, {
        body: `✅ **${name}** is back online as of ${utc(entry.latest.t)} after about ${formatDuration(entry.latest.t - since)} of downtime. ${players}/${max} players${version ? `, ${version}` : ""}.`,
      });
      await api("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      console.log(`Closed issue #${issue.number} for ${server.address}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [configPath = "site/servers.json", historyPath = "status/history.json"] = process.argv.slice(2);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const servers = config.servers ?? [];
  const history = await readJson(historyPath, { servers: {} });

  const results = await Promise.all(servers.map(checkServer));
  servers.forEach((server, i) => {
    const r = results[i];
    console.log(
      r.online
        ? `UP    ${server.address}  ${r.players}/${r.max} players  ${r.latency} ms  ${r.version ?? ""}`
        : `DOWN  ${server.address}  (${r.error})`,
    );
  });

  const next = recordResults(history, servers, results, Math.floor(Date.now() / 1000));
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(next));

  if (config.alerts?.enabled !== false) {
    try {
      await syncIssues(next, servers, config.alerts ?? {});
    } catch (err) {
      console.warn(`Issue alerts failed: ${err.message}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
