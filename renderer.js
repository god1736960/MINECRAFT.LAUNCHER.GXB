/* ===== LAUNCHER MINECRAFT - renderer ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let manifest = null;      // { latest, versions[] }
let installed = [];       // [{id,type,loader,block}]
let settings = null;
let busy = false;
let selLoader = 'vanilla';
let selBlock = 'blk_grass';
let selectedInstall = null;   // instalación seleccionada (borde verde) — SOLO una

// CLAVE compuesta (id + loader): identifica cada instalación de forma única, de
// modo que el mismo id de Minecraft con distinto cargador son instalaciones
// INDEPENDIENTES (cada una con su carpeta). El selector/lista usan esta clave.
function keyOf(v) {
  if (!v) return '';
  if (v.key) return v.key;
  return (v.loader && v.loader !== 'vanilla') ? v.id + '@' + v.loader : v.id;
}

/* ---- Controles de ventana ---- */
$('#min').onclick = () => window.win.minimize();
$('#max').onclick = () => window.win.maximize();
$('#close').onclick = () => window.win.close();

/* ---- Navegación (sidebar + tabs comparten paneles) ---- */
function showPanel(name) {
  $$('.panel').forEach((p) => p.classList.remove('active'));
  const map = { play: 'panel-play', installations: 'panel-installations', skins: 'panel-skins',
    patch: 'panel-patch', news: 'panel-news', settings: 'panel-settings' };
  const el = document.getElementById(map[name]);
  if (el) el.classList.add('active');
  // sincronizar pestañas superiores
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === name));
  if (name === 'installations') renderInstallations();
  // Al mostrar el vestidor, reajusta el lienzo WebGL (antes estaba oculto).
  if (name === 'skins' && window.SkinView) {
    requestAnimationFrame(() => window.SkinView.resize());
  }
}
/* ---- Conmutador de edición (Java / Bedrock / Dungeons / Legends) ---- */
function setEdition(ed) {
  const c = document.querySelector('.content');
  if (!c) return;
  c.classList.remove('ed-java', 'ed-bedrock', 'ed-dungeons', 'ed-legends');
  c.classList.add('ed-' + (ed || 'java'));
}

/* ---- Navegación Dungeons (pestañas internas) ---- */
function showDPanel(name) {
  $$('.dpanel').forEach((p) => p.classList.remove('active'));
  const el = document.getElementById('dpanel-' + name);
  if (el) el.classList.add('active');
  $$('.dtab').forEach((t) => t.classList.toggle('active', t.dataset.dsub === name));
}

/* ---- Navegación Legends (pestañas internas) ---- */
function showLPanel(name) {
  $$('.lpanel').forEach((p) => p.classList.remove('active'));
  const el = document.getElementById('lpanel-' + name);
  if (el) el.classList.add('active');
  $$('.ltab').forEach((t) => t.classList.toggle('active', t.dataset.lsub === name));
}

/* ---- Navegación Bedrock (pestañas internas) ---- */
function showBPanel(name) {
  $$('.bpanel').forEach((p) => p.classList.remove('active'));
  const el = document.getElementById('bpanel-' + name);
  if (el) el.classList.add('active');
  $$('.btab').forEach((t) => t.classList.toggle('active', t.dataset.bsub === name));
  if (name === 'install') refreshBedrock();
}

$$('.nav-item').forEach((b) => b.onclick = () => {
  if (b.dataset.ext) { window.win.openExternal(b.dataset.ext); return; }
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  b.classList.add('active');
  if (b.dataset.tab === 'bedrock') {
    setEdition('bedrock');
    showBPanel('play');
  } else if (b.dataset.tab === 'dungeons') {
    setEdition('dungeons');
    showDPanel('play');
  } else if (b.dataset.tab === 'legends') {
    setEdition('legends');
    showLPanel('play');
  } else {
    setEdition('java');
    showPanel(b.dataset.tab);
  }
});
$$('.btab').forEach((t) => t.onclick = () => showBPanel(t.dataset.bsub));
$$('.tab').forEach((t) => t.onclick = () => showPanel(t.dataset.sub));
$$('.dtab').forEach((t) => t.onclick = () => showDPanel(t.dataset.dsub));
$$('.ltab').forEach((t) => t.onclick = () => showLPanel(t.dataset.lsub));

/* Navega a una edición desde cualquier sitio (menu Play de News, etc.) y
   sincroniza el estado activo de la barra lateral. */
function gotoEdition(go) {
  const tabName = (go === 'bedrock' || go === 'dungeons' || go === 'legends') ? go : 'play';
  const navSel = (go === 'bedrock') ? 'bedrock' : (go === 'dungeons') ? 'dungeons'
    : (go === 'legends') ? 'legends' : 'play';
  const nav = document.querySelector('.nav-item[data-tab="' + navSel + '"]');
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  if (nav) nav.classList.add('active');
  if (go === 'bedrock') { setEdition('bedrock'); showBPanel('play'); }
  else if (go === 'dungeons') { setEdition('dungeons'); showDPanel('play'); }
  else if (go === 'legends') { setEdition('legends'); showLPanel('play'); }
  else { setEdition('java'); showPanel('play'); }
}

