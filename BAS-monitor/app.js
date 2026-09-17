// Battery Monitor
// Connects to nearby Bluetooth LE devices whose name matches a configurable
// prefix (default "BAS_", empty means no filter), reads their Battery
// Service (0x180F) battery_level (0x2A19) characteristic, and re-reads it on
// a configurable interval to keep the value live.
//
// Web Bluetooth constraint: a page cannot silently enumerate every nearby
// device. Each device must be picked by the user from the browser's native
// chooser (one user gesture per device). We filter that chooser using
// requestDevice's namePrefix filter, or acceptAllDevices when no prefix is set.

const BATTERY_SERVICE = "battery_service";       // 0x180F
const BATTERY_LEVEL_CHAR = "battery_level";      // 0x2A19
const SETTINGS_KEY = "batteryMonitor.settings";
const THEME_KEY = "batteryMonitor.theme";
const DEFAULT_SETTINGS = { maxDevices: 5, updateRateMs: 2000, namePrefix: "BAS_" };

const els = {
  addBtn: document.getElementById("addDeviceBtn"),
  deviceList: document.getElementById("deviceList"),
  emptyState: document.getElementById("emptyState"),
  slotCount: document.getElementById("slotCount"),
  slotMax: document.querySelector(".slot-max"),
  statusBar: document.getElementById("statusBar"),
  unsupportedBanner: document.getElementById("unsupportedBanner"),
  settingsBtn: document.getElementById("settingsBtn"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsCloseBtn: document.getElementById("settingsCloseBtn"),
  settingsDoneBtn: document.getElementById("settingsDoneBtn"),
  maxDevicesInput: document.getElementById("maxDevicesInput"),
  maxDevicesValue: document.getElementById("maxDevicesValue"),
  updateRateInput: document.getElementById("updateRateInput"),
  updateRateValue: document.getElementById("updateRateValue"),
  prefixInput: document.getElementById("prefixInput"),
  appSubtitle: document.getElementById("appSubtitle"),
  addBtnLabel: document.getElementById("addBtnLabel"),
  addHint: document.getElementById("addHint"),
  emptySub: document.getElementById("emptySub"),
};

// id -> { id, name, device, card, gatt, char, state }
const devices = new Map();
let nextId = 1;
let settings = loadSettings();

init();

function init() {
  applyTheme(loadTheme());
  if (!("bluetooth" in navigator)) {
    els.unsupportedBanner.hidden = false;
    els.addBtn.disabled = true;
    return;
  }
  els.addBtn.addEventListener("click", onAddDeviceClick);
  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsCloseBtn.addEventListener("click", closeSettings);
  els.settingsDoneBtn.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  els.maxDevicesInput.addEventListener("input", onMaxDevicesChange);
  els.updateRateInput.addEventListener("input", onUpdateRateChange);
  els.prefixInput.addEventListener("input", onPrefixChange);
  els.themeToggleBtn.addEventListener("click", onThemeToggleClick);
  render();
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  els.themeToggleBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable — theme just won't persist.
  }
}

