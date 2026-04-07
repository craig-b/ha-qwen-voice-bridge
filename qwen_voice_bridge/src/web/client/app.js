import { BridgeClient } from "./bridge-client.js";

const client = new BridgeClient("web-client");

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const btn = document.getElementById("connect-btn");
const levelBar = document.getElementById("level-bar");
const errorBox = document.getElementById("error-box");

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Under HA ingress the page is served at /api/hassio_ingress/<token>/
  // The WebSocket upgrade must go through the same path prefix.
  const basePath = location.pathname.replace(/\/[^/]*$/, "");
  return `${proto}//${location.host}${basePath}`;
}

client.addEventListener("statuschange", (ev) => {
  const status = ev.detail;
  statusDot.className = `dot ${status}`;
  statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  btn.textContent = status === "disconnected" ? "Connect" : "Disconnect";
  btn.disabled = status === "connecting";
  if (status === "disconnected") {
    levelBar.style.width = "0%";
  }
  errorBox.hidden = true;
});

client.addEventListener("audiolevel", (ev) => {
  // ev.detail is RMS 0..1 — scale for visibility
  const pct = Math.min(100, ev.detail * 300);
  levelBar.style.width = `${pct}%`;
});

client.addEventListener("error", (ev) => {
  errorBox.textContent = ev.detail;
  errorBox.hidden = false;
});

btn.addEventListener("click", () => {
  if (client.status === "disconnected") {
    client.connect(wsUrl());
  } else {
    client.disconnect();
  }
});
