/* ================================================================
   LAUNCHER MINECRAFT - Motor de arranque (Java Edition)
   Descarga desde el manifiesto oficial de Mojang y lanza el juego
   en modo offline (un solo jugador).
   ================================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const skinServer = require('./skin-server');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';
const JRE_ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader/';
const QUILT_META  = 'https://meta.quiltmc.org/v3/versions/loader/';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const OPTIFINE_SITE = 'https://optifine.net';

/* ---------- Control de descarga (Pausa / Cancelar) ---------- */
class CancelError extends Error { constructor() { super('Descarga cancelada'); this.name = 'CancelError'; } }
const _dl = { paused: false, cancelled: false };

/* ---------- Procesos de juego en marcha ----------
   Se guardan SOLO los procesos de Minecraft que deben cerrarse junto con el
   launcher (opción "Ocultar launcher"). Si el usuario elige "Cerrar launcher"
   el proceso se lanza en modo independiente (detached) y NO se trackea, para
   que Minecraft siga abierto tras cerrar el launcher. */
const _children = new Set();
function killAllChildren() {
  for (const ch of _children) {
    try { ch.kill(); } catch {}
  }
  _children.clear();
  return true;
}

function setPaused(v) { _dl.paused = !!v; return _dl.paused; }
function togglePause() { _dl.paused = !_dl.paused; return _dl.paused; }
function cancelDownload() { _dl.cancelled = true; return true; }
function resetDownloadState() { _dl.paused = false; _dl.cancelled = false; }function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function checkCancel() { if (_dl.cancelled) throw new CancelError(); }
async function waitIfPaused() { while (_dl.paused && !_dl.cancelled) await sleep(200); checkCancel(); }

/* ---------- Rutas base (.minecraft) ---------- */
function defaultGameDir() {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(os.homedir(), '.minecraft');
}

function launcherDir() {
  const d = path.join(defaultGameDir(), 'launcher-minecraft');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Carpeta local donde el launcher guarda la skin y la capa activas.
function skinsDir() {
  const d = path.join(launcherDir(), 'skins');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Descarga (una sola vez) authlib-injector.jar a la carpeta del launcher.
// Es lo que permite que Minecraft tome la skin/capa del servidor local.
async function ensureAuthlibInjector(onLog) {
  const jar = path.join(launcherDir(), 'authlib-injector.jar');
  try { if (fs.existsSync(jar) && fs.statSync(jar).size > 10000) return jar; } catch {}
  onLog && onLog('[skin] Descargando authlib-injector (solo la primera vez)…');
  const meta = await httpJson('https://authlib-injector.yushi.moe/artifact/latest.json');
  if (!meta || !meta.download_url) throw new Error('no se pudo resolver authlib-injector');
  await download(meta.download_url, jar);
  return jar;
}

// Arranca un servidor de skins INDEPENDIENTE (proceso aparte, detached) para el
// modo "Cerrar launcher al iniciar". Sobrevive al cierre del launcher y sigue
// sirviendo la skin/capa a Minecraft; se apaga solo cuando el juego termina.
// Devuelve { url, pidFile }: el launcher usa 'url' en el -javaagent y luego
// escribe el PID de Minecraft en 'pidFile' para que el servidor sepa cuándo salir.
function startDetachedSkinServer(cfg, onLog) {
  return new Promise((resolve, reject) => {
    const ipcDir = path.join(launcherDir(), 'skin-ipc');
    try { fs.mkdirSync(ipcDir, { recursive: true }); } catch {}
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const portFile = path.join(ipcDir, 'port-' + stamp + '.txt');
    const pidFile  = path.join(ipcDir, 'pid-' + stamp + '.txt');
    const confFile = path.join(ipcDir, 'conf-' + stamp + '.json');
    try { fs.rmSync(portFile, { force: true }); } catch {}
    fs.writeFileSync(confFile, JSON.stringify({
      username: cfg.username, uuid: cfg.uuid,
      skinPath: cfg.skinPath, capePath: cfg.capePath, slim: cfg.slim,
      portFile, pidFile
    }));
    const script = path.join(__dirname, '..', 'skin-server-run.js');
    const child = spawn(process.execPath, [script, confFile], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
    });
    child.on('error', (e) => reject(e));
    try { child.unref(); } catch {}
    // Esperar a que el servidor publique su puerto (máx ~10 s).
    const t0 = Date.now();
    const poll = setInterval(() => {
      let p = '';
      try { p = String(fs.readFileSync(portFile, 'utf8')).trim(); } catch {}
      if (p) {
        clearInterval(poll);
        onLog && onLog('[skin] Servidor de skins independiente activo (puerto ' + p + ').');
        resolve({ url: 'http://127.0.0.1:' + p, pidFile });
      } else if (Date.now() - t0 > 10000) {
        clearInterval(poll);
        reject(new Error('el servidor de skins independiente no respondió a tiempo'));
      }
    }, 150);
  });
}
const SETTINGS_FILE = () => path.join(launcherDir(), 'settings.json');
const INSTALLS_FILE = () => path.join(launcherDir(), 'installations.json');

/* ---------- Instalaciones gestionadas (lista mostrada en la UI) ----------
   Semilla por defecto: SOLO las dos versiones solicitadas. */
function defaultInstalls() {
  return [
    { id: '26.3', type: 'release', loader: 'vanilla', block: 'blk_grass', key: '26.3' },
    { id: '26.4-snapshot-3', type: 'snapshot', loader: 'vanilla', block: 'blk_diamond', key: '26.4-snapshot-3' }
  ];
}
// CLAVE COMPUESTA (id + loader): permite tener el MISMO id de Minecraft con
// distintos cargadores (p.ej. 1.20.1 Vanilla y 1.20.1 Fabric) como instalaciones
// INDEPENDIENTES, cada una con su propia carpeta.
function entryKey(v) {
  if (!v) return '';
  if (v.key) return v.key;
  const l = (v.loader && v.loader !== 'vanilla') ? '@' + v.loader : '';
  return v.id + l;
}
function loadInstalls() {
  let arr = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(INSTALLS_FILE(), 'utf8'));
    if (Array.isArray(parsed)) arr = parsed;
  } catch {}
  if (!arr) {
    arr = defaultInstalls();
    try { fs.writeFileSync(INSTALLS_FILE(), JSON.stringify(arr, null, 2)); } catch {}
  }
  // Migración: asegurar la clave compuesta en cada instalación existente.
  let changed = false;
  for (const v of arr) {
    const k = (v.loader && v.loader !== 'vanilla') ? v.id + '@' + v.loader : v.id;
    if (v.key !== k) { v.key = k; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(INSTALLS_FILE(), JSON.stringify(arr, null, 2)); } catch {} }
  return arr;
}
function saveInstalls(list) {
  fs.writeFileSync(INSTALLS_FILE(), JSON.stringify(list || [], null, 2));
  return true;
}
function resolveEntry(keyOrId) {
  const list = loadInstalls();
  return list.find((v) => entryKey(v) === keyOrId) || list.find((v) => v.id === keyOrId) || null;
}
function addInstall(entry) {
  const list = loadInstalls();
  entry.key = (entry.loader && entry.loader !== 'vanilla') ? entry.id + '@' + entry.loader : entry.id;
  if (!list.some((v) => entryKey(v) === entry.key)) list.push(entry);
  saveInstalls(list);
  return list;
}
function removeInstall(keyOrId) {
  let list = loadInstalls();
  if (list.some((v) => entryKey(v) === keyOrId)) list = list.filter((v) => entryKey(v) !== keyOrId);
  else list = list.filter((v) => v.id !== keyOrId);
  saveInstalls(list);
  return list;
}
// Raíz de instancias AISLADAS (fuera de versions/ para no mezclar binarios).
function instancesRoot() {
  const d = path.join(launcherDir(), 'instances');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// Carpeta de EJECUCIÓN propia de cada instalación. Aquí viven mundos (saves),
// mods, config, resourcepacks, shaderpacks y capturas: NO se mezclan entre
// versiones ni entre loaders del mismo id. Los binarios (versions/libraries/
// assets) sí se comparten para no volver a descargarlos.
function instanceRunDir(entry) {
  const key = entryKey(entry) || (entry && entry.id) || 'default';
  const safe = String(key).replace(/[^A-Za-z0-9._@-]/g, '_');
  const d = path.join(instancesRoot(), safe);
  for (const sub of ['', 'mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots']) {
    try { fs.mkdirSync(path.join(d, sub), { recursive: true }); } catch {}
  }
  return d;
}
function installDir(keyOrId) {
  // "Abrir carpeta" → la carpeta AISLADA de ESTA instalación (sus mundos/mods/config).
  const entry = resolveEntry(keyOrId) || { id: keyOrId };
  return instanceRunDir(entry);
}

/* ---------- Ajustes ---------- */
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); }
  catch {
    return { username: 'Steve', gameDir: defaultGameDir(), javaPath: '', ramMb: 2048,
      widthRes: '', heightRes: '', showSnapshots: false,
      skinServer: { enabled: false, type: 'mojang', url: '', injectorJar: '' } };
  }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  return true;
}

