"use strict";

const REFRESH_SECONDS = 60;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_BRANCH = "status-data";
const WATCHLIST_KEY = "mc-status:watchlist";
const DAY = 24 * 60 * 60;
const SLOT = 30 * 60; // one uptime block = 30 minutes
const GAP = 25 * 60; // break the player line when checks are further apart than this

const SPLASHES = [
  "Now with uptime graphs!",
  "Don't dig straight down!",
  "Ping it till it pongs!",
  "100% pixels!",
  "Creeper-proof!",
  "Checked every 10 minutes!",
  "Hostile mobs not included!",
  "Punch trees, not servers!",
  "Bring your friends!",
  "Lag? Never heard of it!",
  "Mined with love!",
  "Made in the Overworld!",
];

const DEFAULT_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#1d1d22'/>" +
      "<path d='M16 5 27 10.5 16 16 5 10.5Z' fill='#6aab3d'/><path d='M5 10.5 16 16v11L5 21.5Z' fill='#866043'/>" +
      "<path d='M16 16 27 10.5v11L16 27Z' fill='#634329'/><path d='M5 10.5 16 16v3L5 13.5Z' fill='#5d9b34'/>" +
      "<path d='M16 16 27 10.5v3L16 19Z' fill='#467826'/></svg>",
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
let cardCounter = 0;

init();

async function init() {
  for (const id of [
    "logo-main", "logo-sub", "brand-mini-text", "splash", "overall", "overall-text", "sum-servers", "sum-players",
    "sum-ping", "join", "join-ip", "join-copy", "ring-fill", "refresh-status", "refresh-btn", "load-error",
    "featured", "watchlist", "watch-empty", "add-form", "add-error", "card-template", "toast", "toast-title",
    "toast-text", "tooltip", "monitor-updated",
  ]) {
    els[id] = document.getElementById(id);
  }
  els.hero = document.querySelector(".hero");

  setupSky();
  setupSplash();

  try {
    const res = await fetch("servers.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
  } catch (err) {
    els["load-error"].textContent = `Couldn't load servers.json (${err.message}).`;
    els["load-error"].hidden = false;
    state.config = { servers: [] };
  }
  applyBranding();

  for (const server of state.config.servers ?? []) createCard(normalizeServer(server), "featured");
  state.watchlist = loadWatchlist();
  for (const server of state.watchlist) createCard(server, "watch");
  updateWatchEmpty();

  const main = state.config.servers?.[0];
  if (main) {
    els["join-ip"].textContent = main.address;
    els["join"].hidden = false;
    els["join-copy"].addEventListener("click", () => copyText(main.address));
  }

  els["refresh-btn"].addEventListener("click", () => refreshAll());
  els["add-form"].addEventListener("submit", onAddServer);
  setupTooltip();
  document.addEventListener("visibilitychange", tick);

  loadHistory();
  refreshAll();
  setInterval(tick, 1000);
  setInterval(setupSky, 5 * 60 * 1000);
}

function applyBranding() {
  const { title, brand, tagline } = state.config;
  if (title) document.title = title;
  if (brand) {
    els["logo-main"].textContent = brand.toUpperCase();
    els["brand-mini-text"].textContent = brand;
  }
  if (tagline) els["logo-sub"].textContent = tagline;
}

// ---------------------------------------------------------------------------
// Sky: day/night follows the visitor's local time (?hour=21 to preview)

function setupSky() {
  const hourParam = Number(new URLSearchParams(location.search).get("hour"));
  const now = new Date();
  const hour = Number.isFinite(hourParam) && hourParam > 0 ? hourParam % 24 : now.getHours() + now.getMinutes() / 60;
  const phase = hour >= 5 && hour < 7 ? "dawn" : hour >= 7 && hour < 18 ? "day" : hour >= 18 && hour < 20 ? "dusk" : "night";
  const orb = { dawn: [12, 46], day: [84, 15], dusk: [88, 44], night: [16, 15] }[phase];

  els.hero.dataset.phase = phase;
  els.hero.style.setProperty("--orb-x", `${orb[0]}%`);
  els.hero.style.setProperty("--orb-y", `${orb[1]}%`);

  const stars = q(els.hero, ".stars");
  if (stars.childElementCount) return;
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const star = document.createElement("span");
    star.className = rand() > 0.85 ? "star big" : "star";
    star.style.left = `${rand() * 100}%`;
    star.style.top = `${rand() * 100}%`;
    star.style.animationDelay = `${-rand() * 3.2}s`;
    stars.append(star);
  }
}

