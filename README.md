# SeanSaj Minecraft Status

A status website for Minecraft servers, hosted for free on GitHub Pages.
The main page monitors:

- `direct.seansaj.net`
- `direct.seansaj.net:25566`

**Live site:** https://seansaj5.github.io/Minecraft/

## What it does

- **Live status** – online/offline, MOTD (with colours), player count and names, version and
  server icon. The page re-checks every 60 seconds.
- **Uptime history** – a GitHub Actions job pings each server every 10 minutes and keeps 7 days
  of results: a 24-hour uptime bar, uptime % for 24 hours and 7 days, ping, and a player-count graph.
- **Down alerts** – when a server fails 2 checks in a row, the monitor opens a GitHub issue
  labelled `server-down` (GitHub emails you about it). The issue closes itself when the server
  comes back.
- **More servers** – anyone can add other Java or Bedrock servers from the page. Those are saved in
  their own browser only.

## Publishing

GitHub Pages serves the `gh-pages` branch. Every push to `main` that changes `site/` runs the
**Deploy website** workflow, which copies `site/` to `gh-pages`; the live site updates a minute later.
You can also run it by hand from the **Actions** tab.

## Adding or renaming servers

Edit [`site/servers.json`](site/servers.json):

```json
{
  "name": "Creative",
  "address": "play.example.com:25567",
  "edition": "java"
}
```

- `address` – host name, plus `:port` if it isn't the default (25565 for Java, 19132 for Bedrock).
- `edition` – `java` or `bedrock`.

Servers listed here are shown on the main page for everyone and get uptime history and alerts.
To turn off the issue alerts, set `"alerts": { "enabled": false }`.

## How it works

| Piece | File |
| --- | --- |
| Website (plain HTML/CSS/JS, no build step) | `site/` |
| Copies `site/` to the `gh-pages` branch (served by GitHub Pages) on every push | `.github/workflows/pages.yml` |
| Pings the servers every 10 minutes, saves history, opens/closes issues | `.github/workflows/monitor.yml`, `scripts/monitor.mjs` |
| Uptime history (rewritten each run) | `status-data` branch → `history.json` |

The browser gets live status from the public [mcstatus.io](https://mcstatus.io) API, with
[mcsrvstat.us](https://mcsrvstat.us) as a backup. The monitor connects to the servers directly
using the Minecraft Server List Ping protocol, so ping times are measured from GitHub's servers.

GitHub runs scheduled workflows on a best-effort basis, so checks can occasionally be a few
minutes late. GitHub also pauses scheduled workflows in repositories with no activity for 60 days;
if that happens, re-enable **Monitor servers** from the Actions tab.

## Run locally

```sh
python3 -m http.server --directory site 8000   # then open http://localhost:8000
node scripts/monitor.mjs site/servers.json status/history.json   # one monitor run
```