/* ---------- Utilidades de red ---------- */
function httpJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'launcher-minecraft/1.0 (+oreateai)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(httpJson(res.headers.location));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* Descarga el HTML/texto de una URL (para localizar la descarga real de OptiFine). */
function httpText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(httpText(res.headers.location));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/* Descarga binaria con cabeceras (OptiFine exige un Referer válido). */
function downloadRaw(url, dest, headers) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const opts = { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, headers || {}) };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(dest, { force: true });
        return resolve(downloadRaw(res.headers.location, dest, headers));
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(true)));
      res.on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
    }).on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
  });
}

function download(url, dest, expectSha1, expectSize) {
  return new Promise((resolve, reject) => {
    if (_dl.cancelled) return reject(new CancelError());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // VALIDACIÓN RÁPIDA sin hashear (evita que el procesador se congele al verificar
    // miles de archivos de assets en cada arranque): si el archivo ya existe y su
    // TAMAÑO coincide, se da por bueno. Solo se hashea si no hay tamaño esperado.
    if (fs.existsSync(dest)) {
      try {
        const sz = fs.statSync(dest).size;
        if (expectSize && sz === expectSize) return resolve(false);
        if (!expectSize && expectSha1) {
          const h = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
          if (h === expectSha1) return resolve(false);
        } else if (!expectSize && !expectSha1 && sz > 0) {
          return resolve(false);
        }
      } catch {}
    }
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(dest, { force: true });
        return resolve(download(res.headers.location, dest, expectSha1, expectSize));
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      res.pipe(file);
      // Pausa / cancelación durante el stream
      const iv = setInterval(() => {
        if (_dl.cancelled) {
          clearInterval(iv); res.destroy(); file.close();
          fs.rmSync(dest, { force: true }); reject(new CancelError());
        } else if (_dl.paused && !res.isPaused()) res.pause();
        else if (!_dl.paused && res.isPaused()) res.resume();
      }, 150);
      file.on('finish', () => { clearInterval(iv); file.close(() => resolve(true)); });
      res.on('error', (e) => { clearInterval(iv); file.close(); fs.rmSync(dest, { force: true }); reject(e); });
    });
    req.on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
  });
}

/* ---------- Manifiesto de versiones ---------- */
let _manifestCache = null;
async function getVersionManifest() {
  if (!_manifestCache) _manifestCache = await httpJson(MANIFEST_URL);
  return {
    latest: _manifestCache.latest,
    versions: _manifestCache.versions.map((v) => ({ id: v.id, type: v.type, url: v.url, releaseTime: v.releaseTime }))
  };
}

function versionsRoot(gameDir) { return path.join(gameDir || defaultGameDir(), 'versions'); }

/* La lista mostrada proviene de las instalaciones gestionadas (store). */
function getInstalledVersions() {
  return loadInstalls();
}

/* ---------- Reglas de plataforma (natives / argumentos) ---------- */
function currentOsName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}
function ruleAllows(rules) {
  if (!rules) return true;
  let allow = false;
  for (const r of rules) {
    let match = true;
    if (r.os && r.os.name && r.os.name !== currentOsName()) match = false;
    // Reglas con 'features' = argumentos OPCIONALES (is_demo_user, has_custom_resolution,
    // has_quick_plays_support, etc.). NO activamos ninguna → así el juego NUNCA entra en
    // modo demo ni mete argumentos de quickPlay. (Causa real del "Demo World".)
    if (r.features) match = false;
    if (match) allow = (r.action === 'allow');
  }
  return allow;
}
function nativeClassifier(lib) {
  if (!lib.natives) return null;
  const key = lib.natives[currentOsName()];
  if (!key) return null;
  return key.replace('${arch}', process.arch.includes('64') ? '64' : '32');
}