/* ---- Carga inicial ---- */
async function init() {
  settings = await window.mc.getSettings();
  applySettingsToUI();
  await refreshData();
  bindSettings();
  bindPlay();
  bindModal();
  await bindSkins();
  bindDownloadCtrls();
  bindBedrock();
  bindNews();
  bindStores();
  // Si ya hay snapshots/betas instaladas, mostrar su filtro para que sean
  // visibles al abrir Installations (de lo contrario quedarían ocultas).
  if (Array.isArray(installed) && installed.some((v) => v && v.type !== 'release')) {
    const f = $('#flt-snap'); if (f) f.checked = true;
  }
}

async function refreshData() {
  installed = await window.mc.getInstalled().catch(() => []);
  fillVersionSelect();
  try {
    manifest = await window.mc.getVersions();
  } catch (e) {
    manifest = { latest: {}, versions: [] };
    console.warn('Sin conexión al manifiesto:', e.message);
  }
  fillVersionSelect();
  fillModalVersions();
}

/* ---- Selector de versión de la barra PLAY (SOLO instaladas) ---- */
function fillVersionSelect() {
  const sel = $('#version-select');
  const prev = sel.value;
  sel.innerHTML = '';
  if (installed.length === 0) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Sin versiones — usa New installation';
    sel.appendChild(o);
    $('#version-sub').textContent = 'No installations';
    return;
  }
  installed.forEach((v) => {
    const o = document.createElement('option');
    o.value = keyOf(v);
    o.textContent = v.id + (v.loader && v.loader !== 'vanilla' ? ' · ' + v.loader : '');
    sel.appendChild(o);
  });
  if (prev && installed.some((v) => keyOf(v) === prev)) sel.value = prev;
  updateVersionSub();
}
function updateVersionSub() {
  const id = $('#version-select').value;
  const v = installed.find((x) => keyOf(x) === id);
  $('#version-sub').textContent = v ? (v.type === 'release' ? 'Release' : 'Snapshot') : 'Installed';
  const grass = document.querySelector('.pb-grass');
  if (grass && v) grass.src = '../assets/' + (v.block || 'blk_grass') + '.png';
  // refrescar la lista de instalaciones para marcar la versión actual
  if (document.getElementById('panel-installations').classList.contains('active')) renderInstallations();
}
$('#version-select').addEventListener('change', updateVersionSub);

/* ---- Lista de Installations (SOLO instaladas) ---- */
function renderInstallations() {
  const list = $('#inst-list');
  const q = ($('#inst-search').value || '').toLowerCase();
  const showRel = $('#flt-release').checked;
  const showSnap = $('#flt-snap').checked;
  list.innerHTML = '';
  const rows = installed.filter((v) => {
    if (q && !v.id.toLowerCase().includes(q)) return false;
    const isSnap = v.type !== 'release';
    if (isSnap && !showSnap) return false;
    if (!isSnap && !showRel) return false;
    return true;
  });
  if (rows.length === 0) {
    list.innerHTML = '<p style="color:#8e8e8e;padding:20px 8px">No hay versiones instaladas. Usa <b>New installation</b> para descargar una.</p>';
    return;
  }
  const curId = selectedInstall || $('#version-select').value;
  rows.forEach((v) => {
    const vk = keyOf(v);
    const row = document.createElement('div');
    row.className = 'inst-row' + (vk === curId ? ' current' : '');
    const blk = v.block || 'blk_grass';
    row.innerHTML =
      '<img class="ic" src="../assets/' + blk + '.png" alt="" />' +
      '<div class="meta"><div class="nm">' + v.id + '</div>' +
      '<div class="vr">' + (v.type === 'release' ? 'Release' : 'Snapshot') +
      (v.loader && v.loader !== 'vanilla' ? ' · ' + v.loader : '') + '</div></div>' +
      '<button class="act act-play" title="Jugar">▶ Jugar</button>' +
      '<button class="act act-folder" title="Abrir carpeta">📂</button>' +
      '<button class="act act-del" title="Eliminar">🗑️</button>';
    // Clic en la tarjeta = SELECCIONAR esta instalación (borde verde solo en ella)
    row.onclick = () => {
      selectedInstall = vk;
      $('#version-select').value = vk;
      updateVersionSub();
      renderInstallations();
    };
    row.querySelector('.act-play').onclick = (ev) => {
      ev.stopPropagation();
      selectedInstall = vk;
      $('#version-select').value = vk; updateVersionSub();
      showPanel('play');
      $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === 'play'));
      doPlay();
    };
    row.querySelector('.act-folder').onclick = (ev) => { ev.stopPropagation(); window.mc.openFolder(vk); };
    row.querySelector('.act-del').onclick = async (ev) => {
      ev.stopPropagation();
      if (selectedInstall === vk) selectedInstall = null;
      installed = await window.mc.removeInstall(vk);
      fillVersionSelect();
      renderInstallations();
    };
    list.appendChild(row);
  });
}
['#inst-search', '#flt-release', '#flt-snap'].forEach((s) =>
  $(s).addEventListener('input', renderInstallations));

