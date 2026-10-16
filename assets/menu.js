"use strict";

// Pages shown in the site menu. To add a page: create the HTML file in site/
// (copy the <nav class="topbar"> block and include this script), then list it here.
// `icon` is one of the h-icon-* classes in style.css.
const PAGES = [
  { href: "./", title: "Server Status", description: "Live status, players and uptime", icon: "grass" },
];

(() => {
  const button = document.getElementById("menu-btn");
  const panel = document.getElementById("menu-panel");
  const list = document.getElementById("menu-list");
  if (!button || !panel || !list) return;

  const normalize = (path) => path.replace(/index\.html$/, "");
  const here = normalize(location.pathname);

  for (const page of PAGES) {
    const link = document.createElement("a");
    link.className = "menu-item";
    link.href = page.href;

    const icon = document.createElement("span");
    icon.className = `h-icon h-icon-${page.icon || "grass"}`;
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "menu-item-title";
    title.textContent = page.title;
    const description = document.createElement("span");
    description.className = "menu-item-desc";
    description.textContent = page.description;
    link.append(icon, title, description);

    if (normalize(new URL(page.href, location.href).pathname) === here) {
      link.setAttribute("aria-current", "page");
      const marker = document.createElement("span");
      marker.className = "menu-item-here";
      marker.textContent = "You are here";
      link.append(marker);
    }

    const item = document.createElement("li");
    item.append(link);
    list.append(item);
  }

  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", () => setOpen(panel.hidden));
  list.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !event.target.closest(".menu")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });
})();
