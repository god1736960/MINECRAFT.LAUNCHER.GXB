/*
 * Servidor de skins INDEPENDIENTE (modo "Cerrar launcher al iniciar el juego").
 * ---------------------------------------------------------------------------
 * Cuando el usuario elige cerrar el launcher al jugar, el servidor de skins NO
 * puede vivir dentro del launcher (se cerraría con él y Minecraft mostraría a
 * Steve). Por eso el launcher arranca ESTE proceso aparte (detached): sobrevive
 * al cierre del launcher y sigue sirviendo tu skin y tu capa a Minecraft durante
 * toda la partida. Cuando Minecraft se cierra, este proceso se apaga solo.
 *
 * Se ejecuta con el binario de Electron en modo Node (ELECTRON_RUN_AS_NODE=1),
 * así no hace falta tener Node instalado aparte.
 *
 * Uso:  <electron> skin-server-run.js <ruta-config.json>
 * config.json: { username, uuid, skinPath, capePath, slim, portFile, pidFile }
 *   - portFile: el servidor escribe aquí el puerto elegido (el launcher lo lee).
 *   - pidFile : el launcher escribe aquí el PID de Minecraft; cuando ese proceso
 *               ya no existe, este servidor se apaga.
 */
const fs = require('fs');
const path = require('path');
const skinServer = require(path.join(__dirname, 'src', 'skin-server'));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function isAlive(pid) {
  if (!pid || isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
function cleanup(cfg) {
  for (const f of [cfg && cfg.portFile, cfg && cfg.pidFile, process.argv[2]]) {
    try { if (f) fs.rmSync(f, { force: true }); } catch {}
  }
}

(async () => {
  const confPath = process.argv[2];
  const cfg = readJson(confPath);
  if (!cfg) process.exit(1);

  skinServer.setProfile({
    username: cfg.username, uuid: cfg.uuid,
    skinPath: cfg.skinPath || null,
    capePath: cfg.capePath || null,
    slim: !!cfg.slim
  });
  const port = await skinServer.start();
  // Publicar el puerto para que el launcher construya la URL del -javaagent.
  try { fs.writeFileSync(cfg.portFile, String(port)); } catch {}

  const t0 = Date.now();
  const START_GRACE = 3 * 60 * 1000;   // 3 min para que aparezca el PID de Minecraft
  const MAX_LIFE = 12 * 60 * 60 * 1000; // tope de seguridad: 12 h

  const timer = setInterval(() => {
    // Tope de vida absoluto (evita procesos huérfanos eternos).
    if (Date.now() - t0 > MAX_LIFE) { clearInterval(timer); try { skinServer.stop(); } catch {} cleanup(cfg); process.exit(0); }

    let pid = null;
    try { pid = parseInt(String(fs.readFileSync(cfg.pidFile, 'utf8')).trim(), 10); } catch {}

    if (!pid) {
      // Minecraft aún no ha reportado su PID: esperar durante el periodo de gracia.
      if (Date.now() - t0 > START_GRACE) { clearInterval(timer); try { skinServer.stop(); } catch {} cleanup(cfg); process.exit(0); }
      return;
    }
    // Minecraft ya reportó su PID: cuando ese proceso termine, apagarse.
    if (!isAlive(pid)) { clearInterval(timer); try { skinServer.stop(); } catch {} cleanup(cfg); process.exit(0); }
  }, 3000);
})().catch(() => process.exit(1));