/* ---- Modal: catalogo COMPLETO (unico lugar con todas las versiones) ---- */
function fillModalVersions() {
  const sel = $('#ni-version');
  if (!manifest) return;
  const snap = $('#ni-snap').checked;
  sel.innerHTML = '';
  manifest.versions
    .filter((v) => snap ? true : v.type === 'release')
    .forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.id + (v.type !== 'release' ? '  (' + v.type + ')' : '');
      sel.appendChild(o);
    });
}
function bindModal() {
  $('#btn-new-inst').onclick = () => { fillModalVersions(); $('#modal-inst').classList.remove('hidden'); };
  $('#modal-x').onclick = () => $('#modal-inst').classList.add('hidden');
  $('#ni-cancel').onclick = () => $('#modal-inst').classList.add('hidden');
  $('#ni-snap').onclick = fillModalVersions;
  // selector de loader
  $$('#loader-row .loader-opt').forEach((b) => b.onclick = () => {
    $$('#loader-row .loader-opt').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); selLoader = b.dataset.loader;
  });
  // selector de icono de bloque
  $$('#block-row .block-opt').forEach((b) => b.onclick = () => {
    $$('#block-row .block-opt').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); selBlock = b.dataset.block;
  });
  $('#ni-create').onclick = async () => {
    const id = $('#ni-version').value;
    if (!id) return;
    const entry = {
      id, loader: selLoader, block: selBlock,
      type: (manifest && manifest.versions.find((v) => v.id === id) || {}).type || 'release'
    };
    installed = await window.mc.addInstall(entry);
    const k = (selLoader && selLoader !== 'vanilla') ? id + '@' + selLoader : id;
    // Si la instalación creada es snapshot/beta, activar su filtro en la lista de
    // Installations para que aparezca de inmediato (si no, el filtro por defecto
    // la ocultaría). Así se guarda VISIBLE y se puede eliminar sin problemas.
    if (entry.type !== 'release') { const f = $('#flt-snap'); if (f) f.checked = true; }
    fillVersionSelect(); $('#version-select').value = k; updateVersionSub();
    renderInstallations();
    $('#modal-inst').classList.add('hidden');
    await installThenRefresh(k);
  };
}

/* ====================================================================
   SKINS — Vestuario estilo KLauncher (2 columnas)
   Izquierda: visor 3D rotable con el ratón (sin giro automático).
   Derecha: nombre, Skin/Cape Library, bloque promo, caja Load (+), rejilla.
   Menú contextual (clic derecho sobre el modelo): Hand Settings (Normal/Slim)
   + Actions (Remove skin / Remove cape).
   ==================================================================== */

// Dos bibliotecas independientes.
let skinGallery = [];     // [{name, skin(dataURL), slim}]
let capeGallery = [];     // [{name, cape(dataURL)}]
let activeSkin = -1;      // índice de la skin equipada (-1 = ninguna → Steve)
let activeCape = -1;      // índice de la capa equipada (-1 = sin capa)
let currentModel = 'wide';// 'wide' (Normal) | 'slim' (Delgado)
let currentLibTab = 'skin'; // pestaña activa: 'skin' | 'cape'
let steveSkin = null;     // skin por defecto (dataURL)

// Convierte una ruta/URL de imagen a dataURL para que la textura SIEMPRE aplique
// (evita la silueta blanca por url relativa que no resuelve).
async function toDataURL(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('No se pudo cargar imagen:', e.message);
    return url;
  }
}

// Aplica skin y capa al visor 3D y lo recuerda; luego sincroniza con el core
// (escribe los PNG locales que servirá el servidor de skins automatico).
async function applyLook(skinUrl, capeUrl, slim) {
  const skinData = await toDataURL(skinUrl);
  const capeData = capeUrl ? await toDataURL(capeUrl) : null;
  // Visor 3D WebGL (motor nuevo): pinta skin y capa sin deformaciones.
  if (window.SkinView) {
    if (skinData) window.SkinView.setSkin(skinData, !!slim);
    window.SkinView.setCape(capeData);  // null = sin capa
  }
  // Persistir como skin/capa activas (el launcher las sirve en local, offline)
  try { await window.mc.setActiveSkin({ skin: skinData, cape: capeData, slim: !!slim }); } catch (e) {}
  return skinData;
}

// Equipa en el visor 3D la skin + capa activas segun el estado actual.
async function applyCurrent() {
  const skin = (activeSkin >= 0 && skinGallery[activeSkin]) ? skinGallery[activeSkin].skin : steveSkin;
  const cape = (activeCape >= 0 && capeGallery[activeCape]) ? capeGallery[activeCape].cape : null;
  const slim = currentModel === 'slim';
  await applyLook(skin, cape, slim);
}

// Recorta en una miniatura la cara frontal de la cabeza (skin 64px).
function skinFace(el, url) {
  el.style.backgroundImage = 'url("' + url + '")';
  el.style.backgroundSize = '432px 432px';
  el.style.backgroundPosition = '-54px -54px';
}

// Muestra la capa en 2D PLANA (la "capa extendida", igual que se ve puesta en el
// juego): recorta del atlas de la textura la cara frontal de la capa.
// Layout estándar de capa 64x32: frente en texel (1,1), tamaño 10x16.
// La miniatura mide 72x112 px -> 7 px por texel aprox (72/10, 112/16=7).
function capeFlat(el, url) {
  const px = 7; // px por texel
  el.style.backgroundImage = 'url("' + url + '")';
  el.style.backgroundSize = (64 * px) + 'px ' + (32 * px) + 'px';
  el.style.backgroundPosition = '-' + (1 * px) + 'px -' + (1 * px) + 'px';
}

