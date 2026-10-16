"use strict";

const REFRESH_SECONDS = 60;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_BRANCH = "status-data";
const WATCHLIST_KEY = "mc-status:watchlist";
const DAY = 24 * 60 * 60;
const SLOT = 30 * 60; // one uptime bar = 30 minutes
const GAP = 25 * 60; // break the player line when checks are further apart than this

const DEFAULT_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' shape-rendering='crispEdges'>" +
      "<rect width='8' height='8' fill='#866043'/><rect width='8' height='3' fill='#5d9b34'/>" +
      "<rect x='1' y='3' width='1' height='1' fill='#5d9b34'/><rect x='4' y='3' width='2' height='1' fill='#5d9b34'/>" +
      "<rect x='2' y='5' width='1' height='1' fill='#6b4a30'/><rect x='6' y='6' width='1' height='1' fill='#6b4a30'/></svg>",
  );

const MC_COLORS = {
  0: "#000000", 1: "#0000aa", 2: "#00aa00", 3: "#00aaaa", 4: "#aa0000", 5: "#aa00aa", 6: "#ffaa00", 7: "#aaaaaa",
  8: "#555555", 9: "#5555ff", a: "#55ff55", b: "#55ffff", c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff",
};

const state = {
  config: null,
  history: null,
  historyLoadedAt: 0,
  watchlist: [],
  cards: new Map(),
  nextRefreshAt: 0,
  refreshing: false,
};

const els = {};
const q = (root, sel) => root.querySelector(sel);
const numberFmt = new Intl.NumberFormat();
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

init();

async function init() {
  for (const id of [
    "site-title", "site-desc", "sum-servers", "sum-players", "refresh-status", "refresh-btn", "load-error",
    "featured", "watchlist", "watch-empty", "add-form", "add-error", "card-template", "tooltip", "monitor-updated",
  ]) {
    els[id] = document.getElementById(id);
  }

  try {
    const res = await fetch("servers.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
  } catch (err) {
    els["load-error"].textContent = `Couldn't load servers.json (${err.message}).`;
    els["load-error"].hidden = false;
    state.config = { servers: [] };
  }

  const { title, description } = state.config;
  if (title) els["site-title"].textContent = document.title = title;
  if (description) els["site-desc"].textContent = description;

  for (const server of state.config.servers ?? []) createCard(normalizeServer(server), "featured");
  state.watchlist = loadWatchlist();
  for (const server of state.watchlist) createCard(server, "watch");
  updateWatchEmpty();

  els["refresh-btn"].addEventListener("click", () => refreshAll());
  els["add-form"].addEventListener("submit", onAddServer);
  setupTooltip();
  document.addEventListener("visibilitychange", tick);

  loadHistory();
  refreshAll();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Servers & watchlist

function normalizeServer(server) {
  return {
    name: String(server.name ?? "").trim(),
    address: String(server.address).trim().toLowerCase(),
    edition: server.edition === "bedrock" ? "bedrock" : "java",
  };
}

const keyOf = (server) => `${server.edition}:${server.address}`;

function isValidAddress(address) {
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/i.exec(address);
  return Boolean(match) && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535));
}

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((s) => s && typeof s.address === "string" && isValidAddress(s.address))
      .map(normalizeServer)
      .filter((s) => !state.cards.has(keyOf(s)));
  } catch {
    return [];
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(state.watchlist));
  } catch {
    // Storage unavailable (private mode etc.): the list lasts for this visit only.
  }
}

function onAddServer(event) {
  event.preventDefault();
  const form = new FormData(els["add-form"]);
  const address = String(form.get("address") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "");
  const server = normalizeServer({ name: form.get("name"), address, edition: form.get("edition") });

  if (!isValidAddress(server.address)) {
    els["add-error"].textContent = "Enter an address like play.example.com or play.example.com:25566.";
    return;
  }
  if (state.cards.has(keyOf(server))) {
    els["add-error"].textContent = "That server is already on this page.";
    return;
  }

  els["add-error"].textContent = "";
  els["add-form"].reset();
  state.watchlist.push(server);
  saveWatchlist();
  const entry = createCard(server, "watch");
  updateWatchEmpty();
  refreshEntry(entry).then(updateSummary);
}