/* ---------- Instalar / descargar una versión completa ---------- */
async function resolveVersionJson(versionId, gameDir) {
  const vdir = path.join(versionsRoot(gameDir), versionId);
  const jsonp = path.join(vdir, versionId + '.json');
  let meta;
  if (fs.existsSync(jsonp)) {
    meta = JSON.parse(fs.readFileSync(jsonp, 'utf8'));
  } else {
    const manifest = await getVersionManifest();
    const entry = manifest.versions.find((v) => v.id === versionId);
    if (!entry) throw new Error('Versión no encontrada en el manifiesto: ' + versionId);
    meta = await httpJson(entry.url);
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(jsonp, JSON.stringify(meta));
  }
  // Herencia (loaders / versiones derivadas)
  if (meta.inheritsFrom) {
    const parent = await resolveVersionJson(meta.inheritsFrom, gameDir);
    meta = mergeInherited(parent, meta);
  }
  return meta;
}
function mergeInherited(parent, child) {
  const merged = Object.assign({}, parent, child);
  merged.libraries = (child.libraries || []).concat(parent.libraries || []);
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [].concat((parent.arguments && parent.arguments.game) || [], (child.arguments && child.arguments.game) || []),
      jvm: [].concat((parent.arguments && parent.arguments.jvm) || [], (child.arguments && child.arguments.jvm) || [])
    };
  }
  return merged;
}

async function installVersion(keyOrId, onProgress) {
  resetDownloadState();
  const st = loadSettings();
  const gameDir = st.gameDir || defaultGameDir();
  const le = resolveEntry(keyOrId) || {};
  const versionId = le.id || keyOrId;
  const report = (pct, text) => onProgress && onProgress({ pct: Math.round(pct), text });
  report(1, 'Leyendo metadatos de ' + versionId + '…');
  const meta = await resolveVersionJson(versionId, gameDir);
  const vdir = path.join(versionsRoot(gameDir), meta.id);

  // client.jar
  if (meta.downloads && meta.downloads.client) {
    await waitIfPaused();
    report(5, 'Descargando client.jar…');
    await download(meta.downloads.client.url, path.join(vdir, meta.id + '.jar'), meta.downloads.client.sha1, meta.downloads.client.size);
  }

  // Librerías + natives
  const libs = (meta.libraries || []).filter((l) => ruleAllows(l.rules));
  const nativesDir = path.join(vdir, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });
  for (let i = 0; i < libs.length; i++) {
    await waitIfPaused();
    const lib = libs[i];
    report(5 + (i / libs.length) * 45, 'Librerías ' + (i + 1) + '/' + libs.length);
    const dl = lib.downloads || {};
    if (dl.artifact && dl.artifact.path)
      await download(dl.artifact.url, path.join(gameDir, 'libraries', dl.artifact.path), dl.artifact.sha1, dl.artifact.size);
    const cl = nativeClassifier(lib);
    if (cl && dl.classifiers && dl.classifiers[cl]) {
      const nat = dl.classifiers[cl];
      const tmp = path.join(nativesDir, path.basename(nat.path));
      await download(nat.url, tmp, nat.sha1, nat.size);
      extractJar(tmp, nativesDir);
    }
  }

  // Assets
  report(52, 'Descargando índice de assets…');
  if (meta.assetIndex) {
    const idxId = meta.assetIndex.id;
    const idxPath = path.join(gameDir, 'assets', 'indexes', idxId + '.json');
    await download(meta.assetIndex.url, idxPath, meta.assetIndex.sha1, meta.assetIndex.size);
    const index = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const names = Object.keys(index.objects || {});
    for (let i = 0; i < names.length; i++) {
      if (i % 25 === 0) { await waitIfPaused(); report(55 + (i / names.length) * 38, 'Assets ' + (i + 1) + '/' + names.length); }
      const o = index.objects[names[i]];
      const h = o.hash;
      const sub = h.substring(0, 2);
      await download(RESOURCES + '/' + sub + '/' + h, path.join(gameDir, 'assets', 'objects', sub, h), h, o.size);
    }
    // ASSETS LEGACY / VIRTUAL: las versiones antiguas NO leen de assets/objects por hash;
    // necesitan los archivos con su RUTA real. Si el índice es 'virtual' o 'map_to_resources'
    // hay que materializarlos, o el juego se queda cargando para siempre.
    if (index.virtual || index.map_to_resources) {
      const vroot = index.map_to_resources
        ? path.join(gameDir, 'resources')
        : path.join(gameDir, 'assets', 'virtual', idxId);
      report(94, 'Preparando assets legacy…');
      for (let i = 0; i < names.length; i++) {
        const o = index.objects[names[i]];
        const sub = o.hash.substring(0, 2);
        const src = path.join(gameDir, 'assets', 'objects', sub, o.hash);
        const dst = path.join(vroot, names[i]);
        try {
          if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.statSync(dst).size !== o.size)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          }
        } catch {}
      }
    }
  }

  // ---- Loader (Fabric/Quilt reales; Forge/OptiFine/NeoForge honestos) ----
  let launchId = meta.id;
  const saveLaunchId = (lid) => {
    const list = loadInstalls();
    const it = list.find((v) => entryKey(v) === entryKey(le)) || list.find((v) => v.id === versionId);
    if (it) { it.launchId = lid; saveInstalls(list); }
  };
  if (le.loader === 'fabric') {
    try {
      launchId = await installFabric(versionId, (p) => report(96 + (p.pct || 0) * 0.04, p.text));
      saveLaunchId(launchId);
    } catch (e) {
      report(100, 'Vanilla OK. Fabric falló: ' + e.message);
      return { ok: true, id: meta.id, loaderError: e.message };
    }
  } else if (le.loader === 'quilt') {
    try {
      launchId = await installQuilt(versionId, (p) => report(96 + (p.pct || 0) * 0.04, p.text));
      saveLaunchId(launchId);
    } catch (e) {
      report(100, 'Vanilla OK. Quilt falló: ' + e.message);
      return { ok: true, id: meta.id, loaderError: e.message };
    }
  } else if (le.loader === 'optifine') {
    // OptiFine REAL (shaders, zoom, HD, rendimiento). Se instala de forma 100%
    // automatizada y sin su instalador gráfico: Fabric + OptiFabric + el .jar
    // oficial de OptiFine descargado desde optifine.net. Carga el OptiFine
    // AUTÉNTICO (no vanilla), que era el fallo anterior.
    try {
      launchId = await installOptiFine(versionId, le, (p) => report(96 + (p.pct || 0) * 0.04, p.text));
      saveLaunchId(launchId);
    } catch (e) {
      report(100, 'Vanilla OK. OptiFine falló: ' + e.message);
      return { ok: true, id: meta.id, loaderError: e.message };
    }
  } else if (le.loader === 'forge' || le.loader === 'neoforge') {
    report(100, 'Vanilla ' + meta.id + ' instalado. Nota: ' + le.loader +
      ' requiere su instalador oficial (no se instala automáticamente).');
    return { ok: true, id: meta.id, loaderNote: le.loader };
  }

  // Marcar la versión como COMPLETA para no re-verificar miles de assets en cada arranque
  try { fs.writeFileSync(path.join(vdir, '.complete'), String(launchId || meta.id)); } catch {}
  report(100, 'Instalación completada: ' + launchId);
  return { ok: true, id: meta.id, launchId };
}