// Pinta la rejilla de la biblioteca activa (skin o cape) con miniaturas reales.
function renderLibrary() {
  const grid = document.getElementById('kl-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (currentLibTab === 'skin') {
    skinGallery.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'kl-card' + (i === activeSkin ? ' active' : '');
      const thumb = document.createElement('div');
      thumb.className = 'kl-thumb';
      skinFace(thumb, s.skin);
      const nm = document.createElement('div');
      nm.className = 'kl-cname';
      nm.textContent = s.name || 'Skin';
      card.appendChild(thumb); card.appendChild(nm);
      card.onclick = async () => { activeSkin = i; await applyCurrent(); renderLibrary(); };
      grid.appendChild(card);
    });
  } else {
    capeGallery.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'kl-card' + (i === activeCape ? ' active' : '');
      const thumb = document.createElement('div');
      thumb.className = 'kl-thumb cape';
      // Vista 2D plana de la capa (capa extendida), no modelo 3D.
      capeFlat(thumb, c.cape);
      const nm = document.createElement('div');
      nm.className = 'kl-cname';
      nm.textContent = c.name || 'Cape';
      card.appendChild(thumb); card.appendChild(nm);
      card.onclick = async () => { activeCape = i; await applyCurrent(); renderLibrary(); };
      grid.appendChild(card);
    });
  }
}

// Cambia entre las pestañas Skin Library / Cape Library (promo + load + rejilla).
function switchLibTab(tab) {
  currentLibTab = tab;
  $$('.kl-libtab').forEach((b) => b.classList.toggle('active', b.dataset.lib === tab));
  const ps = document.getElementById('kl-promo-skin');
  const pc = document.getElementById('kl-promo-cape');
  if (ps) ps.classList.toggle('hidden', tab !== 'skin');
  if (pc) pc.classList.toggle('hidden', tab !== 'cape');
  const lt = document.getElementById('kl-load-txt');
  if (lt) lt.textContent = (tab === 'skin') ? 'Load skin' : 'Load cape';
  renderLibrary();
}

// Carga una skin PNG, la añade a la biblioteca y la equipa.
async function loadSkin() {
  const data = await window.mc.browseSkin();
  if (!data) return;
  const dataUrl = await toDataURL(data);
  skinGallery.push({ name: 'Skin ' + (skinGallery.length + 1), skin: dataUrl, slim: currentModel === 'slim' });
  activeSkin = skinGallery.length - 1;
  await applyCurrent();
  renderLibrary();
}

// Carga una capa PNG, la añade a la biblioteca de capas y la equipa.
async function loadCape() {
  const data = await window.mc.browseCape();
  if (!data) return;
  const dataUrl = await toDataURL(data);
  capeGallery.push({ name: 'Cape ' + (capeGallery.length + 1), cape: dataUrl });
  activeCape = capeGallery.length - 1;
  await applyCurrent();
  renderLibrary();
}

// Quita la skin equipada (vuelve a Steve) y la elimina de la biblioteca.
async function removeSkin() {
  if (activeSkin >= 0) { skinGallery.splice(activeSkin, 1); activeSkin = -1; }
  await applyCurrent();
  if (currentLibTab === 'skin') renderLibrary();
  hideCtx();
}

// Quita la capa equipada y la elimina de la biblioteca de capas.
async function removeCape() {
  if (activeCape >= 0) { capeGallery.splice(activeCape, 1); activeCape = -1; }
  await applyCurrent();
  if (currentLibTab === 'cape') renderLibrary();
  hideCtx();
}

// Cambia el modelo del personaje (Normal/Wide <-> Delgado/Slim).
async function setModel(model) {
  currentModel = model;
  if (activeSkin >= 0 && skinGallery[activeSkin]) skinGallery[activeSkin].slim = (model === 'slim');
  const lab = document.getElementById('kl-model-label');
  if (lab) lab.textContent = (model === 'slim') ? 'Slim' : 'Normal';
  const tg = document.getElementById('kl-model-toggle');
  if (tg) tg.checked = (model === 'slim');
  await applyCurrent();
}

/* ---- Menú contextual (clic derecho sobre el modelo 3D) ---- */
function showCtx(x, y) {
  const m = document.getElementById('kl-ctx');
  if (!m) return;
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  const mx = Math.min(x, window.innerWidth - r.width - 8);
  const my = Math.min(y, window.innerHeight - r.height - 8);
  m.style.left = mx + 'px';
  m.style.top = my + 'px';
}
function hideCtx() {
  const m = document.getElementById('kl-ctx');
  if (m) m.classList.add('hidden');
}