function onThemeToggleClick() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      maxDevices: clamp(parsed.maxDevices ?? DEFAULT_SETTINGS.maxDevices, 1, 20),
      updateRateMs: clamp(parsed.updateRateMs ?? DEFAULT_SETTINGS.updateRateMs, 300, 10000),
      namePrefix: typeof parsed.namePrefix === "string" ? parsed.namePrefix : DEFAULT_SETTINGS.namePrefix,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (e.g. private browsing) — settings just won't persist.
  }
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function formatRate(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function openSettings() {
  els.maxDevicesInput.value = settings.maxDevices;
  els.maxDevicesValue.textContent = settings.maxDevices;
  els.updateRateInput.value = settings.updateRateMs;
  els.updateRateValue.textContent = formatRate(settings.updateRateMs);
  els.prefixInput.value = settings.namePrefix;
  els.settingsOverlay.hidden = false;
}

function closeSettings() {
  els.settingsOverlay.hidden = true;
}

function onMaxDevicesChange(e) {
  settings.maxDevices = clamp(e.target.value, 1, 20);
  els.maxDevicesValue.textContent = settings.maxDevices;
  saveSettings();
  render();
}

function onUpdateRateChange(e) {
  settings.updateRateMs = clamp(e.target.value, 300, 10000);
  els.updateRateValue.textContent = formatRate(settings.updateRateMs);
  saveSettings();
  restartAllPolling();
}

function onPrefixChange(e) {
  settings.namePrefix = e.target.value;
  saveSettings();
  render();
}

function restartAllPolling() {
  for (const entry of devices.values()) {
    if (entry.state === "connected") startPolling(entry);
  }
}

function setStatus(message, isError = false) {
  if (!message) {
    els.statusBar.hidden = true;
    return;
  }
  els.statusBar.hidden = false;
  els.statusBar.textContent = message;
  els.statusBar.classList.toggle("status-error", isError);
}

async function onAddDeviceClick() {
  if (devices.size >= settings.maxDevices) return;

  const prefix = settings.namePrefix;
  setStatus("Opening device picker\u2026");
  let bleDevice;
  try {
    bleDevice = await navigator.bluetooth.requestDevice(
      prefix
        ? { filters: [{ namePrefix: prefix }], optionalServices: [BATTERY_SERVICE] }
        : { acceptAllDevices: true, optionalServices: [BATTERY_SERVICE] }
    );
  } catch (err) {
    // User cancelled the chooser, or no matching device was found/in range.
    if (err.name === "NotFoundError") {
      setStatus(
        prefix
          ? `No "${prefix}" device selected \u2014 cancelled or none in range.`
          : "No device selected \u2014 cancelled or none in range.",
        true
      );
    } else {
      setStatus(`Couldn't open device picker: ${err.message}`, true);
    }
    return;
  }

  // Avoid connecting to the same physical device twice.
  const already = [...devices.values()].find((d) => d.device.id === bleDevice.id);
  if (already) {
    setStatus(`${bleDevice.name || "That device"} is already connected.`, true);
    return;
  }

  const id = nextId++;
  const entry = {
    id,
    name: bleDevice.name || `Unnamed (${bleDevice.id.slice(0, 6)})`,
    device: bleDevice,
    gatt: null,
    char: null,
    state: "connecting", // connecting | connected | disconnected | error
    battery: null,
    error: null,
  };
  devices.set(id, entry);
  render();
  setStatus(`Connecting to ${entry.name}\u2026`);

  bleDevice.addEventListener("gattserverdisconnected", () => onDisconnected(id));

  await connectAndRead(entry);
}

async function connectAndRead(entry) {
  try {
    entry.state = "connecting";
    render();

    const server = await entry.device.gatt.connect();
    entry.gatt = server;

    const service = await server.getPrimaryService(BATTERY_SERVICE);
    const characteristic = await service.getCharacteristic(BATTERY_LEVEL_CHAR);
    entry.char = characteristic;

    const value = await characteristic.readValue();
    entry.battery = value.getUint8(0);
    entry.state = "connected";
    entry.error = null;

    // Re-read on a configurable interval so the update rate is consistent
    // across devices, regardless of whether a device also supports push
    // notifications.
    startPolling(entry);

    setStatus(`${entry.name} connected.`);
  } catch (err) {
    entry.state = "error";
    entry.error = err.message || "Connection failed";
    setStatus(`${entry.name}: ${entry.error}`, true);
  }
  render();
}

function startPolling(entry) {
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  entry.pollTimer = setInterval(async () => {
    if (entry.state !== "connected" || !entry.char) return;
    try {
      const value = await entry.char.readValue();
      entry.battery = value.getUint8(0);
      render();
    } catch {
      // Ignore transient read failures; disconnect event will handle drops.
    }
  }, settings.updateRateMs);
}

function onDisconnected(id) {
  const entry = devices.get(id);
  if (!entry) return;
  entry.state = "disconnected";
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  setStatus(`${entry.name} disconnected.`, true);
  render();
}

function removeDevice(id) {
  const entry = devices.get(id);
  if (!entry) return;
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  try {
    if (entry.device.gatt && entry.device.gatt.connected) {
      entry.device.gatt.disconnect();
    }
  } catch {
    // no-op
  }
  devices.delete(id);
  render();
}

function batteryLevelClass(pct) {
  if (pct == null) return "level-unknown";
  if (pct <= 20) return "level-low";
  if (pct <= 50) return "level-warn";
  return "level-good";
}

function addButtonLabel() {
  return settings.namePrefix ? `Add ${settings.namePrefix} device` : "Add device";
}

function updatePrefixText() {
  const prefix = settings.namePrefix;

  els.appSubtitle.innerHTML = prefix
    ? `Live battery level over Bluetooth LE, filtered to names starting with ` +
      `<span class="mono">${escapeHtml(prefix)}</span> &mdash; change this in Settings.`
    : `Live battery level over Bluetooth LE. No name filter set, so every nearby device appears in the picker.`;

  els.addHint.innerHTML = prefix
    ? `Opens the picker filtered to names starting with <span class="mono">${escapeHtml(prefix)}</span>. ` +
      `Up to ${settings.maxDevices} device${settings.maxDevices === 1 ? "" : "s"} at once.`
    : `Opens the picker showing every nearby device. Up to ${settings.maxDevices} device${settings.maxDevices === 1 ? "" : "s"} at once.`;

  els.emptySub.textContent = `Click "${addButtonLabel()}" and select one from the picker.`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  updatePrefixText();

  els.slotCount.textContent = String(devices.size);
  els.slotMax.textContent = `/${settings.maxDevices}`;
  const isFull = devices.size >= settings.maxDevices;
  els.addBtn.disabled = isFull;
  els.addBtn.innerHTML = isFull
    ? `<span class="btn-add-icon">\u25CF</span> Slots full (${devices.size}/${settings.maxDevices})`
    : `<span class="btn-add-icon">+</span> ${addButtonLabel()}`;

  const hasDevices = devices.size > 0;
  els.emptyState.hidden = hasDevices;
  els.deviceList.hidden = !hasDevices;

  els.deviceList.innerHTML = "";
  for (const entry of devices.values()) {
    els.deviceList.appendChild(renderCard(entry));
  }
}

function renderCard(entry) {
  const li = document.createElement("li");
  li.className = "device-card";
  li.dataset.state = entry.state;

  const dot = document.createElement("span");
  dot.className = "device-status-dot";

  const info = document.createElement("div");
  info.className = "device-info";
  const nameEl = document.createElement("div");
  nameEl.className = "device-name";
  nameEl.textContent = entry.name;
  const metaEl = document.createElement("div");
  metaEl.className = "device-meta mono";
  metaEl.textContent = metaText(entry);
  info.append(nameEl, metaEl);

  const batteryBlock = document.createElement("div");
  batteryBlock.className = "battery-block";

  const readout = document.createElement("div");
  readout.className = "battery-readout";
  const pctEl = document.createElement("div");
  const cls = batteryLevelClass(entry.battery);
  pctEl.className = `battery-pct ${cls} mono`;
  pctEl.textContent = entry.battery != null ? `${entry.battery}%` : "\u2014";
  readout.appendChild(pctEl);

  const track = document.createElement("div");
  track.className = "battery-bar-track";
  const fill = document.createElement("div");
  fill.className = `battery-bar-fill ${cls}`;
  fill.style.width = entry.battery != null ? `${entry.battery}%` : "0%";
  track.appendChild(fill);

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.title = "Disconnect and remove";
  removeBtn.textContent = "\u2715";
  removeBtn.addEventListener("click", () => removeDevice(entry.id));

  batteryBlock.append(readout, track);
  li.append(dot, info, batteryBlock, removeBtn);
  return li;
}

function metaText(entry) {
  switch (entry.state) {
    case "connecting":
      return "connecting\u2026";
    case "connected":
      return "battery_service \u00b7 live";
    case "disconnected":
      return "disconnected";
    case "error":
      return entry.error || "connection error";
    default:
      return "";
  }
}
