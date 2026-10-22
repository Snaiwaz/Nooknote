const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  ipcMain,
  nativeImage,
} = require('electron');

const PRODUCT_NAME = '隅笺 Nooknote';
const EDGE_SIZE = 10;
const EDGE_LENGTH = 76;
const DRAG_SIZE = 28;
const PANEL_WIDTH = 368;
const PANEL_HEIGHT = 548;
const CLOSE_GRACE_MS = 100;
const EDGES = new Set(['left', 'right', 'top', 'bottom']);

let triggerWindow = null;
let panelWindow = null;
let tray = null;
let closeTimer = null;
let quitting = false;
let stateFile = '';
let state = null;

const defaults = () => ({
  draft: '',
  notes: [],
  position: { displayId: null, edge: 'right', ratio: 0.5 },
  openAtLogin: false,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = defaults();
    return {
      ...base,
      ...parsed,
      draft: typeof parsed.draft === 'string' ? parsed.draft : '',
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      openAtLogin: parsed.openAtLogin === true,
      position: {
        ...base.position,
        ...(parsed.position || {}),
        edge: EDGES.has(parsed.position?.edge) ? parsed.position.edge : 'right',
        ratio: clamp(Number(parsed.position?.ratio) || 0.5, 0.12, 0.88),
      },
    };
  } catch {
    return defaults();
  }
}