function removeFromWatchlist(entry) {
  state.watchlist = state.watchlist.filter((s) => keyOf(s) !== entry.key);
  saveWatchlist();
  state.cards.delete(entry.key);
  entry.el.remove();
  updateWatchEmpty();
  updateSummary();
}

function updateWatchEmpty() {
  els["watch-empty"].hidden = state.watchlist.length > 0;
}

// ---------------------------------------------------------------------------
// Live status (browser -> public status API)

async function fetchJSON(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryServer(server) {
  try {
    const data = await fetchJSON(`https://api.mcstatus.io/v2/status/${server.edition}/${server.address}`);
    return fromMcstatus(data, server.edition);
  } catch {
    const path = server.edition === "bedrock" ? "bedrock/3" : "3";
    return fromMcsrvstat(await fetchJSON(`https://api.mcsrvstat.us/${path}/${server.address}`));
  }
}

function fromMcstatus(d, edition) {
  if (!d.online) return { online: false, source: "mcstatus.io" };
  return {
    online: true,
    motd: d.motd?.raw ?? "",
    players: d.players?.online ?? 0,
    max: d.players?.max ?? 0,
    list: (d.players?.list ?? []).map((p) => p.name_clean ?? p.name_raw ?? "").filter(Boolean),
    version: edition === "java" ? d.version?.name_clean : d.version?.name,
    software: d.software ?? null,
    icon: d.icon ?? null,
    source: "mcstatus.io",
  };
}

function fromMcsrvstat(d) {
  if (!d.online) return { online: false, source: "mcsrvstat.us" };
  const motd = d.motd?.raw;
  return {
    online: true,
    motd: Array.isArray(motd) ? motd.join("\n") : (motd ?? ""),
    players: d.players?.online ?? 0,
    max: d.players?.max ?? 0,
    list: (d.players?.list ?? []).map((p) => p.name ?? "").filter(Boolean),
    version: d.version ?? null,
    software: d.software ?? null,
    icon: d.icon ?? null,
    source: "mcsrvstat.us",
  };
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  els["refresh-btn"].disabled = true;
  els["refresh-status"].textContent = "Checking…";

  if (Date.now() - state.historyLoadedAt > HISTORY_REFRESH_MS) loadHistory();
  await Promise.all([...state.cards.values()].map(refreshEntry));

  state.refreshing = false;
  state.nextRefreshAt = Date.now() + REFRESH_SECONDS * 1000;
  els["refresh-btn"].disabled = false;
  updateSummary();
  updateRefreshLabel();
}

async function refreshEntry(entry) {
  entry.el.classList.add("is-refreshing");
  try {
    entry.result = await queryServer(entry.server);
  } catch {
    entry.result = { error: "status service unreachable" };
  }
  entry.checkedAt = Date.now();
  entry.el.classList.remove("is-refreshing");
  if (state.cards.get(entry.key) === entry) renderCard(entry);
}

function tick() {
  if (document.hidden || state.refreshing) return;
  if (Date.now() >= state.nextRefreshAt) {
    refreshAll();
    return;
  }
  updateRefreshLabel();
  for (const entry of state.cards.values()) updateCheckedLabel(entry);
}

function updateRefreshLabel() {
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  els["refresh-status"].textContent = `Auto-refresh in ${seconds}s`;
}

function updateSummary() {
  const entries = [...state.cards.values()];
  const online = entries.filter((e) => e.result?.online);
  const players = online.reduce((sum, e) => sum + (e.result.players || 0), 0);
  els["sum-servers"].textContent = `${online.length} / ${entries.length}`;
  els["sum-players"].textContent = numberFmt.format(players);
  const title = state.config.title || "Minecraft Server Status";
  document.title = entries.length ? `(${online.length}/${entries.length}) ${title}` : title;
}

// ---------------------------------------------------------------------------
// Uptime history (written by the GitHub Actions monitor)

function historyUrl() {
  const { historyUrl, repo } = state.config;
  if (historyUrl) return historyUrl;
  if (repo) return `https://raw.githubusercontent.com/${repo}/${HISTORY_BRANCH}/history.json`;
  return null;
}

async function loadHistory() {
  const url = historyUrl();
  state.historyLoadedAt = Date.now();
  if (!url) return;
  try {
    state.history = await fetchJSON(`${url}?t=${Math.floor(Date.now() / 60000)}`);
  } catch {
    return; // The monitor hasn't run yet; cards explain this.
  }
  if (state.history?.updated) {
    els["monitor-updated"].textContent = ` (last run ${relativeTime(state.history.updated * 1000)})`;
  }
  for (const entry of state.cards.values()) renderCard(entry);
}

function historyFor(entry) {
  if (entry.kind !== "featured") return null;
  return state.history?.servers?.[entry.server.address] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering

function createCard(server, kind) {
  const el = els["card-template"].content.firstElementChild.cloneNode(true);
  const entry = { key: keyOf(server), server, kind, el, result: null, checkedAt: 0 };

  q(el, ".server-name").textContent = server.name || server.address;
  if (server.edition === "bedrock") {
    const tag = document.createElement("span");
    tag.className = "edition-tag";
    tag.textContent = "Bedrock";
    q(el, ".server-name").append(tag);
  }
  q(el, ".address-text").textContent = server.address;
  q(el, ".address").addEventListener("click", () => copyAddress(entry));
  q(el, ".server-icon").src = DEFAULT_ICON;

  if (kind === "watch") {
    const remove = q(el, ".remove");
    remove.hidden = false;
    remove.setAttribute("aria-label", `Remove ${server.name || server.address}`);
    remove.addEventListener("click", () => removeFromWatchlist(entry));
  }
  setupSparkHover(entry);

  state.cards.set(entry.key, entry);
  els[kind === "featured" ? "featured" : "watchlist"].append(el);
  renderCard(entry);
  return entry;
}

function cardState(result) {
  if (!result) return "loading";
  if (result.error) return "unknown";
  return result.online ? "online" : "offline";
}

function renderCard(entry) {
  const { el, result } = entry;
  const status = cardState(result);
  const online = status === "online";
  el.dataset.state = status;
  q(el, ".pill-text").textContent = { loading: "Checking…", online: "Online", offline: "Offline", unknown: "Unknown" }[status];

  const icon = q(el, ".server-icon");
  const iconSrc = online && /^data:image\/(png|jpeg|gif|webp);base64,/.test(result.icon ?? "") ? result.icon : DEFAULT_ICON;
  if (icon.src !== iconSrc) icon.src = iconSrc;

  const motd = q(el, ".motd");
  motd.classList.toggle("motd-empty", !online);
  if (online) renderMotd(result.motd || "A Minecraft Server", motd);
  else {
    motd.textContent = {
      loading: "Contacting server…",
      offline: "This server is offline or not responding.",
      unknown: `Couldn't check this server right now (${result?.error}). Retrying soon.`,
    }[status];
  }

  const players = q(el, ".stat-players");
  players.textContent = online ? `${numberFmt.format(result.players)} / ${numberFmt.format(result.max)}` : "–";
  const version = q(el, ".stat-version");
  version.textContent = online ? result.version || "Unknown" : "–";
  version.title = online ? [result.version, result.software].filter(Boolean).join(" · ") : "";

  renderPlayers(entry);
  renderHistory(entry);
  updateCheckedLabel(entry);
}

function renderMotd(raw, el) {
  el.replaceChildren();
  let color = null;
  const formats = new Set();
  let text = "";

  const flush = () => {
    if (!text) return;
    const span = document.createElement("span");
    span.textContent = text;
    if (color) span.style.color = color;
    for (const f of formats) span.classList.add(`mc-${f}`);
    el.append(span);
    text = "";
  };

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "§" && i + 1 < raw.length) {
      const code = raw[i + 1].toLowerCase();
      const hex = raw.slice(i + 2, i + 14);
      if (code === "x" && /^(§[0-9a-f]){6}$/i.test(hex)) {
        flush();
        color = `#${hex.replace(/§/g, "")}`;
        formats.clear();
        i += 13;
        continue;
      }
      if (code in MC_COLORS) {
        flush();
        color = MC_COLORS[code];
        formats.clear();
        i += 1;
        continue;
      }
      if ("klmno".includes(code)) {
        flush();
        formats.add(code);
        i += 1;
        continue;
      }
      if (code === "r") {
        flush();
        color = null;
        formats.clear();
        i += 1;
        continue;
      }
    }
    text += raw[i];
  }
  flush();
}