async function bindSkins() {
  // skin por defecto (Steve) leída por el proceso principal como dataURL
  // (lectura directa del archivo: la textura SIEMPRE carga, nunca silueta blanca)
  let steve = null;
  try { steve = await window.mc.defaultSkin(); } catch (e) { steve = null; }
  if (!steve) steve = await toDataURL('../assets/skin_steve.png');
  steveSkin = steve;

  // Recuperar las bibliotecas guardadas (skins + capas) y el estado equipado.
  const savedS = (settings && Array.isArray(settings.skinLibrary)) ? settings.skinLibrary : null;
  skinGallery = (savedS && savedS.length)
    ? savedS.map(s => ({ name: s.name || 'Skin', skin: s.skin || steve, slim: !!s.slim }))
    : [];
  const savedC = (settings && Array.isArray(settings.capeLibrary)) ? settings.capeLibrary : null;
  capeGallery = (savedC && savedC.length)
    ? savedC.map(c => ({ name: c.name || 'Cape', cape: c.cape })).filter(c => c.cape)
    : [];
  activeSkin = (typeof settings.activeSkin === 'number') ? settings.activeSkin : -1;
  if (activeSkin >= skinGallery.length) activeSkin = skinGallery.length - 1;
  activeCape = (typeof settings.activeCape === 'number') ? settings.activeCape : -1;
  if (activeCape >= capeGallery.length) activeCape = capeGallery.length - 1;
  currentModel = (settings.model === 'slim') ? 'slim'
    : (activeSkin >= 0 && skinGallery[activeSkin] && skinGallery[activeSkin].slim) ? 'slim' : 'wide';

  // Etiqueta del nombre de usuario (columna derecha).
  const uname = settings.username || 'Steve';
  const ku = document.getElementById('kl-username'); if (ku) ku.textContent = uname;

  // Pestañas de biblioteca Skin / Cape.
  $$('.kl-libtab').forEach((b) => b.onclick = () => switchLibTab(b.dataset.lib));
  // Caja de carga (+): depende de la pestaña activa.
  const load = document.getElementById('kl-load');
  if (load) load.onclick = () => (currentLibTab === 'skin' ? loadSkin() : loadCape());

  // Icono "pies": alterna el modelo Normal <-> Slim.
  const feet = document.getElementById('kl-ic-feet');
  if (feet) feet.onclick = () => setModel(currentModel === 'slim' ? 'wide' : 'slim');
  // Icono "engranaje": abre el menú contextual (ajustes de mano).
  const gear = document.getElementById('kl-ic-gear');
  if (gear) gear.onclick = (e) => { const r = gear.getBoundingClientRect(); showCtx(r.left, r.bottom + 4); e.stopPropagation(); };

  // Menú contextual: clic derecho sobre el visor 3D.
  const stage = document.getElementById('skin-stage');
  if (stage) stage.oncontextmenu = (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY); };
  document.addEventListener('click', (e) => {
    const m = document.getElementById('kl-ctx');
    if (m && !m.contains(e.target)) hideCtx();
  });
  const tg = document.getElementById('kl-model-toggle');
  if (tg) tg.onchange = () => setModel(tg.checked ? 'slim' : 'wide');
  const rmS = document.getElementById('kl-remove-skin'); if (rmS) rmS.onclick = removeSkin;
  const rmC = document.getElementById('kl-remove-cape'); if (rmC) rmC.onclick = removeCape;

  // Rotación del modelo arrastrando con el ratón sobre el escenario.
  bindDragRotate();

  // Estado inicial del toggle/label de modelo.
  if (tg) tg.checked = (currentModel === 'slim');
  const lab = document.getElementById('kl-model-label');
  if (lab) lab.textContent = (currentModel === 'slim') ? 'Slim' : 'Normal';

  await applyCurrent();
  switchLibTab('skin');
}

// Arrastre del raton sobre .kl-stage para rotar el visor 3D WebGL (rx/ry).
function bindDragRotate() {
  const stage = document.getElementById('skin-stage');
  const canvas = document.getElementById('mc-canvas');
  if (!stage || !canvas) return;
  // Inicializa el motor WebGL una sola vez.
  if (window.SkinView && !canvas.__inited) {
    canvas.__inited = window.SkinView.init(canvas);
  }
  let dragging = false, lastX = 0, lastY = 0;
  let ry = 22, rx = 0; // angulos iniciales de camara
  const apply = () => { if (window.SkinView) window.SkinView.setRotation(rx, ry); };
  apply();
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    stage.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    ry += (e.clientX - lastX) * 0.6;
    rx -= (e.clientY - lastY) * 0.4;
    rx = Math.max(-60, Math.min(60, rx));
    lastX = e.clientX; lastY = e.clientY;
    apply();
  });
  window.addEventListener('mouseup', () => { dragging = false; stage.classList.remove('grabbing'); });
}

async function installThenRefresh(id) {
  if (busy) return; busy = true;
  setProgress(true, 0, 'Descargando ' + id + '…');
  $('#play-btn').disabled = true;
  try {
    await window.mc.install(id);
    installed = await window.mc.getInstalled();
    fillVersionSelect();
    $('#version-select').value = id;
    renderInstallations();
    setProgress(false);
  } catch (e) {
    setProgress(true, 100, 'Error: ' + e.message);
    setTimeout(() => setProgress(false), 4000);
  }
  $('#play-btn').disabled = false; busy = false;
}

/* ---- Progreso ---- */
function setProgress(show, pct, text) {
  const box = $('#pb-progress');
  if (show) {
    box.classList.remove('hidden');
    if (pct != null) $('#bar-fill').style.width = pct + '%';
    if (text != null) $('#bar-text').textContent = text;
    const pz = document.getElementById('dl-pause'); if (pz) pz.textContent = '⏸ Pausa';
  } else {
    box.classList.add('hidden');
  }
}
window.mc.onProgress((p) => {
  if ($('#pb-progress').classList.contains('hidden')) setProgress(true, p.pct, p.text);
  else { $('#bar-fill').style.width = (p.pct || 0) + '%'; $('#bar-text').textContent = p.text || ''; }
});
window.mc.onGameLog((l) => console.log('[MC]', l));

/* ---- Controles de descarga (Pausa / Cancelar) ---- */
function bindDownloadCtrls() {
  const p = document.getElementById('dl-pause');
  const c = document.getElementById('dl-cancel');
  if (p) p.onclick = async () => {
    if (!window.mc.pauseDownload) return;
    const paused = await window.mc.pauseDownload();   // devuelve nuevo estado
    p.textContent = paused ? '▶ Reanudar' : '⏸ Pausa';
  };
  if (c) c.onclick = async () => {
    if (window.mc.cancelDownload) await window.mc.cancelDownload();
    const p2 = document.getElementById('dl-pause');
    if (p2) p2.textContent = '⏸ Pausa';
    setProgress(true, 0, 'Cancelado');
    setTimeout(() => setProgress(false), 1500);
  };
}