function setupSplash() {
  let index = Math.floor(Math.random() * SPLASHES.length);
  els.splash.textContent = SPLASHES[index];
  els.splash.addEventListener("click", () => {
    index = (index + 1 + Math.floor(Math.random() * (SPLASHES.length - 1))) % SPLASHES.length;
    els.splash.textContent = SPLASHES[index];
  });
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
  refreshEntry(entry);
  entry.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function removeFromWatchlist(entry) {
  state.watchlist = state.watchlist.filter((s) => keyOf(s) !== entry.key);
  saveWatchlist();
  state.cards.delete(entry.key);
  entry.el.remove();
  updateWatchEmpty();
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
  try {
    entry.result = await queryServer(entry.server);
  } catch {
    entry.result = { error: "status service unreachable" };
  }
  entry.checkedAt = Date.now();
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
  els["refresh-status"].textContent = `Next check ${seconds}s`;
  els["ring-fill"].style.strokeDashoffset = String(100 - (seconds / REFRESH_SECONDS) * 100);
}

function updateSummary() {
  const featured = [...state.cards.values()].filter((e) => e.kind === "featured");
  const total = featured.length;
  const online = featured.filter((e) => e.result?.online);
  const offline = featured.filter((e) => e.result && !e.result.online && !e.result.error);
  const players = online.reduce((sum, e) => sum + (e.result.players || 0), 0);
  const pings = featured
    .map((e) => historyFor(e)?.latest)
    .filter((l) => l?.online && l.latency != null)
    .map((l) => l.latency);

  els["sum-servers"].textContent = total ? `${online.length}/${total}` : "–";
  els["sum-players"].textContent = numberFmt.format(players);
  els["sum-ping"].textContent = pings.length ? `${Math.min(...pings)} ms` : "–";

  let overall;
  let text;
  if (!total) {
    overall = "loading";
    text = "No servers configured";
  } else if (online.length === total) {
    overall = "ok";
    text = total === 1 ? "Server online" : "All servers online";
  } else if (offline.length === total) {
    overall = "down";
    text = total === 1 ? "Server offline" : "All servers offline";
  } else if (offline.length) {
    overall = "partial";
    text = `${offline.length} of ${total} servers offline`;
  } else {
    overall = "partial";
    text = "Status partly unknown";
  }
  els.overall.dataset.state = overall;
  els["overall-text"].textContent = text;

  const title = state.config.title || "Minecraft Server Status";
  document.title = total ? `(${online.length}/${total}) ${title}` : title;
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
  updateSummary();
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
  q(el, ".address").addEventListener("click", () => copyText(server.address));
  q(el, ".copy-btn").addEventListener("click", () => copyText(server.address));
  q(el, ".server-icon").src = DEFAULT_ICON;

  // Each card's SVG gradient needs its own id.
  const gradientId = `spark-grad-${++cardCounter}`;
  q(el, ".spark-grad").id = gradientId;
  q(el, ".spark-area").setAttribute("fill", `url(#${gradientId})`);

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
  q(el, ".status-text").textContent = { loading: "Checking", online: "Online", offline: "Offline", unknown: "Unknown" }[status];

  const icon = q(el, ".server-icon");
  const iconSrc = online && /^data:image\/(png|jpeg|gif|webp);base64,/.test(result.icon ?? "") ? result.icon : DEFAULT_ICON;
  if (icon.src !== iconSrc) icon.src = iconSrc;

  const version = q(el, ".tag-version");
  const versionText = online ? [result.version, result.software && !result.version?.includes(result.software) ? result.software : null].filter(Boolean).join(" · ") : "";
  version.textContent = versionText;
  version.title = versionText;
  version.hidden = !versionText;

  const motd = q(el, ".motd");
  motd.classList.toggle("motd-empty", status === "offline" || status === "unknown");
  if (online) renderMotd(result.motd || "A Minecraft Server", motd);
  else {
    motd.textContent = {
      loading: "Loading…",
      offline: "Can't connect to server. It may be offline or restarting.",
      unknown: `Couldn't check this server right now (${result?.error}). Retrying soon.`,
    }[status];
  }

  const count = q(el, ".xp-count");
  count.textContent = online ? `${numberFmt.format(result.players)} / ${numberFmt.format(result.max)}` : "–";
  const fraction = online && result.max > 0 ? Math.min(1, result.players / result.max) : 0;
  q(el, ".xp-fill").style.setProperty("--fill", `${fraction > 0 ? Math.max(2, fraction * 100) : 0}%`);

  renderSignal(entry);
  renderPlayers(entry);
  renderHistory(entry);
  updateCheckedLabel(entry);
}

function renderSignal(entry) {
  const signal = q(entry.el, ".signal");
  const text = q(signal, ".signal-text");
  const status = cardState(entry.result);
  const latest = historyFor(entry)?.latest;
  const latency = status === "online" && latest?.online ? latest.latency : null;

  if (status === "online") {
    const level = latency == null ? 5 : latency < 150 ? 5 : latency < 300 ? 4 : latency < 600 ? 3 : latency < 1000 ? 2 : 1;
    signal.dataset.level = String(level);
    text.textContent = latency == null ? "" : `${latency} ms`;
    signal.setAttribute("aria-label", latency == null ? "Online" : `Ping ${latency} ms`);
    signal.title = latency == null ? "" : "Ping measured from GitHub's servers";
  } else if (status === "offline") {
    signal.dataset.level = "0";
    text.textContent = "No signal";
    signal.setAttribute("aria-label", "No connection");
    signal.title = "";
  } else {
    delete signal.dataset.level;
    text.textContent = status === "loading" ? "Pinging…" : "";
    signal.setAttribute("aria-label", status === "loading" ? "Pinging" : "Unknown");
    signal.title = "";
  }
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

  if (!result.players) return note("Nobody's online right now — be the first to join!");
  if (!result.list.length) return note("This server keeps its player list private.");

  for (const name of result.list.slice(0, 30)) {
    const chip = document.createElement("span");
    chip.className = "player";
    if (/^[A-Za-z0-9_]{2,16}$/.test(name)) {
      const img = document.createElement("img");
      img.src = `https://mc-heads.net/avatar/${name}/48`;
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
    more.className = "player no-avatar more";
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
  const hasData = day.length > 0;

  for (const sel of [".blocks", ".axis", ".spark", ".history-head-spark"]) q(el, sel).hidden = !hasData;
  note.hidden = hasData;

  const figures = q(el, ".uptime-figures");
  figures.replaceChildren();
  if (!hasData) {
    note.textContent =
      entry.kind === "featured"
        ? "Uptime history appears after the monitor's first checks (every 10 minutes)."
        : "Uptime history is only recorded for servers listed in servers.json.";
    return;
  }

  const upFraction = (list) => list.filter((c) => c[1]).length / list.length;
  const figure = (value, label) => {
    const b = document.createElement("b");
    b.textContent = value;
    figures.append(b, ` ${label}`);
  };
  figure(formatPct(upFraction(day)), "24h");
  if (checks.length > day.length) {
    figures.append("  ·  ");
    figure(formatPct(upFraction(checks)), "7d");
  }

  // Uptime blocks: 48 slots of 30 minutes.
  const blocks = q(el, ".blocks");
  blocks.replaceChildren();
  const start = now - DAY;
  let down = 0;
  for (let i = 0; i < DAY / SLOT; i++) {
    const from = start + i * SLOT;
    const inSlot = day.filter((c) => c[0] >= from && c[0] < from + SLOT);
    const block = document.createElement("span");
    const up = inSlot.filter((c) => c[1]).length;
    const range = `${timeFmt.format(from * 1000)} – ${timeFmt.format((from + SLOT) * 1000)}`;
    if (!inSlot.length) {
      block.className = "block";
      block.dataset.tip = `${range}\nNo data`;
    } else {
      const kind = up === inSlot.length ? "up" : up === 0 ? "down" : "partial";
      block.className = `block ${kind}`;
      const label = kind === "up" ? "✔ Online" : kind === "down" ? "✖ Offline" : "⚠ Partly offline";
      block.dataset.tip = `${range}\n${label} (${up}/${inSlot.length} checks)`;
      if (kind !== "up") down++;
    }
    blocks.append(block);
  }
  blocks.setAttribute("aria-label", `Uptime over the last 24 hours: ${formatPct(upFraction(day))}. ${down} half-hour periods with downtime.`);

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

  q(entry.el, ".spark-line").setAttribute("d", line);
  q(entry.el, ".spark-area").setAttribute("d", area);
  q(entry.el, ".peak").textContent = `Peak ${numberFmt.format(peak)}`;
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
    const label = online ? `${numberFmt.format(players ?? 0)} player${players === 1 ? "" : "s"}` : "✖ Offline";
    showTip(`${timeFmt.format(time * 1000)}\n${label}`, event.clientX, event.clientY);
  });
  box.addEventListener("pointerleave", hide);
}

function updateCheckedLabel(entry) {
  const label = q(entry.el, ".checked");
  label.textContent = entry.checkedAt ? `Updated ${relativeTime(entry.checkedAt)}` : "";
  label.title = entry.result?.source ? `Live status via ${entry.result.source}` : "";
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

// ---------------------------------------------------------------------------
// Copy + advancement-style toast

async function copyText(text) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    // Older browsers: copy from a temporary, invisible text box.
    const area = document.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
  }
  if (copied) showToast("Advancement Made!", `Copied ${text}`);
  else showToast("Couldn't copy", `Select and copy: ${text}`);
}

let toastTimer = null;

function showToast(title, text) {
  const toast = els.toast;
  els["toast-title"].textContent = title;
  els["toast-text"].textContent = text;
  toast.classList.remove("leaving");
  toast.hidden = false;
  // Restart the slide-in animation when toasts arrive back to back.
  toast.style.animation = "none";
  void toast.offsetWidth;
  toast.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("leaving");
    toastTimer = setTimeout(() => (toast.hidden = true), 300);
  }, 2600);
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
