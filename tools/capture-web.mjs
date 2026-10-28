// Reproducible web screenshots for the Wortgut showcase via Chrome DevTools Protocol.
// Usage: node tools/capture-web.mjs
// Requires Chrome installed at the default Windows path and Node 22+ (global WebSocket/fetch).
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), "wortgut-cdp-profile");
const OUT = path.join(process.cwd(), "assets", "web");
const APP = "https://wortgut.vercel.app";

const SHOTS = [
  { name: "desktop-home", route: "/#/heute", width: 1440, height: 900, dpr: 1, mobile: false },
  { name: "desktop-course", route: "/#/kurs", width: 1440, height: 900, dpr: 1, mobile: false },
  { name: "desktop-grammar", route: "/#/grammatik", width: 1440, height: 900, dpr: 1, mobile: false },
  { name: "desktop-exam", route: "/#/pruefung", width: 1440, height: 900, dpr: 1, mobile: false },
  { name: "mobile-home", route: "/#/heute", width: 390, height: 844, dpr: 2, mobile: true },
  { name: "mobile-course", route: "/#/kurs", width: 390, height: 844, dpr: 2, mobile: true },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* keep polling */ }
    await sleep(200);
  }
  throw new Error("timeout");
}

function client(ws) {
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
  ], { stdio: "ignore" });

  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
    const send = client(ws);
    await send("Page.enable");
    await send("Runtime.enable");

    for (const shot of SHOTS) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: shot.width, height: shot.height, deviceScaleFactor: shot.dpr, mobile: shot.mobile,
      });
      await send("Page.navigate", { url: APP + shot.route });
      await sleep(3500);
      // First-run help dialog and programmatic h1 focus would otherwise appear in the capture.
      await send("Runtime.evaluate", { expression: `
        localStorage.setItem('wg.helpSeen', 'true');
        document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        window.scrollTo(0, 0);
      ` });
      await sleep(600);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(OUT, shot.name + ".png"), Buffer.from(data, "base64"));
      console.log(shot.name, "ok");
    }
    ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
