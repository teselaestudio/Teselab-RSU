/* ============================================================
   app.js — Visor Cartográfico Archena · Tesela Estudio
   OGC API Features (QGIS Server / Mergin Maps)
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────
// 1. CONFIGURACIÓN GLOBAL
// ─────────────────────────────────────────────────────────
const CONFIG = {
  // En local: usa el proxy Python que añade cabeceras CORS.
  // En GitHub Pages: cambia a la URL directa (Mergin Maps permite CORS en producción).
  BASE_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '/ogc-proxy'
    : 'https://app.merginmaps.com/v2/ogc/UpOZfUR3b1gCNrvQHxFXTGaIwfo/api',
  COLLECTIONS: {
    municipio:    'Archena_muncipio',
    viario:       'Archena_viario_calculo',
    peatonal:     'Archena_viario_peatonal',
    contenedores: 'Archena_contenedores_y_papeleras_%E2%80%94',
  },
  // BBox del municipio [minLon, minLat, maxLon, maxLat]
  MUNICIPIO_BBOX: [-1.325584878, 38.086049481, -1.265431122, 38.1400745],
  // Sondeo de cambios (ms)
  POLL_INTERVAL: 60000,
  PAGE_SIZE: 500,
};

// Colores por tipo de residuo (coinciden con CSS vars)
const TIPO_COLOR = {
  'Resto':               '#94a3b8',
  'Vidrio':              '#22c55e',
  'Papel y carton':      '#60a5fa',
  'Papel y cartón':      '#60a5fa',
  'Envases':             '#facc15',
  '(Resto y organico)':  '#f97316',
  '(Resto y orgánico)':  '#f97316',
  'default':             '#a78bfa',
};

function getTipoColor(tipo) {
  if (!tipo) return TIPO_COLOR.default;
  const normalized = tipo.trim();
  return TIPO_COLOR[normalized] || TIPO_COLOR.default;
}

function getTipoLabel(tipo) {
  const map = {
    'Papel y carton': 'Papel y Cartón',
    '(Resto y organico)': 'Orgánico',
    '(Resto y orgánico)': 'Orgánico',
  };
  return map[tipo] || tipo || '—';
}

// ─────────────────────────────────────────────────────────
// 2. ESTADO DE LA APLICACIÓN
// ─────────────────────────────────────────────────────────
const STATE = {
  allFeatures: [],          // Todos los features de contenedores
  filteredFeatures: [],     // Features después de aplicar filtros
  selectedFeature: null,    // Feature actualmente seleccionado
  lastTimestamp: null,      // Último timestamp del servidor (para detección de cambios)
  pollTimer: null,          // Timer del sondeo
  activeFilters: {
    tipo: 'all',            // KPI tipo activo
    sistema: 'all',
    color: 'all',
    usuario: 'all',
    search: '',
  },
  leafletLayers: {},        // Referencias a capas de Leaflet
  calendarDate: new Date(), // Mes actual del calendario
  isMobile: false,
  dashboardOpen: true,
  statsPanelOpen: false,
};

// ─────────────────────────────────────────────────────────
// 3. MAPA LEAFLET, CAPAS BASE Y AJUSTES
// ─────────────────────────────────────────────────────────
let map;
let contenedoresLayer;

// Catálogo de capas base disponibles
const BASEMAPS = {
  googleSat: L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    maxZoom: 21,
    attribution: 'Google Satélite',
  }),
  cartoDark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB Dark',
  }),
  cartoLight: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB Light',
  }),
  pnoa: L.tileLayer.wms('https://www.ign.es/wms-inspire/pnoa-ma', {
    layers: 'OI.OrthoimageCoverage',
    format: 'image/jpeg',
    transparent: false,
    version: '1.3.0',
    maxZoom: 20,
    attribution: '&copy; IGN España - PNOA',
  }),
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }),
};

let currentBasemap = 'googleSat';
let currentSaturation = 40;

function setSaturation(value) {
  currentSaturation = value;
  document.documentElement.style.setProperty('--map-saturation', `${value}%`);
  const badge = document.getElementById('val-saturation');
  if (badge) badge.textContent = `${value}%`;
  const slider = document.getElementById('slider-saturation');
  if (slider) slider.value = value;

  // Actualizar presets activos
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === parseInt(value));
  });
}

function switchBasemap(name) {
  if (!BASEMAPS[name] || name === currentBasemap) return;
  map.removeLayer(BASEMAPS[currentBasemap]);
  BASEMAPS[name].addTo(map);
  // Asegurar que la capa base quede debajo de los vectores
  BASEMAPS[name].bringToBack();
  currentBasemap = name;

  // Actualizar botones UI
  document.querySelectorAll('.basemap-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.layer === name);
  });
}

function initMap() {
  const [minLon, minLat, maxLon, maxLat] = CONFIG.MUNICIPIO_BBOX;

  // Saturación inicial al 40%
  setSaturation(40);

  map = L.map('map', {
    preferCanvas: true,
    zoomControl: true,
    attributionControl: false,
  });

  // Cargar Google Satélite por defecto
  BASEMAPS.googleSat.addTo(map);

  // Zoom inicial al municipio
  map.fitBounds([[minLat, minLon], [maxLat, maxLon]], {
    paddingTL: [20, 20],
    paddingBR: [20, 20],
  });

  // Capa individual directa para contenedores (SIN agrupación/cluster)
  contenedoresLayer = L.layerGroup().addTo(map);

  // Click en el mapa (fuera de elementos) → cerrar paneles y fichas
  map.on('click', () => {
    if (STATE.statsPanelOpen) closeStatsPanel();
    closeMobileSheet();
    closeSettingsModal();
  });
}

// ─────────────────────────────────────────────────────────
// 4. FETCH OGC API — Carga paginada
// ─────────────────────────────────────────────────────────
async function fetchAllFeatures(collectionId) {
  let allFeatures = [];
  let offset = 0;
  let totalExpected = null;

  do {
    const url = `${CONFIG.BASE_URL}/collections/${collectionId}/items?limit=${CONFIG.PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} al cargar ${collectionId}`);
    const data = await response.json();

    if (totalExpected === null) totalExpected = data.numberMatched;
    allFeatures = allFeatures.concat(data.features || []);
    offset += CONFIG.PAGE_SIZE;

    updateLoaderProgress(`Cargando contenedores: ${allFeatures.length} / ${totalExpected}`);
  } while (allFeatures.length < totalExpected && totalExpected !== null);

  return allFeatures;
}


async function fetchCollection(collectionId) {
  const url = `${CONFIG.BASE_URL}/collections/${collectionId}/items?limit=${CONFIG.PAGE_SIZE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} al cargar ${collectionId}`);
  return response.json();
}

// Sondeo de cambios: comprueba el timestamp del servidor
async function checkForUpdates() {
  try {
    const response = await fetch(`${CONFIG.BASE_URL}/collections`);
    if (!response.ok) return;
    const data = await response.json();
    const serverTs = data.timeStamp;

    if (STATE.lastTimestamp && serverTs !== STATE.lastTimestamp) {
      showToast('Cambios detectados — actualizando datos...', 'success');
      await reloadContenedores();
    }
    STATE.lastTimestamp = serverTs;
  } catch (_) {
    // Silencioso — no interrumpir al usuario
    updateLiveStatus('error');
  }
}

// ─────────────────────────────────────────────────────────
// 5. CARGA INICIAL DE CAPAS
// ─────────────────────────────────────────────────────────
async function loadAllLayers() {
  try {
    updateLoaderProgress('Cargando límite municipal...');

    // Municipio (1 feature)
    const municipioData = await fetchCollection(CONFIG.COLLECTIONS.municipio);
    if (municipioData.features?.length) {
      STATE.leafletLayers.municipio = L.geoJSON(municipioData, {
        style: {
          color: '#d97706',
          weight: 2.5,
          opacity: 0.7,
          fillOpacity: 0,
          dashArray: '6 4',
        },
      }).addTo(map);
    }

    updateLoaderProgress('Cargando y calculando polígonos de viario...');

    // Viario Cálculo — cargamos dentro del BBox y generamos polígonos según el ancho de calzada
    const [minLon, minLat, maxLon, maxLat] = CONFIG.MUNICIPIO_BBOX;
    const bboxParam = `&bbox=${minLon},${minLat},${maxLon},${maxLat}`;
    const viarioUrl = `${CONFIG.BASE_URL}/collections/${CONFIG.COLLECTIONS.viario}/items?limit=2000${bboxParam}`;
    const viarioResp = await fetch(viarioUrl);
    const viarioData = await viarioResp.json();

    if (viarioData.features?.length) {
      // Buffer con Turf.js para convertir cada eje en su polígono real de calzada
      const polygonFeatures = [];
      viarioData.features.forEach(feature => {
        try {
          const ancho = parseFloat(feature.properties?.AN_CALZ) || 6.0;
          const radiusKm = (ancho / 2.0) / 1000.0;
          if (typeof turf !== 'undefined' && turf.buffer) {
            const buf = turf.buffer(feature, radiusKm, { units: 'kilometers' });
            if (buf) {
              buf.properties = Object.assign({}, feature.properties, { _anchoCalc: ancho });
              polygonFeatures.push(buf);
              return;
            }
          }
        } catch (_) {}
        polygonFeatures.push(feature);
      });

      STATE.leafletLayers.viario = L.geoJSON({ type: 'FeatureCollection', features: polygonFeatures }, {
        style: (feature) => {
          return {
            color: '#94a3b8',
            weight: 1,
            opacity: 0.85,
            fillColor: '#475569',
            fillOpacity: 0.5,
          };
        },
        onEachFeature: (feature, layer) => {
          const p = feature.properties;
          const label = p?.nombre || p?.tipo_vialD || 'Vial';
          const ancho = p?._anchoCalc || p?.AN_CALZ || '—';
          layer.bindTooltip(`<strong>${label}</strong><br>Ancho calzada: ${ancho} m<br>${p?.claseD || ''}`, {
            sticky: true,
            className: 'glass-tooltip',
          });
          layer.on('mouseover', () => {
            layer.setStyle({ fillOpacity: 0.8, fillColor: '#d97706', color: '#f59e0b', weight: 1.5 });
          });
          layer.on('mouseout', () => {
            layer.setStyle({ fillOpacity: 0.5, fillColor: '#475569', color: '#94a3b8', weight: 1 });
          });
        },
      }).addTo(map);
    }

    updateLoaderProgress('Cargando zonas peatonales...');

    // Viario Peatonal (Polígonos nativos)
    const peatonalData = await fetchCollection(CONFIG.COLLECTIONS.peatonal);
    if (peatonalData.features?.length) {
      STATE.leafletLayers.peatonal = L.geoJSON(peatonalData, {
        style: {
          color: '#f59e0b',
          weight: 1.5,
          opacity: 0.9,
          fillColor: '#d97706',
          fillOpacity: 0.35,
        },
        onEachFeature: (feature, layer) => {
          const p = feature.properties;
          const nombre = p?.NOMBRE || 'Zona peatonal';
          const area = p?.AREA ? `<br>Superficie: ${p.AREA} m²` : '';
          layer.bindTooltip(`<strong>${nombre}</strong>${area}<br>Pavimento: ${p?.TIPO_PAV || '—'}`, {
            sticky: true,
            className: 'glass-tooltip',
          });
          layer.on('mouseover', () => {
            layer.setStyle({ fillOpacity: 0.65, weight: 2.5, color: '#fbbf24' });
          });
          layer.on('mouseout', () => {
            layer.setStyle({ fillOpacity: 0.35, weight: 1.5, color: '#f59e0b' });
          });
        },
      }).addTo(map);
    }

    updateLoaderProgress('Cargando contenedores y papeleras...');

    // Contenedores — carga paginada con filtro cliente por BBox del municipio
    const contFeatures = await fetchAllFeatures(CONFIG.COLLECTIONS.contenedores);
    // El OGC API no soporta bbox: filtramos en el cliente para excluir
    // los puntos con coordenadas erróneas fuera del término municipal.
    STATE.allFeatures = contFeatures.filter(f => {
      const coords = f.geometry?.coordinates;
      if (!coords) return false;
      const [lon, lat] = coords;
      return lon >= CONFIG.MUNICIPIO_BBOX[0] && lon <= CONFIG.MUNICIPIO_BBOX[2] &&
             lat >= CONFIG.MUNICIPIO_BBOX[1] && lat <= CONFIG.MUNICIPIO_BBOX[3];
    });


    // Obtener timestamp inicial
    const collectionsResp = await fetch(`${CONFIG.BASE_URL}/collections`);
    const collectionsData = await collectionsResp.json();
    STATE.lastTimestamp = collectionsData.timeStamp;

    // Renderizar
    applyFilters();
    populateFilterPills();
    renderCalendar();
    updateLiveStatus('online');
    hideLoader();

    // Iniciar sondeo de cambios
    STATE.pollTimer = setInterval(checkForUpdates, CONFIG.POLL_INTERVAL);
    updateLiveText('Datos en vivo · actualiza cada min.');

  } catch (err) {
    console.error('Error cargando capas:', err);
    updateLoaderProgress(`Error: ${err.message}`);
    updateLiveStatus('error');
    showToast(`Error de conexión: ${err.message}`, 'error');
  }
}

// Recargar solo contenedores (en actualizaciones)
async function reloadContenedores() {
  try {
    document.getElementById('btn-refresh').classList.add('spinning');
    const contFeatures = await fetchAllFeatures(CONFIG.COLLECTIONS.contenedores);
    STATE.allFeatures = contFeatures.filter(f => {
      const coords = f.geometry?.coordinates;
      if (!coords) return false;
      const [lon, lat] = coords;
      return lon >= CONFIG.MUNICIPIO_BBOX[0] && lon <= CONFIG.MUNICIPIO_BBOX[2] &&
             lat >= CONFIG.MUNICIPIO_BBOX[1] && lat <= CONFIG.MUNICIPIO_BBOX[3];
    });


    applyFilters();
    showToast(`Datos actualizados — ${STATE.filteredFeatures.length} elementos`, 'success');
    const now = new Date();
    updateLiveText(`Actualizado a las ${now.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})}`);
  } catch (err) {
    showToast('Error al recargar datos', 'error');
    updateLiveStatus('error');
  } finally {
    document.getElementById('btn-refresh').classList.remove('spinning');
  }
}

// ─────────────────────────────────────────────────────────
// 6. FILTROS Y RENDERIZADO DE CONTENEDORES
// ─────────────────────────────────────────────────────────
function applyFilters() {
  const { tipo, sistema, color, usuario, search } = STATE.activeFilters;

  STATE.filteredFeatures = STATE.allFeatures.filter(f => {
    const p = f.properties;
    if (tipo !== 'all' && p.Tipo?.trim() !== tipo) return false;
    if (sistema !== 'all' && p['Sistema de recogida']?.trim() !== sistema) return false;
    if (color !== 'all' && p.Color?.trim() !== color) return false;
    if (usuario !== 'all' && p.Usuario?.trim() !== usuario) return false;
    if (search) {
      const q = search.toLowerCase();
      const code = (p.Codigo || '').toLowerCase();
      const tipo2 = (p.Tipo || '').toLowerCase();
      const cont = (p.Contenedor || '').toLowerCase();
      if (!code.includes(q) && !tipo2.includes(q) && !cont.includes(q)) return false;
    }
    return true;
  });

  renderContenedoresLayer();
  updateKPIs();
  updateTipoChart();
  renderLista();
  syncKPIStates();
}

function renderContenedoresLayer() {
  // Renderizado individual directo sin agrupar (SIN clusters)
  contenedoresLayer.clearLayers();

  STATE.filteredFeatures.forEach(feature => {
    const coords = feature.geometry?.coordinates;
    if (!coords) return;

    const [lon, lat] = coords;
    const p = feature.properties;
    const color = getTipoColor(p.Tipo);
    const isSelected = STATE.selectedFeature?.properties?.fid === p.fid;

    const marker = L.circleMarker([lat, lon], {
      radius: isSelected ? 9 : 6.5,
      fillColor: color,
      color: isSelected ? '#d97706' : '#ffffff',
      weight: isSelected ? 2.5 : 1.5,
      fillOpacity: 0.95,
      feature: feature,
    });

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectFeature(feature, marker);
    });

    marker.on('mouseover', () => {
      marker.setRadius(9);
      marker.setStyle({ weight: 2.5, color: '#f59e0b' });
    });

    marker.on('mouseout', () => {
      if (STATE.selectedFeature?.properties?.fid !== p.fid) {
        marker.setRadius(6.5);
        marker.setStyle({ weight: 1.5, color: '#ffffff' });
      }
    });

    contenedoresLayer.addLayer(marker);
  });
}

// ─────────────────────────────────────────────────────────
// 7. KPIs Y GRÁFICOS
// ─────────────────────────────────────────────────────────
function countByTipo(features) {
  const counts = {};
  features.forEach(f => {
    const t = f.properties.Tipo?.trim() || '(Vacío)';
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

function updateKPIs() {
  const total = STATE.filteredFeatures.length;
  const counts = countByTipo(STATE.filteredFeatures);

  document.getElementById('kpi-total-val').textContent = total;
  document.getElementById('kpi-resto-val').textContent = counts['Resto'] || 0;
  document.getElementById('kpi-vidrio-val').textContent = counts['Vidrio'] || 0;
  document.getElementById('kpi-papel-val').textContent =
    (counts['Papel y carton'] || 0) + (counts['Papel y cartón'] || 0);
  document.getElementById('kpi-envases-val').textContent = counts['Envases'] || 0;
  document.getElementById('kpi-organico-val').textContent =
    (counts['(Resto y organico)'] || 0) + (counts['(Resto y orgánico)'] || 0);

  document.getElementById('lista-count').textContent = `${total} elemento${total !== 1 ? 's' : ''}`;
}

function syncKPIStates() {
  const activeTipo = STATE.activeFilters.tipo;
  document.querySelectorAll('.kpi-card').forEach(card => {
    const cardTipo = card.dataset.filterTipo;
    card.classList.toggle('active', cardTipo === activeTipo);
  });
}

function updateTipoChart() {
  const chart = document.getElementById('tipo-chart');
  const counts = countByTipo(STATE.allFeatures);
  const filteredCounts = countByTipo(STATE.filteredFeatures);
  const maxVal = Math.max(...Object.values(counts));
  const activeTipo = STATE.activeFilters.tipo;

  const tipoOrder = ['Resto', 'Vidrio', 'Papel y carton', 'Envases', '(Resto y organico)'];

  chart.innerHTML = tipoOrder.map(tipo => {
    const total = counts[tipo] || 0;
    if (total === 0) return '';
    const filtered = filteredCounts[tipo] || 0;
    const pct = maxVal > 0 ? (total / maxVal * 100) : 0;
    const filteredPct = maxVal > 0 ? (filtered / maxVal * 100) : 0;
    const color = getTipoColor(tipo);
    const label = getTipoLabel(tipo);
    const isActive = activeTipo === tipo;
    const isInactive = activeTipo !== 'all' && !isActive;

    return `
      <div class="tipo-chart-row ${isActive ? 'active' : ''} ${isInactive ? 'inactive' : ''}"
           data-tipo="${tipo}" role="button" tabindex="0" aria-label="Filtrar por ${label}">
        <div class="tipo-chart-label" title="${label}">${label}</div>
        <div class="tipo-chart-bar-wrap">
          <div class="tipo-chart-bar"
               style="width: ${filteredPct}%; background: ${color}; opacity: ${isInactive ? 0.3 : 1}">
          </div>
        </div>
        <div class="tipo-chart-count">${filtered}</div>
      </div>
    `;
  }).join('');

  // Eventos de click en barras
  chart.querySelectorAll('.tipo-chart-row').forEach(row => {
    row.addEventListener('click', () => {
      const tipo = row.dataset.tipo;
      STATE.activeFilters.tipo = STATE.activeFilters.tipo === tipo ? 'all' : tipo;
      applyFilters();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    });
  });
}

// ─────────────────────────────────────────────────────────
// 8. PILLS DE FILTROS DINÁMICOS
// ─────────────────────────────────────────────────────────
function populateFilterPills() {
  buildPills('filter-sistema', 'Sistema de recogida', 'sistema');
  buildPills('filter-color', 'Color', 'color');
  buildPills('filter-usuario', 'Usuario', 'usuario');
}

function buildPills(containerId, propKey, filterKey) {
  const values = [...new Set(
    STATE.allFeatures
      .map(f => f.properties[propKey]?.trim())
      .filter(v => v && v !== '()' && v !== '')
  )].sort();

  const container = document.getElementById(containerId);
  const existing = container.querySelector('.pill[data-value="all"]');
  container.innerHTML = '';

  const allPill = document.createElement('button');
  allPill.className = `pill ${STATE.activeFilters[filterKey] === 'all' ? 'active' : ''}`;
  allPill.dataset.value = 'all';
  allPill.textContent = 'Todos';
  allPill.addEventListener('click', () => { STATE.activeFilters[filterKey] = 'all'; applyFilters(); rebuildPillActiveState(containerId, filterKey); });
  container.appendChild(allPill);

  values.forEach(val => {
    const pill = document.createElement('button');
    pill.className = `pill ${STATE.activeFilters[filterKey] === val ? 'active' : ''}`;
    pill.dataset.value = val;
    pill.textContent = val.replace(/^\(/, '').replace(/\)$/, '');
    pill.addEventListener('click', () => {
      STATE.activeFilters[filterKey] = STATE.activeFilters[filterKey] === val ? 'all' : val;
      applyFilters();
      rebuildPillActiveState(containerId, filterKey);
    });
    container.appendChild(pill);
  });
}

function rebuildPillActiveState(containerId, filterKey) {
  const active = STATE.activeFilters[filterKey];
  document.querySelectorAll(`#${containerId} .pill`).forEach(pill => {
    pill.classList.toggle('active', pill.dataset.value === active);
  });
}

// ─────────────────────────────────────────────────────────
// 9. LISTA DE ELEMENTOS
// ─────────────────────────────────────────────────────────
function renderLista() {
  const container = document.getElementById('lista-items');
  const features = STATE.filteredFeatures;

  if (features.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:24px 0;color:var(--text-muted);font-size:12px;">
        Sin resultados con los filtros actuales
      </div>`;
    return;
  }

  // Renderizado virtual: mostramos los primeros 200, con lazy load
  const toShow = features.slice(0, 200);

  container.innerHTML = toShow.map((f, i) => {
    const p = f.properties;
    const color = getTipoColor(p.Tipo);
    const isActive = STATE.selectedFeature?.properties?.fid === p.fid;
    return `
      <div class="lista-item ${isActive ? 'active' : ''}" data-fid="${p.fid}" data-index="${i}">
        <div class="lista-item-dot" style="background:${color}"></div>
        <div class="lista-item-info">
          <div class="lista-item-code">${p.Codigo || '—'}</div>
          <div class="lista-item-tipo">${getTipoLabel(p.Tipo)}</div>
        </div>
        <div class="lista-item-badge">${(p['Sistema de recogida'] || '').replace(/[()]/g,'').trim() || '—'}</div>
      </div>`;
  }).join('');

  if (features.length > 200) {
    container.innerHTML += `
      <div style="text-align:center;padding:10px 0;color:var(--text-muted);font-size:11px;">
        Mostrando 200 de ${features.length} — usa los filtros para acotar
      </div>`;
  }

  // Eventos de click en lista
  container.querySelectorAll('.lista-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      const feature = features[idx];
      if (feature) {
        selectFeature(feature, null);
        // En móvil, ir al mapa
        if (STATE.isMobile) closeDashboard();
      }
    });
  });
}

function scrollListToActive() {
  if (!STATE.selectedFeature) return;
  const fid = STATE.selectedFeature.properties.fid;
  const item = document.querySelector(`.lista-item[data-fid="${fid}"]`);
  if (item && document.getElementById('dashboard').classList.contains('open') || !STATE.isMobile) {
    item?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ─────────────────────────────────────────────────────────
// 10. SELECCIÓN DE FEATURE — FICHA DETALLE
// ─────────────────────────────────────────────────────────
function selectFeature(feature, marker) {
  STATE.selectedFeature = feature;
  const p = feature.properties;
  const color = getTipoColor(p.Tipo);
  const isMobile = checkMobile();

  // Resaltar en lista
  document.querySelectorAll('.lista-item').forEach(el => {
    el.classList.toggle('active', el.dataset.fid == p.fid);
  });

  if (!isMobile) {
    // Desktop: panel derecho
    renderStatsPanel(feature);
    openStatsPanel();
  } else {
    // Móvil: cerrar dashboard para ver el mapa y abrir bottom sheet
    closeDashboard();
    closeSettingsModal();
    renderMobileSheet(feature);
    openMobileSheet('peek');
  }

  // Zoom al elemento
  if (feature.geometry?.coordinates) {
    const [lon, lat] = feature.geometry.coordinates;
    const targetLL = [lat, lon];

    if (isMobile) {
      map.setView(targetLL, Math.max(map.getZoom(), 17), { animate: true });
    } else {
      map.flyTo(targetLL, Math.max(map.getZoom(), 17), { animate: true, duration: 0.5 });
    }
  }

  scrollListToActive();
}

function renderStatsPanel(feature) {
  const p = feature.properties;
  const color = getTipoColor(p.Tipo);

  const content = document.getElementById('stats-content');
  content.innerHTML = `
    <div class="stats-section">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <div style="width:14px;height:14px;border-radius:50%;background:${color};flex-shrink:0"></div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary)">${p.Codigo || '—'}</div>
      </div>
      <div class="stats-tipo-badge" style="background:${color}20;border:1px solid ${color}50;color:${color}">
        ${getTipoLabel(p.Tipo)}
      </div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Identificación</div>
      ${statsRow('Código', p.Codigo)}
      ${statsRow('Tipo residuo', getTipoLabel(p.Tipo))}
      ${statsRow('Modelo', p.Contenedor)}
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Características</div>
      ${statsRow('Capacidad', p.Capacidad?.replace(/[()]/g, '').trim())}
      ${statsRow('Color', p.Color)}
      ${statsRow('Sistema de recogida', p['Sistema de recogida']?.replace(/[()]/g, '').trim())}
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Trazabilidad</div>
      ${statsRow('Técnico de campo', p.Usuario)}
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Ubicación</div>
      ${feature.geometry?.coordinates
        ? statsRow('Coordenadas', `${feature.geometry.coordinates[1].toFixed(6)}, ${feature.geometry.coordinates[0].toFixed(6)}`)
        : ''}
    </div>
  `;

  document.getElementById('stats-footer').style.display = 'flex';

  // Botón zoom
  document.getElementById('btn-zoom-elemento').onclick = () => {
    const [lon, lat] = feature.geometry.coordinates;
    map.flyTo([lat, lon], 19, { animate: true });
  };
}

function statsRow(label, value) {
  if (!value || value === 'null' || value === 'undefined') return '';
  return `
    <div class="stats-row">
      <div class="stats-label">${label}</div>
      <div class="stats-value">${value}</div>
    </div>`;
}

function renderMobileSheet(feature) {
  const p = feature.properties;
  const color = getTipoColor(p.Tipo);

  document.getElementById('mobile-stats-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0 12px">
      <div style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div style="font-size:15px;font-weight:700;color:var(--text-primary)">${p.Codigo || '—'}</div>
      <div class="stats-tipo-badge" style="background:${color}20;border:1px solid ${color}50;color:${color};font-size:11px;padding:3px 8px;border-radius:12px">
        ${getTipoLabel(p.Tipo)}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      ${mobileStatCard('Capacidad', p.Capacidad?.replace(/[()]/g,'').trim())}
      ${mobileStatCard('Color', p.Color)}
      ${mobileStatCard('Sistema', p['Sistema de recogida']?.replace(/[()]/g,'').trim())}
      ${mobileStatCard('Técnico', p.Usuario)}
    </div>
    <button class="btn-primary" style="width:100%;margin-top:4px" onclick="generateElementPDF()">
      <svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      Exportar ficha PDF
    </button>
  `;
}

function mobileStatCard(label, value) {
  if (!value) return '';
  return `
    <div style="padding:8px;background:rgba(255,255,255,0.04);border:1px solid var(--glass-border);border-radius:8px">
      <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">${label}</div>
      <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-top:2px">${value}</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────
// 11. CALENDARIO
// ─────────────────────────────────────────────────────────
function renderCalendar() {
  const date = STATE.calendarDate;
  const year = date.getFullYear();
  const month = date.getMonth();

  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const dayNames = ['Lu','Ma','Mi','Ju','Vi','Sa','Do'];

  document.getElementById('cal-month-title').textContent = `${monthNames[month]} ${year}`;

  const grid = document.getElementById('calendar-grid');
  const today = new Date();

  // Primer día del mes (ajustado a lunes=0)
  const firstDay = new Date(year, month, 1);
  let startDow = firstDay.getDay(); // 0=dom
  startDow = startDow === 0 ? 6 : startDow - 1; // convertir a lun=0

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = dayNames.map(d => `<div class="cal-day-header">${d}</div>`).join('');

  // Días vacíos al inicio
  for (let i = 0; i < startDow; i++) {
    html += `<div class="cal-day other-month"></div>`;
  }

  // Días del mes
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = (day === today.getDate() && month === today.getMonth() && year === today.getFullYear());
    html += `<div class="cal-day ${isToday ? 'today' : ''}">${day}</div>`;
  }

  grid.innerHTML = html;
}

// ─────────────────────────────────────────────────────────
// 12. EXPORTACIÓN PDF
// ─────────────────────────────────────────────────────────
function generateListaPDF() {
  const features = STATE.filteredFeatures;
  const fecha = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' });
  const now = new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });

  // Resumen por tipos
  const counts = countByTipo(features);
  const tiposList = Object.entries(counts)
    .sort((a,b) => b[1]-a[1])
    .map(([tipo, cnt]) => {
      const color = getTipoColor(tipo);
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px"></span>
          ${getTipoLabel(tipo)}
        </td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${cnt}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;color:#888">
          ${(cnt/features.length*100).toFixed(1)}%
        </td>
      </tr>`;
    }).join('');

  // Tabla de elementos (max 100 para PDF)
  const tableRows = features.slice(0, 100).map(f => {
    const p = f.properties;
    const color = getTipoColor(p.Tipo);
    return `<tr>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${p.Codigo || '—'}</td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px"></span>
        ${getTipoLabel(p.Tipo)}
      </td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${p.Contenedor || '—'}</td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${p.Capacidad?.replace(/[()]/g,'').trim() || '—'}</td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${p.Color || '—'}</td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${(p['Sistema de recogida'] || '').replace(/[()]/g,'').trim() || '—'}</td>
      <td style="padding:3px 6px;border-bottom:1px solid #f0f0f0;font-size:10px">${p.Usuario || '—'}</td>
    </tr>`;
  }).join('');

  const filtersDesc = buildFiltersDescription();

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Informe — Contenedores Archena</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    html, body { width: 277mm; font-family: 'Arial', sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; }
    h1 { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
    h2 { font-size: 12px; font-weight: 600; margin: 12px 0 6px; color: #555; }
    table { width: 100%; border-collapse: collapse; }
    thead th { padding: 5px 6px; background: #1a1a1a; color: #fff; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; text-align: left; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid #1a1a1a; }
    .kpis { display: flex; gap: 8px; margin-bottom: 12px; }
    .kpi-box { flex: 1; padding: 8px 10px; border: 1px solid #e5e5e5; border-radius: 6px; text-align: center; }
    .kpi-box .val { font-size: 18px; font-weight: 700; }
    .kpi-box .lbl { font-size: 8px; text-transform: uppercase; color: #888; letter-spacing: 0.05em; }
    .footer { margin-top: 10px; padding-top: 8px; border-top: 1px solid #e5e5e5; font-size: 9px; color: #888; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Inventario de Contenedores y Papeleras</h1>
      <div style="font-size:12px;color:#555">Archena, Murcia · ${fecha} · ${now}</div>
      ${filtersDesc ? `<div style="font-size:10px;color:#888;margin-top:4px">Filtros: ${filtersDesc}</div>` : ''}
    </div>
    <div style="text-align:right;font-size:10px;color:#888">
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.03em">TESELA</div>
      <div style="font-size:10px;letter-spacing:0.1em">estudio</div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi-box"><div class="val">${features.length}</div><div class="lbl">Total</div></div>
    ${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([t,c]) =>
      `<div class="kpi-box"><div class="val">${c}</div><div class="lbl">${getTipoLabel(t)}</div></div>`
    ).join('')}
  </div>

  <h2>Distribución por tipo</h2>
  <table style="width:300px;margin-bottom:14px">
    <thead><tr><th>Tipo</th><th style="text-align:right">N.º</th><th style="text-align:right">%</th></tr></thead>
    <tbody>${tiposList}</tbody>
  </table>

  <h2>Listado de elementos${features.length > 100 ? ` (primeros 100 de ${features.length})` : ''}</h2>
  <table>
    <thead>
      <tr>
        <th>Código</th><th>Tipo</th><th>Modelo</th><th>Capacidad</th><th>Color</th><th>Sistema</th><th>Técnico</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  <div class="footer">
    <span>Generado por Visor Cartográfico Archena · Tesela Estudio</span>
    <span>Datos en vivo desde OGC API · Mergin Maps</span>
  </div>
</body>
</html>`);
  win.document.close();
  setTimeout(() => { win.print(); }, 800);
}

function generateElementPDF() {
  const feature = STATE.selectedFeature;
  if (!feature) return;

  const p = feature.properties;
  const color = getTipoColor(p.Tipo);
  const fecha = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' });
  const coords = feature.geometry?.coordinates;

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ficha — ${p.Codigo || 'Contenedor'}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    html, body { width: 277mm; height: 190mm; overflow: hidden; font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; display: flex; }
    .layout { display: flex; width: 277mm; height: 190mm; gap: 8mm; }
    .col-map { flex: 3; position: relative; border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden; }
    .col-data { flex: 1; display: flex; flex-direction: column; gap: 8px; }
    #print-map { width: 100%; height: 100%; }
    .data-header { padding-bottom: 8px; border-bottom: 2px solid #1a1a1a; }
    h1 { font-size: 14px; margin: 0 0 2px; }
    .tipo-badge { display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:700;color:#fff;background:${color};margin-top:4px; }
    .data-section h2 { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin: 0 0 4px; }
    .data-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f5f5f5; }
    .data-label { font-size: 10px; color: #888; }
    .data-value { font-size: 10px; font-weight: 600; text-align: right; max-width: 55%; }
    .brand { font-size: 16px; font-weight: 700; letter-spacing: -0.03em; }
    .brand-sub { font-size: 9px; letter-spacing: 0.1em; color: #888; }
    .footer { margin-top: auto; padding-top: 6px; border-top: 1px solid #e5e5e5; font-size: 8px; color: #aaa; }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</head>
<body>
<div class="layout">
  <div class="col-map"><div id="print-map"></div></div>
  <div class="col-data">
    <div class="data-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><h1>${p.Codigo || '—'}</h1><span class="tipo-badge">${getTipoLabel(p.Tipo)}</span></div>
        <div style="text-align:right"><div class="brand">TESELA</div><div class="brand-sub">estudio</div></div>
      </div>
      <div style="font-size:9px;color:#888;margin-top:4px">${fecha}</div>
    </div>

    <div class="data-section">
      <h2>Identificación</h2>
      ${pdfRow('Código', p.Codigo)}
      ${pdfRow('Modelo', p.Contenedor)}
    </div>

    <div class="data-section">
      <h2>Características</h2>
      ${pdfRow('Capacidad', p.Capacidad?.replace(/[()]/g,'').trim())}
      ${pdfRow('Color', p.Color)}
      ${pdfRow('Sistema', (p['Sistema de recogida'] || '').replace(/[()]/g,'').trim())}
    </div>

    <div class="data-section">
      <h2>Trazabilidad</h2>
      ${pdfRow('Técnico', p.Usuario)}
      ${coords ? pdfRow('Coordenadas', `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`) : ''}
    </div>

    <div class="footer">Visor Cartográfico Archena · Tesela Estudio · OGC API Mergin Maps</div>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('print-map', { zoomControl: false, attributionControl: false, zoomAnimation: false, fadeAnimation: false });
  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 21 }).addTo(map);
  ${coords ? `
  const ll = [${coords[1]}, ${coords[0]}];
  map.setView(ll, 18);
  L.circleMarker(ll, { radius: 10, fillColor: '${color}', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
  ` : ''}
  window.addEventListener('load', () => {
    setTimeout(() => {
      map.invalidateSize();
      setTimeout(() => { window.print(); window.close(); }, 600);
    }, 1000);
  });
</script>
</body>
</html>`);
  win.document.close();
}

function pdfRow(label, value) {
  if (!value) return '';
  return `<div class="data-row"><span class="data-label">${label}</span><span class="data-value">${value}</span></div>`;
}

function buildFiltersDescription() {
  const parts = [];
  if (STATE.activeFilters.tipo !== 'all') parts.push(`Tipo: ${STATE.activeFilters.tipo}`);
  if (STATE.activeFilters.sistema !== 'all') parts.push(`Sistema: ${STATE.activeFilters.sistema.replace(/[()]/g,'')}`);
  if (STATE.activeFilters.color !== 'all') parts.push(`Color: ${STATE.activeFilters.color}`);
  if (STATE.activeFilters.usuario !== 'all') parts.push(`Técnico: ${STATE.activeFilters.usuario}`);
  if (STATE.activeFilters.search) parts.push(`Búsqueda: "${STATE.activeFilters.search}"`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────
// 13. CONTROL DE PANELES
// ─────────────────────────────────────────────────────────
function openStatsPanel() {
  document.getElementById('stats-panel').classList.add('open');
  document.getElementById('stats-panel').setAttribute('aria-hidden', 'false');
  STATE.statsPanelOpen = true;
}

function closeStatsPanel() {
  document.getElementById('stats-panel').classList.remove('open');
  document.getElementById('stats-panel').setAttribute('aria-hidden', 'true');
  STATE.statsPanelOpen = false;
  document.getElementById('stats-footer').style.display = 'none';
}

function openDashboard() {
  document.getElementById('dashboard').classList.add('open');
  STATE.dashboardOpen = true;
}

function closeDashboard() {
  document.getElementById('dashboard').classList.remove('open');
  STATE.dashboardOpen = false;
}

function openMobileSheet(state = 'open') {
  const sheet = document.getElementById('mobile-stats-sheet');
  sheet.classList.remove('hidden', 'peek', 'open');
  sheet.classList.add(state);
  sheet.setAttribute('aria-hidden', 'false');
}

function closeMobileSheet() {
  const sheet = document.getElementById('mobile-stats-sheet');
  if (sheet) {
    sheet.classList.remove('open', 'peek');
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }
}

// Control del panel modal de Ajustes de Mapa
function openSettingsModal() {
  const m = document.getElementById('settings-modal');
  if (m) {
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
  }
}

function closeSettingsModal() {
  const m = document.getElementById('settings-modal');
  if (m) {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  }
}

function toggleSettingsModal() {
  const m = document.getElementById('settings-modal');
  if (m && m.classList.contains('open')) {
    closeSettingsModal();
  } else {
    openSettingsModal();
  }
}

function bindSettingsControls() {
  const btnSettings = document.getElementById('btn-map-settings');
  const btnClose = document.getElementById('btn-close-settings');
  const slider = document.getElementById('slider-saturation');

  if (btnSettings) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsModal();
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSettingsModal();
    });
  }

  if (slider) {
    slider.addEventListener('input', (e) => {
      setSaturation(e.target.value);
    });
  }

  // Presets de saturación
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setSaturation(parseInt(btn.dataset.val));
    });
  });

  // Selector de capas base
  document.querySelectorAll('.basemap-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      switchBasemap(opt.dataset.layer);
    });
  });
}

function checkMobile() {
  return window.innerWidth <= 768;
}

// ─────────────────────────────────────────────────────────
// 14. CONTROL DE CAPAS (CHECKBOXES)
// ─────────────────────────────────────────────────────────
function bindLayerControls() {
  document.getElementById('layer-contenedores').addEventListener('change', (e) => {
    if (e.target.checked) map.addLayer(contenedoresLayer);
    else map.removeLayer(contenedoresLayer);
  });
  document.getElementById('layer-viario').addEventListener('change', (e) => {
    const l = STATE.leafletLayers.viario;
    if (!l) return;
    if (e.target.checked) map.addLayer(l); else map.removeLayer(l);
  });
  document.getElementById('layer-peatonal').addEventListener('change', (e) => {
    const l = STATE.leafletLayers.peatonal;
    if (!l) return;
    if (e.target.checked) map.addLayer(l); else map.removeLayer(l);
  });
  document.getElementById('layer-municipio').addEventListener('change', (e) => {
    const l = STATE.leafletLayers.municipio;
    if (!l) return;
    if (e.target.checked) map.addLayer(l); else map.removeLayer(l);
  });
}

// ─────────────────────────────────────────────────────────
// 15. TABS
// ─────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });
}

// ─────────────────────────────────────────────────────────
// 16. BOTTOM SHEET — GESTOS TÁCTILES
// ─────────────────────────────────────────────────────────
function bindBottomSheetGestures() {
  const sheet = document.getElementById('mobile-stats-sheet');
  let startY = 0;
  let startTransform = 0;

  sheet.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    const computed = getComputedStyle(sheet).transform;
    startTransform = 0;
  }, { passive: true });

  sheet.addEventListener('touchend', (e) => {
    const endY = e.changedTouches[0].clientY;
    const delta = endY - startY;
    if (delta > 80) {
      if (sheet.classList.contains('open')) openMobileSheet('peek');
      else closeMobileSheet();
    } else if (delta < -60) {
      openMobileSheet('open');
    }
  }, { passive: true });

  // Doble toque → maximizar
  let lastTap = 0;
  sheet.querySelector('.sheet-handle').addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 300) openMobileSheet('open');
    lastTap = now;
  });
}

// ─────────────────────────────────────────────────────────
// 17. ESTADO DE CONEXIÓN Y LOADER
// ─────────────────────────────────────────────────────────
function updateLiveStatus(status) {
  const dot = document.getElementById('live-dot');
  dot.className = 'live-dot';
  if (status === 'online') dot.classList.add('online');
  else if (status === 'error') dot.classList.add('error');
}

function updateLiveText(text) {
  document.getElementById('live-text').innerHTML = text;
}

function updateLoaderProgress(text) {
  const el = document.getElementById('loader-progress');
  if (el) el.textContent = text;
}

function hideLoader() {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 500);
}

// ─────────────────────────────────────────────────────────
// 18. TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4200);
}

// ─────────────────────────────────────────────────────────
// 19. BÚSQUEDA
// ─────────────────────────────────────────────────────────
function bindSearch() {
  const input = document.getElementById('search-input');
  const btnClear = document.getElementById('btn-clear-search');

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      STATE.activeFilters.search = input.value.trim();
      btnClear.style.display = STATE.activeFilters.search ? 'flex' : 'none';
      applyFilters();
    }, 250);
  });

  btnClear.addEventListener('click', () => {
    input.value = '';
    STATE.activeFilters.search = '';
    btnClear.style.display = 'none';
    applyFilters();
  });
}

// ─────────────────────────────────────────────────────────
// 20. LIMPIAR FILTROS
// ─────────────────────────────────────────────────────────
function clearAllFilters() {
  STATE.activeFilters = { tipo: 'all', sistema: 'all', color: 'all', usuario: 'all', search: '' };
  document.getElementById('search-input').value = '';
  document.getElementById('btn-clear-search').style.display = 'none';
  populateFilterPills();
  applyFilters();
}

// ─────────────────────────────────────────────────────────
// 21. EVENTOS KPI CARDS
// ─────────────────────────────────────────────────────────
function bindKPIs() {
  document.querySelectorAll('.kpi-card').forEach(card => {
    card.addEventListener('click', () => {
      const tipo = card.dataset.filterTipo;
      STATE.activeFilters.tipo = STATE.activeFilters.tipo === tipo ? 'all' : tipo;
      applyFilters();
    });
  });
}

// ─────────────────────────────────────────────────────────
// 22. INIT — PUNTO DE ENTRADA
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Detectar móvil
  STATE.isMobile = checkMobile();
  window.addEventListener('resize', () => { STATE.isMobile = checkMobile(); });

  // Iniciar mapa
  initMap();

  // Bindings UI
  bindTabs();
  bindSearch();
  bindKPIs();
  bindLayerControls();
  bindSettingsControls();
  bindBottomSheetGestures();

  // Botones
  document.getElementById('btn-close-dashboard').addEventListener('click', closeDashboard);
  document.getElementById('btn-close-stats').addEventListener('click', closeStatsPanel);
  const btnCloseMobile = document.getElementById('btn-close-mobile-sheet');
  if (btnCloseMobile) {
    btnCloseMobile.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileSheet();
    });
  }
  document.getElementById('fab-dashboard').addEventListener('click', () => {
    STATE.dashboardOpen ? closeDashboard() : openDashboard();
    STATE.dashboardOpen = !STATE.dashboardOpen;
  });
  document.getElementById('btn-refresh').addEventListener('click', reloadContenedores);
  document.getElementById('btn-clear-filters').addEventListener('click', clearAllFilters);
  document.getElementById('btn-pdf-lista').addEventListener('click', generateListaPDF);
  document.getElementById('btn-pdf-elemento').addEventListener('click', generateElementPDF);

  // Calendario
  document.getElementById('cal-prev').addEventListener('click', () => {
    STATE.calendarDate = new Date(STATE.calendarDate.getFullYear(), STATE.calendarDate.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    STATE.calendarDate = new Date(STATE.calendarDate.getFullYear(), STATE.calendarDate.getMonth() + 1, 1);
    renderCalendar();
  });

  // Cargar capas
  await loadAllLayers();
});
