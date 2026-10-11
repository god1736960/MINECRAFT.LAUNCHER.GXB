const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./src/launcher-core');

let win;
let tray = null;

/* ---- OPTIMIZACIÓN del launcher (menos CPU/RAM en segundo plano) ----
   Chromium "congela" el proceso del renderer cuando la ventana está oculta,
   así que mientras juegas el launcher casi no consume recursos. Reducimos
   además el trabajo de fondo y evitamos timers de alta frecuencia. */
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// Ocultar/mostrar el launcher DE VERDAD (no solo minimizar): al jugar
// desaparece de la barra de tareas y queda en la bandeja del sistema; el
// renderer se suspende y libera CPU/RAM. Vuelve al cerrar Minecraft o desde
// el icono de la bandeja.
function hideLauncher() {
  if (!win || win.isDestroyed()) return;
  try { win.hide(); } catch {}
  try { win.setSkipTaskbar(true); } catch {}
  ensureTray();
  if (tray) try { tray.setToolTip('LAUNCHER MINECRAFT — jugando (clic para volver)'); } catch {}
}
function showLauncher() {
  if (!win || win.isDestroyed()) return;
  try { win.setSkipTaskbar(false); } catch {}
  try { if (win.isMinimized()) win.restore(); } catch {}
  try { win.show(); win.focus(); } catch {}
  if (tray) try { tray.setToolTip('LAUNCHER MINECRAFT'); } catch {}
}
function ensureTray() {
  if (tray) return tray;
  try {
    const ico = path.join(__dirname, 'build', 'icon.ico');
    const img = fs.existsSync(ico) ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
    tray = new Tray(img);
    const menu = Menu.buildFromTemplate([
      { label: 'Mostrar launcher', click: () => showLauncher() },
      { type: 'separator' },
      { label: 'Salir', click: () => { try { app.quit(); } catch {} } }
    ]);
    tray.setToolTip('LAUNCHER MINECRAFT');
    tray.setContextMenu(menu);
    tray.on('click', () => showLauncher());
    tray.on('double-click', () => showLauncher());
  } catch { tray = null; }
  return tray;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#2b2b2b',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Al cerrar el launcher manualmente, cerrar también Minecraft (si así se
// configuró en Ajustes). Los juegos lanzados en modo "Cerrar el launcher"
// quedan desvinculados y NO se tocan aquí (siguen abiertos por su cuenta).
app.on('before-quit', () => {
  try { if (tray) { tray.destroy(); tray = null; } } catch {}
  try {
    const st = core.loadSettings();
    if (st.killGameOnExit !== false) core.killAllChildren();
  } catch {}
});

/* ---- Controles de ventana ---- */
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:openExternal', async (e, url) => {
  try { if (/^https?:\/\//i.test(String(url || ''))) { await shell.openExternal(url); return { ok: true }; } }
  catch (err) { return { ok: false, error: err.message }; }
  return { ok: false };
});

/* ---- Motor del launcher ---- */
ipcMain.handle('core:getVersions', async () => core.getVersionManifest());
ipcMain.handle('core:getInstalled', async () => core.getInstalledVersions());
ipcMain.handle('core:addInstall', async (e, entry) => core.addInstall(entry));
ipcMain.handle('core:removeInstall', async (e, id) => core.removeInstall(id));
ipcMain.handle('core:openFolder', async (e, id) => {
  const dir = core.installDir(id);
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle('core:browseSkin', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Skin PNG', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const b = fs.readFileSync(r.filePaths[0]);
    return 'data:image/png;base64,' + b.toString('base64');
  } catch { return null; }
});
// Elegir una capa (cape) PNG local y devolverla como dataURL.
ipcMain.handle('core:browseCape', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Capa PNG', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const b = fs.readFileSync(r.filePaths[0]);
    return 'data:image/png;base64,' + b.toString('base64');
  } catch { return null; }
});
// Fija la skin (y capa) activas: el core las escribe como PNG locales y el
// servidor local de skins las servirá a Minecraft de forma transparente.
ipcMain.handle('core:setActiveSkin', async (e, payload) => {
  try { return core.setActiveSkin(payload || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('core:defaultSkin', async () => {
  // Lee la skin por defecto (Steve) y la devuelve como dataURL. Esto evita que
  // la textura no cargue por una ruta relativa / fetch bloqueado en file://.
  try {
    const p = path.join(__dirname, 'assets', 'skin_steve.png');
    const b = fs.readFileSync(p);
    return 'data:image/png;base64,' + b.toString('base64');
  } catch { return null; }
});
ipcMain.handle('core:getSettings', async () => core.loadSettings());
ipcMain.handle('core:saveSettings', async (e, s) => core.saveSettings(s));

ipcMain.handle('core:browseDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('core:browseJava', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }, { name: 'Todos', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('core:browseJar', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'authlib-injector (.jar)', extensions: ['jar'] }, { name: 'Todos', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

// Instalar (descargar) una versión con progreso
ipcMain.handle('core:install', async (e, versionId) => {
  return core.installVersion(versionId, (p) => {
    if (win && !win.isDestroyed()) win.webContents.send('core:progress', p);
  });
});

// Lanzar el juego
ipcMain.handle('core:launch', async (e, opts) => {
  const st = core.loadSettings();
  const behavior = st.onGameStart || 'keep';
  const r = await core.launchGame(opts,
    (p) => { if (win && !win.isDestroyed()) win.webContents.send('core:progress', p); },
    (line) => { if (win && !win.isDestroyed()) win.webContents.send('core:gamelog', line); },
    () => {
      // El juego se cerró: si estábamos ocultos, recuperar el launcher.
      if (behavior === 'hide') showLauncher();
      if (win && !win.isDestroyed()) win.webContents.send('core:gameexit');
    });
  // Aplicar el comportamiento elegido en Ajustes al iniciar el juego.
  if (r && r.ok && win && !win.isDestroyed()) {
    // 'hide' = OCULTAR DE VERDAD (fuera de la barra de tareas + a la bandeja),
    // para que no quede corriendo visible ni consuma recursos mientras juegas.
    if (behavior === 'hide') setTimeout(() => hideLauncher(), 300);
    else if (behavior === 'close') setTimeout(() => { try { win.close(); } catch {} }, 400);
  }
  return r;
});

// Controles de descarga
ipcMain.handle('core:pauseDownload', async () => core.togglePause());
ipcMain.handle('core:cancelDownload', async () => core.cancelDownload());

/* ================= MINECRAFT BEDROCK EDITION =================
   Bedrock es una app UWP de Microsoft Store: el launcher la DETECTA
   y la abre a través del sistema (no gestiona sus binarios). Solo
   funciona en Windows 10/11; en otros sistemas se informa con honestidad. */
const { execFile } = require('child_process');
function psAppxVersion(pkgName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('powershell.exe',
      ['-NoProfile', '-Command', '(Get-AppxPackage -Name ' + pkgName + ' | Select-Object -First 1).Version'],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout || '').trim();
        resolve(v || null);
      });
  });
}
ipcMain.handle('bedrock:detect', async () => {
  if (process.platform !== 'win32') return { supported: false, installed: false };
  const v = await psAppxVersion('Microsoft.MinecraftUWP');
  const pv = await psAppxVersion('Microsoft.MinecraftWindowsBeta');
  return { supported: true, installed: !!v, version: v, previewInstalled: !!pv, previewVersion: pv };
});
ipcMain.handle('bedrock:play', async (e, preview) => {
  if (process.platform !== 'win32')
    return { ok: false, error: 'Minecraft Bedrock Edition solo está disponible en Windows 10/11.' };
  try { await shell.openExternal(preview ? 'minecraft-preview://' : 'minecraft://'); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('bedrock:folder', async (e, preview) => {
  if (process.platform !== 'win32') return null;
  const base = process.env.LOCALAPPDATA || '';
  const pkg = preview ? 'Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe' : 'Microsoft.MinecraftUWP_8wekyb3d8bbwe';
  const dir = path.join(base, 'Packages', pkg, 'LocalState', 'games', 'com.mojang');
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle('bedrock:remove', async () => {
  if (process.platform !== 'win32') return { ok: false };
  try { await shell.openExternal('ms-settings:appsfeatures'); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