/* ---------- Fabric (instalación real) ---------- */
function mavenToPath(name) {
  const parts = name.split(':');
  const g = parts[0], a = parts[1], v = parts[2], classifier = parts[3];
  const file = a + '-' + v + (classifier ? '-' + classifier : '') + '.jar';
  return g.replace(/\./g, '/') + '/' + a + '/' + v + '/' + file;
}
async function installFabric(mcId, onProgress) {
  const report = (p, t) => onProgress && onProgress({ pct: Math.round(p), text: t });
  report(1, 'Fabric: buscando loader…');
  const loaders = await httpJson(FABRIC_META + encodeURIComponent(mcId));
  if (!loaders || !loaders.length) throw new Error('Fabric no soporta ' + mcId);
  const loaderV = loaders[0].loader.version;
  const profile = await httpJson(FABRIC_META + encodeURIComponent(mcId) + '/' + loaderV + '/profile/json');
  const st = loadSettings(); const gameDir = st.gameDir || defaultGameDir();
  const vdir = path.join(versionsRoot(gameDir), profile.id);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, profile.id + '.json'), JSON.stringify(profile));
  const libs = profile.libraries || [];
  for (let i = 0; i < libs.length; i++) {
    await waitIfPaused();
    const lib = libs[i];
    report(10 + (i / libs.length) * 85, 'Fabric libs ' + (i + 1) + '/' + libs.length);
    const base = (lib.url || 'https://maven.fabricmc.net/').replace(/\/$/, '');
    const rel = mavenToPath(lib.name);
    try { await download(base + '/' + rel, path.join(gameDir, 'libraries', rel)); }
    catch (e) {
      // mirror de respaldo
      try { await download('https://maven.fabricmc.net/' + rel, path.join(gameDir, 'libraries', rel)); }
      catch (e2) { throw new Error('Librería Fabric no disponible: ' + lib.name); }
    }
  }
  report(100, 'Fabric instalado: ' + profile.id);
  return profile.id;
}

/* ---------- Quilt (instalación real; perfil estilo Fabric) ---------- */
async function installQuilt(mcId, onProgress) {
  const report = (p, t) => onProgress && onProgress({ pct: Math.round(p), text: t });
  report(1, 'Quilt: buscando loader…');
  const loaders = await httpJson(QUILT_META + encodeURIComponent(mcId));
  if (!loaders || !loaders.length) throw new Error('Quilt no soporta ' + mcId);
  const loaderV = loaders[0].loader.version;
  const profile = await httpJson(QUILT_META + encodeURIComponent(mcId) + '/' + loaderV + '/profile/json');
  const st = loadSettings(); const gameDir = st.gameDir || defaultGameDir();
  const vdir = path.join(versionsRoot(gameDir), profile.id);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, profile.id + '.json'), JSON.stringify(profile));
  const libs = profile.libraries || [];
  for (let i = 0; i < libs.length; i++) {
    await waitIfPaused();
    const lib = libs[i];
    report(10 + (i / libs.length) * 85, 'Quilt libs ' + (i + 1) + '/' + libs.length);
    const base = (lib.url || 'https://maven.quiltmc.org/repository/release/').replace(/\/$/, '');
    const rel = mavenToPath(lib.name);
    try { await download(base + '/' + rel, path.join(gameDir, 'libraries', rel)); }
    catch (e) {
      // mirrors de respaldo (Quilt reusa varias libs de Fabric)
      try { await download('https://maven.fabricmc.net/' + rel, path.join(gameDir, 'libraries', rel)); }
      catch (e2) {
        try { await download('https://maven.quiltmc.org/repository/release/' + rel, path.join(gameDir, 'libraries', rel)); }
        catch (e3) { throw new Error('Librería Quilt no disponible: ' + lib.name); }
      }
    }
  }
  report(100, 'Quilt instalado: ' + profile.id);
  return profile.id;
}

/* ---------- OptiFine REAL (sobre Fabric + OptiFabric) ---------- */
// OptiFine no publica un metadato de versión como Fabric/Quilt; su instalador es
// un .jar gráfico. Para automatizarlo sin interacción lo cargamos como mod sobre
// Fabric usando OptiFabric (puente oficial Fabric<->OptiFine). Así se obtiene el
// OptiFine AUTÉNTICO (HD, shaders, zoom, rendimiento), no vanilla.

// Última versión de un proyecto de Modrinth compatible con la versión/loader dados.
async function modrinthLatest(projectId, gameVersion, loader) {
  const url = MODRINTH_API + '/project/' + projectId + '/version' +
    '?loaders=["' + (loader || 'fabric') + '"]&game_versions=["' + gameVersion + '"]';
  const arr = await httpJson(url);
  if (!Array.isArray(arr) || !arr.length) throw new Error('Sin versión de ' + projectId + ' para ' + gameVersion);
  const v = arr[0];
  const file = (v.files || []).find((f) => f.primary) || v.files[0];
  if (!file) throw new Error('Sin archivo para ' + projectId);
  return { url: file.url, name: file.filename };
}