/* ---- PLAY ---- */
function bindPlay() { $('#play-btn').onclick = doPlay; }
async function doPlay() {
  if (busy) return;
  const id = $('#version-select').value;
  if (!id) { showPanel('installations'); $('#btn-new-inst').click(); return; }
  busy = true; $('#play-btn').disabled = true;
  setProgress(true, 0, 'Preparando ' + id + '…');
  try {
    const r = await window.mc.launch({ versionId: id, username: settings.username });
    if (r && r.ok) { setProgress(true, 100, '¡Minecraft iniciado!'); setTimeout(() => setProgress(false), 2500); }
    else { setProgress(true, 100, 'Error: ' + (r && r.error || 'desconocido')); setTimeout(() => setProgress(false), 5000); }
    installed = await window.mc.getInstalled(); fillVersionSelect(); $('#version-select').value = id;
  } catch (e) {
    setProgress(true, 100, 'Error: ' + e.message); setTimeout(() => setProgress(false), 5000);
  }
  $('#play-btn').disabled = false; busy = false;
}

/* ---- Settings ---- */
function applySettingsToUI() {
  $('#set-user').value = settings.username || 'Steve';
  $('#set-dir').value = settings.gameDir || '';
  $('#set-java').value = settings.javaPath || '';
  $('#set-ram').value = settings.ramMb || 2048;
  $('#set-w').value = settings.widthRes || '';
  $('#set-h').value = settings.heightRes || '';
  // Comportamiento al iniciar el juego
  const beh = settings.onGameStart || 'keep';
  const rb = document.querySelector('input[name="onstart"][value="' + beh + '"]');
  if (rb) rb.checked = true;
  const kg = $('#set-killgame');
  if (kg) kg.checked = (settings.killGameOnExit !== false);
  const oj = $('#set-optimize');
  if (oj) oj.checked = (settings.optimizeJvm !== false);
  updateUserLabels(settings.username || 'Steve');
}
function updateUserLabels(name) {
  $('#pb-user').textContent = name;
  $('.profile-name').childNodes[0].nodeValue = name + ' ';
  const sn = $('#skin-name'); if (sn) sn.textContent = name;
  const ku = $('#kl-username'); if (ku) ku.textContent = name;
  const bu = $('#bk-pb-user'); if (bu) bu.textContent = name;
}
function bindSettings() {
  $('#browse-dir').onclick = async () => { const d = await window.mc.browseDir(); if (d) $('#set-dir').value = d; };
  $('#browse-java').onclick = async () => { const d = await window.mc.browseJava(); if (d) $('#set-java').value = d; };
  $('#save-settings').onclick = async () => {
    settings = {
      username: ($('#set-user').value || 'Steve').trim() || 'Steve',
      gameDir: $('#set-dir').value.trim(),
      javaPath: $('#set-java').value.trim(),
      ramMb: parseInt($('#set-ram').value, 10) || 2048,
      widthRes: $('#set-w').value ? parseInt($('#set-w').value, 10) : '',
      heightRes: $('#set-h').value ? parseInt($('#set-h').value, 10) : '',
      // Comportamiento del launcher al iniciar/cerrar el juego
      onGameStart: (document.querySelector('input[name="onstart"]:checked') || {}).value || 'keep',
      killGameOnExit: $('#set-killgame') ? $('#set-killgame').checked : true,
      optimizeJvm: $('#set-optimize') ? $('#set-optimize').checked : true,
      // Conservar las bibliotecas de skins/capas y el estado equipado
      skinLibrary: skinGallery.map(s => ({ name: s.name, skin: s.skin, slim: !!s.slim })),
      capeLibrary: capeGallery.map(c => ({ name: c.name, cape: c.cape })),
      activeSkin: activeSkin,
      activeCape: activeCape,
      model: currentModel
    };
    await window.mc.saveSettings(settings);
    updateUserLabels(settings.username);
    installed = await window.mc.getInstalled(); fillVersionSelect();
    $('#save-ok').textContent = 'Guardado ✓';
    setTimeout(() => ($('#save-ok').textContent = ''), 2500);
  };
}

/* ====================================================================
   BEDROCK EDITION — detección de versión y acciones (Play/Carpeta/Eliminar)
   Bedrock es una app UWP de Microsoft Store: el launcher la DETECTA y la
   abre a través del sistema (no descarga ni gestiona sus binarios).
   ==================================================================== */
async function refreshBedrock() {
  if (!window.mc.bedrockDetect) return;
  let info = null;
  try { info = await window.mc.bedrockDetect(); } catch (e) { info = null; }
  const verEl = document.getElementById('bedrock-ver');
  const subEl = document.getElementById('bk-version-sub');
  const prevRow = document.getElementById('bedrock-preview-row');
  const prevVer = document.getElementById('bedrock-preview-ver');
  const note = document.getElementById('bedrock-note');
  if (info && info.installed) {
    if (verEl) verEl.textContent = 'Versión instalada: ' + (info.version || 'desconocida');
    if (subEl) subEl.textContent = info.version || 'Instalado';
    if (note) note.textContent = '';
  } else if (info && info.supported === false) {
    if (verEl) verEl.textContent = 'Disponible solo en Windows 10/11';
    if (subEl) subEl.textContent = 'Solo Windows';
    if (note) note.textContent = 'Minecraft Bedrock Edition es una aplicación de Microsoft Store (UWP) y solo puede detectarse y abrirse en Windows 10/11.';
  } else {
    if (verEl) verEl.textContent = 'No se encontró Bedrock instalado';
    if (subEl) subEl.textContent = 'No instalado';
    if (note) note.textContent = 'No se detectó Minecraft Bedrock Edition en este equipo. Instálalo desde Microsoft Store y pulsa de nuevo esta pestaña.';
  }
  if (info && info.previewInstalled) {
    if (prevRow) prevRow.style.display = '';
    if (prevVer) prevVer.textContent = 'Versión Preview: ' + (info.previewVersion || 'instalada');
  } else if (prevRow) {
    prevRow.style.display = 'none';
  }
}