function persistState() {
  const tempPath = `${stateFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, stateFile);
}

function positionDisplay() {
  const displays = screen.getAllDisplays();
  const matching = displays.find((display) => String(display.id) === String(state.position.displayId));
  return matching || screen.getPrimaryDisplay();
}

function triggerBounds(display = positionDisplay()) {
  const area = display.workArea;
  const edge = state.position.edge;
  const ratio = clamp(state.position.ratio, 0.12, 0.88);
  if (edge === 'left' || edge === 'right') {
    const y = Math.round(area.y + area.height * ratio - EDGE_LENGTH / 2);
    return {
      x: edge === 'left' ? area.x : area.x + area.width - EDGE_SIZE,
      y: clamp(y, area.y, area.y + area.height - EDGE_LENGTH),
      width: EDGE_SIZE,
      height: EDGE_LENGTH,
    };
  }
  const x = Math.round(area.x + area.width * ratio - EDGE_LENGTH / 2);
  return {
    x: clamp(x, area.x, area.x + area.width - EDGE_LENGTH),
    y: edge === 'top' ? area.y : area.y + area.height - EDGE_SIZE,
    width: EDGE_LENGTH,
    height: EDGE_SIZE,
  };
}

function panelBounds() {
  const display = positionDisplay();
  const area = display.workArea;
  const { edge, ratio } = state.position;
  const width = Math.min(PANEL_WIDTH, area.width);
  const height = Math.min(PANEL_HEIGHT, area.height);
  if (edge === 'left' || edge === 'right') {
    const triggerCenter = area.y + area.height * ratio;
    return {
      x: edge === 'left' ? area.x : area.x + area.width - width,
      y: clamp(Math.round(triggerCenter - height / 2), area.y, area.y + area.height - height),
      width,
      height,
    };
  }
  const triggerCenter = area.x + area.width * ratio;
  return {
    x: clamp(Math.round(triggerCenter - width / 2), area.x, area.x + area.width - width),
    y: edge === 'top' ? area.y : area.y + area.height - height,
    width,
    height,
  };
}

function setPosition(nextPosition) {
  const display = nextPosition.displayId == null
    ? screen.getPrimaryDisplay()
    : screen.getAllDisplays().find((item) => String(item.id) === String(nextPosition.displayId)) || screen.getPrimaryDisplay();
  state.position = {
    displayId: display.id,
    edge: EDGES.has(nextPosition.edge) ? nextPosition.edge : 'right',
    ratio: clamp(Number(nextPosition.ratio) || 0.5, 0.12, 0.88),
  };
  persistState();
  if (triggerWindow && !triggerWindow.isDestroyed()) {
    triggerWindow.setBounds(triggerBounds(display));
    triggerWindow.webContents.send('edge:position-changed', state.position);
  }
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    panelWindow.setBounds(panelBounds());
  }
}

function createTriggerWindow() {
  triggerWindow = new BrowserWindow({
    ...triggerBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  triggerWindow.setAlwaysOnTop(true, 'floating');
  triggerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  triggerWindow.loadFile(path.join(__dirname, 'trigger.html'));
  triggerWindow.once('ready-to-show', () => triggerWindow.show());
  triggerWindow.on('closed', () => { triggerWindow = null; });
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    ...panelBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.loadFile(path.join(__dirname, 'panel.html'));
  panelWindow.webContents.on('did-finish-load', () => {
    if (panelWindow?.isVisible()) panelWindow.webContents.send('panel:opened');
  });
  panelWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePanel();
    }
  });
  panelWindow.on('closed', () => { panelWindow = null; });
}

function showPanel() {
  clearTimeout(closeTimer);
  if (!panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.setBounds(panelBounds());
  if (!panelWindow.isVisible()) panelWindow.show();
  panelWindow.focus();
  if (!panelWindow.webContents.isLoading()) panelWindow.webContents.send('panel:opened');
}

function hidePanel() {
  clearTimeout(closeTimer);
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
}

function schedulePanelClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(hidePanel, CLOSE_GRACE_MS);
}

function moveTriggerWithPointer(point) {
  if (!triggerWindow || triggerWindow.isDestroyed()) return;
  triggerWindow.setBounds({
    x: Math.round(point.x - DRAG_SIZE / 2),
    y: Math.round(point.y - DRAG_SIZE / 2),
    width: DRAG_SIZE,
    height: DRAG_SIZE,
  });
}

function finishDrag(point) {
  const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y });
  const area = display.workArea;
  const distances = [
    { edge: 'left', distance: Math.abs(point.x - area.x) },
    { edge: 'right', distance: Math.abs(area.x + area.width - point.x) },
    { edge: 'top', distance: Math.abs(point.y - area.y) },
    { edge: 'bottom', distance: Math.abs(area.y + area.height - point.y) },
  ].sort((a, b) => a.distance - b.distance);
  const edge = distances[0].edge;
  const ratio = edge === 'left' || edge === 'right'
    ? (point.y - area.y) / area.height
    : (point.x - area.x) / area.width;
  setPosition({ displayId: display.id, edge, ratio });
}

function buildTrayImage() {
  const width = 32;
  const height = 32;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const dx = (x + 0.5 - 16) / 9.5;
      const dy = (y + 0.5 - 15.5) / 11.5;
      const inside = dx * dx + dy * dy < 1 && y > 4 && y < 28;
      const offset = row + 1 + x * 4;
      if (inside) {
        pixels[offset] = 198;
        pixels[offset + 1] = 228;
        pixels[offset + 2] = 181;
        pixels[offset + 3] = 255;
      }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuffer = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function createTray() {
  tray = new Tray(buildTrayImage());
  tray.setToolTip(PRODUCT_NAME);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '随系统启动',
      type: 'checkbox',
      checked: state.openAtLogin,
      click: (item) => {
        state.openAtLogin = item.checked;
        app.setLoginItemSettings({ openAtLogin: state.openAtLogin });
        persistState();
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '退出隅笺', click: () => { quitting = true; app.quit(); } },
  ]));
}

function registerIpc() {
  ipcMain.handle('state:get', () => ({ ...state, position: { ...state.position } }));
  ipcMain.handle('state:save-draft', (_event, draft) => {
    state.draft = typeof draft === 'string' ? draft : '';
    persistState();
    return true;
  });
  ipcMain.handle('note:add', (_event, text) => {
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText) return null;
    const note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: cleanText, time: Date.now() };
    state.notes.unshift(note);
    persistState();
    return note;
  });
  ipcMain.handle('note:delete', (_event, id) => {
    state.notes = state.notes.filter((note) => note.id !== id);
    persistState();
    return true;
  });
  ipcMain.handle('state:position', () => ({ ...state.position }));
  ipcMain.on('panel:open', showPanel);
  ipcMain.on('panel:hide', hidePanel);
  ipcMain.on('panel:enter', () => clearTimeout(closeTimer));
  ipcMain.on('panel:leave', schedulePanelClose);
  ipcMain.on('trigger:leave', schedulePanelClose);
  ipcMain.on('edge:drag-start', () => hidePanel());
  ipcMain.on('edge:drag-move', (_event, point) => moveTriggerWithPointer(point));
  ipcMain.handle('edge:drag-end', (_event, point) => {
    finishDrag(point);
    return { ...state.position };
  });
  ipcMain.on('app:escape', hidePanel);
}

function setupDisplayListeners() {
  screen.on('display-removed', (_event, removed) => {
    if (String(removed.id) === String(state.position.displayId)) {
      const display = screen.getPrimaryDisplay();
      setPosition({ ...state.position, displayId: display.id });
    }
  });
  screen.on('display-metrics-changed', (display) => {
    if (String(display.id) === String(state.position.displayId)) setPosition(state.position);
  });
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {});
  app.whenReady().then(() => {
    app.setAppUserModelId('com.nooknote.desktop');
    stateFile = path.join(app.getPath('userData'), 'nooknote.json');
    state = loadState();
    if (!screen.getAllDisplays().some((display) => String(display.id) === String(state.position.displayId))) {
      state.position.displayId = screen.getPrimaryDisplay().id;
      persistState();
    }
    app.setLoginItemSettings({ openAtLogin: state.openAtLogin });
    registerIpc();
    createTriggerWindow();
    createPanelWindow();
    createTray();
    setupDisplayListeners();
  }).catch((error) => console.error('[Nooknote] startup failed:', error));
  // The app stays resident in the notification area until the user chooses Exit.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
}