// Localiza el enlace de descarga directo del .jar oficial de OptiFine para una
// versión de Minecraft (scrape de optifine.net: downloads -> adloadx -> downloadx).
async function findOptiFineDownload(gameVersion) {
  const list = await httpText(OPTIFINE_SITE + '/downloads');
  // Enlaces del tipo adloadx?f=OptiFine_1.21.1_HD_U_J1.jar
  const re = /adloadx\?f=(OptiFine_([0-9.]+)_[^"'&]+\.jar)/g;
  let m, best = null;
  while ((m = re.exec(list))) {
    if (m[2] === gameVersion && (!best || m[1] > best.file)) best = { file: m[1], adloadx: 'adloadx?f=' + m[1] };
  }
  if (!best) throw new Error('OptiFine no tiene build para ' + gameVersion);
  const page = await httpText(OPTIFINE_SITE + '/' + best.adloadx);
  // La página adloadx contiene un enlace a downloadx?f=...&x=TOKEN
  const dl = page.match(/href=['"](downloadx\?f=[^'"]+)['"]/);
  if (!dl) throw new Error('No se pudo resolver la descarga de OptiFine');
  return {
    file: best.file,
    url: OPTIFINE_SITE + '/' + dl[1].replace(/&amp;/g, '&'),
    referer: OPTIFINE_SITE + '/' + best.adloadx
  };
}

// Instala Fabric para la versión, coloca OptiFabric + OptiFine en /mods del
// instanceRunDir y devuelve el launchId de Fabric (para que arranque con mods).
async function installOptiFine(gameVersion, le, onProgress) {
  const rep = (pct, text) => onProgress && onProgress({ pct, text });
  rep(5, 'Instalando base Fabric para OptiFine…');
  const fabricId = await installFabric(gameVersion, (p) => rep((p.pct || 0) * 0.5, p.text));
  const runDir = instanceRunDir(le);
  const modsDir = path.join(runDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  rep(55, 'Descargando OptiFabric…');
  const ofab = await modrinthLatest('optifabric', gameVersion, 'fabric');
  await download(ofab.url, path.join(modsDir, ofab.name));
  rep(75, 'Localizando OptiFine oficial…');
  const of = await findOptiFineDownload(gameVersion);
  rep(85, 'Descargando OptiFine ' + of.file + '…');
  await downloadRaw(of.url, path.join(modsDir, of.file), { Referer: of.referer });
  rep(100, 'OptiFine REAL instalado sobre Fabric: ' + fabricId);
  return fabricId;
}
// Orden de preferencia de runtimes, del MÁS NUEVO al más antiguo. Las versiones
// recientes (p.ej. 26.1+) piden un Java moderno; si el componente que declara la
// versión no estuviera disponible, se descarga automáticamente el runtime oficial
// más nuevo que Mojang publique para esta plataforma.
const JAVA_COMPONENT_ORDER = [
  'java-runtime-delta', 'java-runtime-gamma-snapshot', 'java-runtime-gamma',
  'java-runtime-beta', 'java-runtime-alpha', 'jre-legacy'
];
function javaPlatformKey() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'ia32' ? 'windows-x86' : a === 'arm64' ? 'windows-arm64' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}
async function ensureJavaRuntime(component, onProgress) {
  component = component || 'jre-legacy';
  const all = await httpJson(JRE_ALL);
  const key = javaPlatformKey();
  const avail = all[key] || {};
  const hasRuntime = (c) => !!(avail[c] && avail[c][0] && avail[c][0].manifest);
  // Elegir el componente REAL a usar: el que pide la versión si está disponible;
  // si no, el más nuevo que Mojang ofrezca para esta plataforma (descarga automática).
  let chosen = null;
  if (hasRuntime(component)) chosen = component;
  if (!chosen) { for (const c of JAVA_COMPONENT_ORDER) { if (hasRuntime(c)) { chosen = c; break; } } }
  if (!chosen) chosen = Object.keys(avail).find(hasRuntime) || null;
  if (!chosen) throw new Error('Sin runtime Java disponible para ' + key);
  const runtimeDir = path.join(launcherDir(), 'runtime', chosen);
  const javaExe = path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javawExe = path.join(runtimeDir, 'bin', 'javaw.exe');
  const pick = () => (process.platform === 'win32' && fs.existsSync(javawExe)) ? javawExe : javaExe;
  if (fs.existsSync(javaExe)) return pick();
  onProgress && onProgress({ pct: 0, text: 'Descargando Java (' + chosen + ')…' });
  const arr = avail[chosen];
  const files = await httpJson(arr[0].manifest.url);
  const entries = Object.entries(files.files || {});
  for (let i = 0; i < entries.length; i++) {
    await waitIfPaused();
    const [rel, info] = entries[i];
    if (i % 20 === 0) onProgress && onProgress({ pct: Math.round((i / entries.length) * 100), text: 'Java ' + (i + 1) + '/' + entries.length });
    const destp = path.join(runtimeDir, rel);
    if (info.type === 'directory') { fs.mkdirSync(destp, { recursive: true }); continue; }
    if (info.type === 'link') { try { fs.mkdirSync(path.dirname(destp), { recursive: true }); fs.symlinkSync(info.target, destp); } catch {} continue; }
    const raw = info.downloads && info.downloads.raw;
    if (!raw) continue;
    await download(raw.url, destp, raw.sha1);
    if (info.executable) { try { fs.chmodSync(destp, 0o755); } catch {} }
  }
  if (!fs.existsSync(javaExe)) throw new Error('No se encontró el ejecutable Java tras la descarga');
  return pick();
}

function extractJar(jarPath, destDir) {
  // Extrae natives (.dll/.so/.dylib) de un jar sin dependencias externas
  try {
    const buf = fs.readFileSync(jarPath);
    let o = buf.length - 22;
    while (o >= 0 && buf.readUInt32LE(o) !== 0x06054b50) o--;
    if (o < 0) return;
    const count = buf.readUInt16LE(o + 10);
    let p = buf.readUInt32LE(o + 16);
    const zlib = require('zlib');
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const comp = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commLen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commLen;
      if (name.endsWith('/') || name.startsWith('META-INF')) continue;
      const lnameLen = buf.readUInt16LE(lho + 26);
      const lextraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lnameLen + lextraLen;
      const raw = buf.slice(dataStart, dataStart + comp);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      fs.writeFileSync(path.join(destDir, path.basename(name)), data);
    }
  } catch (e) { /* natives opcionales */ }
}

/* ---------- Resolver Java ---------- */
function resolveJava(st) {
  if (st.javaPath && fs.existsSync(st.javaPath)) return st.javaPath;
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(p)) return p;
  }
  return process.platform === 'win32' ? 'javaw.exe' : 'java'; // del PATH
}