function renderPlayers(entry) {
  const box = q(entry.el, ".players");
  const result = entry.result;
  box.replaceChildren();
  box.hidden = !result?.online;
  if (!result?.online) return;

  const note = (text) => {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    box.append(p);
  };

  if (!result.players) return note("Nobody is online right now.");
  if (!result.list.length) return note("This server keeps its player list private.");

  for (const name of result.list.slice(0, 30)) {
    const chip = document.createElement("span");
    chip.className = "player";
    if (/^[A-Za-z0-9_]{2,16}$/.test(name)) {
      const img = document.createElement("img");
      img.src = `https://mc-heads.net/avatar/${name}/40`;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      chip.append(img);
    } else {
      chip.classList.add("no-avatar");
    }
    chip.append(name);
    box.append(chip);
  }
  const hidden = result.players - Math.min(result.list.length, 30);
  if (hidden > 0) {
    const more = document.createElement("span");
    more.className = "player no-avatar muted";
    more.textContent = `+${numberFmt.format(hidden)} more`;
    box.append(more);
  }
}

function formatPct(fraction) {
  const pct = fraction * 100;
  return pct === 100 || pct === 0 ? `${pct}%` : `${pct.toFixed(pct > 99.9 ? 2 : 1)}%`;
}

function renderHistory(entry) {
  const { el } = entry;
  const history = historyFor(entry);
  const now = Date.now() / 1000;
  const checks = history?.checks ?? [];
  const day = checks.filter((c) => c[0] >= now - DAY);
  const note = q(el, ".history-note");
  const ping = q(el, ".stat-ping");
  const uptime = q(el, ".stat-uptime");

  const latest = history?.latest;
  ping.textContent = latest?.online && latest.latency != null ? `${latest.latency} ms` : "–";
  ping.title = latest?.online ? "Measured from GitHub's servers" : "";

  const hasData = day.length > 0;
  for (const sel of [".bars", ".spark"]) q(el, sel).hidden = !hasData;
  el.querySelectorAll(".history-label").forEach((n) => (n.hidden = !hasData));
  note.hidden = hasData;

  if (!hasData) {
    uptime.textContent = "–";
    note.textContent =
      entry.kind === "featured"
        ? "Uptime history appears here after the GitHub Actions monitor runs (every 10 minutes)."
        : "Uptime history is only recorded for servers listed in servers.json.";
    return;
  }

  const upFraction = (list) => list.filter((c) => c[1]).length / list.length;
  uptime.textContent = formatPct(upFraction(day));
  q(el, ".uptime-week").textContent = checks.length > day.length ? `7 days: ${formatPct(upFraction(checks))}` : "";

  // Uptime bars: 48 slots of 30 minutes.
  const bars = q(el, ".bars");
  bars.replaceChildren();
  const start = now - DAY;
  let down = 0;
  for (let i = 0; i < DAY / SLOT; i++) {
    const from = start + i * SLOT;
    const inSlot = day.filter((c) => c[0] >= from && c[0] < from + SLOT);
    const bar = document.createElement("span");
    const online = inSlot.filter((c) => c[1]).length;
    const range = `${timeFmt.format(from * 1000)} – ${timeFmt.format((from + SLOT) * 1000)}`;
    if (!inSlot.length) {
      bar.className = "bar";
      bar.dataset.tip = `${range}\nNo data`;
    } else {
      const kind = online === inSlot.length ? "up" : online === 0 ? "down" : "partial";
      bar.className = `bar ${kind}`;
      bar.dataset.tip = `${range}\n${kind === "up" ? "✓ Online" : kind === "down" ? "✕ Offline" : "! Partly offline"} (${online}/${inSlot.length} checks)`;
      if (kind !== "up") down++;
    }
    bars.append(bar);
  }
  bars.setAttribute("aria-label", `Uptime over the last 24 hours: ${formatPct(upFraction(day))}. ${down} half-hour periods with downtime.`);

  renderSpark(entry, day, start, now);
}

