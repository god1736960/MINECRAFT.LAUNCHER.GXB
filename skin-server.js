/*
 * Servidor LOCAL y AUTOMÁTICO de skins (modo offline, un jugador).
 * ------------------------------------------------------------------
 * Replica el sistema de skins/capas del launcher oficial pero funcionando
 * en local, SIN servidores externos y SIN que el usuario configure nada.
 *
 * Cómo encaja:
 *   - El launcher guarda la skin y la capa en una carpeta local
 *     (%appdata%/launcher-minecraft/skins/).
 *   - Este servidor expone una API Yggdrasil mínima en 127.0.0.1:<puerto>.
 *   - Al lanzar, el launcher añade automáticamente authlib-injector apuntando
 *     a este servidor, así Minecraft carga la skin/capa locales como si fueran
 *     oficiales. El usuario no toca URLs ni .jar: todo es transparente.
 *
 * Nota honesta: Minecraft Java (vanilla) NO tiene un argumento para "cargar
 * una skin desde un archivo local" directamente; la única forma offline de
 * mostrar una skin propia es un servidor de skins local como éste (el launcher
 * lo gestiona por ti), o un mod. Aquí el launcher lo hace solo.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

let keys = null;           // { publicKey, privateKey } PEM
let server = null;
let port = 0;

// Estado del perfil activo (lo fija el proceso principal)
const state = {
  username: 'Steve',
  uuid: '00000000000000000000000000000000',
  skinPath: null,          // ruta a PNG de skin (o null)
  capePath: null,          // ruta a PNG de capa (o null)
  skinHash: null,          // sha1 del contenido de la skin (versiona la URL)
  capeHash: null,          // sha1 del contenido de la capa (versiona la URL)
  slim: false              // modelo delgado (Alex) sí/no
};

// SHA1 del CONTENIDO del archivo. Esto es la clave del arreglo del cacheo:
// Minecraft guarda cada textura en cache usando su URL; si la URL no cambia,
// el juego reutiliza la capa/skin ANTIGUA aunque el archivo haya cambiado.
// Metiendo el hash del contenido en la URL (/textures/<hash>.png), cada vez
// que cambias de capa la direccion es distinta → el juego la recarga; y si el
// contenido es el mismo, la URL se mantiene (no recarga de mas). Igual que Mojang.
function fileHash(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }
  catch { return null; }
}

function ensureKeys() {
  if (keys) return keys;
  keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return keys;
}

function signSha1(data) {
  const s = crypto.createSign('RSA-SHA1');
  s.update(data);
  return s.sign(keys.privateKey, 'base64');
}

function texturesProperty(host) {
  const textures = {};
  if (state.skinPath && fs.existsSync(state.skinPath)) {
    const v = state.skinHash || 'skin';
    textures.SKIN = { url: 'http://' + host + '/textures/' + v + '.png' };
    if (state.slim) textures.SKIN.metadata = { model: 'slim' };
  }
  if (state.capePath && fs.existsSync(state.capePath)) {
    const v = state.capeHash || 'cape';
    textures.CAPE = { url: 'http://' + host + '/textures/' + v + '.png' };
  }
  const payload = {
    timestamp: Date.now(),
    profileId: state.uuid,
    profileName: state.username,
    textures
  };
  const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return { name: 'textures', value, signature: signSha1(value) };
}

function profileObject(host, signed) {
  const props = [texturesProperty(host)];
  return { id: state.uuid, name: state.username, properties: props };
}

function send(res, code, obj, type) {
  const body = type ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

function serveTexture(res, file) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      // Nunca cachear: el juego siempre recibe la version actual.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end();
  }
}

async function handler(req, res) {
  const host = req.headers.host || ('127.0.0.1:' + port);
  const url = (req.url || '').split('?')[0];

  // --- Metadatos del servidor (authlib-injector) ---
  if (url === '/' || url === '') {
    ensureKeys();
    const pub = keys.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return send(res, 200, {
      meta: {
        serverName: 'launcher-minecraft (local)',
        implementationName: 'launcher-minecraft',
        implementationVersion: '1.0.0',
        'feature.non_email_login': true
      },
      skinDomains: ['127.0.0.1', 'localhost', '.127.0.0.1', '.localhost'],
      signaturePublickey: '-----BEGIN PUBLIC KEY-----\n' + pub.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n'
    });
  }

  // --- Texturas (PNG locales, URL versionada por hash de contenido) ---
  if (url.startsWith('/textures/') && url.endsWith('.png')) {
    const h = url.slice('/textures/'.length, -4);
    if (state.skinHash && h === state.skinHash) return serveTexture(res, state.skinPath);
    if (state.capeHash && h === state.capeHash) return serveTexture(res, state.capePath);
    // Compatibilidad con nombres antiguos / sin hash
    if (h === 'skin') return serveTexture(res, state.skinPath);
    if (h === 'cape') return serveTexture(res, state.capePath);
    res.writeHead(404); return res.end();
  }

  // --- Yggdrasil: autenticación (offline, siempre OK) ---
  if (url === '/authserver/authenticate') {
    const b = await readBody(req);
    const name = (b.username || state.username).replace(/@.*/, '') || state.username;
    state.username = name;
    const token = crypto.randomBytes(16).toString('hex');
    return send(res, 200, {
      accessToken: token,
      clientToken: b.clientToken || crypto.randomBytes(16).toString('hex'),
      availableProfiles: [{ id: state.uuid, name: state.username }],
      selectedProfile: { id: state.uuid, name: state.username }
    });
  }
  if (url === '/authserver/refresh') {
    const b = await readBody(req);
    return send(res, 200, {
      accessToken: b.accessToken || crypto.randomBytes(16).toString('hex'),
      clientToken: b.clientToken || crypto.randomBytes(16).toString('hex'),
      selectedProfile: { id: state.uuid, name: state.username }
    });
  }
  if (url === '/authserver/validate' || url === '/authserver/signout' || url === '/authserver/invalidate') {
    res.writeHead(204); return res.end();
  }

  // --- Yggdrasil: sesión ---
  if (url === '/sessionserver/session/minecraft/join') { res.writeHead(204); return res.end(); }
  if (url.startsWith('/sessionserver/session/minecraft/hasJoined')) {
    return send(res, 200, profileObject(host, true));
  }
  if (url.startsWith('/sessionserver/session/minecraft/profile/')) {
    return send(res, 200, profileObject(host, true));
  }

  // --- API de perfiles por nombre ---
  if (url === '/api/profiles/minecraft') {
    return send(res, 200, [{ id: state.uuid, name: state.username }]);
  }

  // --- Minecraft Services (perfil propio del jugador) ---
  if (url === '/minecraftservices/minecraft/profile') {
    const t = texturesProperty(host);
    const textures = JSON.parse(Buffer.from(t.value, 'base64').toString('utf8')).textures || {};
    const skins = textures.SKIN ? [{
      id: crypto.randomBytes(16).toString('hex'), state: 'ACTIVE',
      url: textures.SKIN.url, variant: state.slim ? 'SLIM' : 'CLASSIC'
    }] : [];
    const capes = textures.CAPE ? [{
      id: crypto.randomBytes(16).toString('hex'), state: 'ACTIVE', url: textures.CAPE.url, alias: 'Capa'
    }] : [];
    return send(res, 200, { id: state.uuid, name: state.username, skins, capes });
  }
  if (url === '/minecraftservices/player/certificates') {
    // Certificado de jugador (1.19+). Se genera uno local; opcional para arrancar.
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const exp = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    return send(res, 200, {
      keyPair: { privateKey: kp.privateKey, publicKey: kp.publicKey },
      publicKeySignature: '', publicKeySignatureV2: '',
      expiresAt: exp, refreshedAfter: exp
    });
  }

  // Por defecto: OK vacío (evita que una llamada no mapeada tumbe al cliente)
  res.writeHead(204); res.end();
}

/* API pública del módulo */
function setProfile(p) {
  if (!p) return;
  if (p.username) state.username = p.username;
  if (p.uuid) state.uuid = String(p.uuid).replace(/-/g, '');
  state.skinPath = p.skinPath || null;
  state.capePath = p.capePath || null;
  // Recalcular hashes de contenido → la URL cambia solo si cambia la imagen.
  state.skinHash = state.skinPath ? fileHash(state.skinPath) : null;
  state.capeHash = state.capePath ? fileHash(state.capePath) : null;
  state.slim = !!p.slim;
}

function start(fixedPort) {
  if (server) return Promise.resolve(port);
  ensureKeys();
  return new Promise((resolve) => {
    server = http.createServer((req, res) => { handler(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }); });
    // Siempre en localhost (nunca expuesto a la red). Puerto 0 = aleatorio;
    // si se pasa un puerto fijo se usa ese (lo necesita el modo independiente).
    server.listen(fixedPort || 0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

function getPort() { return port; }
function getUrl() { return 'http://127.0.0.1:' + port; }
function stop() { if (server) { try { server.close(); } catch {} server = null; port = 0; } }

module.exports = { start, stop, setProfile, getPort, getUrl };