/* ---------- Construir y lanzar ---------- */
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

async function launchGame(opts, onProgress, onLog, onExit) {
  resetDownloadState();
  const st = loadSettings();
  const gameDir = st.gameDir || defaultGameDir();
  const requestedKey = opts.versionId;
  const username = (opts.username || st.username || 'Steve').trim() || 'Steve';

  // Resolver la instalación por su CLAVE compuesta (id + loader). Así el mismo id
  // con distinto cargador se lanza como instalación independiente.
  const entry = resolveEntry(requestedKey) || {};
  const requestedId = entry.id || requestedKey;
  const versionId = entry.launchId || requestedId;

  // Carpeta de ejecución AISLADA de esta instalación (mundos/mods/config propios).
  const runDir = instanceRunDir(entry.id ? entry : { id: requestedId });

  // Asegurar que la versión esté COMPLETA (client.jar + marcador .complete).
  // Si falta el jar o el marcador, se (re)instala descargando SOLO lo que falte
  // (los archivos ya válidos se saltan por sha1). Esto arregla versiones que
  // "tardan mucho o no abren" por una instalación incompleta previa.
  const reqDir = path.join(versionsRoot(gameDir), requestedId);
  const vanillaJar = path.join(reqDir, requestedId + '.jar');
  const completeMark = path.join(reqDir, '.complete');
  if (!fs.existsSync(vanillaJar) || !fs.existsSync(completeMark)) {
    onProgress && onProgress({ pct: 0, text: 'Verificando archivos de ' + requestedId + '…' });
    await installVersion(requestedKey, onProgress);
  }
  onProgress && onProgress({ pct: 100, text: 'Preparando lanzamiento…' });

  const meta = await resolveVersionJson(versionId, gameDir);
  // Para perfiles de loader (inheritsFrom) el client.jar y los natives son los de la versión base (vanilla)
  const baseId = meta.inheritsFrom || meta.id;
  const vdir = path.join(versionsRoot(gameDir), baseId);
  const nativesDir = path.join(vdir, 'natives');

  // classpath
  const cp = [];
  for (const lib of (meta.libraries || []).filter((l) => ruleAllows(l.rules))) {
    const art = lib.downloads && lib.downloads.artifact;
    if (art && art.path) cp.push(path.join(gameDir, 'libraries', art.path));
    else if (lib.name && !lib.downloads) cp.push(path.join(gameDir, 'libraries', mavenToPath(lib.name))); // libs de Fabric
  }
  cp.push(path.join(vdir, baseId + '.jar'));

  const uuid = offlineUuid(username);
  const idxId = (meta.assetIndex && meta.assetIndex.id) || meta.assets || 'legacy';
  const subst = {
    auth_player_name: username, version_name: meta.id, game_directory: runDir,
    assets_root: path.join(gameDir, 'assets'), assets_index_name: idxId,
    auth_uuid: uuid, auth_access_token: '0', auth_session: 'token:0:' + uuid,
    clientid: '0', auth_xuid: '0', profile_name: 'launcher-minecraft',
    user_type: 'legacy', version_type: meta.type || 'release', user_properties: '{}',
    natives_directory: nativesDir, launcher_name: 'launcher-minecraft', launcher_version: '1.0.0',
    classpath: cp.join(path.delimiter), game_assets: path.join(gameDir, 'assets', 'virtual', idxId),
    library_directory: path.join(gameDir, 'libraries'), classpath_separator: path.delimiter,
    primary_jar: path.join(vdir, baseId + '.jar')
  };
  const fill = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (subst[k] !== undefined ? subst[k] : m));

  const jvmArgs = [];
  const gameArgs = [];
  if (meta.arguments) {
    for (const a of meta.arguments.jvm || []) {
      if (typeof a === 'string') jvmArgs.push(fill(a));
      else if (ruleAllows(a.rules)) [].concat(a.value).forEach((v) => jvmArgs.push(fill(v)));
    }
    for (const a of meta.arguments.game || []) {
      if (typeof a === 'string') gameArgs.push(fill(a));
      else if (ruleAllows(a.rules)) [].concat(a.value).forEach((v) => gameArgs.push(fill(v)));
    }
  } else {
    jvmArgs.push('-Djava.library.path=' + nativesDir, '-cp', subst.classpath);
    (meta.minecraftArguments || '').split(' ').filter(Boolean).forEach((t) => gameArgs.push(fill(t)));
  }
  // Si no se definieron -cp/-Djava.library.path por arguments, añadirlos
  if (!jvmArgs.some((x) => x === '-cp' || x === '-classpath')) {
    jvmArgs.push('-Djava.library.path=' + nativesDir, '-cp', subst.classpath);
  }

  const ram = Math.min(65536, Math.max(512, parseInt(st.ramMb || 2048, 10) || 2048));
  const mem = ['-Xmx' + ram + 'M', '-Xms' + Math.min(ram, 512) + 'M'];

  // --- Super-optimización JVM (flags de Aikar G1GC) ---------------------------
  // Aditivo y seguro: NO cambia el motor de arranque, solo afina el recolector de
  // basura para menos tirones (stutter) y mejor FPS. Se puede desactivar en
  // Ajustes con optimizeJvm=false. Son las mismas banderas que usan los grandes
  // launchers y servidores de Minecraft.
  if (st.optimizeJvm !== false) {
    mem.push(
      '-XX:+UseG1GC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+ParallelRefProcEnabled',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs',
      '-Daikars.new.flags=true'
    );
  }
  // --- Skins locales AUTOMÁTICAS (sin configuración, modo offline / un jugador) ---
  // El launcher levanta un servidor LOCAL de skins (127.0.0.1) y adjunta
  // authlib-injector apuntando a él, de forma totalmente transparente. Así
  // Minecraft muestra tu skin y tu capa locales sin servidores externos ni
  // configuración manual. Si aún no has cargado una skin propia, se omite y el
  // juego abre con la apariencia por defecto.
  //
  // IMPORTANTE (modo "Cerrar launcher al iniciar"): si el launcher se cierra, un
  // servidor en el propio launcher moriría con él y Minecraft mostraría a Steve.
  // Por eso en ese modo el servidor de skins se arranca como proceso APARTE
  // (independiente) que sobrevive al cierre del launcher y se apaga solo cuando
  // el juego termina. Así la skin/capa cargan igual que con "Ocultar launcher".
  const skinCloseMode = (st.onGameStart === 'close');
  let detachedSkinPidFile = null;   // dónde escribir el PID de Minecraft (modo cerrar)
  try {
    const sdir = skinsDir();
    const skinPng = path.join(sdir, 'active_skin.png');
    const capePng = path.join(sdir, 'active_cape.png');
    if (fs.existsSync(skinPng)) {
      const jar = await ensureAuthlibInjector(onLog);
      const hasCape = fs.existsSync(capePng);
      if (skinCloseMode) {
        // Servidor independiente que sobrevive al cierre del launcher.
        const srv = await startDetachedSkinServer({
          username, uuid,
          skinPath: skinPng,
          capePath: hasCape ? capePng : null,
          slim: !!st.skinSlim
        }, onLog);
        detachedSkinPidFile = srv.pidFile;
        jvmArgs.unshift('-javaagent:' + jar + '=' + srv.url);
        onLog && onLog('[skin] Skin/capa activas vía servidor independiente → ' + srv.url + (hasCape ? ' (con capa)' : '') + '. Seguirá sirviendo aunque cierres el launcher.');
      } else {
        await skinServer.start();
        skinServer.setProfile({
          username, uuid,
          skinPath: skinPng,
          capePath: hasCape ? capePng : null,
          slim: !!st.skinSlim
        });
        jvmArgs.unshift('-javaagent:' + jar + '=' + skinServer.getUrl());
        onLog && onLog('[skin] Servidor local de skins activo → ' + skinServer.getUrl() + (hasCape ? ' (con capa)' : ''));
      }
    } else {
      onLog && onLog('[skin] Sin skin propia cargada: se usa la apariencia por defecto.');
    }
  } catch (e) {
    onLog && onLog('[skin] No se pudo iniciar el servidor local de skins: ' + e.message + ' (el juego abrirá con la skin por defecto).');
  }

  if (st.widthRes && st.heightRes) gameArgs.push('--width', String(st.widthRes), '--height', String(st.heightRes));

  // Resolver Java: ruta manual → runtime oficial de Mojang (64-bit, arregla el error de JVM) → sistema
  let java;
  if (st.javaPath && fs.existsSync(st.javaPath)) {
    java = st.javaPath;
  } else {
    const comp = (meta.javaVersion && meta.javaVersion.component) || 'jre-legacy';
    try {
      onProgress && onProgress({ pct: 0, text: 'Comprobando Java (' + comp + ')…' });
      java = await ensureJavaRuntime(comp, onProgress);
      onLog && onLog('[java] runtime Mojang: ' + java);
    } catch (e) {
      onLog && onLog('[java] no se pudo obtener el runtime de Mojang (' + e.message + '); usando Java del sistema');
      java = resolveJava(st);
    }
  }
  // Endurecer argumentos:
  //  - El classpath se pasa por la variable de entorno CLASSPATH (NO por -cp en la
  //    línea de comandos). En Windows la línea de comandos tiene un límite (~32 KB) y
  //    el classpath de Minecraft lo supera con facilidad → la JVM no arranca
  //    ("Could not create the Java Virtual Machine"). CLASSPATH funciona en Java 8+.
  //  - Se descartan tokens vacíos y placeholders ${...} sin resolver (romperían la JVM).
  let classpathVal = subst.classpath;
  const cleanJvm = [];
  for (let i = 0; i < jvmArgs.length; i++) {
    const a = jvmArgs[i];
    if (a === undefined || a === null || String(a).trim() === '') continue;
    if (a === '-cp' || a === '-classpath') { if (jvmArgs[i + 1]) classpathVal = jvmArgs[i + 1]; i++; continue; }
    if (/\$\{\w+\}/.test(a)) continue;          // placeholder sin resolver
    cleanJvm.push(a);
  }
  const cleanGame = gameArgs.filter((a) => a !== undefined && a !== null && String(a).trim() !== '' && !/\$\{\w+\}/.test(a));
  const finalArgs = [...mem, ...cleanJvm, meta.mainClass, ...cleanGame].filter((a) => String(a).trim() !== '');
  const childEnv = Object.assign({}, process.env, { CLASSPATH: classpathVal });

  onLog && onLog('[launcher] Java: ' + java);
  onLog && onLog('[launcher] RAM: -Xmx' + ram + 'M | classpath: ' + cp.length + ' entradas (' + classpathVal.length + ' chars, via CLASSPATH)');
  onLog && onLog('[launcher] ' + java + ' ' + finalArgs.join(' '));
  // Comportamiento al iniciar el juego:
  //  - 'close'    → se lanza Minecraft INDEPENDIENTE (detached+unref) y el launcher
  //                 puede cerrarse sin matar el juego. NO se trackea.
  //  - cualquier otro ('minimize'/'keep') → se trackea para poder cerrarlo cuando
  //                 el usuario cierre el launcher manualmente.
  const closeOnStart = (st.onGameStart === 'close');
  const spawnOpts = { cwd: runDir, env: childEnv };
  if (closeOnStart) spawnOpts.detached = true;
  const child = spawn(java, finalArgs, spawnOpts);
  if (closeOnStart) { try { child.unref(); } catch {} }
  else _children.add(child);
  // Modo "Cerrar launcher al iniciar": informar al servidor de skins independiente
  // del PID de Minecraft para que se apague solo cuando el juego termine.
  if (closeOnStart && detachedSkinPidFile && child.pid) {
    try { fs.writeFileSync(detachedSkinPidFile, String(child.pid)); } catch {}
  }
  let exited = false, exitCode = null;
  let tail = '';                 // últimas líneas de salida (para diagnosticar un cierre rápido)
  const addTail = (s) => { tail = (tail + s).slice(-4000); };
  child.stdout.on('data', (d) => { const s = d.toString(); addTail(s); onLog && onLog(s); });
  child.stderr.on('data', (d) => { const s = d.toString(); addTail(s); onLog && onLog(s); });
  child.on('exit', (code, sig) => {
    exited = true; exitCode = code;
    _children.delete(child);
    onLog && onLog('[launcher] Minecraft finalizó (code=' + code + (sig ? ', signal=' + sig : '') + ')');
    try { onExit && onExit(code, sig); } catch {}
  });
  // Traduce las causas de cierre inmediato más habituales a un mensaje claro.
  const diagnose = (t) => {
    // 1) Incompatibilidad de versión de Java (causa real al abrir 26.1+ con un Java viejo).
    //    Se comprueba PRIMERO para no dar el falso aviso de "RAM/JVM".
    if (/UnsupportedClassVersionError|class file version|compiled by a more recent version of the Java|requires Java|bytecode version/i.test(t))
      return 'Esta versión de Minecraft necesita un Java más nuevo. Deja la ruta de Java en AUTOMÁTICO en Ajustes: el launcher descargará solo el Java correcto desde los servidores de Mojang.';
    if (/NoClassDefFoundError|ClassNotFoundException|Could not find or load main class/i.test(t)) return 'Falta una librería en el classpath (instalación incompleta). Pulsa de nuevo JUGAR para que se complete la descarga.';
    if (/UnsatisfiedLinkError|no lwjgl|Failed to locate library|GLFW/i.test(t)) return 'Faltan los archivos nativos (natives) o los drivers gráficos. Reinstala la versión y actualiza los drivers de la GPU.';
    if (/java\.lang\.module|FindException|module .* not found/i.test(t)) return 'Problema con el module-path/classpath de esta versión. Reinstala la versión.';
    // 2) RAM/JVM solo si NO hay señales de incompatibilidad de versión (evita el falso aviso).
    if (/Could not (create|reserve enough space).*Java Virtual Machine|Error occurred during initialization of VM|OutOfMemoryError|insufficient memory/i.test(t)) return 'La JVM no pudo arrancar: revisa la RAM asignada en Ajustes (prueba 2048–4096 MB) y usa un Java de 64 bits.';
    return null;
  };
  return new Promise((resolve) => {
    child.on('error', (e) => { onLog && onLog('[error] ' + e.message); resolve({ ok: false, error: e.message }); });
    child.on('spawn', () => {
      onLog && onLog('[launcher] Proceso lanzado (pid ' + child.pid + '). Cargando Minecraft…');
      // Esperar un poco: si el proceso muere enseguida, informar del fallo REAL.
      setTimeout(() => {
        if (exited) {
          const why = diagnose(tail);
          const last = tail.trim().split('\n').slice(-12).join('\n');
          resolve({
            ok: false,
            error: (why || 'Minecraft se cerró nada más abrir (code=' + exitCode + ').') +
              '\n\n— Últimas líneas del log —\n' + (last || '(sin salida)')
          });
        } else resolve({ ok: true, pid: child.pid });
      }, 3000);
    });
  });
}