function renderSpark(entry, checks, from, to) {
  const W = 600;
  const H = 60;
  const peak = Math.max(0, ...checks.map((c) => c[2] ?? 0));
  const top = Math.max(1, peak);
  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (p) => H - 2 - (p / top) * (H - 8);

  let line = "";
  let area = "";
  let segment = [];
  const closeSegment = () => {
    if (!segment.length) return;
    const pts = segment.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`);
    line += `M${pts.join("L")}`;
    area += `M${x(segment[0][0]).toFixed(1)},${H}L${pts.join("L")}L${x(segment.at(-1)[0]).toFixed(1)},${H}Z`;
    segment = [];
  };
  let prevT = null;
  for (const [t, online, players] of checks) {
    if (!online || players == null || (prevT != null && t - prevT > GAP)) closeSegment();
    if (online && players != null) segment.push([t, players]);
    prevT = t;
  }
  closeSegment();

  const svg = q(entry.el, ".spark-svg");
  q(svg, ".spark-line").setAttribute("d", line);
  q(svg, ".spark-area").setAttribute("d", area);
  q(entry.el, ".peak").textContent = `peak ${numberFmt.format(peak)}`;
  entry.spark = { checks, from, to, x, y, W, H };
}

function setupSparkHover(entry) {
  const box = q(entry.el, ".spark");
  const cursor = q(box, ".spark-cursor");
  const dot = q(box, ".spark-dot");

  const hide = () => {
    cursor.hidden = dot.hidden = true;
    hideTip();
  };

  box.addEventListener("pointermove", (event) => {
    const spark = entry.spark;
    if (!spark?.checks.length) return hide();
    const rect = box.getBoundingClientRect();
    const t = spark.from + ((event.clientX - rect.left) / rect.width) * (spark.to - spark.from);
    let nearest = spark.checks[0];
    for (const c of spark.checks) if (Math.abs(c[0] - t) < Math.abs(nearest[0] - t)) nearest = c;

    const left = (spark.x(nearest[0]) / spark.W) * 100;
    cursor.style.left = `${left}%`;
    cursor.hidden = false;
    const [time, online, players] = nearest;
    if (online && players != null) {
      dot.style.left = `${left}%`;
      dot.style.top = `${(spark.y(players) / spark.H) * 100}%`;
      dot.hidden = false;
    } else {
      dot.hidden = true;
    }
    const label = online ? `${numberFmt.format(players ?? 0)} player${players === 1 ? "" : "s"}` : "✕ Offline";
    showTip(`${timeFmt.format(time * 1000)}\n${label}`, event.clientX, event.clientY);
  });
  box.addEventListener("pointerleave", hide);
}

function updateCheckedLabel(entry) {
  const label = q(entry.el, ".checked");
  if (!entry.checkedAt) {
    label.textContent = "";
    return;
  }
  const source = entry.result?.source ? ` via ${entry.result.source}` : "";
  label.textContent = `Checked ${relativeTime(entry.checkedAt)}${source}`;
}

function relativeTime(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

async function copyAddress(entry) {
  const hint = q(entry.el, ".copy-hint");
  try {
    await navigator.clipboard.writeText(entry.server.address);
    hint.textContent = "Copied!";
  } catch {
    hint.textContent = "Copy failed";
  }
  clearTimeout(entry.copyTimer);
  entry.copyTimer = setTimeout(() => (hint.textContent = "Copy"), 1500);
}

// ---------------------------------------------------------------------------
// Tooltip

function setupTooltip() {
  const onPointer = (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (target) showTip(target.dataset.tip, event.clientX, event.clientY);
  };
  document.addEventListener("pointerover", onPointer);
  document.addEventListener("pointermove", onPointer);
  document.addEventListener("pointerout", (event) => {
    if (event.target.closest?.("[data-tip]")) hideTip();
  });
  window.addEventListener("scroll", hideTip, { passive: true });
}

function showTip(text, clientX, clientY) {
  const tip = els.tooltip;
  tip.textContent = text;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, clientX - width / 2), window.innerWidth - width - 8);
  const top = clientY - height - 14 < 8 ? clientY + 18 : clientY - height - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  els.tooltip.hidden = true;
}