async function bedrockPlay(preview) {
  const r = await (window.mc.bedrockPlay ? window.mc.bedrockPlay(!!preview) : Promise.resolve({ ok: false }));
  const note = document.getElementById('bedrock-note');
  if (r && !r.ok && note) note.textContent = r.error || 'No se pudo iniciar Bedrock. Ábrelo desde Microsoft Store.';
}

function bindBedrock() {
  const user = (settings && settings.username) || 'Steve';
  const bu = document.getElementById('bk-pb-user'); if (bu) bu.textContent = user;
  const map = [
    ['bk-play-btn', () => bedrockPlay(false)],
    ['bk-inst-play', () => bedrockPlay(false)],
    ['bk-prev-play', () => bedrockPlay(true)],
    ['bk-inst-folder', () => window.mc.bedrockFolder && window.mc.bedrockFolder(false)],
    ['bk-prev-folder', () => window.mc.bedrockFolder && window.mc.bedrockFolder(true)],
    ['bk-inst-del', () => window.mc.bedrockRemove && window.mc.bedrockRemove()]
  ];
  map.forEach(([id, fn]) => { const el = document.getElementById(id); if (el) el.onclick = fn; });
  refreshBedrock();
}

/* ====================================================================
   NEWS — menu Play, tarjeta destacada + mini tarjetas rotatorias,
   busqueda, filtros y rejilla de novedades por juego.
   ==================================================================== */
const DUNGEONS_URL = 'https://www.minecraft.net/es-es/about-dungeons';
const LEGENDS_URL = 'https://www.minecraft.net/es-es/about-legends';

// Catalogo de novedades (imagenes locales existentes). game: java|bedrock|dungeons|legends
const NEWS_ITEMS = [
  { game: 'java', cat: 'update', img: '../assets/patch1.webp', tag: 'Java', title: 'The Wild Update', sub: 'Biomas, el Allay y el Deep Dark llegan a Java Edition.' },
  { game: 'java', cat: 'update', img: '../assets/patch2.jpg', tag: 'Java', title: 'Nether Update', sub: 'Nuevos biomas y bloques del Nether.' },
  { game: 'java', cat: 'update', img: '../assets/patch3.jpg', tag: 'Java', title: 'Trails & Tales', sub: 'Arqueologia, camellos y mucho mas.' },
  { game: 'java', cat: 'news', img: '../assets/bg_cave.jpg', tag: 'Java', title: 'Descargas oficiales', sub: 'Instala cualquier version (releases y snapshots) con un clic.' },
  { game: 'bedrock', cat: 'update', img: '../assets/bedrock/patch_1.jpg', tag: 'Bedrock', title: 'Chaos Cubed', sub: 'El contenido mas reciente de Bedrock Edition.' },
  { game: 'bedrock', cat: 'update', img: '../assets/bedrock/patch_5.jpg', tag: 'Bedrock', title: 'Trial Chambers', sub: 'Nuevas mazmorras y desafios de combate.' },
  { game: 'bedrock', cat: 'news', img: '../assets/bedrock/market_1.jpg', tag: 'Bedrock', title: 'Novedades del Marketplace', sub: 'Skins, mundos y texturas cada semana.' },
  { game: 'bedrock', cat: 'guide', img: '../assets/bedrock/realm_1.jpg', tag: 'Bedrock', title: 'Realms Plus', sub: 'Tu mundo privado en la nube para ti y tus amigos.' },
  { game: 'dungeons', cat: 'update', img: '../assets/game_dungeons.webp', tag: 'Dungeons', title: 'Update 1.17.0.0', sub: 'La ultima actualizacion de Minecraft Dungeons.' },
  { game: 'dungeons', cat: 'news', img: '../assets/patch1.webp', tag: 'Dungeons', title: 'DLC Flames of the Nether', sub: 'Lleva la batalla al Nether con misiones ardientes.' },
  { game: 'legends', cat: 'update', img: '../assets/game_legends.webp', tag: 'Legends', title: 'Update 1.18.19068', sub: 'La ultima actualizacion de Minecraft Legends.' },
  { game: 'legends', cat: 'news', img: '../assets/patch3.jpg', tag: 'Legends', title: 'Defiende el Overworld', sub: 'Lidera a tus aliados contra los piglins.' }
];

function newsOpen(item) {
  if (item.game === 'dungeons') gotoEdition('dungeons');
  else if (item.game === 'legends') gotoEdition('legends');
  else if (item.game === 'bedrock') gotoEdition('bedrock');
  else gotoEdition('play');
}