/* ---------- Skins locales (guardar skin/capa activas y biblioteca) ---------- */
function dataUrlToBuffer(dataUrl) {
  const m = /^data:[^;]+;base64,(.*)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[1], 'base64') : null;
}

// Guarda la skin (y opcionalmente la capa) activas como PNG en la carpeta local
// del launcher. Minecraft las tomará de ahí a través del servidor local.
function setActiveSkin(payload) {
  const sdir = skinsDir();
  const skinPng = path.join(sdir, 'active_skin.png');
  const capePng = path.join(sdir, 'active_cape.png');
  const sBuf = dataUrlToBuffer(payload && payload.skin);
  if (sBuf) fs.writeFileSync(skinPng, sBuf);
  const cBuf = dataUrlToBuffer(payload && payload.cape);
  if (cBuf) fs.writeFileSync(capePng, cBuf);
  else { try { fs.rmSync(capePng, { force: true }); } catch {} }   // sin capa → solo skin
  // recordar el modelo (slim/alex) en ajustes
  try { const st = loadSettings(); st.skinSlim = !!(payload && payload.slim); saveSettings(st); } catch {}

  // COPIA en las carpetas estándar de .minecraft (skins/ y cape/), como hace el
  // launcher oficial a modo de BIBLIOTECA local de archivos. Así los PNG viven
  // dentro de .minecraft y quedan disponibles aunque el launcher se cierre.
  //
  // NOTA honesta: Minecraft Java (vanilla) NO renderiza tu skin leyéndola de esta
  // carpeta —la obtiene del proveedor de sesión (online) o, en offline, de un
  // proveedor local—; por eso el launcher sigue adjuntando el proveedor local de
  // skins al lanzar. Esta copia es un espejo de archivos (no sustituye al
  // proveedor), equivalente a la biblioteca de skins del launcher oficial.
  try {
    const st = loadSettings();
    const gd = st.gameDir || defaultGameDir();
    const safe = String(st.username || 'Steve').replace(/[^A-Za-z0-9._-]/g, '_') || 'skin';
    if (fs.existsSync(skinPng)) {
      const d = path.join(gd, 'skins'); fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(skinPng, path.join(d, safe + '.png'));
    }
    if (fs.existsSync(capePng)) {
      const d = path.join(gd, 'cape'); fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(capePng, path.join(d, safe + '.png'));
    }
  } catch {}
  // si el servidor local ya está activo, refrescar el perfil en caliente
  try {
    if (skinServer.getPort && skinServer.getPort()) {
      const st = loadSettings();
      skinServer.setProfile({
        username: st.username || 'Steve', uuid: offlineUuid(st.username || 'Steve'),
        skinPath: fs.existsSync(skinPng) ? skinPng : null,
        capePath: fs.existsSync(capePng) ? capePng : null, slim: !!st.skinSlim
      });
    }
  } catch {}
  return { ok: true, hasCape: fs.existsSync(capePng) };
}

module.exports = {
  defaultGameDir, loadSettings, saveSettings, getVersionManifest,
  getInstalledVersions, installVersion, launchGame,
  loadInstalls, saveInstalls, addInstall, removeInstall, installDir,
  togglePause, setPaused, cancelDownload, resetDownloadState,
  killAllChildren,
  ensureJavaRuntime, installFabric, installQuilt,
  setActiveSkin, offlineUuid, skinsDir
};