let newsHeroTimer = null;
function startNewsRotation() {
  if (newsHeroTimer) clearInterval(newsHeroTimer);
  // La tarjeta grande rota entre destacados; las 4 mini tarjetas tambien cambian.
  const heroPool = NEWS_ITEMS.slice();
  const miniPool = NEWS_ITEMS.slice();
  let hi = 0, mi = 0;
  const heroImg = document.getElementById('nf-hero-img');
  const heroTag = document.getElementById('nf-hero-tag');
  const heroTitle = document.getElementById('nf-hero-title');
  const heroSub = document.getElementById('nf-hero-sub');
  const hero = document.getElementById('nf-hero');
  const minisBox = document.getElementById('nf-minis');
  function paintHero() {
    const it = heroPool[hi % heroPool.length];
    if (heroImg) heroImg.src = it.img;
    if (heroTag) heroTag.textContent = it.tag;
    if (heroTitle) heroTitle.textContent = it.title;
    if (heroSub) heroSub.textContent = it.sub;
    if (hero) hero.onclick = () => newsOpen(it);
  }
  function paintMinis() {
    if (!minisBox) return;
    minisBox.innerHTML = '';
    for (let k = 0; k < 4; k++) {
      const it = miniPool[(mi + k) % miniPool.length];
      const d = document.createElement('div');
      d.className = 'nf-mini';
      d.innerHTML = '<img src="' + it.img + '" alt=""/><div class="nf-mini-grad"></div><span>' + it.title + '</span>';
      d.onclick = () => newsOpen(it);
      minisBox.appendChild(d);
    }
  }
  paintHero(); paintMinis();
  newsHeroTimer = setInterval(() => {
    hi = (hi + 1) % heroPool.length;
    mi = (mi + 1) % miniPool.length;
    paintHero(); paintMinis();
  }, 4500);
}

function renderNewsGrid() {
  const grid = document.getElementById('news-grid');
  if (!grid) return;
  const q = ((document.getElementById('news-search') || {}).value || '').toLowerCase().trim();
  const g = (document.getElementById('nf-game') || {}).value || 'all';
  const cat = (document.getElementById('nf-cat') || {}).value || 'all';
  grid.innerHTML = '';
  const rows = NEWS_ITEMS.filter((it) => {
    if (g !== 'all' && it.game !== g) return false;
    if (cat !== 'all' && it.cat !== cat) return false;
    if (q && !(it.title.toLowerCase().includes(q) || it.sub.toLowerCase().includes(q) || it.tag.toLowerCase().includes(q))) return false;
    return true;
  });
  if (!rows.length) {
    grid.innerHTML = '<div class="news-empty">No se encontraron novedades con esos filtros.</div>';
    return;
  }
  rows.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'ng-card';
    card.innerHTML = '<img src="' + it.img + '" alt=""/><div class="ng-body">' +
      '<span class="ng-chip ' + it.game + '">' + it.tag + '</span>' +
      '<h3>' + it.title + '</h3><p>' + it.sub + '</p></div>';
    card.onclick = () => newsOpen(it);
    grid.appendChild(card);
  });
}

function bindNews() {
  // Menu desplegable del boton Play
  const caret = document.getElementById('news-play-caret');
  const menu = document.getElementById('news-play-menu');
  const playBig = document.getElementById('news-play');
  if (playBig) playBig.onclick = () => gotoEdition('play');
  if (caret && menu) {
    caret.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== caret) menu.classList.add('hidden');
    });
  }
  $$('#news-play-menu .npm-item').forEach((b) => b.onclick = () => {
    if (menu) menu.classList.add('hidden');
    gotoEdition(b.dataset.go);
  });
  // Filtros desplegables
  const fbtn = document.getElementById('news-filter-btn');
  const fmenu = document.getElementById('news-filter-menu');
  if (fbtn && fmenu) {
    fbtn.onclick = (e) => { e.stopPropagation(); fmenu.classList.toggle('hidden'); };
    document.addEventListener('click', (e) => {
      if (!fmenu.contains(e.target) && e.target !== fbtn) fmenu.classList.add('hidden');
    });
  }
  const gsel = document.getElementById('nf-game');
  const csel = document.getElementById('nf-cat');
  if (gsel) gsel.onchange = renderNewsGrid;
  if (csel) csel.onchange = renderNewsGrid;
  const search = document.getElementById('news-search');
  if (search) search.addEventListener('input', renderNewsGrid);
  startNewsRotation();
  renderNewsGrid();
}

/* ====================================================================
   DUNGEONS / LEGENDS — pestañas, BUY NOW / Buy as Gift y tarjetas.
   Todo lo que implique compra o descarga abre el sitio OFICIAL.
   ==================================================================== */
function bindStores() {
  // Pestañas internas (ya se enlazan arriba por data-dsub/data-lsub, pero
  // aseguramos el estado inicial).
  const openDg = () => window.win.openExternal(DUNGEONS_URL);
  const openLg = () => window.win.openExternal(LEGENDS_URL);
  const dgBuy = document.getElementById('dg-buy-btn'); if (dgBuy) dgBuy.onclick = openDg;
  const dgGift = document.getElementById('dg-gift-btn'); if (dgGift) dgGift.onclick = openDg;
  const lgBuy = document.getElementById('lg-buy-btn'); if (lgBuy) lgBuy.onclick = openLg;
  const lgGift = document.getElementById('lg-gift-btn'); if (lgGift) lgGift.onclick = openLg;
  // Cualquier tarjeta/boton de descarga de Dungeons/Legends -> sitio oficial.
  $$('.ext-dungeons').forEach((el) => el.onclick = openDg);
  $$('.ext-legends').forEach((el) => el.onclick = openLg);
}

init();
