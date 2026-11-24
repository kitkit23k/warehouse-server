// ============================================
// Grid Scale Module
// Each floor grid cell represents 10 m x 10 m in the real world.
// Rack/wall sizes are defined in real meters (rackWidthMeters etc.),
// and converted to Three.js scene units at the start of rebuildRacks().
// Existing drawing functions (buildRackUnit etc.) do not need any change.
// ============================================
const METERS_PER_CELL = 10;
function metersToUnits(meters) {
  return meters / METERS_PER_CELL;
}
function unitsToCellIndex(units) {
  return Math.round(units / metersToUnits(METERS_PER_CELL));
}
function cellIndexToUnits(cellIndex) {
  return cellIndex * metersToUnits(METERS_PER_CELL);
}

// Wall height: currently "a bit taller than the racks", i.e. rackHeight + WALL_HEIGHT_EXTRA.
// To change the wall height alone, edit the number below or config.warehouse.wallHeight directly.
const WALL_HEIGHT_EXTRA = 2;
// Number of grid cells a wall occupies (length x width): 40m x 40m / 10m per cell = 4 x 4 cells
const WALL_SIZE_CELLS = 4;

const initialConfig = {
  "theme": "dark",
  "autoRotate": false,
  "warehouse": {
    "floorLength": 24,
    "floorWidth": 8,
    "aisleWidth": -0.1,
    "rackRowCount": 3,
    "rackSpacing": 3.4,
    "rackWidth": 3,
    "rackDepth": 1,
    "rackWidthMeters": 30,
    "rackDepthMeters": 10,
    "rackHeight": 6,
    "wallHeight": 8,
    "levels": 2,
    "sideOffset": 0.3,
    "slotsPerLevel": 3,
    "columnSpacing": 3.4
  },
  walls: [],
  startPoint: { x: 0, z: -11 },
  racks: [
  { id: 'r1', col: 0, row: 0, levels: [2, 1], types: ['large', 'small'] },
  { id: 'r2', col: 0, row: 3, levels: [1, 2], types: ['large', 'large'] },
  { id: 'r3', col: 0, row: 6, levels: [1, 2], types: ['small', 'large'] },
  { id: 'r4', col: 3, row: 0, levels: [2, 2], types: ['large', 'small'] },
  { id: 'r5', col: 3, row: 3, levels: [0, 2], types: ['large', 'large'] },
  { id: 'r6', col: 3, row: 6, levels: [1, 2], types: ['large', 'small'] }
],
  goodsSizes: {
    small: { width: 0.823, depth: 0.411, height: 0.206 },
    medium: { width: 0.514, depth: 0.514, height: 0.514 },
    large: { width: 0.72, depth: 0.617, height: 1.029 }
  },
  colors: {
    floor: '#efe7d9',
    aisle: '#f8f4ec',
    gridMajor: '#0b6b6f',
    gridMinor: '#d9d0c2',
    upright: '#2b6ee7',
    beam: '#df533f',
    shelf: '#d8c9b2',
    lineUpright: '#0f3f88',
    lineBeam: '#8c2018',
    goods: '#d6a34f',
    goodsAlt: '#d98b3a'
  },
  camera: {
    x: 14,
    y: 11,
    z: 16,
    targetY: 2.5
  },
  light: {
    directionalIntensity: 0.92,
    hemisphereIntensity: 0.88
  }
};

const clone = (obj) => JSON.parse(JSON.stringify(obj));
let config = clone(initialConfig);
let currentTheme = config.theme;

/* ============================================
   Task assignment system - global state (declared early so that rebuildRacks()
   does not read uninitialized variables because of the TDZ when it runs in the middle of the script)
   ============================================ */
const workerPool = ['001', '002', '003'];
let workerRoundRobinIndex = 0;
let lockedWorkers = new Set(); // workers currently blocked from new tasks (unresolved mismatch)
let pendingGoods = [];   // {id, source, model, productionOrder}
let goodsRecords = [];   // {id, source, model, productionOrder, sizeCategory, uid}
let tasks = [];          // {taskId, goodsId, uid, source, model, productionOrder, sizeCategory,
                          //  targetRackId, targetLevel, targetSlot, assignedWorker, status, hadMismatch, mismatchCount}
let taskCompletionLog = [];
let score = 0;
var selectedOrderIds = new Set();   // orders ticked on the orders page
var batchCtx = null;                // current multi-order batch { orders, tasks, stage, plan }
var batchHighlights = [];           // rack highlight frames
var batchStopLabels = [];           // slot boxes, names, arrows pointing at slots
var BATCH_MAX_ORDERS = 6;           // maximum number of orders accepted at once
const workerScores = {};   // score of each worker
const workerFirstTry = {};
workerPool.forEach(w => { workerScores[w] = 0; });

// ============================================
// Order Queue Module
// ============================================
let orderQueue = []; // {orderId, uid, itemCode, itemType, receivedAt}
let pathLine = null;
let pathLabelSprite = null;
let destinationHighlightMesh = null;
let destinationHighlightTween = null;
let ghostGoodsMesh = null;
let ghostGoodsTween = null;

function showGhostGoods(rack, levelIndex, slotIndex, goodsType = 'large') {
  hideGhostGoods();
  const target = slotWorldPosition(rack, levelIndex, slotIndex);
  if (!target) return;
  const size = config.goodsSizes?.[goodsType] || config.goodsSizes?.large;

  const geo = new THREE.BoxGeometry(size.width, size.height, size.depth);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x00e5ff, transparent: true, opacity: 0.55, depthTest: false
  });
  ghostGoodsMesh = new THREE.Mesh(geo, mat);
  ghostGoodsMesh.position.set(target.x, target.y + size.height / 2 + 0.08, target.z);
  ghostGoodsMesh.renderOrder = 998;
  ghostGoodsMesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false })
  ));
  rackGroup.add(ghostGoodsMesh);

  ghostGoodsTween = new TWEEN.Tween(mat)
    .to({ opacity: 0.2 }, 600)
    .repeat(Infinity)
    .yoyo(true)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .start();
}

function hideGhostGoods() {
  if (ghostGoodsTween) { ghostGoodsTween.stop(); ghostGoodsTween = null; }
  if (ghostGoodsMesh) {
    rackGroup.remove(ghostGoodsMesh);
    ghostGoodsMesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    ghostGoodsMesh = null;
  }
}

const root = document.documentElement;
root.setAttribute('data-theme', currentTheme);

const host = document.getElementById('scene');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xefe7d9);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, config.camera.targetY, 0);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8c7a5e, config.light.hemisphereIntensity);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, config.light.directionalIntensity);
dir.position.set(12, 18, 10);
dir.castShadow = true;
dir.shadow.mapSize.width = 2048;
dir.shadow.mapSize.height = 2048;
dir.shadow.camera.near = 0.5;
dir.shadow.camera.far = 80;
dir.shadow.camera.left = -25;
dir.shadow.camera.right = 25;
dir.shadow.camera.top = 25;
dir.shadow.camera.bottom = -25;
scene.add(dir);

let rackGroup = new THREE.Group();
scene.add(rackGroup);
let floorMesh = null;
let aisleMesh = null;
let gridHelper = null;
let goodsArray = [];
let rackHitboxes = [];
let slotHitboxes = [];
let wallHitboxes = [];
let wallMeshes = [];
let startPointMarker = null;
let selectedRackId = null;
let rackHighlightMesh = null;
let rackHighlightTween = null;
let slotHighlightMesh = null;
let slotHighlightTween = null;
let selectedSlotLevel = null;
let selectedSlotIndex = null;
let rackPositions = {};
let removalLog = [];
let startPointGridOutline = null;
let placementMode = null;
let placementPreviewMesh = null;
let selectedWallId = null;
let wallHighlightMesh = null;
let wallHighlightTween = null;

function fitRenderer() {
  const w = host.clientWidth || 1000;
  const h = host.clientHeight || 700;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function hex(v, fallback) {
  try {
    return new THREE.Color(v);
  } catch (e) {
    return new THREE.Color(fallback);
  }
}

function makeEdges(geometry, material, position) {
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), material);
  edges.position.copy(position);
  return edges;
}

function makeRackId() {
  return 'r' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// ============================================
// Rack zone naming
//  1. Racks whose edges touch and form one row belong to the same zone (a single rack is its own zone).
//  2. Zone names follow the order of the rows placed side by side: first decide along which direction the racks form rows (front-back or left-right),
//     then number the rows from one side to the other (by default A starts from the right of the default view, then B, C... to the left).
//     Only the position of the rows matters, not their length or extent, so adjacent rows always get consecutive zone names.
//  3. Within one zone, the rack closest to the start point is No. 1, then numbered by distance: zone B -> B1, B2, B3...
//  Full slot name: B2 (2-1) = zone B, 2nd rack, level 2, slot 1
// ============================================
const ZONE_LINK_GAP = 0.3;    // two racks whose edge distance is within this value (scene units) count as "connected"
const ZONE_ALIGN_TOL = 0.3;   // the perpendicular offset must be within this value to count as "in the same line"
const ZONE_START_FROM_RIGHT = true;   // true: A starts from the right of the default view; false: start from the left
let rackNamingCache = { sig: '', map: {} };

function zoneLetters(index) {
  let s = '';
  let i = Math.floor(index);
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

function getRackWorldPos(rack) {
  if (typeof rackPositions !== 'undefined' && rackPositions[rack.id]) return rackPositions[rack.id];
  if (Number.isFinite(Number(rack.worldX)) && Number.isFinite(Number(rack.worldZ))) {
    return { x: Number(rack.worldX), z: Number(rack.worldZ) };
  }
  return cellToWorld(Number(rack.col) || 0, Number(rack.row) || 0);
}

// "Right of the screen" of the default view (config.camera) (unit vector on the floor plane)
function getZoneViewAxes() {
  const cam = config.camera || {};
  let cx = Number(cam.x), cz = Number(cam.z);
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || (cx === 0 && cz === 0)) { cx = 14; cz = 16; }
  const len = Math.hypot(cx, cz);
  return { rx: cz / len, rz: -cx / len };
}

function computeRackNaming() {
  const racks = config.racks || [];
  const w = config.warehouse.rackWidth;
  const d = config.warehouse.rackDepth;
  const start = getActiveStartPoint();
  const ax = getZoneViewAxes();
  const pos = racks.map(getRackWorldPos);
  const sig = [w, d, start.x, start.z, ax.rx.toFixed(4), ax.rz.toFixed(4), ZONE_START_FROM_RIGHT].join(',') + '|' +
    racks.map((r, i) => r.id + ':' + pos[i].x.toFixed(3) + ',' + pos[i].z.toFixed(3)).join(';');
  if (rackNamingCache.sig === sig) return rackNamingCache.map;

  const parent = racks.map((_, i) => i);
  const find = i => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
    let linksAlongX = 0;   // number of rack pairs connected left-right
    let linksAlongZ = 0;   // number of rack pairs connected front-back
  for (let i = 0; i < racks.length; i++) {    for (let j = i + 1; j < racks.length; j++) {
      const dx = Math.abs(pos[i].x - pos[j].x);
      const dz = Math.abs(pos[i].z - pos[j].z);
            const sideBySide = dz <= ZONE_ALIGN_TOL && dx <= w + ZONE_LINK_GAP;   // connected left-right
            const frontBack = dx <= ZONE_ALIGN_TOL && dz <= d + ZONE_LINK_GAP;    // connected front-back
      if (sideBySide) linksAlongX++;
      if (frontBack) linksAlongZ++;
      if (sideBySide || frontBack) parent[find(i)] = find(j);
    }
  }

    // Along which direction the racks mostly form rows: front-back (z) or left-right (x)
  const stripsRunAlongZ = linksAlongZ >= linksAlongX;
    // Row ordering direction = the axis perpendicular to the rows; the sign makes the "right of the screen" value larger
  const crossOf = i => (stripsRunAlongZ
    ? pos[i].x * (ax.rx >= 0 ? 1 : -1)
    : pos[i].z * (ax.rz >= 0 ? 1 : -1));
  const alongOf = i => (stripsRunAlongZ ? pos[i].z : pos[i].x);

  const groups = {};
  racks.forEach((_, i) => {
    const root = find(i);
    (groups[root] = groups[root] || []).push(i);
  });
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const list = Object.values(groups).map(idxs => ({
    idxs,
    cross: mean(idxs.map(crossOf)),
    along: mean(idxs.map(alongOf))
  }));
    const dir = ZONE_START_FROM_RIGHT ? -1 : 1;   // -1: larger cross value first (right side first)
  list.sort((a, b) => (Math.abs(a.cross - b.cross) > 0.01 ? dir * (a.cross - b.cross) : a.along - b.along));

  const map = {};
  list.forEach((g, gi) => {
    const letter = zoneLetters(gi);
    const sorted = g.idxs.slice().sort((a, b) => {
      const da = Math.hypot(pos[a].x - start.x, pos[a].z - start.z);
      const db = Math.hypot(pos[b].x - start.x, pos[b].z - start.z);
      if (Math.abs(da - db) > 0.001) return da - db;
      return pos[a].x - pos[b].x || pos[a].z - pos[b].z;
    });
    sorted.forEach((ri, n) => {
      map[racks[ri].id] = { zone: letter, no: n + 1, code: letter + (n + 1) };
    });
  });
  rackNamingCache = { sig, map };
  return map;
}

// Rack name, e.g. B2 (2nd rack of zone B)
function rackZoneLabel(rackId) {
  const info = computeRackNaming()[rackId];
  return info ? info.code : '?';
}

// Slot name, e.g. B2 (2-1) = rack B2, level 2, slot 1
function slotLabel(rackId, levelIndex, slotIndex) {
    return rackZoneLabel(rackId) + ' (' + (levelIndex + 1) + '-' + (slotIndex + 1) + ')';
}

function sanitizeGoodsSizes(rawSizes) {
  const defaults = clone(initialConfig.goodsSizes);
  const source = rawSizes && typeof rawSizes === 'object' ? rawSizes : {};
  const out = {};
  ['small', 'medium', 'large'].forEach((key) => {
    const src = source[key] || defaults[key];
    out[key] = {
      width: Math.max(0.05, Number(src.width) || defaults[key].width),
      depth: Math.max(0.05, Number(src.depth) || defaults[key].depth),
      height: Math.max(0.05, Number(src.height) || defaults[key].height)
    };
  });
  return out;
}

function sanitizeRackList(rawRacks, warehouse) {
  const maxLevels = Math.max(1, Math.floor(warehouse.levels || 1));
  const maxSlots = Math.max(1, Math.floor(warehouse.slotsPerLevel || 3));
  const list = Array.isArray(rawRacks) ? rawRacks : [];

  return list
    .filter(r => r && Number.isFinite(Number(r.col)) && Number.isFinite(Number(r.row)))
    .map(r => {
      const levelList = Array.isArray(r.levels) ? r.levels : [];
      const typeList = Array.isArray(r.types) ? r.types : [];
      const cleanLevels = [];
      const cleanTypes = [];

      for (let i = 0; i < maxLevels; i++) {
        const value = Number(levelList[i] ?? 0);
        cleanLevels.push(
          Math.max(0, Math.min(maxSlots, Math.floor(Number.isFinite(value) ? value : 0)))
        );
        cleanTypes.push(
          typeList[i] === 'small'
            ? 'small'
            : (typeList[i] === 'medium' ? 'medium' : 'large')
        );
      }

      return {
        id: r.id || makeRackId(),
        col: Math.floor(Number(r.col) || 0),
        row: Math.max(0, Math.floor(Number(r.row) || 0)),
        worldX: Number.isFinite(Number(r.worldX)) ? Number(r.worldX) : undefined,
        worldZ: Number.isFinite(Number(r.worldZ)) ? Number(r.worldZ) : undefined,
        levels: cleanLevels,
        types: cleanTypes,
        occupancy: Array.isArray(r.occupancy) ? r.occupancy : null,
        slotGoods: Array.isArray(r.slotGoods) ? r.slotGoods : null,
        slotTypes: Array.isArray(r.slotTypes) ? r.slotTypes : null
      };
    });
}

function ensureOccupancy(rack, maxSlots) {
  if (!Array.isArray(rack.occupancy)) rack.occupancy = [];
  const maxLevels = config.warehouse.levels;
  for (let i = 0; i < maxLevels; i++) {
    if (!Array.isArray(rack.occupancy[i])) {
      const filled = rack.levels?.[i] || 0;
      rack.occupancy[i] = Array.from({ length: maxSlots }, (_, s) => s < filled);
    }
  }
  return rack.occupancy;
}

function ensureSlotGoods(rack, maxSlots) {
  if (!Array.isArray(rack.slotGoods)) rack.slotGoods = [];
  const maxLevels = config.warehouse.levels;
  for (let i = 0; i < maxLevels; i++) {
    if (!Array.isArray(rack.slotGoods[i])) {
      rack.slotGoods[i] = Array.from({ length: maxSlots }, () => null);
    }
  }
  return rack.slotGoods;
}

function ensureSlotTypes(rack, maxSlots) {
  if (!Array.isArray(rack.slotTypes)) rack.slotTypes = [];
  const maxLevels = config.warehouse.levels;
  for (let i = 0; i < maxLevels; i++) {
    if (!Array.isArray(rack.slotTypes[i])) {
      rack.slotTypes[i] = Array.from({ length: maxSlots }, () => null);
    }
  }
  return rack.slotTypes;
}

function migrateActiveRacksToRacks(activeRacks, warehouse) {
  const levels = Math.max(1, Math.floor(warehouse.levels || 1));
  const maxSlots = Math.max(1, Math.floor(warehouse.slotsPerLevel || 3));
  const defaultLevels = Array(levels).fill(maxSlots);
  const defaultTypes = Array(levels).fill('large');
  const rackCount = Math.max(1, Math.floor(warehouse.rackRowCount || warehouse.rackCountPerSide || 1));
  const out = [];

  const sideToCol = { left: 0, right: 1 };

  ['left', 'right'].forEach(side => {
    const rackMap = (activeRacks && activeRacks[side]) || {};
    for (let rackIndex = 1; rackIndex <= rackCount; rackIndex++) {
      const custom = rackMap[rackIndex] || rackMap[String(rackIndex)] || {};
      out.push({
        id: makeRackId(),
        col: sideToCol[side],
        row: rackIndex - 1,
        levels: custom.levels || [...defaultLevels],
        types: custom.types || [...defaultTypes]
      });
    }
  });

  return out;
}

function migrateOldSideRacks(rawRacks, warehouse) {
  const sideToCol = { left: 0, right: 1 };
  return (Array.isArray(rawRacks) ? rawRacks : [])
    .filter(r => r && (r.side === 'left' || r.side === 'right'))
    .map(r => {
      const bay = Math.max(0, Math.floor(Number(r.bay) || 0));
      const baseCol = sideToCol[r.side];
      const col = r.side === 'left' ? (baseCol - bay) : (baseCol + bay);
      return {
        id: r.id || makeRackId(),
        col,
        row: Math.max(0, Math.floor(Number(r.row) || 0)),
        levels: r.levels,
        types: r.types
      };
    });
}

function buildBase() {
  if (floorMesh) rackGroup.remove(floorMesh);
  if (aisleMesh) rackGroup.remove(aisleMesh);
  if (gridHelper) rackGroup.remove(gridHelper);

  const c = config.warehouse;

  const floorGeo = new THREE.BoxGeometry(c.floorLength, 0.12, c.floorLength);
  const floorMat = new THREE.MeshStandardMaterial({ color: hex(config.colors.floor, '#efe7d9'), roughness: 0.96, metalness: 0.02 });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.position.y = -0.06;
  floorMesh.receiveShadow = true;
  rackGroup.add(floorMesh);

  const aisleGeo = new THREE.BoxGeometry(c.aisleWidth, 0.014, c.floorLength * 0.96);
  const aisleMat = new THREE.MeshStandardMaterial({ color: hex(config.colors.aisle, '#f8f4ec'), roughness: 1 });
  aisleMesh = new THREE.Mesh(aisleGeo, aisleMat);
  aisleMesh.position.y = 0.01;
  aisleMesh.receiveShadow = true;
  rackGroup.add(aisleMesh);

  gridHelper = new THREE.GridHelper(
    c.floorLength,
    Math.max(8, Math.round(c.floorLength)),
    hex(config.colors.gridMajor, '#0b6b6f'),
    hex(config.colors.gridMinor, '#d9d0c2')
  );
  gridHelper.position.y = 0.02;
  gridHelper.rotation.y = Math.PI / 2;
  rackGroup.add(gridHelper);
}

function addShelfGoods(centerX, centerZ, levelY, count, goodsType, c, rackId, rowPosIndex, rowTotal, levelIndex, rack) {
  const maxSlots = Math.max(1, Math.floor(c.slotsPerLevel || 3));
  const goodsCount = Math.max(0, Math.min(maxSlots, Math.floor(count || 0)));

    // Draw by which slots actually hold goods; fall back to the "first N slots" only when there is no occupancy data
  let occRow = null;
  if (rack) {
    ensureOccupancy(rack, maxSlots);
    occRow = rack.occupancy[levelIndex] || null;
  }
  const hasGoodsAt = (s) => occRow ? occRow[s] === true : s < goodsCount;
  let anyGoods = false;
  for (let s = 0; s < maxSlots; s++) { if (hasGoodsAt(s)) { anyGoods = true; break; } }
  if (!anyGoods) return;

  const goodsMatA = new THREE.MeshStandardMaterial({ color: hex(config.colors.goods, '#d6a34f'), roughness: 0.72, metalness: 0.08 });
  const goodsMatB = new THREE.MeshStandardMaterial({ color: hex(config.colors.goodsAlt, '#d98b3a'), roughness: 0.76, metalness: 0.05 });

  const usableWidth = c.rackWidth - 0.3;
  const slotWidth = usableWidth / maxSlots;
  const fallbackSize = { width: 1.2, depth: 1.0, height: 0.8 };
  const startX = centerX - usableWidth / 2 + slotWidth / 2;

  for (let s = 0; s < maxSlots; s++) {
    if (!hasGoodsAt(s)) continue;

        // Goods type: slot record -> goods data -> default type of the level
    let slotType = goodsType;
    const savedType = rack && rack.slotTypes && rack.slotTypes[levelIndex] ? rack.slotTypes[levelIndex][s] : null;
    if (savedType && config.goodsSizes?.[savedType]) {
      slotType = savedType;
    } else {
      const gid = (rack && rack.slotGoods && rack.slotGoods[levelIndex]) ? rack.slotGoods[levelIndex][s] : null;
      const rec = gid ? goodsRecords.find(g => g.id === gid) : null;
      if (rec && config.goodsSizes?.[rec.sizeCategory]) slotType = rec.sizeCategory;
    }
    const selectedSize = config.goodsSizes?.[slotType] || config.goodsSizes?.large || fallbackSize;
    const itemWidth = selectedSize.width;
    const itemDepth = selectedSize.depth;
    const itemHeight = selectedSize.height;

    const boxGeo = new THREE.BoxGeometry(itemWidth, itemHeight, itemDepth);
    const box = new THREE.Mesh(boxGeo, (s % 2 === 0 ? goodsMatA : goodsMatB).clone());
    const x = startX + s * slotWidth;
    const y = levelY + itemHeight / 2 + 0.08;
    box.position.set(x, y, centerZ);
    box.castShadow = true;
    box.receiveShadow = true;
    box.userData.rackId = rackId;
    box.userData.rowPosIndex = rowPosIndex;
    box.userData.rowTotal = rowTotal;
    box.userData.levelIndex = levelIndex;
    box.userData.slotIndex = s;
    box.userData.goodsType = slotType;
    box.userData.goodsId = (rack && rack.slotGoods && rack.slotGoods[levelIndex]) ? rack.slotGoods[levelIndex][s] : null;
    rackGroup.add(box);
    goodsArray.push(box);
  }
}

function addSlotHitboxes(rack, rowPosIndex, rowTotal) {
  const c = config.warehouse;
  const maxSlots = Math.max(1, Math.floor(c.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(c.levels || 1));
  const largeSize = config.goodsSizes?.large || { width: 1.2, depth: 1.0, height: 0.8 };

  for (let lvl = 0; lvl < maxLevels; lvl++) {
    for (let s = 0; s < maxSlots; s++) {
      const pos = slotWorldPosition(rack, lvl, s);
      if (!pos) continue;
      const geo = new THREE.BoxGeometry(largeSize.width, largeSize.height, largeSize.depth);
      const mat = new THREE.MeshBasicMaterial({ visible: false });
      const hitbox = new THREE.Mesh(geo, mat);
      hitbox.position.set(pos.x, pos.y + largeSize.height / 2, pos.z);
      hitbox.userData.rackId = rack.id;
      hitbox.userData.levelIndex = lvl;
      hitbox.userData.slotIndex = s;
      hitbox.userData.isSlotHitbox = true;
      hitbox.userData.rowPosIndex = rowPosIndex;
      hitbox.userData.rowTotal = rowTotal;
      rackGroup.add(hitbox);
      slotHitboxes.push(hitbox);
    }
  }
}

function slotWorldPosition(rack, levelIndex, slotIndex) {
  const pos = rackPositions[rack.id];
  if (!pos) return null;
  const c = config.warehouse;
  const maxSlots = Math.max(1, Math.floor(c.slotsPerLevel || 3));
  const usableWidth = c.rackWidth - 0.3;
  const slotWidth = usableWidth / maxSlots;
  const startX = pos.x - usableWidth / 2 + slotWidth / 2;
  const step = c.rackHeight / c.levels;
  const y = levelIndex * step + 0.08;
  const x = startX + slotIndex * slotWidth;
  return { x, y, z: pos.z };
}

function removeGoodsAnimation(box, exitDirection = { x: 1, z: 0 }) {
  const startPos = { x: box.position.x, y: box.position.y, z: box.position.z };
  const moveOutDistance = 1.5;

  box.material.transparent = true;

  const moveOutTween = new TWEEN.Tween(box.position)
    .to({
      x: startPos.x + exitDirection.x * moveOutDistance,
      z: startPos.z + exitDirection.z * moveOutDistance
    }, 600)
    .easing(TWEEN.Easing.Quadratic.Out);

  const riseUpTween = new TWEEN.Tween(box.position)
    .to({ y: startPos.y + 3 }, 700)
    .easing(TWEEN.Easing.Quadratic.In);

  const fadeOutTween = new TWEEN.Tween(box.material)
    .to({ opacity: 0 }, 700)
    .easing(TWEEN.Easing.Quadratic.In)
    .onComplete(() => {
      rackGroup.remove(box);
      goodsArray = goodsArray.filter(g => g !== box);
      box.geometry.dispose();
      box.material.dispose();
    });

  moveOutTween.chain(riseUpTween, fadeOutTween);
  moveOutTween.start();
}

function placeGoodsAnimation(rack, levelIndex, slotIndex, goodsType, rowPosIndex, rowTotal, goodsId) {
  const target = slotWorldPosition(rack, levelIndex, slotIndex);
  if (!target) return;

  const selectedSize = config.goodsSizes?.[goodsType] || config.goodsSizes?.large || { width: 1.2, depth: 1.0, height: 0.8 };
  const itemWidth = selectedSize.width;
  const itemDepth = selectedSize.depth;
  const itemHeight = selectedSize.height;

  const goodsMatA = new THREE.MeshStandardMaterial({ color: hex(config.colors.goods, '#d6a34f'), roughness: 0.72, metalness: 0.08, transparent: true, opacity: 0 });
  const boxGeo = new THREE.BoxGeometry(itemWidth, itemHeight, itemDepth);
  const box = new THREE.Mesh(boxGeo, goodsMatA);

  const finalY = target.y + itemHeight / 2 + 0.08;
  box.position.set(target.x, finalY + 3, target.z);
  box.castShadow = true;
  box.receiveShadow = true;
  box.userData.rackId = rack.id;
  box.userData.rowPosIndex = rowPosIndex;
  box.userData.rowTotal = rowTotal;
  box.userData.levelIndex = levelIndex;
  box.userData.slotIndex = slotIndex;
  box.userData.goodsType = goodsType;
  box.userData.goodsId = goodsId || null;
  rackGroup.add(box);
  goodsArray.push(box);

  const fadeInTween = new TWEEN.Tween(box.material).to({ opacity: 1 }, 300).easing(TWEEN.Easing.Quadratic.Out);
  const dropTween = new TWEEN.Tween(box.position).to({ y: finalY }, 650).easing(TWEEN.Easing.Bounce.Out);

  fadeInTween.start();
  dropTween.start();
}

function recordRemoval(box) {
  const rack = config.racks.find(r => r.id === box.userData.rackId);
  if (!rack) return;

  const levelIdx = box.userData.levelIndex ?? 0;
  const slotIdx = box.userData.slotIndex ?? 0;
  if (rack.levels[levelIdx] > 0) {
    rack.levels[levelIdx] -= 1;
  }
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  ensureSlotGoods(rack, maxSlots);
  if (rack.occupancy[levelIdx]) rack.occupancy[levelIdx][slotIdx] = false;
  if (rack.slotGoods[levelIdx]) rack.slotGoods[levelIdx][slotIdx] = null;
  if (rack.slotTypes && rack.slotTypes[levelIdx]) rack.slotTypes[levelIdx][slotIdx] = null;

  removalLog.unshift({
    time: new Date(),
    rackId: rack.id,
    row: rack.row,
    col: rack.col,
    goodsType: box.userData.goodsType || 'unknown'
  });

  if (removalLog.length > 200) removalLog.pop();

  syncJsonFromConfig();
}

function buildRackUnit(centerX, centerZ, rack, rowPosIndex, rowTotal) {
  const c = config.warehouse;
  rackPositions[rack.id] = { x: centerX, z: centerZ };

  const postSize = 0.12;
  const beamHeight = 0.12;
  const shelfHeight = 0.12;

  const postMat = new THREE.MeshStandardMaterial({ color: hex(config.colors.upright, '#1a57b0'), metalness: 0.28, roughness: 0.42 });
  const beamMat = new THREE.MeshStandardMaterial({ color: hex(config.colors.beam, '#c83b2b'), metalness: 0.2, roughness: 0.46 });
  const shelfMat = new THREE.MeshStandardMaterial({ color: hex(config.colors.shelf, '#d8c9b2'), roughness: 0.88 });
  const uprightLineMat = new THREE.LineBasicMaterial({ color: hex(config.colors.lineUpright, '#0f3f88') });
  const beamLineMat = new THREE.LineBasicMaterial({ color: hex(config.colors.lineBeam, '#8c2018') });

  const positions = [
    [centerX - c.rackWidth / 2, centerZ - c.rackDepth / 2],
    [centerX + c.rackWidth / 2, centerZ - c.rackDepth / 2],
    [centerX - c.rackWidth / 2, centerZ + c.rackDepth / 2],
    [centerX + c.rackWidth / 2, centerZ + c.rackDepth / 2]
  ];

  positions.forEach(([px, pz]) => {
    const geo = new THREE.BoxGeometry(postSize, c.rackHeight, postSize);
    const mesh = new THREE.Mesh(geo, postMat);
    mesh.position.set(px, c.rackHeight / 2, pz);
    mesh.castShadow = true;
    rackGroup.add(mesh);
    rackGroup.add(makeEdges(geo, uprightLineMat, mesh.position));
  });

  const step = c.rackHeight / c.levels;

  for (let i = 0; i <= c.levels; i++) {
    const y = i * step;
    const beamGeo = new THREE.BoxGeometry(c.rackWidth, beamHeight, beamHeight);

    const front = new THREE.Mesh(beamGeo, beamMat);
    front.position.set(centerX, y, centerZ - c.rackDepth / 2);
    front.castShadow = true;
    rackGroup.add(front);
    rackGroup.add(makeEdges(beamGeo, beamLineMat, front.position));

    const back = new THREE.Mesh(beamGeo, beamMat);
    back.position.set(centerX, y, centerZ + c.rackDepth / 2);
    back.castShadow = true;
    rackGroup.add(back);
    rackGroup.add(makeEdges(beamGeo, beamLineMat, back.position));

    const shelfGeo = new THREE.BoxGeometry(c.rackWidth - 0.02, shelfHeight, c.rackDepth - 0.02);
    const shelf = new THREE.Mesh(shelfGeo, shelfMat);
    shelf.position.set(centerX, y + 0.08, centerZ);
    shelf.castShadow = true;
    shelf.receiveShadow = true;
    rackGroup.add(shelf);

    if (i < c.levels) {
      const goodsCount = rack.levels?.[i] || 0;
      const goodsType = rack.types?.[i] || 'large';
      addShelfGoods(centerX, centerZ, y + 0.08, goodsCount, goodsType, c, rack.id, rowPosIndex, rowTotal, i, rack);
    }
  }

  const hitboxGeo = new THREE.BoxGeometry(c.rackWidth + 0.3, c.rackHeight + 0.3, c.rackDepth + 0.3);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(centerX, c.rackHeight / 2, centerZ);
  hitbox.userData.rackId = rack.id;
  hitbox.userData.isRackHitbox = true;
  rackGroup.add(hitbox);
  rackHitboxes.push(hitbox);

  addSlotHitboxes(rack, rowPosIndex, rowTotal);
}

// ============================================
// Wall Module
// A wall always occupies WALL_SIZE_CELLS x WALL_SIZE_CELLS cells (default 4x4 cells = 40m x 40m).
// Each config.walls entry records a "cell coordinate" (cellX, cellZ), the center cell of the wall.
// ============================================
function cellSizeInUnits() {
  return metersToUnits(METERS_PER_CELL);
}

function cellToWorld(cellX, cellZ) {
  const size = cellSizeInUnits();
  return { x: cellX * size, z: cellZ * size };
}

function worldToNearestCell(x, z) {
  const size = cellSizeInUnits();
  return { cellX: Math.round(x / size), cellZ: Math.round(z / size) };
}

function makeWallId() {
  return 'w' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

const WALL_SIZE_CELLS_PER_SIDE = 2;

function showGroundCellHighlight(cellX, cellZ) {
  hideGroundCellHighlight();
  const size = cellSizeInUnits();
  const pos = cellToWorld(cellX, cellZ);
  const geo = new THREE.PlaneGeometry(size * 2, size * 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    depthTest: false
  });
  groundSelectedCellMarker = new THREE.Mesh(geo, mat);
  groundSelectedCellMarker.rotation.x = -Math.PI / 2;
  groundSelectedCellMarker.position.set(pos.x, 0.5, pos.z);
  groundSelectedCellMarker.renderOrder = 999;
  rackGroup.add(groundSelectedCellMarker);
}

function hideGroundCellHighlight() {
  if (groundSelectedCellMarker) {
    rackGroup.remove(groundSelectedCellMarker);
    groundSelectedCellMarker.geometry.dispose();
    groundSelectedCellMarker.material.dispose();
    groundSelectedCellMarker = null;
  }
}

function wallWorldPosition(wall) {
  if (Number.isFinite(wall.worldX) && Number.isFinite(wall.worldZ)) {
    return { x: wall.worldX, z: wall.worldZ };
  }
  return cellToWorld(wall.cellX, wall.cellZ);
}

function getRackWorldBounds(rack) {
  const pos = rackPositions[rack.id];
  if (!pos) return null;
  const c = config.warehouse;
  return {
    minX: pos.x - c.rackWidth / 2,
    maxX: pos.x + c.rackWidth / 2,
    minZ: pos.z - c.rackDepth / 2,
    maxZ: pos.z + c.rackDepth / 2
  };
}

function getWallBoundsAt(x, z) {
  const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * cellSizeInUnits();
  return {
    minX: x - wallSideUnits / 2,
    maxX: x + wallSideUnits / 2,
    minZ: z - wallSideUnits / 2,
    maxZ: z + wallSideUnits / 2
  };
}

function boundsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function resolveWallPosition(x, z, excludeWallId) {
  const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * cellSizeInUnits();
  let curX = x, curZ = z;

  for (let iter = 0; iter < 8; iter++) {
    const wb = getWallBoundsAt(curX, curZ);
    let collided = null;

    for (const r of config.racks) {
      const rb = rackWorldBoundsOf(r);
      if (rb && boundsOverlap(wb, rb)) { collided = rb; break; }
    }
    if (!collided) {
      for (const w of config.walls) {
        if (w.id === excludeWallId) continue;
        const wpos = wallWorldPosition(w);
        const ob = getWallBoundsAt(wpos.x, wpos.z);
        if (boundsOverlap(wb, ob)) { collided = ob; break; }
      }
    }
    if (!collided) return { x: curX, z: curZ };

    const overlapX = Math.min(wb.maxX, collided.maxX) - Math.max(wb.minX, collided.minX);
    const overlapZ = Math.min(wb.maxZ, collided.maxZ) - Math.max(wb.minZ, collided.minZ);

    if (overlapX < overlapZ) {
      curX = (curX < (collided.minX + collided.maxX) / 2)
        ? collided.minX - wallSideUnits / 2
        : collided.maxX + wallSideUnits / 2;
    } else {
      curZ = (curZ < (collided.minZ + collided.maxZ) / 2)
        ? collided.minZ - wallSideUnits / 2
        : collided.maxZ + wallSideUnits / 2;
    }
  }
  return { x: curX, z: curZ };
}

function buildWallUnit(wall) {
  const size = cellSizeInUnits();
  const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * size;
  const wallHeight = Number.isFinite(config.warehouse.wallHeight)
    ? config.warehouse.wallHeight
    : (config.warehouse.rackHeight || 6) + WALL_HEIGHT_EXTRA;

  const pos = wallWorldPosition(wall);

  const geo = new THREE.BoxGeometry(wallSideUnits, wallHeight, wallSideUnits);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8c8378, roughness: 0.9, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, wallHeight / 2, pos.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.wallId = wall.id;
  rackGroup.add(mesh);
  wallMeshes.push(mesh);

  const hitboxGeo = new THREE.BoxGeometry(wallSideUnits, wallHeight, wallSideUnits);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(pos.x, wallHeight / 2, pos.z);
  hitbox.userData.wallId = wall.id;
  hitbox.userData.isWallHitbox = true;
  rackGroup.add(hitbox);
  wallHitboxes.push(hitbox);
}

function buildAllWalls() {
  if (!Array.isArray(config.walls)) config.walls = [];
  config.walls.forEach(buildWallUnit);
}

function getRackWorldBounds(rack) {
  const pos = rackPositions[rack.id];
  if (!pos) return null;
  const c = config.warehouse;
  return {
    minX: pos.x - c.rackWidth / 2,
    maxX: pos.x + c.rackWidth / 2,
    minZ: pos.z - c.rackDepth / 2,
    maxZ: pos.z + c.rackDepth / 2
  };
}

function getWallWorldBounds(cellX, cellZ) {
  const size = cellSizeInUnits();
  const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * size;
  const pos = cellToWorld(cellX, cellZ);
  return {
    minX: pos.x - wallSideUnits / 2,
    maxX: pos.x + wallSideUnits / 2,
    minZ: pos.z - wallSideUnits / 2,
    maxZ: pos.z + wallSideUnits / 2
  };
}

function boundsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function isCellBlockedByRackOrWall(cellX, cellZ, excludeWallId) {
  const wallBounds = getWallWorldBounds(cellX, cellZ);
  const rackHit = config.racks.some(r => {
    const rb = getRackWorldBounds(r);
    return rb && boundsOverlap(wallBounds, rb);
  });
  if (rackHit) return true;
  const wallHit = config.walls.some(w => {
    if (w.id === excludeWallId) return false;
    if (w.cellX === cellX && w.cellZ === cellZ) return true;
    const wb = getWallWorldBounds(w.cellX, w.cellZ);
    return boundsOverlap(wallBounds, wb);
  });
  return wallHit;
}

function findNearestFreeCellForWall(startCellX, startCellZ) {
  if (!isCellBlockedByRackOrWall(startCellX, startCellZ)) {
    return { cellX: startCellX, cellZ: startCellZ };
  }
  for (let radius = 1; radius <= 20; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const cx = startCellX + dx;
        const cz = startCellZ + dz;
        if (!isCellBlockedByRackOrWall(cx, cz)) {
          return { cellX: cx, cellZ: cz };
        }
      }
    }
  }
  return null;
}

function addWallAtCell(cellX, cellZ) {
  if (!Array.isArray(config.walls)) config.walls = [];
  const initialPos = cellToWorld(cellX, cellZ);
  const resolved = resolveWallPosition(initialPos.x, initialPos.z);
  config.walls.push({ id: makeWallId(), worldX: resolved.x, worldZ: resolved.z });
  rebuildRacks();
  syncJsonFromConfig();
}

const PATHFINDING_CELL_SIZE = 0.5;

  function buildPathfindingGrid() {
  const c = config.warehouse;
  const cell = PATHFINDING_CELL_SIZE;
  const margin = 0.3;
  const edge = 0.1;
  const half = c.floorLength / 2;

  const minX = -half + edge, maxX = half - edge;
  const minZ = -half + edge, maxZ = half - edge;

  const boxes = [];
  config.racks.forEach(r => {
    const b = rackWorldBoundsOf(r);
    if (b) boxes.push(b);
  });
  (config.walls || []).forEach(w => {
    const p = wallWorldPosition(w);
    boxes.push(getWallBoundsAt(p.x, p.z));
  });

  const cols = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxZ - minZ) / cell) + 1;
  const blocked = new Set();

  boxes.forEach(b => {
    const gx0 = Math.ceil((b.minX - margin - minX) / cell);
    const gx1 = Math.floor((b.maxX + margin - minX) / cell);
    const gz0 = Math.ceil((b.minZ - margin - minZ) / cell);
    const gz1 = Math.floor((b.maxZ + margin - minZ) / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        blocked.add(gx + ',' + gz);
      }
    }
  });

  return {
    cols, rows, blocked,
    toGridX: x => Math.round((x - minX) / cell),
    toGridZ: z => Math.round((z - minZ) / cell),
    toWorldX: gx => minX + gx * cell,
    toWorldZ: gz => minZ + gz * cell
  };
}

function isFreeCell(grid, gx, gz) {
  return gx >= 0 && gx < grid.cols && gz >= 0 && gz < grid.rows && !grid.blocked.has(gx + ',' + gz);
}

function nearestFreeCell(grid, gx, gz) {
  if (isFreeCell(grid, gx, gz)) return { gx, gz };
  for (let r = 1; r <= 30; r++) {
    let best = null, bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = gx + dx, nz = gz + dz;
        if (!isFreeCell(grid, nx, nz)) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = { gx: nx, gz: nz }; }
      }
    }
    if (best) return best;
  }
  return null;
}

function aStarPath(grid, startX, startZ, endX, endZ, trace, opts) {
  const o = opts || {};
  const weight = o.weight || 1;
  const allowDiag = o.diagonal !== false;
  const penalty = o.penalty || null;
  const penaltyCost = o.penaltyCost || 0;

  const start = nearestFreeCell(grid, grid.toGridX(startX), grid.toGridZ(startZ));
  const goal = nearestFreeCell(grid, grid.toGridX(endX), grid.toGridZ(endZ));
  if (!start || !goal) return null;

  const key = (x, z) => x + ',' + z;
  const heuristic = (x, z) => weight * Math.hypot(x - goal.gx, z - goal.gz);

  const open = new Map();
  open.set(key(start.gx, start.gz), { gx: start.gx, gz: start.gz, g: 0, f: heuristic(start.gx, start.gz), parent: null });
  const closed = new Set();
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let iterations = 0;

  while (open.size > 0 && iterations < 60000) {
    iterations++;
    let currentKey = null, current = null;
    for (const [k, node] of open) {
      if (!current || node.f < current.f) { current = node; currentKey = k; }
    }
    open.delete(currentKey);
    closed.add(currentKey);

    if (trace && current.parent) {
      trace.push({
        x1: grid.toWorldX(current.parent.gx), z1: grid.toWorldZ(current.parent.gz),
        x2: grid.toWorldX(current.gx),        z2: grid.toWorldZ(current.gz)
      });
    }

    if (current.gx === goal.gx && current.gz === goal.gz) {
      const path = [];
      let node = current;
      while (node) {
        path.unshift({ x: grid.toWorldX(node.gx), z: grid.toWorldZ(node.gz) });
        node = node.parent;
      }
      return path;
    }

    for (const [dx, dz] of dirs) {
      if (!allowDiag && dx !== 0 && dz !== 0) continue;
      const nx = current.gx + dx, nz = current.gz + dz;
      if (!isFreeCell(grid, nx, nz)) continue;
      if (dx !== 0 && dz !== 0) {
        if (!isFreeCell(grid, current.gx + dx, current.gz) || !isFreeCell(grid, current.gx, current.gz + dz)) continue;
      }
      const nk = key(nx, nz);
      if (closed.has(nk)) continue;
      const g = current.g + ((dx !== 0 && dz !== 0) ? 1.414 : 1) + (penalty && penalty.has(nk) ? penaltyCost : 0);
      const existing = open.get(nk);
      if (!existing || g < existing.g) {
        open.set(nk, { gx: nx, gz: nz, g, f: g + heuristic(nx, nz), parent: current });
      }
    }
  }
  return null;
}

function pathLength(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    sum += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return sum;
}

function simplifyPath(points) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    const dx1 = curr.x - prev.x, dz1 = curr.z - prev.z;
    const dx2 = next.x - curr.x, dz2 = next.z - curr.z;
    const cross = dx1 * dz2 - dz1 * dx2;
    if (Math.abs(cross) > 0.001) {
      result.push(curr);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

function deleteWallById(wallId) {
  config.walls = (config.walls || []).filter(w => w.id !== wallId);
  rebuildRacks();
  syncJsonFromConfig();
}

// ============================================
// Start Point Module
// The start point sits at the exact center of the clicked cell, shown with a glowing cone + base ring.
// ============================================
function buildStartPointMarker() {
  const sp = getActiveStartPoint();
  const coneGeo = new THREE.ConeGeometry(0.4, 1, 16);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00707a, roughness: 0.4 });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(sp.x, 0.9, sp.z);
  rackGroup.add(cone);

  const ringGeo = new THREE.RingGeometry(0.5, 0.7, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(sp.x, 0.03, sp.z);
  rackGroup.add(ring);

  startPointMarker = new THREE.Group();
  startPointMarker.add(cone);
  startPointMarker.add(ring);
}

function buildStartPointGridOutline() {
  if (startPointGridOutline) {
    rackGroup.remove(startPointGridOutline);
    startPointGridOutline.geometry.dispose();
    startPointGridOutline.material.dispose();
    startPointGridOutline = null;
  }
  const sp = getActiveStartPoint();
  const size = cellSizeInUnits();
  const outlineSide = 2 * size;
  const geo = new THREE.PlaneGeometry(outlineSide, outlineSide);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
  startPointGridOutline = new THREE.LineSegments(edges, mat);
  startPointGridOutline.rotation.x = -Math.PI / 2;
  startPointGridOutline.position.set(sp.x, 0.05, sp.z);
  rackGroup.add(startPointGridOutline);
}

function getPlacementFootprint(type) {
  const c = config.warehouse;
  if (type === 'rack') {
    const wCells = Math.max(1, Math.round(c.rackWidth / cellSizeInUnits()));
    const dCells = Math.max(1, Math.round(c.rackDepth / cellSizeInUnits()));
    return { w: wCells, d: dCells };
  }
  if (type === 'wall') {
    return { w: WALL_SIZE_CELLS_PER_SIDE, d: WALL_SIZE_CELLS_PER_SIDE };
  }
  return { w: 1, d: 1 }; // start point
}

function getOccupiedCells(cellX, cellZ, footprint) {
  const cells = [];
  const halfW = (footprint.w - 1) / 2;
  const halfD = (footprint.d - 1) / 2;
  const startX = Math.round(cellX - halfW);
  const startZ = Math.round(cellZ - halfD);
  for (let dx = 0; dx < footprint.w; dx++) {
    for (let dz = 0; dz < footprint.d; dz++) {
      cells.push({ x: startX + dx, z: startZ + dz });
    }
  }
  return cells;
}

function getAllOccupiedCellsSet(excludeType) {
  const occupied = new Set();

  if (excludeType !== 'rack') {
    config.racks.forEach(rack => {
      const footprint = getPlacementFootprint('rack');
      const cells = getOccupiedCells(rack.col, rack.row, footprint);
      cells.forEach(c => occupied.add(c.x + ',' + c.z));
    });
  } else {
        // When adding a rack, still avoid existing racks (racks must not overlap)
    config.racks.forEach(rack => {
      const footprint = getPlacementFootprint('rack');
      const cells = getOccupiedCells(rack.col, rack.row, footprint);
      cells.forEach(c => occupied.add(c.x + ',' + c.z));
    });
  }

  (config.walls || []).forEach(wall => {
    const footprint = getPlacementFootprint('wall');
    const cells = getOccupiedCells(wall.cellX, wall.cellZ, footprint);
    cells.forEach(c => occupied.add(c.x + ',' + c.z));
  });

  return occupied;
}

function isPlacementColliding(cellX, cellZ, type) {
  const footprint = getPlacementFootprint(type);
  const targetCells = getOccupiedCells(cellX, cellZ, footprint);
  const occupiedSet = getAllOccupiedCellsSet(type);
  return targetCells.some(c => occupiedSet.has(c.x + ',' + c.z));
}

function findNearestFreeCell(cellX, cellZ, type) {
  if (!isPlacementColliding(cellX, cellZ, type)) {
    return { cellX, cellZ };
  }

  for (let radius = 1; radius <= 20; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const testX = cellX + dx;
        const testZ = cellZ + dz;
        if (!isPlacementColliding(testX, testZ, type)) {
          return { cellX: testX, cellZ: testZ };
        }
      }
    }
  }
    return { cellX, cellZ }; // nothing found, keep the original position (extreme case)
}

function buildPlacementPreview(type) {
  clearPlacementPreview();
  const c = config.warehouse;
  let geo, mat;

  if (type === 'rack') {
    geo = new THREE.BoxGeometry(c.rackWidth, c.rackHeight, c.rackDepth);
    mat = new THREE.MeshBasicMaterial({ color: 0x1a57b0, transparent: true, opacity: 0.45, depthTest: false });
    placementPreviewMesh = new THREE.Mesh(geo, mat);
    placementPreviewMesh.position.y = c.rackHeight / 2;
  } else if (type === 'wall') {
    const size = cellSizeInUnits();
    const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * size;
    const wallHeight = Number.isFinite(c.wallHeight) ? c.wallHeight : (c.rackHeight || 6) + WALL_HEIGHT_EXTRA;
    geo = new THREE.BoxGeometry(wallSideUnits, wallHeight, wallSideUnits);
    mat = new THREE.MeshBasicMaterial({ color: 0x8c8378, transparent: true, opacity: 0.45, depthTest: false });
    placementPreviewMesh = new THREE.Mesh(geo, mat);
    placementPreviewMesh.position.y = wallHeight / 2;
  } else if (type === 'start') {
    const coneGeo = new THREE.ConeGeometry(0.4, 1, 16);
    mat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55, depthTest: false });
    placementPreviewMesh = new THREE.Mesh(coneGeo, mat);
    placementPreviewMesh.position.y = 0.9;
  }

  if (placementPreviewMesh) {
    placementPreviewMesh.renderOrder = 999;
    rackGroup.add(placementPreviewMesh);
  }
}

function clearPlacementPreview() {
  if (placementPreviewMesh) {
    rackGroup.remove(placementPreviewMesh);
    placementPreviewMesh.geometry.dispose();
    placementPreviewMesh.material.dispose();
    placementPreviewMesh = null;
  }
}

function updatePlacementPreviewPosition(worldX, worldZ) {
  if (!placementPreviewMesh) return;

  if (placementMode === 'rack') {
    const p = resolveRackPosition(worldX, worldZ);
    placementPreviewMesh.position.x = p.x;
    placementPreviewMesh.position.z = p.z;
    return;
  }

  const { cellX, cellZ } = worldToNearestCell(worldX, worldZ);
  const pos = cellToWorld(cellX, cellZ);
  placementPreviewMesh.position.x = pos.x;
  placementPreviewMesh.position.z = pos.z;
}

function startPlacementMode(type) {
  placementMode = type;
  buildPlacementPreview(type);
  closeAddItemMenu();
}

function cancelPlacementMode() {
  placementMode = null;
  clearPlacementPreview();
}

function rackWorldBoundsOf(rack) {
  const c = config.warehouse;

  if (Number.isFinite(Number(rack.worldX)) && Number.isFinite(Number(rack.worldZ))) {
    const x = Number(rack.worldX);
    const z = Number(rack.worldZ);
    return {
      minX: x - c.rackWidth / 2,
      maxX: x + c.rackWidth / 2,
      minZ: z - c.rackDepth / 2,
      maxZ: z + c.rackDepth / 2
    };
  }

  return getRackWorldBounds(rack);
}

function isRackSpotFree(x, z) {
  const c = config.warehouse;
  const eps = 0.001;
  const candidate = {
    minX: x - c.rackWidth / 2 + eps,
    maxX: x + c.rackWidth / 2 - eps,
    minZ: z - c.rackDepth / 2 + eps,
    maxZ: z + c.rackDepth / 2 - eps
  };

  for (const rack of config.racks) {
    const b = rackWorldBoundsOf(rack);
    if (b && boundsOverlap(candidate, b)) return false;
  }
  for (const wall of (config.walls || [])) {
    const p = wallWorldPosition(wall);
    if (boundsOverlap(candidate, getWallBoundsAt(p.x, p.z))) return false;
  }
  return true;
}

function resolveRackPosition(worldX, worldZ) {
  const c = config.warehouse;
  const stepX = c.rackWidth;
  const stepZ = cellSizeInUnits();
  const baseCol = Math.round(worldX / stepX);
  const baseRow = Math.round(worldZ / stepZ);

  if (isRackSpotFree(baseCol * stepX, baseRow * stepZ)) {
    return { x: baseCol * stepX, z: baseRow * stepZ };
  }

  let best = null;
  let bestDist = Infinity;
  for (let dc = -4; dc <= 4; dc++) {
    for (let dr = -8; dr <= 8; dr++) {
      const x = (baseCol + dc) * stepX;
      const z = (baseRow + dr) * stepZ;
      if (!isRackSpotFree(x, z)) continue;
      const dist = (x - worldX) ** 2 + (z - worldZ) ** 2;
      if (dist < bestDist) { bestDist = dist; best = { x, z }; }
    }
  }
  return best || { x: baseCol * stepX, z: baseRow * stepZ };
}

function confirmPlacementAt(worldX, worldZ) {
  if (!placementMode) return;

  if (placementMode === 'rack') {
    const emptyLevels = Array(config.warehouse.levels).fill(0);
    const emptyTypes = Array(config.warehouse.levels).fill('large');
    const resolved = resolveRackPosition(worldX, worldZ);

    config.racks.push({
      id: makeRackId(),
      worldX: resolved.x,
      worldZ: resolved.z,
      col: 0,
      row: config.racks.length,
      levels: emptyLevels,
      types: emptyTypes
    });

    rebuildRacks();
    syncJsonFromConfig();
  } else if (placementMode === 'wall') {
    const rawCell = worldToNearestCell(worldX, worldZ);
    addWallAtCell(rawCell.cellX, rawCell.cellZ);
  } else if (placementMode === 'start') {
    const rawCell = worldToNearestCell(worldX, worldZ);
    setStartPointAtCell(rawCell.cellX, rawCell.cellZ);
  }

  cancelPlacementMode();
}

function setStartPointAtCell(cellX, cellZ) {
  const pos = cellToWorld(cellX, cellZ);
  config.startPoint = { x: pos.x, z: pos.z };
  rebuildRacks();
  syncJsonFromConfig();
}

function countTotalGoods() {
  return (config.racks || []).reduce((sum, rack) => {
    const subtotal = Array.isArray(rack.levels) ? rack.levels.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    return sum + subtotal;
  }, 0);
}

function computeColumnPositions(allCols, c) {
  const baseXOffset = c.aisleWidth / 2 + c.rackWidth / 2;
  const gap = c.rackWidth + c.aisleWidth;

  const leftCols = allCols.filter(v => v <= 0).sort((a, b) => b - a);
  const rightCols = allCols.filter(v => v >= 1).sort((a, b) => a - b);

  const colToX = {};
  leftCols.forEach((colVal, idx) => {
    colToX[colVal] = -(baseXOffset + idx * gap);
  });
  rightCols.forEach((colVal, idx) => {
    colToX[colVal] = baseXOffset + idx * gap;
  });
  return colToX;
}

function rebuildRacks() {
  scene.remove(rackGroup);
  rackGroup = new THREE.Group();
  scene.add(rackGroup);
  goodsArray = [];
  rackHitboxes = [];
  slotHitboxes = [];
  wallHitboxes = [];
  wallMeshes = [];
  startPointMarker = null;
  startPointGridOutline = null;
  groundSelectedCellMarker = null;
  placementPreviewMesh = null;
  rackPositions = {};
  rackHighlightMesh = null;
  slotHighlightMesh = null;
  buildBase();

  config.goodsSizes = sanitizeGoodsSizes(config.goodsSizes);
  config.racks = sanitizeRackList(config.racks, config.warehouse);

    // Grid scale conversion: real meters -> Three.js scene units (existing drawing functions need no change)
  if (Number.isFinite(config.warehouse.rackWidthMeters)) {
    config.warehouse.rackWidth = metersToUnits(config.warehouse.rackWidthMeters);
  }
  if (Number.isFinite(config.warehouse.rackDepthMeters)) {
    config.warehouse.rackDepth = metersToUnits(config.warehouse.rackDepthMeters);
  }
  if (!Number.isFinite(config.warehouse.wallHeight)) {
    config.warehouse.wallHeight = (config.warehouse.rackHeight || 6) + WALL_HEIGHT_EXTRA;
  }

  const c = config.warehouse;

  const freeformRacks = config.racks.filter(r =>
  Number.isFinite(Number(r.worldX)) &&
  Number.isFinite(Number(r.worldZ))
);

const gridRacks = config.racks.filter(r =>
  !Number.isFinite(Number(r.worldX)) ||
  !Number.isFinite(Number(r.worldZ))
);

const groupsByCol = {};

gridRacks.forEach(rack => {
  groupsByCol[rack.col] = groupsByCol[rack.col] || [];
  groupsByCol[rack.col].push(rack);
});

Object.keys(groupsByCol).forEach(colKey => {
  const rowGroup = groupsByCol[colKey].sort((a, b) => a.row - b.row);
  const total = rowGroup.length;

  rowGroup.forEach((rack, idx) => {
    const pos = cellToWorld(rack.col, rack.row);
    buildRackUnit(pos.x, pos.z, rack, idx, total);
  });
});

freeformRacks.forEach(rack => {
  buildRackUnit(
    Number(rack.worldX),
    Number(rack.worldZ),
    rack,
    0,
    1
  );
});
  config.racks.forEach(rack => {
    ensureOccupancy(rack, Math.max(1, Math.floor(c.slotsPerLevel || 3)));
    ensureSlotGoods(rack, Math.max(1, Math.floor(c.slotsPerLevel || 3)));
  });

  buildAllWalls();
  buildStartPointMarker();
  buildStartPointGridOutline();
  updateStats();
  if (typeof renderTaskUI === 'function') renderTaskUI();
}

function updateStats() {
  const c = config.warehouse;
  document.getElementById('statRackUnits').textContent = config.racks.length;
    document.getElementById('statShelves').textContent = `${config.racks.length * (c.levels + 1)} / Goods ${countTotalGoods()}`;
  document.getElementById('statAisle').textContent = c.aisleWidth.toFixed(1);
  document.getElementById('statHeight').textContent = c.rackHeight.toFixed(1);
}

function setCameraFromConfig() {
  camera.position.set(config.camera.x, config.camera.y, config.camera.z);
  controls.target.set(0, config.camera.targetY, 0);
  controls.update();
}

function applyRackCountToRows(newCount) {
  const c = config.warehouse;
  const levels = Math.max(1, Math.floor(c.levels || 1));
  const maxSlots = Math.max(1, Math.floor(c.slotsPerLevel || 3));
  const defaultLevels = Array(levels).fill(0);
  const defaultTypes = Array(levels).fill('large');

  const uniqueCols = Array.from(new Set(config.racks.map(r => r.col)));

  uniqueCols.forEach(col => {
    let colRacks = config.racks.filter(r => r.col === col).sort((a, b) => a.row - b.row);
    if (colRacks.length === newCount) return;

    if (colRacks.length < newCount) {
      for (let row = colRacks.length; row < newCount; row++) {
        config.racks.push({
          id: makeRackId(),
          col,
          row,
          levels: [...defaultLevels],
          types: [...defaultTypes]
        });
      }
    } else {
      const removeIds = colRacks.slice(newCount).map(r => r.id);
      config.racks = config.racks.filter(r => !removeIds.includes(r.id));
    }
  });
}

function showErrorToast(message) {
  const existing = document.getElementById('rackErrorToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'rackErrorToast';
  toast.className = 'rack-error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 700);
  }, 2000);
}

function addRackRelative(direction) {
  const src = config.racks.find(r => r.id === selectedRackId);
  if (!src) return;

  const emptyLevels = Array(config.warehouse.levels).fill(0);
  const emptyTypes = Array(config.warehouse.levels).fill('large');

  if (direction === 'vertical') {
    const occupiedFront = config.racks.some(r => r.col === src.col && r.row === src.row + 1);
    const occupiedBack = src.row > 0 && config.racks.some(r => r.col === src.col && r.row === src.row - 1);

    let targetRow = null;
    if (!occupiedFront) {
      targetRow = src.row + 1;
    } else if (src.row > 0 && !occupiedBack) {
      targetRow = src.row - 1;
    }

    if (targetRow === null) {
      showErrorToast('Cannot be generated');
      closeRackContextMenu();
      return;
    }

    config.racks.push({
      id: makeRackId(),
      col: src.col,
      row: targetRow,
      levels: emptyLevels,
      types: emptyTypes
    });

  } else {
    const rightOccupied = config.racks.some(r => r.row === src.row && r.col === src.col + 1);
    const leftOccupied = config.racks.some(r => r.row === src.row && r.col === src.col - 1);

    let targetCol = null;
    if (!rightOccupied) {
      targetCol = src.col + 1;
    } else if (!leftOccupied) {
      targetCol = src.col - 1;
    }

    if (targetCol === null) {
      showErrorToast('Cannot be generated');
      closeRackContextMenu();
      return;
    }

    config.racks.push({
      id: makeRackId(),
      col: targetCol,
      row: src.row,
      levels: emptyLevels,
      types: emptyTypes
    });
  }

  rebuildRacks();
  syncJsonFromConfig();
  closeRackContextMenu();
}

function deleteSelectedRack() {
  config.racks = config.racks.filter(r => r.id !== selectedRackId);
  rebuildRacks();
  syncJsonFromConfig();
  closeRackContextMenu();
}

const rackContextMenu = document.getElementById('rackContextMenu');
const slotActionMenu = document.getElementById('slotActionMenu');

// Extra rightward offset so popups appear further to the right of the click
// point, instead of directly beneath the cursor.
const MENU_OFFSET_X = 48;

function showRackHighlight(rackId) {
  hideRackHighlight();
  const pos = rackPositions[rackId];
  if (!pos) return;

  const c = config.warehouse;
  const geo = new THREE.BoxGeometry(c.rackWidth + 0.5, c.rackHeight + 0.5, c.rackDepth + 0.5);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 1,
    depthTest: false
  });

  rackHighlightMesh = new THREE.LineSegments(edges, mat);
  rackHighlightMesh.position.set(pos.x, c.rackHeight / 2, pos.z);
  rackGroup.add(rackHighlightMesh);

  rackHighlightTween = new TWEEN.Tween(mat)
    .to({ opacity: 0.25 }, 550)
    .repeat(Infinity)
    .yoyo(true)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .start();
}

function showWallHighlight(wallId) {
  hideWallHighlight();
  const wall = (config.walls || []).find(w => w.id === wallId);
  if (!wall) return;
  const size = cellSizeInUnits();
  const wallSideUnits = WALL_SIZE_CELLS_PER_SIDE * size;
  const wallHeight = Number.isFinite(config.warehouse.wallHeight) ? config.warehouse.wallHeight : (config.warehouse.rackHeight || 6) + WALL_HEIGHT_EXTRA;
  const pos = wallWorldPosition(wall);
  const geo = new THREE.BoxGeometry(wallSideUnits + 0.3, wallHeight + 0.3, wallSideUnits + 0.3);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 1, depthTest: false });
  wallHighlightMesh = new THREE.LineSegments(edges, mat);
  wallHighlightMesh.position.set(pos.x, wallHeight / 2, pos.z);
  rackGroup.add(wallHighlightMesh);
  wallHighlightTween = new TWEEN.Tween(mat)
    .to({ opacity: 0.25 }, 550)
    .repeat(Infinity)
    .yoyo(true)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .start();
}

function hideWallHighlight() {
  if (wallHighlightTween) { wallHighlightTween.stop(); wallHighlightTween = null; }
  if (wallHighlightMesh) {
    rackGroup.remove(wallHighlightMesh);
    wallHighlightMesh.geometry.dispose();
    wallHighlightMesh.material.dispose();
    wallHighlightMesh = null;
  }
}

function hideRackHighlight() {
  if (rackHighlightTween) {
    rackHighlightTween.stop();
    rackHighlightTween = null;
  }
  if (rackHighlightMesh) {
    rackGroup.remove(rackHighlightMesh);
    rackHighlightMesh.geometry.dispose();
    rackHighlightMesh.material.dispose();
    rackHighlightMesh = null;
  }
}

function showSlotHighlight(rack, levelIndex, slotIndex) {
  hideSlotHighlight();
  const target = slotWorldPosition(rack, levelIndex, slotIndex);
  if (!target) return;

  const largeSize = config.goodsSizes?.large || { width: 1.2, depth: 1.0, height: 0.8 };
  const geo = new THREE.BoxGeometry(largeSize.width + 0.06, largeSize.height + 0.06, largeSize.depth + 0.06);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0xff3b3b,
    transparent: true,
    opacity: 1,
    depthTest: false
  });

  slotHighlightMesh = new THREE.LineSegments(edges, mat);
  slotHighlightMesh.position.set(target.x, target.y + largeSize.height / 2, target.z);
  rackGroup.add(slotHighlightMesh);

  slotHighlightTween = new TWEEN.Tween(mat)
    .to({ opacity: 0.25 }, 500)
    .repeat(Infinity)
    .yoyo(true)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .start();
}

function hideSlotHighlight() {
  if (slotHighlightTween) {
    slotHighlightTween.stop();
    slotHighlightTween = null;
  }
  if (slotHighlightMesh) {
    rackGroup.remove(slotHighlightMesh);
    slotHighlightMesh.geometry.dispose();
    slotHighlightMesh.material.dispose();
    slotHighlightMesh = null;
  }
}

function openRackContextMenu(clientX, clientY) {
  const menuWidth = 210, menuHeight = 180;
  const x = Math.min(clientX + MENU_OFFSET_X, window.innerWidth - menuWidth - 10);
  const y = Math.min(clientY, window.innerHeight - menuHeight - 10);
  rackContextMenu.style.left = x + 'px';
  rackContextMenu.style.top = y + 'px';
  rackContextMenu.classList.add('open');
  showRackHighlight(selectedRackId);
}

function closeRackContextMenu() {
  rackContextMenu.classList.remove('open');
  hideRackHighlight();
  selectedRackId = null;
  closeSlotActionMenu();
}

// ============================================
// Ground Context Menu
// Pops up when the empty floor is clicked in edit mode, offering "Rack / Wall / Start point".
// ============================================
function openGroundContextMenu(clientX, clientY) {
  const menu = document.getElementById('groundContextMenu');
  if (!menu) return;
  const menuWidth = 210, menuHeight = 160;
  const x = Math.min(clientX + MENU_OFFSET_X, window.innerWidth - menuWidth - 10);
  const y = Math.min(clientY, window.innerHeight - menuHeight - 10);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('open');
}

function openWallContextMenu(clientX, clientY) {
  const menu = document.getElementById('wallContextMenu');
  if (!menu) return;
  const menuWidth = 210, menuHeight = 90;
  const x = Math.min(clientX + MENU_OFFSET_X, window.innerWidth - menuWidth - 10);
  const y = Math.min(clientY, window.innerHeight - menuHeight - 10);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('open');
  showWallHighlight(selectedWallId);
}

function closeWallContextMenu() {
  const menu = document.getElementById('wallContextMenu');
  if (menu) menu.classList.remove('open');
  hideWallHighlight();
  selectedWallId = null;
}

function deleteSelectedWall() {
  if (!selectedWallId) return;
  deleteWallById(selectedWallId);
  closeWallContextMenu();
}

function closeGroundContextMenu() {
  const menu = document.getElementById('groundContextMenu');
  if (menu) menu.classList.remove('open');
  groundClickMenuPos = null;
}

function handleGroundAddRack() {
  if (!groundClickMenuPos) { closeGroundContextMenu(); return; }
  const { cellX, cellZ } = worldToNearestCell(groundClickMenuPos.x, groundClickMenuPos.z);
  const emptyLevels = Array(config.warehouse.levels).fill(0);
  const emptyTypes = Array(config.warehouse.levels).fill('large');
  const exists = config.racks.some(r => r.col === cellX && r.row === cellZ);
  if (exists) {
        showErrorToast('A rack already exists at this position');
    closeGroundContextMenu();
    return;
  }
  config.racks.push({ id: makeRackId(), col: cellX, row: cellZ, levels: emptyLevels, types: emptyTypes });
  rebuildRacks();
  syncJsonFromConfig();
  closeGroundContextMenu();
}

function handleGroundAddWall() {
  if (!groundClickMenuPos) { closeGroundContextMenu(); return; }
  const { cellX, cellZ } = worldToNearestCell(groundClickMenuPos.x, groundClickMenuPos.z);
  addWallAtCell(cellX, cellZ);
  closeGroundContextMenu();
}

function handleGroundSetStartPoint() {
  if (!groundClickMenuPos) { closeGroundContextMenu(); return; }
  const { cellX, cellZ } = worldToNearestCell(groundClickMenuPos.x, groundClickMenuPos.z);
  setStartPointAtCell(cellX, cellZ);
  closeGroundContextMenu();
}

function openSlotActionMenu(clientX, clientY, rack, levelIndex, slotIndex) {
  selectedSlotLevel = levelIndex;
  selectedSlotIndex = slotIndex;
  showSlotHighlight(rack, levelIndex, slotIndex);

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  const occupied = !!rack.occupancy[levelIndex] && !!rack.occupancy[levelIndex][slotIndex];

  const addBtn = document.getElementById('slotAddGoods');
  const delBtn = document.getElementById('slotDeleteGoods');
  addBtn.disabled = occupied;
  delBtn.disabled = !occupied;

  const menuWidth = 210, menuHeight = 130;
  const x = Math.min(clientX + MENU_OFFSET_X, window.innerWidth - menuWidth - 10);
  const y = Math.min(clientY, window.innerHeight - menuHeight - 10);
  slotActionMenu.style.left = x + 'px';
  slotActionMenu.style.top = y + 'px';
  slotActionMenu.classList.add('open');
}

function closeSlotActionMenu() {
  slotActionMenu.classList.remove('open');
  hideSlotHighlight();
  selectedSlotLevel = null;
  selectedSlotIndex = null;
}

function addDefaultGoodsAtSlot() {
  const rack = config.racks.find(r => r.id === selectedRackId);
  if (!rack || selectedSlotLevel === null || selectedSlotIndex === null) return;

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  ensureSlotGoods(rack, maxSlots);
  if (rack.occupancy[selectedSlotLevel][selectedSlotIndex]) return;

  rack.occupancy[selectedSlotLevel][selectedSlotIndex] = true;
  rack.slotGoods[selectedSlotLevel][selectedSlotIndex] = null;
  rack.levels[selectedSlotLevel] = (rack.levels[selectedSlotLevel] || 0) + 1;

  const rowGroup = config.racks.filter(r => r.col === rack.col).sort((a, b) => a.row - b.row);
  const rowPosIndex = rowGroup.findIndex(r => r.id === rack.id);
  placeGoodsAnimation(rack, selectedSlotLevel, selectedSlotIndex, 'large', rowPosIndex, rowGroup.length, null);

  syncJsonFromConfig();
  updateStats();
  closeSlotActionMenu();
}

function deleteGoodsAtSlot() {
  const rack = config.racks.find(r => r.id === selectedRackId);
  if (!rack || selectedSlotLevel === null || selectedSlotIndex === null) return;

  const box = goodsArray.find(b =>
    b.userData.rackId === rack.id &&
    b.userData.levelIndex === selectedSlotLevel &&
    b.userData.slotIndex === selectedSlotIndex
  );
  if (!box) return;

  recordRemoval(box);
  removeGoodsAnimation(box, { x: 0, z: 1 });
  updateStatsScreen();
  closeSlotActionMenu();
}

document.getElementById('rackAddVertical').addEventListener('click', () => addRackRelative('vertical'));
document.getElementById('rackAddHorizontal').addEventListener('click', () => addRackRelative('horizontal'));
document.getElementById('rackDelete').addEventListener('click', deleteSelectedRack);
document.getElementById('slotAddGoods').addEventListener('click', addDefaultGoodsAtSlot);
document.getElementById('slotDeleteGoods').addEventListener('click', deleteGoodsAtSlot);

const wallDeleteBtn = document.getElementById('wallDelete');
if (wallDeleteBtn) wallDeleteBtn.addEventListener('click', deleteSelectedWall);
const rackCount = document.getElementById('rackCount');
const levels = document.getElementById('levels');
const rackHeight = document.getElementById('rackHeight');
const rackWidth = document.getElementById('rackWidth');
const rackDepth = document.getElementById('rackDepth');
const aisleWidth = document.getElementById('aisleWidth');
const rackSpacing = document.getElementById('rackSpacing');
const floorLength = document.getElementById('floorLength');
const jsonEditor = document.getElementById('jsonEditor');

function syncFormFromConfig() {
  const c = config.warehouse;
  rackCount.value = c.rackRowCount;
  levels.value = c.levels;
  rackHeight.value = c.rackHeight;
  rackWidth.value = c.rackWidth;
  rackDepth.value = c.rackDepth;
  aisleWidth.value = c.aisleWidth;
  rackSpacing.value = c.rackSpacing;
  floorLength.value = c.floorLength;
}

function syncJsonFromConfig() {
  jsonEditor.value = JSON.stringify(config, null, 2);
}

function clampNumber(n, fallback, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function applyFormToConfig() {
  config.warehouse.rackRowCount = clampNumber(rackCount.value, 1, 1, 12);
  config.warehouse.levels = clampNumber(levels.value, 2, 1, 6);
  config.warehouse.rackHeight = clampNumber(rackHeight.value, 6, 2, 12);
  config.warehouse.rackWidth = clampNumber(rackWidth.value, 3.8, 0.8, 5);
  config.warehouse.rackDepth = clampNumber(rackDepth.value, 1, 0.4, 3);
  config.warehouse.aisleWidth = clampNumber(aisleWidth.value, 2, 0, 12);
  config.warehouse.rackSpacing = clampNumber(rackSpacing.value, 3.4, 1.2, 8);
  config.warehouse.floorLength = clampNumber(floorLength.value, 12, 10, 80);
  config.warehouse.floorWidth = Math.max(
    config.warehouse.aisleWidth + config.warehouse.rackDepth * 2 + config.warehouse.sideOffset * 2 + 2.5,
    8
  );
  config.goodsSizes = sanitizeGoodsSizes(config.goodsSizes);

  applyRackCountToRows(config.warehouse.rackRowCount);
  config.racks = sanitizeRackList(config.racks, config.warehouse);

  rebuildRacks();
  syncJsonFromConfig();
}

function applyJsonToConfig() {
  try {
    const parsed = JSON.parse(jsonEditor.value);
    config = Object.assign(clone(initialConfig), parsed);
    config.warehouse = Object.assign(clone(initialConfig.warehouse), parsed.warehouse || {});
    config.colors = Object.assign(clone(initialConfig.colors), parsed.colors || {});
    config.camera = Object.assign(clone(initialConfig.camera), parsed.camera || {});
    config.light = Object.assign(clone(initialConfig.light), parsed.light || {});
    config.goodsSizes = sanitizeGoodsSizes(parsed.goodsSizes || clone(initialConfig.goodsSizes));

    if (Array.isArray(parsed.racks)) {
      const hasOldFormat = parsed.racks.some(r => r && r.side);
      config.racks = hasOldFormat
        ? sanitizeRackList(migrateOldSideRacks(parsed.racks, config.warehouse), config.warehouse)
        : sanitizeRackList(parsed.racks, config.warehouse);
    } else if (parsed.activeRacks) {
      config.racks = migrateActiveRacksToRacks(parsed.activeRacks, config.warehouse);
    } else {
      config.racks = clone(initialConfig.racks);
    }

    currentTheme = config.theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', currentTheme);
    dir.intensity = clampNumber(config.light.directionalIntensity, 0.92, 0.1, 2);
    hemi.intensity = clampNumber(config.light.hemisphereIntensity, 0.88, 0.1, 2);
    scene.background = hex(config.colors.floor, '#efe7d9').clone().offsetHSL(0, -0.02, 0.02);

    syncFormFromConfig();
    setCameraFromConfig();
    rebuildRacks();
    syncJsonFromConfig();
  } catch (err) {
        alert('Invalid JSON format. Please check commas, brackets and quotes.');
  }
}

function downloadCurrentJson() {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'warehouse-config.json';
  a.click();
  URL.revokeObjectURL(url);
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

renderer.domElement.addEventListener('click', (event) => {
  if (document.body.classList.contains('task-mode')) return;
  if (placementMode) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const floorHits = floorMesh ? raycaster.intersectObject(floorMesh) : [];
    if (floorHits.length > 0) {
      const point = floorHits[0].point;
      confirmPlacementAt(point.x, point.z);
    }
    return;
  }
  const isAdmin = document.body.classList.contains('admin-mode');

  const infoCardEl = document.getElementById('goodsInfoCard');
  if (isAdmin && infoCardEl && infoCardEl.classList.contains('open')) {
    closeGoodsInfoCard();
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  if (isAdmin) {
    if (!document.body.classList.contains('edit-mode') && rackContextMenu.classList.contains('open') && selectedRackId) {
      const slotHits = raycaster.intersectObjects(slotHitboxes);
      const slotInSelectedRack = slotHits.find(h => h.object.userData.rackId === selectedRackId);
      if (slotInSelectedRack) {
        const rack = config.racks.find(r => r.id === selectedRackId);
        const { levelIndex, slotIndex } = slotInSelectedRack.object.userData;
        openSlotActionMenu(event.clientX, event.clientY, rack, levelIndex, slotIndex);

        const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
        ensureSlotGoods(rack, maxSlots);
        const goodsId = rack.slotGoods?.[levelIndex]?.[slotIndex];
        if (goodsId) {
          const box = goodsArray.find(b =>
            b.userData.rackId === rack.id &&
            b.userData.levelIndex === levelIndex &&
            b.userData.slotIndex === slotIndex
          );
          if (box) showGoodsInfoCard(box);
        }
        return;
      }
    }

    const wallHits = raycaster.intersectObjects(wallHitboxes);
    if (wallHits.length > 0) {
      selectedWallId = wallHits[0].object.userData.wallId;
      closeRackContextMenu();
      closeSlotActionMenu();
      openWallContextMenu(event.clientX, event.clientY);
      return;
    }
    
    const rackHits = raycaster.intersectObjects(rackHitboxes);
if (rackHits.length > 0) {
  closeWallContextMenu();
  selectedRackId = rackHits[0].object.userData.rackId;
  closeSlotActionMenu();
  openRackContextMenu(event.clientX, event.clientY);
  return;
}
if (rackContextMenu.classList.contains('open')) {
  closeRackContextMenu();
  return;
}

        // Edit mode: click the empty floor -> pop up the "Rack / Wall / Start point" menu
    const isEditMode = document.body.classList.contains('edit-mode');
    if (isEditMode) {
      const wallHits = raycaster.intersectObjects(wallHitboxes);
      if (wallHits.length === 0) {
        const floorHits = floorMesh ? raycaster.intersectObject(floorMesh) : [];
        if (floorHits.length > 0) {
          const point = floorHits[0].point;
          groundClickMenuPos = { x: point.x, z: point.z };
          openGroundContextMenu(event.clientX, event.clientY);
          return;
        }
      }
    }
    return;
  }

  if (rackContextMenu.classList.contains('open')) return;

  const intersects = raycaster.intersectObjects(goodsArray);
  if (intersects.length > 0) {
    const selectedBox = intersects[0].object;
    const idx = selectedBox.userData.rowPosIndex ?? 0;
    const total = selectedBox.userData.rowTotal ?? 1;

    let dirZ;
    if (idx === 0) {
      dirZ = 1;
    } else if (idx === total - 1) {
      dirZ = -1;
    } else {
      dirZ = Math.random() > 0.5 ? 1 : -1;
    }

    recordRemoval(selectedBox);
    removeGoodsAnimation(selectedBox, { x: 0, z: dirZ });
    updateStatsScreen();
  }
});

document.addEventListener('click', (e) => {
  const wallMenuEl = document.getElementById('wallContextMenu');
  if (rackContextMenu.classList.contains('open') && !rackContextMenu.contains(e.target) && !slotActionMenu.contains(e.target) && e.target !== renderer.domElement) {
    closeRackContextMenu();
  }
  if (slotActionMenu.classList.contains('open') && !slotActionMenu.contains(e.target) && !rackContextMenu.contains(e.target) && e.target !== renderer.domElement) {
    closeSlotActionMenu();
  }
  if (wallMenuEl && wallMenuEl.classList.contains('open') && !wallMenuEl.contains(e.target) && e.target !== renderer.domElement) {
    closeWallContextMenu();
  }
});

renderer.domElement.addEventListener('mousemove', (event) => {
  if (!placementMode) return;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const floorHits = floorMesh ? raycaster.intersectObject(floorMesh) : [];
  if (floorHits.length > 0) {
    const point = floorHits[0].point;
    updatePlacementPreviewPosition(point.x, point.z);
  }
});

/* ============================================
   Goods info card (only for goods placed through the RC522 task flow that have a goodsId)
   ============================================ */
function ensureGoodsInfoCardEl() {
  let card = document.getElementById('goodsInfoCard');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'goodsInfoCard';
  card.className = 'goods-info-card';
  document.body.appendChild(card);
  return card;
}

function showGoodsInfoCard(box) {
  const goodsId = box.userData.goodsId;
  const record = goodsRecords.find(g => g.id === goodsId);
  const task = tasks.find(t => t.goodsId === goodsId);
  if (!record) return;

  const rack = config.racks.find(r => r.id === box.userData.rackId);
  const levelIdx = box.userData.levelIndex ?? 0;
  const slotIdx = box.userData.slotIndex ?? 0;
  const zoneLabel = rack ? rackZoneLabel(rack.id) : '?';

  const card = ensureGoodsInfoCardEl();
  card.innerHTML = `
    <div class="goods-info-title">
            <span>Goods Info</span>
      <button id="goodsInfoClose" class="goods-info-close" type="button">✕</button>
    </div>
        <div class="goods-info-row"><strong>Source</strong><span>${record.source || '-'}</span></div>
        <div class="goods-info-row"><strong>Model</strong><span>${record.model || '-'}</span></div>
    <div class="goods-info-row"><strong>Production Order</strong><span>${record.productionOrder || '-'}</span></div>
        <div class="goods-info-row"><strong>Size</strong><span>${sizeLabel(record.sizeCategory)}</span></div>
    <div class="goods-info-row"><strong>UID</strong><span>${record.uid || '-'}</span></div>
        <div class="goods-info-row"><strong>Location</strong><span>${zoneLabel} Level ${levelIdx + 1}, Slot ${slotIdx + 1}</span></div>
        ${task ? `<div class="goods-info-row"><strong>Worker</strong><span>${task.assignedWorker}</span></div>` : ''}
  `;
  card.classList.add('open');

  document.getElementById('goodsInfoClose').addEventListener('click', closeGoodsInfoCard);
}

function closeGoodsInfoCard() {
  const card = document.getElementById('goodsInfoCard');
  if (card) card.classList.remove('open');
}

function sizeLabel(sizeCategory) {
    if (sizeCategory === 'small') return 'Small';
    if (sizeCategory === 'medium') return 'Medium';
    return 'Large';
}

/* ============================================
   Per-worker statistics (workers 001 / 002 / 003)
   ============================================ */
function ensureWorkerStatsBlock() {
  let block = document.getElementById('workerStatsBlock');
  if (block) return block;
  const screen = document.getElementById('statsScreen');
  if (!screen) return null;

  const cards = workerPool.map(w => `
      <div class="stats-card">
                <div class="stats-card-label">Worker ${w} · Score</div>
        <div class="stats-card-value" id="workerScore-${w}">0</div>
        <div class="stats-card-label" id="workerMeta-${w}" style="margin-top:6px"></div>
      </div>`).join('');

  block = document.createElement('div');
  block.id = 'workerStatsBlock';
  block.innerHTML = `
        <div class="stats-log-title">Per-worker statistics</div>
    <div class="stats-summary">${cards}</div>
  `;
  const summary = screen.querySelector('.stats-summary');
  if (summary && summary.parentNode === screen) {
    summary.insertAdjacentElement('afterend', block);
  } else {
    screen.insertBefore(block, screen.querySelector('.stats-log-title'));
  }
  return block;
}

function updateWorkerStats() {
  const block = ensureWorkerStatsBlock();
  if (!block) return;

  const done = {}, fix = {};
  workerPool.forEach(w => { done[w] = 0; fix[w] = 0; });
  taskCompletionLog.forEach(e => {
    if (!(e.worker in done)) return;
    if (e.success) done[e.worker]++; else fix[e.worker]++;
  });

  let sumWorker = 0;
  workerPool.forEach(w => {
    sumWorker += workerScores[w] || 0;
    const scoreEl = document.getElementById('workerScore-' + w);
    const metaEl = document.getElementById('workerMeta-' + w);
    if (scoreEl) scoreEl.textContent = workerScores[w] || 0;
    if (metaEl) {
      metaEl.textContent =
                `Completed ${done[w]} | First-try correct ${workerFirstTry[w] || 0} | Needed correction ${fix[w]} time(s)`;
    }
  });
}

function updateStatsScreen() {
  updateWorkerStats();
  updateGreenStats();   
  const totalRacksEl = document.getElementById('statsTotalRacks');
  const totalGoodsEl = document.getElementById('statsTotalGoods');
  const totalRemovedEl = document.getElementById('statsTotalRemoved');
  const totalPlacedEl = document.getElementById('statsTotalPlaced');
  const totalScoreEl = document.getElementById('statsTotalScore');
  const listEl = document.getElementById('statsLogList');
  const taskListEl = document.getElementById('statsTaskLogList');
  if (!totalRacksEl || !totalGoodsEl || !totalRemovedEl || !listEl) return;

  totalRacksEl.textContent = config.racks.length;
  totalGoodsEl.textContent = countTotalGoods();
  totalRemovedEl.textContent = removalLog.length;
  if (totalPlacedEl) totalPlacedEl.textContent = taskCompletionLog.length;
  if (totalScoreEl) totalScoreEl.textContent = score;

  listEl.innerHTML = '';
  if (removalLog.length === 0) {
    const li = document.createElement('li');
        li.textContent = 'No pick-up records yet';
    listEl.appendChild(li);
  } else {
    removalLog.forEach(entry => {
      const li = document.createElement('li');
      const timeStr = entry.time.toLocaleTimeString();
            li.textContent = `${timeStr} — 1 item taken from rack (row ${entry.row}, col ${entry.col})`;
      listEl.appendChild(li);
    });
  }

  if (taskListEl) {
    taskListEl.innerHTML = '';
    if (taskCompletionLog.length === 0) {
      const li = document.createElement('li');
          li.textContent = 'No placement task records yet';
      taskListEl.appendChild(li);
    } else {
      taskCompletionLog.forEach(entry => {
        const li = document.createElement('li');
        const timeStr = entry.time.toLocaleTimeString();
                const resultText = entry.success ? 'Success' : (entry.correctionNeeded ? 'Needs correction' : 'Failed');
                li.textContent = `${timeStr} — Worker ${entry.worker} placed on rack (row ${entry.row}, col ${entry.col}) Level ${entry.level + 1}, Slot ${entry.slot + 1} — ${resultText}`;
        taskListEl.appendChild(li);
      });
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  TWEEN.update();
  if (config.autoRotate) {
    rackGroup.rotation.y += 0.003;
  }
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', fitRenderer);
[rackCount, levels, rackHeight, rackWidth, rackDepth, aisleWidth, rackSpacing, floorLength].forEach(elm => {
  elm.addEventListener('input', applyFormToConfig);
});

document.getElementById('applyJson').addEventListener('click', applyJsonToConfig);
document.getElementById('syncJson').addEventListener('click', () => {
  applyFormToConfig();
  syncJsonFromConfig();
});
document.getElementById('loadExample').addEventListener('click', () => {
  config = clone(initialConfig);
  currentTheme = config.theme;
  root.setAttribute('data-theme', currentTheme);
  syncFormFromConfig();
  syncJsonFromConfig();
  applyJsonToConfig();
});
document.getElementById('downloadJson').addEventListener('click', downloadCurrentJson);
document.getElementById('resetView').addEventListener('click', () => {
  config.camera = clone(initialConfig.camera);
  setCameraFromConfig();
});
document.getElementById('themeToggle').addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  config.theme = currentTheme;
  root.setAttribute('data-theme', currentTheme);
  syncJsonFromConfig();
});

document.body.classList.add('admin-mode');

const exitAdminBtn = document.getElementById('exitAdminBtn');
exitAdminBtn.addEventListener('click', () => {
  document.body.classList.remove('admin-mode');
  document.body.classList.add('viewer-mode');
  if (document.body.classList.contains('order-active')) {
    document.body.classList.add('task-mode');    
  }                                             
  closeRackContextMenu();
  closeGoodsInfoCard();
  fitRenderer();
});

const modeAdminBtn = document.getElementById('modeAdmin');
const modeStatsBtn = document.getElementById('modeStats');
const sideMenuPanel = document.getElementById('sideMenuPanel');
const sideMenuToggle = document.getElementById('sideMenuToggle');

sideMenuToggle.addEventListener('click', () => {
  sideMenuPanel.classList.toggle('open');
  sideMenuToggle.classList.toggle('shift');
});

document.addEventListener('click', (e) => {
  if (!sideMenuPanel.contains(e.target) && !sideMenuToggle.contains(e.target)) {
    sideMenuPanel.classList.remove('open');
    sideMenuToggle.classList.remove('shift');
  }
});

modeAdminBtn.addEventListener('click', () => {
  document.body.classList.remove('viewer-mode');
  document.body.classList.remove('stats-mode');
  document.body.classList.remove('orders-mode');
  document.body.classList.add('admin-mode');
  sideMenuPanel.classList.remove('open');
  sideMenuToggle.classList.remove('shift');
  fitRenderer();
});

modeStatsBtn.addEventListener('click', () => {
  document.body.classList.remove('admin-mode');
  document.body.classList.remove('viewer-mode');
  document.body.classList.remove('edit-mode');
  document.body.classList.remove('orders-mode');
  document.body.classList.add('stats-mode');
  sideMenuPanel.classList.remove('open');
  sideMenuToggle.classList.remove('shift');
  closeRackContextMenu();
  closeGoodsInfoCard();
  updateStatsScreen();
});

const statsBackBtn = document.getElementById('statsBackBtn');
if (statsBackBtn) {
  statsBackBtn.addEventListener('click', () => {
    document.body.classList.remove('stats-mode');
    document.body.classList.add('viewer-mode');
    closeRackContextMenu();
    fitRenderer();
  });
}

// ============================================
// Orders Mode
// ============================================
const modeOrdersBtn = document.getElementById('modeOrders');
if (modeOrdersBtn) {
  modeOrdersBtn.addEventListener('click', () => {
    document.body.classList.remove('admin-mode');
    document.body.classList.remove('viewer-mode');
    document.body.classList.remove('edit-mode');
    document.body.classList.remove('stats-mode');
    document.body.classList.add('orders-mode');
    sideMenuPanel.classList.remove('open');
    sideMenuToggle.classList.remove('shift');
    closeRackContextMenu();
    closeGoodsInfoCard();
    renderOrdersUI();
  });
}

const ordersBackBtn = document.getElementById('ordersBackBtn');
if (ordersBackBtn) {
  ordersBackBtn.addEventListener('click', () => {
    document.body.classList.remove('orders-mode');
    document.body.classList.add('viewer-mode');
    fitRenderer();
  });
}

/* ============================================
   Order Task Mode
   ============================================ */
function ensureTaskModeElements() {
  let btn = document.getElementById('endOrderBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'endOrderBtn';
    btn.type = 'button';
        btn.textContent = 'End Order';
  }
  let dlg = document.getElementById('endOrderDialog');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'endOrderDialog';
    dlg.innerHTML = `
      <div class="end-order-box">
                <div class="end-order-text">End this order?</div>
        <div class="end-order-actions">
                    <button type="button" class="end-order-back" id="endOrderBack">Back</button>
                    <button type="button" class="end-order-confirm" id="endOrderConfirm">Confirm</button>
        </div>
      </div>`;
  }
  document.body.appendChild(btn);
  document.body.appendChild(dlg);
  return { btn, dlg };
}

const { btn: endOrderBtn, dlg: endOrderDialog } = ensureTaskModeElements();
let activeOrderCtx = null; // { order, taskId, goodsId }

function enterTaskMode() {
  ['admin-mode', 'stats-mode', 'orders-mode', 'edit-mode'].forEach(m => document.body.classList.remove(m));
  document.body.classList.add('viewer-mode', 'task-mode', 'order-active');
  sideMenuPanel.classList.remove('open');
  sideMenuToggle.classList.remove('shift');
  closeRackContextMenu();
  closeGroundContextMenu();
  closeGoodsInfoCard();
  fitRenderer();
}

function openEndOrderDialog() { endOrderDialog.classList.add('open'); }
function closeEndOrderDialog() { endOrderDialog.classList.remove('open'); }

function exitTaskMode() {
  closeEndOrderDialog();
  hideOptimalPath();
  activeOrderCtx = null;
  batchCtx = null;
  document.body.classList.remove('batch-review');
  document.body.classList.remove('task-mode', 'order-active');
  document.body.classList.add('viewer-mode');
  fitRenderer();
}

endOrderBtn.addEventListener('click', openEndOrderDialog);
endOrderDialog.querySelector('#endOrderBack').addEventListener('click', closeEndOrderDialog);
endOrderDialog.querySelector('#endOrderConfirm').addEventListener('click', exitTaskMode);

function hasActiveOrder() {
  if (!activeOrderCtx) return false;
  const ids = activeOrderCtx.taskIds || [activeOrderCtx.taskId];
  return tasks.some(x => ids.includes(x.taskId) && x.status === 'pending');
}

function enterAdminFromTask() {
  closeEndOrderDialog();
  ['task-mode', 'viewer-mode', 'stats-mode', 'orders-mode', 'edit-mode'].forEach(m => document.body.classList.remove(m));
  document.body.classList.add('admin-mode');
  fitRenderer();
}

function cancelActiveOrder() {
  const ctx = activeOrderCtx;
  activeOrderCtx = null;
  batchCtx = null;
  document.body.classList.remove('batch-review');
    let message = 'Order ended';

  if (ctx) {
    const taskIds = ctx.taskIds || [ctx.taskId];
    const ordersOfCtx = ctx.orders || [ctx.order];
    const requeue = [];
    taskIds.forEach(tid => {
      const task = tasks.find(t => t.taskId === tid);
      if (!task || task.status !== 'pending') return;
      const rack = config.racks.find(r => r.id === task.targetRackId);
      if (rack) {
        const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
        ensureOccupancy(rack, maxSlots);
        if (rack.occupancy[task.targetLevel][task.targetSlot] === 'reserved') {
          rack.occupancy[task.targetLevel][task.targetSlot] = false;
        }
      }
      tasks = tasks.filter(t => t.taskId !== task.taskId);
      goodsRecords = goodsRecords.filter(g => g.id !== task.goodsId);
      const w = task.assignedWorker;
      if (!tasks.some(t => t.assignedWorker === w && t.status === 'pending' && t.hadMismatch)) {
        lockedWorkers.delete(w);
      }
      const od = ordersOfCtx.find(o => o && o.orderId === task.productionOrder);
      if (od) requeue.push(od);
    });
    if (requeue.length > 0) {
      orderQueue.unshift(...requeue);
      message = requeue.length > 1
                ? `${requeue.length} orders cancelled and returned to the order list`
                : 'Order cancelled and returned to the order list';
    }
  }

  hideOptimalPath();
  ['admin-mode', 'viewer-mode', 'stats-mode', 'edit-mode', 'task-mode', 'order-active'].forEach(m => document.body.classList.remove(m));
  document.body.classList.add('orders-mode');
  sideMenuPanel.classList.remove('open');
  sideMenuToggle.classList.remove('shift');
  closeRackContextMenu();
  closeGoodsInfoCard();

  renderOrdersUI();
  renderTaskUI();
  updateStats();
  syncJsonFromConfig();
  updateStatsScreen();
  showScoreToast(message);
}

(function ensureEndOrderAdminBtn() {
  const actions = endOrderDialog.querySelector('.end-order-actions');
  if (!actions) return;
  let b = document.getElementById('endOrderAdmin');
  if (!b) {
    b = document.createElement('button');
    b.id = 'endOrderAdmin';
    b.type = 'button';
    b.className = 'end-order-admin';
        b.textContent = 'Admin';
    actions.insertBefore(b, actions.querySelector('#endOrderConfirm'));
  }
  b.addEventListener('click', enterAdminFromTask);
})();

(function ensureCancelOrderBtn() {
  let btn = document.getElementById('cancelOrderBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'cancelOrderBtn';
    btn.className = 'side-menu-btn danger';
    btn.type = 'button';
        btn.textContent = '🚫 Cancel Order';
    sideMenuPanel.appendChild(btn);
  }
  btn.addEventListener('click', cancelActiveOrder);
})();

// ============================================
// Edit Mode
// Visible only in admin mode; the rack/slot edit panel is shown only after it is turned on,
// and clicking the empty floor -> rack/wall/start point menu is enabled.
// ============================================
let modeBeforeEdit = null;
const modeEditBtn = document.getElementById('modeEdit');
if (modeEditBtn) {
  modeEditBtn.addEventListener('click', () => {
    modeBeforeEdit = ['admin-mode', 'viewer-mode', 'stats-mode', 'orders-mode']
      .find(m => document.body.classList.contains(m)) || 'admin-mode';
    document.body.classList.add('edit-mode');
    sideMenuPanel.classList.remove('open');
    sideMenuToggle.classList.remove('shift');
    closeRackContextMenu();
    closeGroundContextMenu();
    closeGoodsInfoCard();
  });
}

function openAddItemMenu() {
  const menu = document.getElementById('addItemMenu');
  if (menu) menu.classList.add('open');
}

function closeAddItemMenu() {
  const menu = document.getElementById('addItemMenu');
  if (menu) menu.classList.remove('open');
}

const editModeLabel = document.getElementById('editModeLabel');
if (editModeLabel) {
  editModeLabel.addEventListener('click', () => {
    document.body.classList.remove('edit-mode');
    closeRackContextMenu();
    closeGroundContextMenu();
    closeGoodsInfoCard();
  });
}

const addItemBtn = document.getElementById('addItemBtn');
if (addItemBtn) {
  addItemBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddItemMenu();
  });
}

const addItemRackBtn = document.getElementById('addItemRack');
if (addItemRackBtn) addItemRackBtn.addEventListener('click', () => startPlacementMode('rack'));

const addItemWallBtn = document.getElementById('addItemWall');
if (addItemWallBtn) addItemWallBtn.addEventListener('click', () => startPlacementMode('wall'));

const addItemStartBtn = document.getElementById('addItemStart');
if (addItemStartBtn) addItemStartBtn.addEventListener('click', () => startPlacementMode('start'));

document.addEventListener('click', (e) => {
  const menu = document.getElementById('addItemMenu');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && e.target !== addItemBtn) {
    closeAddItemMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && placementMode) {
    cancelPlacementMode();
  }
});

const groundAddRackBtn = document.getElementById('groundAddRack');
if (groundAddRackBtn) groundAddRackBtn.addEventListener('click', handleGroundAddRack);
const groundAddWallBtn = document.getElementById('groundAddWall');
if (groundAddWallBtn) groundAddWallBtn.addEventListener('click', handleGroundAddWall);
const groundSetStartBtn = document.getElementById('groundSetStartPoint');
if (groundSetStartBtn) groundSetStartBtn.addEventListener('click', handleGroundSetStartPoint);

document.addEventListener('click', (e) => {
  const groundMenu = document.getElementById('groundContextMenu');
  if (groundMenu && groundMenu.classList.contains('open') &&
      !groundMenu.contains(e.target) && e.target !== renderer.domElement) {
    closeGroundContextMenu();
  }
});

document.addEventListener('click', (e) => {
  const wallMenu = document.getElementById('wallContextMenu');
  if (wallMenu && wallMenu.classList.contains('open') && !wallMenu.contains(e.target) && e.target !== renderer.domElement) {
    closeWallContextMenu();
  }
});

/* ============================================
   Green warehouse metrics: less walking, less paper (statistics mode only)
   Metric 1: distance saved (A* computed route vs the average route of "random placement")
   Metric 2: paper documents saved (each electronic receiving order replaces one paper form)
   There is also a "batch simulation": it automatically simulates N consecutive put-aways and compares the cumulative distance of different placement methods.
   Note: this simulation does not measure equipment energy use, so electricity use and carbon emissions are not estimated.
   ============================================ */
// Distance conversion: 1 scene unit = 1.5 meters (derived from real warehouse aisle proportions)
const STATS_METERS_PER_UNIT = 1.5;
const PAPER_CO2E_G_PER_SHEET = 4.64; // about 4.64 g CO2e per A4 sheet (literature value)

let lastRouteUnits = 0;
let greenStats = [];
let greenPaperCount = 0;   // number of completed tasks (electronic order replaced paper)

// ---- Route length cache (cleared automatically when the map, start point, walls or racks change) ----
const routeLenCache = new Map();
let routeLenCacheSig = '';

function routeLayoutSignature() {
  const c = config.warehouse;
  return JSON.stringify([
    config.racks.map(r => [r.id, r.col, r.row, r.worldX, r.worldZ]),
    (config.walls || []).map(w => [w.id, w.cellX, w.cellZ, w.worldX, w.worldZ]),
    getActiveStartPoint(),
    c.rackWidth, c.rackDepth, c.floorLength, c.levels, c.slotsPerLevel, c.rackHeight
  ]);
}

function syncRouteLenCache() {
  const sig = routeLayoutSignature();
  if (sig !== routeLenCacheSig) {
    routeLenCache.clear();
    routeLenCacheSig = sig;
  }
  return sig;
}

function getSlotRouteLen(rack, level, slot) {
  const key = rack.id + '|' + level + '|' + slot;
  if (routeLenCache.has(key)) return routeLenCache.get(key);
  const savedSearch = lastSearchData;
  let len = null;
  try {
    const waypoints = computeOptimalPath(rack, level, slot, true);
    if (waypoints) len = pathLength(waypoints);
  } catch (e) {
    len = null;
  }
  lastSearchData = savedSearch;
  routeLenCache.set(key, len);
  return len;
}

// Collect "all slots" whether or not they hold goods (for batch simulation: assume all racks are empty)
function collectAllSlotsForSimulation() {
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));
  const list = [];
  config.racks.forEach(rack => {
    if (!rackPositions[rack.id]) return;
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      for (let s = 0; s < maxSlots; s++) {
        list.push({ rack, level: lvl, slot: s });
      }
    }
  });
  return list;
}

// Collect all empty slots (must be called before the target slot is occupied when a task starts)
function collectEmptySlotsForBaseline() {
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));
  const list = [];
  config.racks.forEach(rack => {
    if (!rackPositions[rack.id]) return;
    ensureOccupancy(rack, maxSlots);
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      for (let s = 0; s < maxSlots; s++) {
        if (!rack.occupancy[lvl][s]) list.push({ rack, level: lvl, slot: s });
      }
    }
  });
  return list;
}

function applyBaselineToEntry(entry, b) {
  entry.randM = b.randomUnits * STATS_METERS_PER_UNIT;
  entry.minM = b.minUnits * STATS_METERS_PER_UNIT;
  entry.slotCount = b.count;
}

// Compute in chunks (at most about 12 ms per chunk) so the screen does not freeze
function scheduleRouteBaseline(task, slots) {
  syncRouteLenCache();
  const lens = [];
  let i = 0;

  const step = () => {
    const t0 = performance.now();
    while (i < slots.length && performance.now() - t0 < 12) {
      const s = slots[i++];
      const len = getSlotRouteLen(s.rack, s.level, s.slot);
      if (Number.isFinite(len)) lens.push(len);
    }
    if (i < slots.length) {
      setTimeout(step, 0);
      return;
    }
    if (lens.length === 0) return;
    const sum = lens.reduce((a, b) => a + b, 0);
    task.baseline = {
      randomUnits: sum / lens.length,
      minUnits: Math.min(...lens),
      count: lens.length
    };
    if (task.greenEntry) {
      applyBaselineToEntry(task.greenEntry, task.baseline);
      updateGreenStats();
    }
  };
  setTimeout(step, 0);
}

function recordGreenStat(task) {
  if (!task || task.greenRecorded) return;
  task.greenRecorded = true;
  greenPaperCount++;
  const units = Number(task.routeUnits);
    if (!Number.isFinite(units) || units <= 0) return;   // multi-order batch tasks are not counted in the single-order distance comparison

  const entry = {
    time: new Date(),
    worker: task.assignedWorker,
    sysM: units * STATS_METERS_PER_UNIT,
    randM: null,
    minM: null,
    slotCount: 0
  };
  greenStats.unshift(entry);
  if (greenStats.length > 500) greenStats.pop();

  task.greenEntry = entry;
  if (task.baseline) applyBaselineToEntry(entry, task.baseline);
}

/* ---------- Batch simulation ----------
      Assumes "all racks are empty" (ignores the goods that are really there),
      does not change real racks, tasks or statistics, and only compares four placement methods in memory:
      1. System placement: same as findBestSlot (find the rack closest to the start point in a straight line, then look for an empty slot from low level, left to right)
      2. Random placement: pick randomly from all reachable empty slots, repeat 200 times and take the average
      3. Fixed order: take the first empty slot following the rack creation order (zone A, zone B...)
      4. Theoretical shortest: the shortest total distance N items can reach (simply take the N shortest empty slots)
      Route length does not depend on whether a slot is occupied, so each slot only needs to be computed once. */
let batchRunning = false;

function getRacksSortedByStartDistance() {
  const start = getActiveStartPoint();
  return config.racks
    .map(rack => ({ rack, pos: rackPositions[rack.id] }))
    .filter(x => x.pos)
    .sort((a, b) =>
      Math.hypot(a.pos.x - start.x, a.pos.z - start.z) -
      Math.hypot(b.pos.x - start.x, b.pos.z - start.z))
    .map(x => x.rack);
}

function batchSlotKey(rack, level, slot) {
  return rack.id + '|' + level + '|' + slot;
}

function batchOrderFromRacks(racks, lenMap, maxLevels, maxSlots) {
  const out = [];
  racks.forEach(rack => {
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      for (let s = 0; s < maxSlots; s++) {
        const len = lenMap.get(batchSlotKey(rack, lvl, s));
        if (Number.isFinite(len)) out.push(len);
      }
    }
  });
  return out;
}

function batchSum(arr, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  return sum;
}

function batchChangeText(base, value) {
    if (!(base > 0)) return '—';
  const d = ((base - value) / base) * 100;
    return d >= 0 ? `${d.toFixed(1)}% less` : `${(-d).toFixed(1)}% more`;
}

function resetBatchResult() {
  const st = document.getElementById('batchStatus');
  const rs = document.getElementById('batchResult');
  if (st) st.textContent = '';
  if (rs) rs.innerHTML = '';
}

function runBatchSimulation() {
  if (batchRunning) return;
  const statusEl = document.getElementById('batchStatus');
  const resultEl = document.getElementById('batchResult');
  const runBtn = document.getElementById('batchRun');
  const nInput = document.getElementById('batchN');
  if (!statusEl || !resultEl || !runBtn || !nInput) return;

  const wantN = Math.max(2, Math.min(200, Math.floor(Number(nInput.value) || 30)));
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));

  const sig = syncRouteLenCache();
    const items = collectAllSlotsForSimulation();   // assume all racks are empty, ignoring the goods currently there
  resultEl.innerHTML = '';
  if (items.length < 2) {
        statusEl.textContent = 'Fewer than 2 slots, cannot simulate.';
    return;
  }

  batchRunning = true;
  runBtn.disabled = true;
  const lenMap = new Map();
  let i = 0;

  const finish = () => {
    batchRunning = false;
    runBtn.disabled = false;
    if (routeLayoutSignature() !== sig) {
            statusEl.textContent = 'The map was changed during calculation, please simulate again.';
      return;
    }
    const usable = items.filter(x => Number.isFinite(lenMap.get(batchSlotKey(x.rack, x.level, x.slot))));
    const n = Math.min(wantN, usable.length);
    if (n < 2) {
            statusEl.textContent = 'Fewer than 2 reachable slots, cannot simulate.';
      return;
    }
    const emptyMap = new Map();
    usable.forEach(x => {
      const k = batchSlotKey(x.rack, x.level, x.slot);
      emptyMap.set(k, lenMap.get(k));
    });

    const sysOrder = batchOrderFromRacks(getRacksSortedByStartDistance(), emptyMap, maxLevels, maxSlots);
    const fixedOrder = batchOrderFromRacks(
      config.racks.filter(r => rackPositions[r.id]), emptyMap, maxLevels, maxSlots);
    const allLens = Array.from(emptyMap.values());
    const sorted = allLens.slice().sort((a, b) => a - b);

    const sysTotal = batchSum(sysOrder, n);
    const fixedTotal = batchSum(fixedOrder, n);
    const optTotal = batchSum(sorted, n);

    const REPS = 200;
    const totals = [];
    for (let r = 0; r < REPS; r++) {
      const arr = allLens.slice();
      for (let k = arr.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        const tmp = arr[k]; arr[k] = arr[j]; arr[j] = tmp;
      }
      totals.push(batchSum(arr, n));
    }
    const randMean = totals.reduce((a, b) => a + b, 0) / REPS;
    const randSd = Math.sqrt(totals.reduce((a, b) => a + (b - randMean) * (b - randMean), 0) / REPS);

    const m = STATS_METERS_PER_UNIT;
    const fmt = (units) => (units * m).toFixed(1);
    const lines = [
            `<li><strong>Result: over ${n} consecutive put-aways, the system walks ${batchChangeText(randMean, sysTotal)} than "random placement" and ` +
                `${batchChangeText(fixedTotal, sysTotal)} than "fixed order".</strong></li>`,
            `<li>System placement: ${fmt(sysTotal)} m in total (average ${fmt(sysTotal / n)} m each)</li>`,
            `<li>Random placement (average of ${REPS} runs): ${fmt(randMean)} m in total (± ${fmt(randSd)} m)</li>`,
            `<li>Fixed-order placement: ${fmt(fixedTotal)} m in total</li>`,
            `<li>Theoretical shortest (reference): ${fmt(optTotal)} m in total; the system walks ${sysTotal >= optTotal ? 'more' : 'less'} than it by ` +
        `${optTotal > 0 ? (Math.abs((sysTotal - optTotal) / optTotal) * 100).toFixed(1) : '0.0'}%</li>`
    ];
    resultEl.innerHTML = `<ul class="stats-log-list">${lines.join('')}</ul>`;
    statusEl.textContent =
            `Done: assuming all racks are empty, simulated ${n} put-aways from ${usable.length} reachable empty slots (one-way distance, 1 unit = ${STATS_METERS_PER_UNIT} m).` +
            `This is a simulation experiment; it does not change the real racks or the statistics above.`;
  };

  const step = () => {
    const t0 = performance.now();
    while (i < items.length && performance.now() - t0 < 12) {
      const x = items[i++];
      lenMap.set(batchSlotKey(x.rack, x.level, x.slot), getSlotRouteLen(x.rack, x.level, x.slot));
    }
        statusEl.textContent = `Calculating routes… ${Math.min(i, items.length)} / ${items.length}`;
    if (i < items.length) {
      setTimeout(step, 0);
      return;
    }
    finish();
  };
    statusEl.textContent = 'Calculating routes…';
  setTimeout(step, 0);
}

/* ---------- Fill all with goods ----------
      Randomly places small / medium / large goods in every "empty" slot.
      Slots that already have goods (or are reserved for an order in progress) are left untouched. */
const FILL_GOODS_TYPES = ['small', 'medium', 'large'];
let fillGoodsSeq = 0;

function fillAllEmptyGoodsRandomly() {
  const statusEl = document.getElementById('fillGoodsStatus');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

  if (hasActiveOrder()) {
        showErrorToast('An order is in progress. End or cancel it before filling with goods');
    return;
  }

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));
  const targets = [];
  config.racks.forEach(rack => {
    ensureOccupancy(rack, maxSlots);
    ensureSlotGoods(rack, maxSlots);
    ensureSlotTypes(rack, maxSlots);
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      for (let s = 0; s < maxSlots; s++) {
        if (!rack.occupancy[lvl][s]) targets.push({ rack, level: lvl, slot: s });
      }
    }
  });

  if (targets.length === 0) {
        setStatus('No empty slots; every slot already has goods.');
    return;
  }

  const ok = window.confirm(
        `Goods of random sizes (small / medium / large) will be placed in ${targets.length} empty slots.\nSlots that already have goods stay unchanged. Continue?`
  );
  if (!ok) return;

  const counts = { small: 0, medium: 0, large: 0 };
  targets.forEach(t => {
    const type = FILL_GOODS_TYPES[Math.floor(Math.random() * FILL_GOODS_TYPES.length)];
    fillGoodsSeq++;
    const record = {
      id: makeSimpleId('g'),
            source: 'Simulated fill',
            model: `Sim-${sizeLabel(type)}-${String(fillGoodsSeq).padStart(3, '0')}`,
      productionOrder: 'FILL',
      sizeCategory: type,
      uid: makeUid()
    };
    goodsRecords.push(record);
    t.rack.occupancy[t.level][t.slot] = true;
    t.rack.slotGoods[t.level][t.slot] = record.id;
    t.rack.slotTypes[t.level][t.slot] = type;
    counts[type]++;
  });

  config.racks.forEach(rack => {
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      rack.levels[lvl] = rack.occupancy[lvl].filter(v => v === true).length;
    }
  });

  rebuildRacks();
  syncJsonFromConfig();
  updateStats();
  updateStatsScreen();
  resetBatchResult();
  setStatus(
        `Filled: added ${targets.length} item(s) (small ${counts.small} / medium ${counts.medium} / large ${counts.large}); existing goods unchanged.`
  );
    showScoreToast(`Filled with goods (added ${targets.length})`);
}

function ensureGreenStatsBlock() {
  let block = document.getElementById('greenStatsBlock');
  if (block) return block;
  const screen = document.getElementById('statsScreen');
  if (!screen) return null;

  block = document.createElement('div');
  block.id = 'greenStatsBlock';
  block.innerHTML = `
        <div class="stats-log-title">Green warehouse metrics: less walking, less paper (simulated)</div>
    <div class="stats-summary">
            <div class="stats-card"><div class="stats-card-label">Put-aways completed</div><div class="stats-card-value" id="greenCount">0</div></div>
            <div class="stats-card"><div class="stats-card-label">Approx. emissions avoided (paper saved)</div><div class="stats-card-value" id="greenPaper">0</div></div>
            <div class="stats-card"><div class="stats-card-label">Distance walked with the system (m)</div><div class="stats-card-value" id="greenSys">0</div></div>
            <div class="stats-card"><div class="stats-card-label">Estimated distance without it (m)</div><div class="stats-card-value" id="greenRand">0</div></div>
            <div class="stats-card"><div class="stats-card-label">Distance saved (%)</div><div class="stats-card-value" id="greenPct">0</div></div>
    </div>
        <div class="stats-log-title">Walking distance of each put-away</div>
    <ul id="greenLogList" class="stats-log-list"></ul>
        <div class="stats-log-title">Batch simulation: automatic put-away experiment</div>
        <p class="help" style="color:#a9b4c0">Automatically simulates N consecutive put-aways and compares the cumulative walking distance of "system placement", "random placement" and "fixed order". The simulation assumes all racks are empty and does not change the real racks.</p>
    <div class="actions" style="margin:8px 0;align-items:center">
            <label for="batchN" style="font-size:13px">Number of runs</label>
      <input id="batchN" type="number" min="2" max="200" value="30" style="width:80px">
            <button class="btn primary" id="batchRun" type="button">Start simulation</button>
    </div>
    <p class="help" id="batchStatus" style="color:#a9b4c0"></p>
    <div id="batchResult"></div>
    <div class="actions" style="margin-top:16px">
            <button class="btn" id="fillGoodsBtn" type="button">Fill with goods</button>
    </div>
        <p class="help" id="fillGoodsStatus" style="color:#a9b4c0">Randomly places small / medium / large goods in all empty slots; slots that already have goods stay unchanged.</p>
  `;
  const firstTitle = screen.querySelector('.stats-log-title');
  const ref = (firstTitle && firstTitle.parentNode === screen) ? firstTitle : null;
  screen.insertBefore(block, ref);

  const runBtn = block.querySelector('#batchRun');
  if (runBtn) runBtn.addEventListener('click', runBatchSimulation);
  const fillBtn = block.querySelector('#fillGoodsBtn');
  if (fillBtn) fillBtn.addEventListener('click', fillAllEmptyGoodsRandomly);
  return block;
}

function updateGreenStats() {
  const block = ensureGreenStatsBlock();
  if (!block) return;

  const compared = greenStats.filter(g => g.randM !== null);
  const sysSum = compared.reduce((a, g) => a + g.sysM, 0);
  const randSum = compared.reduce((a, g) => a + g.randM, 0);
  const savedSum = randSum - sysSum;
  const pct = randSum > 0 ? (savedSum / randSum) * 100 : 0;

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('greenCount', greenPaperCount);
  set('greenPaper', (greenPaperCount * PAPER_CO2E_G_PER_SHEET).toFixed(1));
  set('greenSys', sysSum.toFixed(1));
  set('greenRand', randSum.toFixed(1));
  set('greenPct', pct.toFixed(1));
  
  const list = document.getElementById('greenLogList');
  if (!list) return;
  list.innerHTML = '';
  if (greenStats.length === 0) {
    const li = document.createElement('li');
        li.textContent = 'No completed put-away records yet';
    list.appendChild(li);
    return;
  }
  greenStats.forEach(g => {
    const li = document.createElement('li');
        const head = `${g.time.toLocaleTimeString()} — Worker ${g.worker}: actually walked ${g.sysM.toFixed(1)} m`;
    if (g.randM === null) {
            li.textContent = head + ' (comparison calculating…)';
    } else {
      const p1 = g.randM > 0 ? ((g.randM - g.sysM) / g.randM) * 100 : 0;
      li.textContent =
                `${head} | random placement average ${g.randM.toFixed(1)} m | shortest possible ${g.minM.toFixed(1)} m | ` +
                `${p1.toFixed(1)}% less walking (compared against ${g.slotCount} empty slots)`;
    }
    list.appendChild(li);
  });
}

/* ============================================
   Gamification Module
   ============================================ */

// Score on successful placement: first-try correct +2; corrected after 1 mistake +1; 2 or more mistakes +0 (a wrong placement itself is not penalized)
function awardPlacementScore(task) {
  const wrongCount = task.mismatchCount || 0;
  const pts = wrongCount === 0 ? 2 : (wrongCount === 1 ? 1 : 0);
  if (wrongCount === 0 && Object.prototype.hasOwnProperty.call(workerFirstTry, task.assignedWorker)) {
    workerFirstTry[task.assignedWorker] += 1;
  }
  addScore(pts, task.assignedWorker);
  const label = wrongCount === 0
        ? 'First-try correct'
        : (wrongCount === 1 ? 'Completed after correction' : `Completed after ${wrongCount} mistakes`);
    showScoreToast(`Worker ${task.assignedWorker} ${label} +${pts} pts`);
}

function addScore(points = 1, worker = null) {
  score += points;
  if (worker && Object.prototype.hasOwnProperty.call(workerScores, worker)) {
    workerScores[worker] += points;
  }
    showScoreToast(`+${points} pts`);
  updateStatsScreen();
}

function showScoreToast(text) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.textContent = text;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 600);
  }, 1200);
}

/* ============================================
   Task Assignment Module
   ------------------------------------------------
   Wrong-placement rules:
   - If the UID or position (level/slot) sensed by the RC522 differs from the task in any way, it counts as a "wrong placement"
   - On a wrong placement the task stays pending (it does not become failed) and is marked hadMismatch=true,
       which is used to show a "needs correction" warning on the task card
   - The worker of that task is added to lockedWorkers; until they put the goods back in the correct position
       and the match succeeds, this worker is skipped when new tasks are assigned
   - After a successful match the worker is removed from lockedWorkers and can take new tasks again in turn
   ============================================ */

function makeSimpleId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function makeUid() {
  const hexChars = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < 8; i++) out += hexChars[Math.floor(Math.random() * 16)];
  return out;
}

// Skips any worker currently locked (has an unresolved mismatch to correct).
// If every worker in the pool is locked, returns null so the caller can
// refuse to create a new task instead of assigning to nobody.
function getWorkerPendingTask(w) {
  return tasks.find(t => t.assignedWorker === w && t.status === 'pending') || null;
}

// Busy = has unfinished tasks (including wrong placements waiting for correction)
function isWorkerBusy(w) {
  return lockedWorkers.has(w) || !!getWorkerPendingTask(w);
}

// Dispatch in rotation (001 -> 002 -> 003 -> 001...), skipping busy workers
function nextWorker() {
  const poolSize = workerPool.length;
  for (let i = 0; i < poolSize; i++) {
    const candidateIndex = (workerRoundRobinIndex + i) % poolSize;
    const candidate = workerPool[candidateIndex];
    if (!isWorkerBusy(candidate)) {
      workerRoundRobinIndex = candidateIndex + 1;
      return candidate;
    }
  }
  return null;
}

function findEmptySlot(rack) {
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));
  ensureOccupancy(rack, maxSlots);
  for (let lvl = 0; lvl < maxLevels; lvl++) {
    for (let slot = 0; slot < maxSlots; slot++) {
      if (!rack.occupancy[lvl][slot]) {
        return { level: lvl, slot };
      }
    }
  }
  return null;
}

function renderPendingGoodsUI() {
  const list = document.getElementById('pendingGoodsList');
  if (!list) return;
  list.innerHTML = '';

  if (pendingGoods.length === 0) {
    const li = document.createElement('li');
    li.className = 'task-empty';
        li.textContent = 'No goods waiting to be scanned';
    list.appendChild(li);
    return;
  }

  pendingGoods.forEach(g => {
    const li = document.createElement('li');
    li.className = 'task-card';
    li.innerHTML = `
            <div class="task-card-title">${g.model || '(model not entered)'}</div>
            <div class="task-card-meta">Source: ${g.source || '-'} · PO: ${g.productionOrder || '-'}</div>
      <div class="task-card-actions">
                <button class="btn" data-size="small" data-id="${g.id}">Small</button>
                <button class="btn" data-size="medium" data-id="${g.id}">Medium</button>
                <button class="btn" data-size="large" data-id="${g.id}">Large</button>
      </div>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('button[data-size]').forEach(btn => {
    btn.addEventListener('click', () => {
      simulateLidarScan(btn.getAttribute('data-id'), btn.getAttribute('data-size'));
    });
  });
}

// From all racks pick the slot that is closest to the start point, empty, and reachable by a route
// requireRoute = false: only look at empty slots (for the LiDAR flow, which has no route)
function findBestSlot(requireRoute = true) {
  const start = getActiveStartPoint();
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));

  const racks = config.racks
    .map(r => ({ rack: r, pos: rackPositions[r.id] }))
    .filter(x => x.pos)
    .sort((a, b) =>
      Math.hypot(a.pos.x - start.x, a.pos.z - start.z) -
      Math.hypot(b.pos.x - start.x, b.pos.z - start.z));

  for (const { rack } of racks) {
    ensureOccupancy(rack, maxSlots);
    for (let lvl = 0; lvl < maxLevels; lvl++) {
      for (let slot = 0; slot < maxSlots; slot++) {
        if (rack.occupancy[lvl][slot]) continue;
        if (!requireRoute || computeOptimalPath(rack, lvl, slot, true)) {
          return { rack, level: lvl, slot };
        }
      }
    }
  }
  return null;
}

function renderTaskListUI() {
  const list = document.getElementById('taskList');
  if (!list) return;
  list.innerHTML = '';

  const pendingTasks = tasks.filter(t => t.status === 'pending');

  if (pendingTasks.length === 0) {
    const li = document.createElement('li');
    li.className = 'task-empty';
        li.textContent = 'No tasks waiting to be completed';
    list.appendChild(li);
    return;
  }

  pendingTasks.forEach(t => {
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const zoneLabel = rack ? rackZoneLabel(rack.id) : '?';
    const li = document.createElement('li');
    li.className = 'task-card' + (t.hadMismatch ? ' task-card--mismatch' : '');
    li.innerHTML = `
      <div class="task-card-title">
                <span>${t.model || '(model not entered)'} / UID ${t.uid}</span>
                <span class="task-card-worker">Worker ${t.assignedWorker}</span>
      </div>
      <div class="task-card-meta">
                Size: ${sizeLabel(t.sizeCategory)} · Target: ${zoneLabel} Level ${t.targetLevel + 1}, Slot ${t.targetSlot + 1} · <strong>Task in progress</strong>
      </div>
            ${t.hadMismatch ? `<div class="task-card-mismatch-badge">⚠ Wrong position/UID. Worker ${t.assignedWorker}, please put it in the correct position (Level ${t.targetLevel + 1}, Slot ${t.targetSlot + 1})${t.mismatchCount > 1 ? ` (wrong ${t.mismatchCount} times)` : ''}</div>` : ''}
    `;
    list.appendChild(li);
  });
}

function renderRc522FormOptions() {
  const taskSelect = document.getElementById('rc522Task');
  const levelSelect = document.getElementById('rc522Level');
  const slotSelect = document.getElementById('rc522Slot');
  const uidInput = document.getElementById('rc522Uid');
  if (!taskSelect) return;

  const pendingTasks = tasks.filter(t => t.status === 'pending');
  taskSelect.innerHTML = '';
  if (pendingTasks.length === 0) {
        taskSelect.innerHTML = '<option value="">(No tasks waiting)</option>';
    levelSelect.innerHTML = '';
    slotSelect.innerHTML = '';
    uidInput.value = '';
    return;
  }

  pendingTasks.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.taskId;
        opt.textContent = `${t.model || 'Goods'} / UID ${t.uid} / Worker ${t.assignedWorker}${t.hadMismatch ? ' ⚠ needs correction' : ''}`;
    taskSelect.appendChild(opt);
  });

  const maxLevels = Math.max(1, Math.floor(config.warehouse.levels || 2));
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  levelSelect.innerHTML = '';
  for (let i = 0; i < maxLevels; i++) {
    const opt = document.createElement('option');
    opt.value = i;
        opt.textContent = `Level ${i + 1}`;
    levelSelect.appendChild(opt);
  }
  slotSelect.innerHTML = '';
  for (let s = 0; s < maxSlots; s++) {
    const opt = document.createElement('option');
    opt.value = s;
        opt.textContent = `Slot ${s + 1}`;
    slotSelect.appendChild(opt);
  }

  syncRc522DefaultsFromTask();
}

function syncRc522DefaultsFromTask() {
  const taskSelect = document.getElementById('rc522Task');
  const levelSelect = document.getElementById('rc522Level');
  const slotSelect = document.getElementById('rc522Slot');
  const uidInput = document.getElementById('rc522Uid');
  if (!taskSelect || !taskSelect.value) return;

  const task = tasks.find(t => t.taskId === taskSelect.value);
  if (!task) return;

  levelSelect.value = String(task.targetLevel);
  slotSelect.value = String(task.targetSlot);
  uidInput.value = task.uid;
}

// ============================================
// Order list UI (the "Orders" page)
// ============================================
function renderOrdersBatchBar(visible) {
  const screen = document.getElementById('ordersScreen');
  const list = document.getElementById('ordersList');
  if (!screen || !list) return;
  let bar = document.getElementById('ordersBatchBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ordersBatchBar';
    bar.className = 'orders-batch-bar';
    bar.innerHTML = `
      <span id="ordersBatchInfo"></span>
      <button class="btn primary" id="ordersBatchStart" type="button"></button>
            <button class="btn" id="ordersBatchClear" type="button">Clear selection</button>
    `;
    screen.insertBefore(bar, list);
    bar.querySelector('#ordersBatchStart').addEventListener('click', startBatchFromSelection);
    bar.querySelector('#ordersBatchClear').addEventListener('click', () => {
      selectedOrderIds = new Set();
      renderOrdersUI();
    });
  }
  bar.style.display = visible ? 'flex' : 'none';
  const n = selectedOrderIds.size;
    bar.querySelector('#ordersBatchInfo').textContent = `${n} order(s) selected (at most ${BATCH_MAX_ORDERS} at once)`;
  const startBtn = bar.querySelector('#ordersBatchStart');
    startBtn.textContent = `Start task (${n})`;
  startBtn.disabled = n === 0;
}

function renderOrdersUI() {
  const list = document.getElementById('ordersList');
  if (!list) return;
  list.innerHTML = '';

  selectedOrderIds.forEach(id => {
    if (!orderQueue.some(o => o.orderId === id)) selectedOrderIds.delete(id);
  });

  if (orderQueue.length === 0) {
    const li = document.createElement('li');
    li.className = 'task-empty';
        li.textContent = 'No new orders';
    list.appendChild(li);
    renderOrdersBatchBar(false);
    return;
  }

  orderQueue.forEach(o => {
    const li = document.createElement('li');
    li.className = 'task-card';
    li.innerHTML = `
      <div class="task-card-title">
                <span>${o.itemCode || '(item code not provided)'}</span>
        <span class="task-card-worker">${sizeLabel(o.itemType)}</span>
      </div>
            <div class="task-card-meta">UID: ${o.uid || '-'} · Arrived at: ${o.receivedAt.toLocaleTimeString()}</div>
      <div class="task-card-actions">
        <label class="order-pick">
                    <input type="checkbox" data-pick-order-id="${o.orderId}" ${selectedOrderIds.has(o.orderId) ? 'checked' : ''}> Select
        </label>
                <button class="btn primary" data-order-id="${o.orderId}">Start task</button>
                ${adminRole ? `<button class="btn danger" data-delete-order-id="${o.orderId}">Delete order</button>` : ''}
      </div>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('input[data-pick-order-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-pick-order-id');
      if (cb.checked) {
        if (selectedOrderIds.size >= BATCH_MAX_ORDERS) {
          cb.checked = false;
                    showErrorToast(`At most ${BATCH_MAX_ORDERS} orders at once`);
          return;
        }
        selectedOrderIds.add(id);
      } else {
        selectedOrderIds.delete(id);
      }
      renderOrdersBatchBar(true);
    });
  });

  list.querySelectorAll('button[data-order-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      try {
        startTaskFromOrder(btn.getAttribute('data-order-id'));
      } catch (e) {
        console.error(e);
                showErrorToast('Failed to start task: ' + e.message);
      }
    });
  });

  list.querySelectorAll('button[data-delete-order-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteOrderById(btn.getAttribute('data-delete-order-id'));
    });
  });

  renderOrdersBatchBar(true);
}


// ===== Admin identity record (the orders page removes admin-mode, so it is remembered separately) =====
var adminRole = document.body.classList.contains('admin-mode');
new MutationObserver(() => {
  if (document.body.classList.contains('admin-mode')) adminRole = true;
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
const exitBtnForRole = document.getElementById('exitAdminBtn');
if (exitBtnForRole) exitBtnForRole.addEventListener('click', () => { adminRole = false; });

function deleteOrderById(orderId) {
  if (!adminRole) {
        showErrorToast('Only an admin can delete orders');
    return;
  }
  const idx = orderQueue.findIndex(o => o.orderId === orderId);
  if (idx === -1) return;
  const o = orderQueue[idx];
  const ok = window.confirm(
        `Delete this order?\nItem code: ${o.itemCode || '(item code not provided)'}\nUID: ${o.uid || '-'}\nThis cannot be undone.`
  );
  if (!ok) return;
  orderQueue.splice(idx, 1);
  renderOrdersUI();
    showScoreToast('Order deleted');
}

function startTaskFromOrder(orderId) {
  const idx = orderQueue.findIndex(o => o.orderId === orderId);
  if (idx === -1) return;
  if (hasActiveOrder()) {
        showErrorToast('An order is already in progress. End or cancel it first');
    return; 
  }
  const order = orderQueue[idx];

    if (!config.racks.length) {
        showErrorToast('There are no racks to assign a task to');
    return;
  }
  const target = findBestSlot();
  if (!target) {
        showErrorToast('All racks are full, or there is no reachable empty slot');
    return;
  }
  const rack = target.rack;
  const emptySlot = { level: target.level, slot: target.slot };
  
  const worker = nextWorker();
  if (!worker) {
        showErrorToast('All workers are busy; a new task cannot be assigned for now');
    return;
  }

  const goodsRecord = {
    id: makeSimpleId('g'),
        source: order.itemCode || '(not entered)',
        model: order.itemCode || '(not entered)',
    productionOrder: order.orderId,
    sizeCategory: order.itemType,
    uid: order.uid || makeUid()
  };
  goodsRecords.push(goodsRecord);

  const task = {
    taskId: makeSimpleId('t'),
    goodsId: goodsRecord.id,
    uid: goodsRecord.uid,
    source: goodsRecord.source,
    model: goodsRecord.model,
    productionOrder: goodsRecord.productionOrder,
    sizeCategory: order.itemType,
    targetRackId: rack.id,
    targetLevel: emptySlot.level,
    targetSlot: emptySlot.slot,
    assignedWorker: worker,
    status: 'pending',
    hadMismatch: false,
    mismatchCount: 0
  };
  tasks.push(task);

  const baselineSlots = collectEmptySlotsForBaseline();

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  rack.occupancy[emptySlot.level][emptySlot.slot] = 'reserved';

    orderQueue.splice(idx, 1);
  activeOrderCtx = { order, taskId: task.taskId, goodsId: goodsRecord.id };

  showOptimalPath(rack, emptySlot.level, emptySlot.slot, order.itemType);
  task.routeUnits = lastRouteUnits;
  scheduleRouteBaseline(task, baselineSlots);
    showScoreToast(`${worker} was assigned the task, task in progress`);

  renderOrdersUI();
  renderTaskUI();
  enterTaskMode(); 
}

// --------------------------------------------------
// Optimal route calculation and 3D visualization (uses the configurable start point config.startPoint)
// -------------------------------------------------
function getActiveStartPoint() {
  if (config.startPoint && Number.isFinite(config.startPoint.x) && Number.isFinite(config.startPoint.z)) {
    return config.startPoint;
  }
  return { x: 0, z: -((config.warehouse.floorLength || 24) / 2) + 1 };
}

const SEARCH_COLORS = [0xffc107, 0xff7043, 0xab47bc, 0x26c6da, 0x9ccc65, 0xec407a];
let lastSearchData = null;

function densifyPath(points, step) {
  const out = [{ x: points[0].x, z: points[0].z }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / step));
    for (let j = 1; j <= n; j++) {
      out.push({ x: a.x + (b.x - a.x) * j / n, z: a.z + (b.z - a.z) * j / n });
    }
  }
  return out;
}

function computeOptimalPath(rack, levelIndex, slotIndex, silent = false) {
  const target = slotWorldPosition(rack, levelIndex, slotIndex);
  const pos = rackPositions[rack.id];
  if (!target || !pos) return null;

  const c = config.warehouse;
  const start = getActiveStartPoint();
  const grid = buildPathfindingGrid();
  const gap = 1.2;
  const endOffset = 0.15;

  const approaches = [
    { x: target.x, z: pos.z - c.rackDepth / 2 - gap, endZ: pos.z - c.rackDepth / 2 - endOffset },
    { x: target.x, z: pos.z + c.rackDepth / 2 + gap, endZ: pos.z + c.rackDepth / 2 + endOffset }
  ];

  const tryRoute = (a, opts) => {
    const trace = [];
    const raw = aStarPath(grid, start.x, start.z, a.x, a.z, trace, opts);
    if (!raw) return null;
    const tail = raw[raw.length - 1];
    if (Math.hypot(tail.x - a.x, tail.z - a.z) > 0.6) return null;
    const full = simplifyPath(raw.concat([{ x: target.x, z: a.endZ }]));
    return { a, raw, full, len: pathLength(full), trace };
  };

  let best = null;
  const mains = [];
  approaches.forEach(a => {
    const r = tryRoute(a, null);
    if (!r) return;
    mains.push(r);
    if (!best || r.len < best.len) best = r;
  });

  lastSearchData = null;

  if (!best) {
        if (!silent) showErrorToast('No route found that avoids racks and walls');
    return null;
  }

    // Only generate candidate routes when a route is actually shown (not for the trial calculation when picking slots)
  if (!silent) {
    const cands = [];
    const add = (r, name) => {
      const sig = r.full.map(p => p.x.toFixed(1) + ',' + p.z.toFixed(1)).join('|');
      if (cands.some(x => x.sig === sig)) return;
      cands.push({ r, name, sig });
    };
        add(best, 'Shortest');
        mains.forEach(m => { if (m !== best) add(m, 'Other side'); });

    const addAlt = (opts, name) => {
      const r = tryRoute(best.a, opts);
      if (r) add(r, name);
      return r;
    };
        addAlt({ diagonal: false }, 'Right-angle route');
        addAlt({ weight: 3 }, 'Quick estimate');

    const keySet = new Set();
    const mark = (raw) => raw.forEach(p => {
      const gx = grid.toGridX(p.x), gz = grid.toGridZ(p.z);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) keySet.add((gx + dx) + ',' + (gz + dz));
      }
    });
    mark(best.raw);
        const alt1 = addAlt({ penalty: keySet, penaltyCost: 8 }, 'Detour A');
    if (alt1) {
      mark(alt1.raw);
            addAlt({ penalty: keySet, penaltyCost: 8 }, 'Detour B');
    }

    const kept = cands
      .filter((x, i) => i === 0 || x.r.len <= best.len * 2.5)
      .slice(0, SEARCH_COLORS.length);

    lastSearchData = {
      explore: kept.map((x, i) => ({ trace: x.r.trace, color: SEARCH_COLORS[i] })),
      candidates: kept.map((x, i) => ({
        pts: densifyPath(x.r.full, 0.25),
        len: x.r.len,
        name: x.name,
        color: SEARCH_COLORS[i],
        isBest: i === 0
      }))
    };
  }

  return best.full;
}

function makePathLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0, 180, 200, 0.95)';
  ctx.fillRect(4, 4, 248, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 0.55, 1);
  return sprite;
}

function getPathMidpoint(waypoints) {
  let totalLen = 0;
  const segLens = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const dx = waypoints[i+1].x - waypoints[i].x;
    const dz = waypoints[i+1].z - waypoints[i].z;
    const len = Math.sqrt(dx*dx + dz*dz);
    segLens.push(len);
    totalLen += len;
  }
  let target = totalLen / 2;
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i]) {
      const t = segLens[i] > 0 ? target / segLens[i] : 0;
      return {
        x: waypoints[i].x + (waypoints[i+1].x - waypoints[i].x) * t,
        z: waypoints[i].z + (waypoints[i+1].z - waypoints[i].z) * t
      };
    }
    target -= segLens[i];
  }
  return waypoints[Math.floor(waypoints.length / 2)];
}

// ===== Route search timing (multi-path exploration -> candidate comparison -> pick the shortest) =====
const SEARCH_EXPLORE_MS = 1800;     // Phase 1: multi-path exploration
const SEARCH_CANDIDATE_MS = 1500;   // Phase 2: candidate route comparison
const SEARCH_PICK_MS = 800;         // Phase 3: pick the shortest
const SEARCH_EXPLORE_WIDTH = 0.1;
const SEARCH_TAG_SHOW_EXTRA = true;
let searchAnimEnabled = true;       // set to false to skip the animation
let searchAnimObjects = [];
let searchAnimTweens = [];
let searchAnimToken = 0;

function addSearchObject(obj) {
  rackGroup.add(obj);
  searchAnimObjects.push(obj);
  return obj;
}

function clearSearchAnimation() {
  searchAnimTweens.forEach(t => t.stop());
  searchAnimTweens = [];
  searchAnimObjects.forEach(o => {
    rackGroup.remove(o);
    o.traverse(n => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        if (n.material.map) n.material.map.dispose();
        n.material.dispose();
      }
    });
  });
  searchAnimObjects = [];
}

function makeRibbon(pts, width, color, y, opacity) {
  const segCount = pts.length - 1;
  const pos = new Float32Array(segCount * 6 * 3);
  let k = 0;
  const put = (x, z) => { pos[k++] = x; pos[k++] = y; pos[k++] = z; };
  for (let i = 0; i < segCount; i++) {
    const p = pts[i], q = pts[i + 1];
    const dx = q.x - p.x, dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width / 2, nz = (dx / len) * width / 2;
    put(p.x + nx, p.z + nz); put(p.x - nx, p.z - nz); put(q.x + nx, q.z + nz);
    put(p.x - nx, p.z - nz); put(q.x - nx, q.z - nz); put(q.x + nx, q.z + nz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5;
  return { mesh, segCount };
}

function makeTagSprite(text, hex) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + hex.toString(16).padStart(6, '0');
  ctx.globalAlpha = 0.92;
  ctx.fillRect(4, 4, 248, 56);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(1.9, 0.48, 1);
  sprite.renderOrder = 7;
  return sprite;
}

function playRouteSearchAnimation(data, onDone, token) {
  const alive = () => token === searchAnimToken;

    // Phase 1: several searches explore at the same time (one color each, shown interleaved in expansion order)
  const segs = [];
  data.explore.forEach(s => {
    const n = s.trace.length;
    s.trace.forEach((seg, i) => segs.push({ t: n > 1 ? i / (n - 1) : 0, seg, color: s.color }));
  });
  segs.sort((a, b) => a.t - b.t);

    const pos = new Float32Array(segs.length * 18);
  const col = new Float32Array(segs.length * 18);
  const tmp = new THREE.Color();
  segs.forEach((s, i) => {
    const dx = s.seg.x2 - s.seg.x1, dz = s.seg.z2 - s.seg.z1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * SEARCH_EXPLORE_WIDTH / 2;
    const nz = (dx / len) * SEARCH_EXPLORE_WIDTH / 2;
    const y = 0.035;
    pos.set([
      s.seg.x1 + nx, y, s.seg.z1 + nz,
      s.seg.x1 - nx, y, s.seg.z1 - nz,
      s.seg.x2 + nx, y, s.seg.z2 + nz,
      s.seg.x1 - nx, y, s.seg.z1 - nz,
      s.seg.x2 - nx, y, s.seg.z2 - nz,
      s.seg.x2 + nx, y, s.seg.z2 + nz
    ], i * 18);
    tmp.set(s.color);
    for (let k = 0; k < 6; k++) col.set([tmp.r, tmp.g, tmp.b], i * 18 + k * 3);
  });
  const egeo = new THREE.BufferGeometry();
  egeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  egeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  egeo.setDrawRange(0, 0);
  const exploreLines = addSearchObject(new THREE.Mesh(
    egeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false
    })
  ));
  exploreLines.renderOrder = 4;

    // Candidate routes used in phase 2 (thick lines) and the leading dots
  const cands = data.candidates.map(cd => {
    const rb = makeRibbon(cd.pts, cd.isBest ? 0.16 : 0.11, cd.color, 0.045, cd.isBest ? 0.95 : 0.8);
    addSearchObject(rb.mesh);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 8),
      new THREE.MeshBasicMaterial({ color: cd.color, depthTest: false })
    );
    head.renderOrder = 6;
    head.position.set(cd.pts[0].x, 0.15, cd.pts[0].z);
    addSearchObject(head);
    return { cd, rb, head, tag: null };
  });
  const maxN = Math.max(...cands.map(x => x.cd.pts.length));

  const s1 = { t: 0 };
  const tween1 = new TWEEN.Tween(s1)
    .to({ t: 1 }, SEARCH_EXPLORE_MS)
    .easing(TWEEN.Easing.Quadratic.Out)
    .onUpdate(() => {
      if (!alive()) return;
      egeo.setDrawRange(0, Math.floor(s1.t * segs.length) * 2);
    })
    .onComplete(() => {
      if (!alive()) return;
      egeo.setDrawRange(0, segs.length * 2);
    });

    const s2 = { t: 0 };
  const tween2 = new TWEEN.Tween(s2)
    .to({ t: 1 }, SEARCH_CANDIDATE_MS)
    .easing(TWEEN.Easing.Linear.None)
    .onStart(() => {
      if (alive()) exploreLines.material.opacity = 0.35;
    })
    .onUpdate(() => {
      if (!alive()) return;
      cands.forEach(x => {
        const n = x.cd.pts.length;
        const idx = Math.min(n - 1, Math.floor(s2.t * maxN));
        x.rb.mesh.geometry.setDrawRange(0, idx * 6);
        const p = x.cd.pts[idx];
        x.head.position.set(p.x, 0.15, p.z);
      });
    })
    .onComplete(() => {
      if (!alive()) return;
      const bestLen = data.candidates[0].len;
      cands.forEach((x, i) => {
        x.rb.mesh.geometry.setDrawRange(0, x.rb.segCount * 6);
        if (x.cd.isBest) return;
        const extra = (x.cd.len - bestLen) * STATS_METERS_PER_UNIT;
        const total = x.cd.len * STATS_METERS_PER_UNIT;
        const meters = (SEARCH_TAG_SHOW_EXTRA ? extra : total).toFixed(1);
                const tag = makeTagSprite('Detour ' + meters + ' m', x.cd.color);
        const mp = x.cd.pts[Math.floor(x.cd.pts.length * 0.5)];
        tag.position.set(mp.x, 0.9 + i * 0.5, mp.z);
        addSearchObject(tag);
        x.tag = tag;
      });
    });


  const s3 = { t: 0 };
  const tween3 = new TWEEN.Tween(s3)
    .to({ t: 1 }, SEARCH_PICK_MS)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .onStart(() => {
      if (!alive()) return;
      cands.forEach(x => {
        x.head.visible = false;
                if (x.cd.isBest) x.rb.mesh.material.color.set(0x00e5ff);   // the shortest route turns cyan
      });
    })
    .onUpdate(() => {
      if (!alive()) return;
      exploreLines.material.opacity = 0.35 - 0.23 * s3.t;
      cands.forEach(x => {
        if (!x.cd.isBest) x.rb.mesh.material.opacity = 0.8 - 0.65 * s3.t;
      });
    })
    .onComplete(() => {
      if (!alive()) return;
      cands.forEach(x => { if (x.tag) x.tag.visible = false; });
      onDone();
    });

  tween1.chain(tween2);
  tween2.chain(tween3);
  searchAnimTweens.push(tween1, tween2, tween3);
  tween1.start();
}

function showOptimalPath(rack, levelIndex, slotIndex, goodsType) {
  hideOptimalPath();
  const token = searchAnimToken;

  showDestinationHighlight(rack);
  showGhostGoods(rack, levelIndex, slotIndex, goodsType);

  lastRouteUnits = 0;
  const waypoints = computeOptimalPath(rack, levelIndex, slotIndex);
  if (!waypoints) return;
  lastRouteUnits = pathLength(waypoints);
  const data = lastSearchData;

  const drawFinal = () => {
    if (token !== searchAnimToken) return;

    const points = waypoints.map(p => new THREE.Vector3(p.x, 0.05, p.z));

    const slot = slotWorldPosition(rack, levelIndex, slotIndex);
    const size = (config.goodsSizes && config.goodsSizes[goodsType]) || config.goodsSizes.large;
    if (slot) {
      const midY = slot.y + size.height / 2 + 0.08;
      const last = waypoints[waypoints.length - 1];
      points.push(new THREE.Vector3(last.x, midY, last.z));
      points.push(new THREE.Vector3(slot.x, midY, slot.z));
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, transparent: true, opacity: 0.95 });
    pathLine = new THREE.Line(geo, mat);
    rackGroup.add(pathLine);

    const mid = getPathMidpoint(waypoints);
    const zoneLabel = rackZoneLabel(rack.id);
    pathLabelSprite = makePathLabel('-> ' + slotLabel(rack.id, levelIndex, slotIndex));
    pathLabelSprite.position.set(mid.x, 1.4, mid.z);
    rackGroup.add(pathLabelSprite);
  };

  if (searchAnimEnabled && data && data.candidates.length > 0 && data.explore.length > 0) {
    playRouteSearchAnimation(data, drawFinal, token);
  } else {
    drawFinal();
  }
}

function hideOptimalPath() {
  searchAnimToken++;
  clearSearchAnimation();
  if (pathLine) {
    rackGroup.remove(pathLine);
    pathLine.geometry.dispose();
    pathLine.material.dispose();
    pathLine = null;
  }
  if (pathLabelSprite) {
    rackGroup.remove(pathLabelSprite);
    pathLabelSprite.material.map.dispose();
    pathLabelSprite.material.dispose();
    pathLabelSprite = null;
  }
  hideDestinationHighlight();
  hideGhostGoods();
  hideBatchHighlights();
}

function hideGhostGoods() {
  if (ghostGoodsTween) { ghostGoodsTween.stop(); ghostGoodsTween = null; }
  if (ghostGoodsMesh) {
    rackGroup.remove(ghostGoodsMesh);
    ghostGoodsMesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    ghostGoodsMesh = null;
  }
}

function showDestinationHighlight(rack) {
  hideDestinationHighlight();
  const pos = rackPositions[rack.id];
  if (!pos) return;
  const c = config.warehouse;
  const geo = new THREE.BoxGeometry(c.rackWidth + 0.4, c.rackHeight + 0.4, c.rackDepth + 0.4);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0xff9500, transparent: true, opacity: 1, depthTest: false });
  destinationHighlightMesh = new THREE.LineSegments(edges, mat);
  destinationHighlightMesh.position.set(pos.x, c.rackHeight / 2, pos.z);
  rackGroup.add(destinationHighlightMesh);

  destinationHighlightTween = new TWEEN.Tween(mat)
    .to({ opacity: 0.3 }, 500)
    .repeat(Infinity)
    .yoyo(true)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .start();
}

function hideDestinationHighlight() {
  if (destinationHighlightTween) { destinationHighlightTween.stop(); destinationHighlightTween = null; }
  if (destinationHighlightMesh) {
    rackGroup.remove(destinationHighlightMesh);
    destinationHighlightMesh.geometry.dispose();
    destinationHighlightMesh.material.dispose();
    destinationHighlightMesh = null;
  }
}

function renderTaskUI() {
  renderPendingGoodsUI();
  renderTaskListUI();
  renderRc522FormOptions();
  renderOrdersUI();
}

// ===== RFID card UID: after pressing "Scan card", wait for a physical card tap =====
// After pressing the button it waits; the UID of the next card tapped on a reader is filled into the field automatically.
// Accepted sources:
//   1. Dedicated card-read message  { type: 'card_read', uid }
//   2. ESP32-A writer station { type: 'write_complete', uid, status: 'success' } (no order is created while waiting)
//   3. Shelf reader ESP32-B: not accepted by default (to avoid stealing the placement confirmation); set the value below to true to accept it
const UID_CAPTURE_TIMEOUT_MS = 30000;
const UID_CAPTURE_ACCEPT_SHELF = false;
let uidCapture = { active: false, timer: null };

function setUidCaptureUI(active, statusText) {
  const btn = document.getElementById('goodsUidScan');
  const st = document.getElementById('goodsUidStatus');
    if (btn) btn.textContent = active ? 'Cancel waiting' : 'Scan card';
  if (st) st.textContent = statusText || '';
}

function stopUidCapture(statusText) {
  uidCapture.active = false;
  if (uidCapture.timer) { clearTimeout(uidCapture.timer); uidCapture.timer = null; }
  setUidCaptureUI(false, statusText || '');
}

function startUidCapture() {
    if (uidCapture.active) { stopUidCapture('Cancelled'); return; }
  if (!esp32Socket || esp32Socket.readyState !== WebSocket.OPEN) {
        showErrorToast('ESP32 is not connected, cannot read the card; try again later or type the UID directly');
    return;
  }
  uidCapture.active = true;
    setUidCaptureUI(true, `Tap a card on the reader… (within ${UID_CAPTURE_TIMEOUT_MS / 1000} seconds)`);
  uidCapture.timer = setTimeout(
        () => stopUidCapture('Timed out. Press "Scan card" again or type it directly'),
    UID_CAPTURE_TIMEOUT_MS
  );
}

// While waiting for a card tap, take the next card-read message that carries a UID; returns true if the message was used and needs no further handling
function tryCaptureUid(data) {
  if (!uidCapture.active || !data || !data.uid) return false;
  const isCardRead = data.type === 'card_read';
  const isWriter = data.type === 'write_complete' && (!data.status || data.status === 'success');
  const isShelf = UID_CAPTURE_ACCEPT_SHELF && 'level' in data && 'slot' in data && data.detected !== false;
  if (!(isCardRead || isWriter || isShelf)) return false;

  const uid = String(data.uid).trim().toUpperCase();
  const input = document.getElementById('goodsUid');
  if (input) input.value = uid;
    stopUidCapture(`Read: ${uid}`);
    showScoreToast(`Card UID read: ${uid}`);
  return true;
}

// ===== Goods registration (manual entry) =====
// The operator fills in the goods data (model, PO, size, RFID card UID); after submitting, a put-away task is created directly.
// LiDAR scanning is no longer simulated: the size is chosen by hand and the UID is typed in (or read from a physical card via "Scan card").
function submitGoodsEntry() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  const source = getVal('goodsSource');
  const model = getVal('goodsModel');
  const productionOrder = getVal('goodsPO');
  const sizeCategory = getVal('goodsSize');
  const uid = getVal('goodsUid').toUpperCase();

    if (!model) { showErrorToast('Please enter the model'); return; }
    if (!productionOrder) { showErrorToast('Please enter the Production Order'); return; }
    if (!['small', 'medium', 'large'].includes(sizeCategory)) { showErrorToast('Please select the goods size'); return; }
    if (!uid) { showErrorToast('Please enter the UID of the RFID card (you can press "Scan card")'); return; }

    // The UID must be unique (registered goods and orders in the list both count)
  const uidTaken =
    goodsRecords.some(g => String(g.uid || '').toUpperCase() === uid) ||
    orderQueue.some(o => String(o.uid || '').toUpperCase() === uid);
    if (uidTaken) { showErrorToast('This UID is already in use, please check the RFID card'); return; }

    if (!config.racks.length) { showErrorToast('There are no racks to assign a task to'); return; }
  const target = findBestSlot(false);
    if (!target) { showErrorToast('All racks are full'); return; }

  const worker = nextWorker();
    if (!worker) { showErrorToast('All workers are busy; a new task cannot be assigned for now'); return; }

  const rack = target.rack;
  const goodsRecord = {
    id: makeSimpleId('g'),
        source: source || '(not entered)',
    model,
    productionOrder,
    sizeCategory,
    uid
  };
  goodsRecords.push(goodsRecord);

  tasks.push({
    taskId: makeSimpleId('t'),
    goodsId: goodsRecord.id,
    uid,
    source: goodsRecord.source,
    model,
    productionOrder,
    sizeCategory,
    targetRackId: rack.id,
    targetLevel: target.level,
    targetSlot: target.slot,
    assignedWorker: worker,
    status: 'pending',
    hadMismatch: false,
    mismatchCount: 0
  });

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  rack.occupancy[target.level][target.slot] = 'reserved';

  ['goodsSource', 'goodsModel', 'goodsPO', 'goodsUid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const sizeEl = document.getElementById('goodsSize');
  if (sizeEl) sizeEl.value = '';
  stopUidCapture('');

  const where = (typeof slotLabel === 'function')
    ? slotLabel(rack.id, target.level, target.slot)
        : `Level ${target.level + 1}, Slot ${target.slot + 1}`;
    showScoreToast(`Task assigned to worker ${worker}, slot ${where}`);
  renderTaskUI();
}

function simulateLidarScan(pendingId, sizeCategory) {
  const idx = pendingGoods.findIndex(g => g.id === pendingId);
  if (idx === -1) return;
  const pending = pendingGoods[idx];

  if (!config.racks.length) {
        showErrorToast('There are no racks to assign a task to');
    return;
  }
  const target = findBestSlot(false);
  if (!target) {
        showErrorToast('All racks are full');
    return;
  }
  const rack = target.rack;
  const emptySlot = { level: target.level, slot: target.slot };

  const worker = nextWorker();
  if (!worker) {
        showErrorToast('All workers are busy; a new task cannot be assigned for now');
    return;
  }

  const uid = makeUid();
  const goodsRecord = {
    id: pending.id,
    source: pending.source,
    model: pending.model,
    productionOrder: pending.productionOrder,
    sizeCategory,
    uid
  };
  goodsRecords.push(goodsRecord);
  pendingGoods.splice(idx, 1);

  const task = {
    taskId: makeSimpleId('t'),
    goodsId: goodsRecord.id,
    uid,
    source: goodsRecord.source,
    model: goodsRecord.model,
    productionOrder: goodsRecord.productionOrder,
    sizeCategory,
    targetRackId: rack.id,
    targetLevel: emptySlot.level,
    targetSlot: emptySlot.slot,
    assignedWorker: worker,
    status: 'pending',
    hadMismatch: false,
    mismatchCount: 0
  };
  tasks.push(task);

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  rack.occupancy[emptySlot.level][emptySlot.slot] = 'reserved';

    showScoreToast(`Task assigned to worker ${worker}`);
  renderTaskUI();
}

function confirmRc522Sensing() {
  const taskSelect = document.getElementById('rc522Task');
  const levelSelect = document.getElementById('rc522Level');
  const slotSelect = document.getElementById('rc522Slot');
  const uidInput = document.getElementById('rc522Uid');

  const taskId = taskSelect.value;
  const task = tasks.find(t => t.taskId === taskId);
  if (!task) {
        showErrorToast('Please select a task first');
    return;
  }

  const actualLevel = Number(levelSelect.value);
  const actualSlot = Number(slotSelect.value);
  const actualUid = uidInput.value.trim().toUpperCase();

  const rack = config.racks.find(r => r.id === task.targetRackId);
  const success = rack &&
    actualLevel === task.targetLevel &&
    actualSlot === task.targetSlot &&
    actualUid === task.uid;

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  ensureSlotGoods(rack, maxSlots);

  if (success) {
    task.status = 'done';
    recordGreenStat(task);
    lockedWorkers.delete(task.assignedWorker);
    rack.occupancy[actualLevel][actualSlot] = true;
    rack.slotGoods[actualLevel][actualSlot] = task.goodsId;
    rack.levels[actualLevel] = (rack.levels[actualLevel] || 0) + 1;

    const rowGroup = config.racks.filter(r => r.col === rack.col).sort((a, b) => a.row - b.row);
    const rowPosIndex = rowGroup.findIndex(r => r.id === rack.id);
    placeGoodsAnimation(rack, actualLevel, actualSlot, task.sizeCategory, rowPosIndex, rowGroup.length, task.goodsId);

    awardPlacementScore(task);
    afterPlacementVisuals(task);
  } else {
    // Placed wrong (UID or level/slot mismatch): keep the task pending and
    // require this worker to correct it. Lock this worker from receiving a
    // new task until they place the correct goods at the correct slot.
    task.status = 'pending';
    task.hadMismatch = true;
    task.mismatchCount = (task.mismatchCount || 0) + 1;
    lockedWorkers.add(task.assignedWorker);
    // The reserved slot stays reserved (not released) since the task is
    // still outstanding and must end up there.

        showErrorToast(`Worker ${task.assignedWorker} placed it wrongly: please put the goods back on rack ${rack ? rackZoneLabel(rack.id) : '?'} Level ${task.targetLevel + 1}, Slot ${task.targetSlot + 1}, UID must be ${task.uid}`);
  }

  taskCompletionLog.unshift({
    time: new Date(),
    worker: task.assignedWorker,
    row: rack ? rack.row : '?',
    col: rack ? rack.col : '?',
    level: actualLevel,
    slot: actualSlot,
    success,
    correctionNeeded: !success
  });
  if (taskCompletionLog.length > 200) taskCompletionLog.pop();

  syncJsonFromConfig();
  updateStats();
  renderTaskUI();
  updateStatsScreen();
}

document.getElementById('submitGoods').addEventListener('click', submitGoodsEntry);
const goodsUidScanBtn = document.getElementById('goodsUidScan');
if (goodsUidScanBtn) goodsUidScanBtn.addEventListener('click', startUidCapture);
document.getElementById('confirmRc522').addEventListener('click', confirmRc522Sensing);
document.getElementById('rc522Task').addEventListener('change', syncRc522DefaultsFromTask);

/* ============================================
   Initialization (runs after all functions and state declarations)
   ============================================ */
fitRenderer();
syncFormFromConfig();
syncJsonFromConfig();
setCameraFromConfig();
rebuildRacks();
animate();

/* ===== Map list (from the GitHub repository deployed on the Render server) ===== */
const MAP_API_BASE = 'https://warehouse-server-mv0z.onrender.com';
let currentMapName = null;

function markActiveMap(name) {
  document.querySelectorAll('.map-item').forEach(b => {
    b.classList.toggle('active', b.textContent === name);
  });
}

async function loadMapList() {
  const box = document.getElementById('mapListBox');
  if (!box) return;
    box.innerHTML = '<div class="map-empty">Loading… (it may take a moment while the server wakes up)</div>';
  try {
    const res = await fetch(MAP_API_BASE + '/api/maps');
    const data = await res.json();
    box.innerHTML = '';
    if (!data.maps || data.maps.length === 0) {
            box.innerHTML = '<div class="map-empty">No map files found. Put JSON files into the maps folder of the repository</div>';
      return;
    }
    data.maps.forEach(m => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-item' + (m.name === currentMapName ? ' active' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => loadMapByFile(m));
      box.appendChild(btn);
    });
  } catch (e) {
    console.error(e);
        box.innerHTML = '<div class="map-empty">Failed to load the map list. Press "Refresh list"</div>';
  }
}

async function loadMapByFile(m) {
  if (hasActiveOrder()) {
        showErrorToast('An order is in progress. End or cancel it before switching maps');
    return;
  }
  try {
    const res = await fetch(MAP_API_BASE + '/maps/' + encodeURIComponent(m.file));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
        JSON.parse(text);                       // first check that the JSON format is valid

        // Before switching maps, clear the task state of the old map
    tasks = [];
    goodsRecords = [];
    pendingGoods = [];
    greenStats = [];
    greenPaperCount = 0;
    resetBatchResult();
    lockedWorkers.clear();
    activeOrderCtx = null;
    hideOptimalPath();

    document.getElementById('jsonEditor').value = text;
    applyJsonToConfig();

        // Clear the "reserved" slots left over in the map
    config.racks.forEach(r => (r.occupancy || []).forEach(level => {
      level.forEach((v, i) => { if (v === 'reserved') level[i] = false; });
    }));
    syncJsonFromConfig();

    renderTaskUI();
    currentMapName = m.name;
    markActiveMap(m.name);
        showScoreToast('Map loaded: ' + m.name);
  } catch (e) {
    console.error(e);
        showErrorToast('Failed to load map: ' + m.name);
  }
}

const mapRefreshBtn = document.getElementById('mapRefresh');
if (mapRefreshBtn) mapRefreshBtn.addEventListener('click', loadMapList);
loadMapList();

const WS_URL = 'wss://warehouse-server-mv0z.onrender.com';

let esp32Socket = null;
let esp32ReconnectTimer = null;

function connectEsp32WebSocket() {
  esp32Socket = new WebSocket(WS_URL);

  esp32Socket.onopen = () => {
        console.log('[ESP32] Connected to the warehouse server');
    updateEsp32StatusUI(true);
  };

  esp32Socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
            console.error('[ESP32] Cannot parse message:', event.data);
      return;
    }
    handleEsp32Message(data);
  };

  esp32Socket.onclose = () => {
        console.warn('[ESP32] Connection lost, retrying in 5 seconds...');
    updateEsp32StatusUI(false);
    esp32ReconnectTimer = setTimeout(connectEsp32WebSocket, 5000);
  };

  esp32Socket.onerror = (err) => {
        console.error('[ESP32] WebSocket error:', err);
    esp32Socket.close();
  };
}

function handleEsp32Message(data) {
    // While waiting for a physical card tap to fill the UID, let the card-read message be taken first (no order is created and no placement is checked)
  if (tryCaptureUid(data)) return;

  if (data.type === 'hello') {
    console.log('[ESP32]', data.message);
    return;
  }

  if (data.type === 'write_complete') {
        // ESP32-A laser classification + RFID write complete
    // data: { type, uid, itemCode, itemType, status }
        console.log('[ESP32-A] Write complete:', data);
    handleWriteComplete(data);
    return;
  }

  if ('level' in data && 'slot' in data && 'uid' in data) {
        // ESP32-B shelf reader data
    // data: { level, slot, uid, detected }
        console.log('[ESP32-B] Shelf position update:', data);
    handleShelfDetection(data);
    return;
  }

    console.log('[ESP32] Received unclassified message:', data);
}

// --------------------------------------------------
// ESP32-A write complete: only logged for now, does not affect task state
// (write complete = goods are ready to be carried, not yet placed on a rack)
// --------------------------------------------------
function handleWriteComplete(data) {
  if (data.status !== 'success') {
        showErrorToast(`RFID write failed: ${data.itemCode || data.uid}`);
    return;
  }

  const order = {
    orderId: makeSimpleId('o'),
    uid: data.uid || '',
    itemCode: data.itemCode || '',
    itemType: data.itemType || 'large',
    receivedAt: new Date()
  };
  orderQueue.unshift(order);

    showNewOrderToast(`New order arrived: ${order.itemCode || order.uid}`);
  renderOrdersUI();
}

function showNewOrderToast(text) {
  const toast = document.createElement('div');
  toast.className = 'new-order-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 600);
  }, 2200);
}

// --------------------------------------------------
// ESP32-B shelf read: maps to the existing confirmRc522Sensing() matching logic
// Reuses the existing tasks / config / addScore / showScoreToast / showErrorToast directly
// --------------------------------------------------
function handleShelfDetection(data) {
  const { level, slot, uid, detected } = data;

  if (!detected) {
        // Card was removed; not handled in the current version, may be added later
    return;
  }

  const actualUid = String(uid).trim().toUpperCase();

    // Among all pending tasks, find the one whose targetLevel/targetSlot matches this position
    // Only level and slot are compared (ESP32-B does not report a rack number).
    // If several batch tasks share the same level/slot, use the UID to find which one it is.
  const candidates = tasks.filter(t => t.status === 'pending' && t.targetLevel === level && t.targetSlot === slot);
  const task = candidates.find(t => String(t.uid).toUpperCase() === actualUid) || candidates[0];

  if (!task) {
        // No task matches this position; ignore without reporting an error (follows section 5 of the spec)
        console.log(`[ESP32-B] level=${level}, slot=${slot} has no matching pending task, ignored`);
    return;
  }

  const rack = config.racks.find(r => r.id === task.targetRackId);
  const success = actualUid === task.uid.toUpperCase();

  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  ensureOccupancy(rack, maxSlots);
  ensureSlotGoods(rack, maxSlots);

  if (success) {
    task.status = 'done';
    recordGreenStat(task);
    lockedWorkers.delete(task.assignedWorker);
    rack.occupancy[level][slot] = true;
    rack.slotGoods[level][slot] = task.goodsId;
    rack.levels[level] = (rack.levels[level] || 0) + 1;

    const rowGroup = config.racks.filter(r => r.col === rack.col).sort((a, b) => a.row - b.row);
    const rowPosIndex = rowGroup.findIndex(r => r.id === rack.id);

    placeGoodsAnimation(rack, level, slot, task.sizeCategory, rowPosIndex, rowGroup.length, task.goodsId);

    awardPlacementScore(task);
    afterPlacementVisuals(task);
  } else {
    task.status = 'pending';
    task.hadMismatch = true;
    task.mismatchCount = (task.mismatchCount || 0) + 1;
    lockedWorkers.add(task.assignedWorker);

        showErrorToast(`${task.assignedWorker} wrong position or UID mismatch, please correct`);
  }

  taskCompletionLog.unshift({
    time: new Date(),
    worker: task.assignedWorker,
    row: rack ? rack.row : '?',
    col: rack ? rack.col : '?',
    level,
    slot,
    success,
    correctionNeeded: !success
  });
  if (taskCompletionLog.length > 200) taskCompletionLog.pop();

  syncJsonFromConfig();
  updateStats();
  renderTaskUI();
  updateStatsScreen();
}

// --------------------------------------------------
// Connection status display (optional: add an element with id="esp32Status" to the HTML)
// --------------------------------------------------
function updateEsp32StatusUI(isConnected) {
  const el = document.getElementById('esp32Status');
  if (el) {
        el.textContent = isConnected ? 'ESP32 connected' : 'ESP32 connection lost, retrying...';
    el.style.color = isConnected ? 'green' : 'red';
  }
}

// ============================================
// Notify ESP32-B of the tasks in progress (light the LEDs, start card reading)
// Compares the "in-progress task" list once per second and sends it to the server only when it changes (completion, wrong placement and cancellation also update automatically).
// Sending happens in the background and does not wait for the ESP32; the 3D view is shown at the same time as usual.
// ============================================
const ESP32_HTTP_BASE = 'https://warehouse-server-mv0z.onrender.com';
// false: the LEDs light as soon as a task is created (when the 3D highlight appears); true: batch orders wait until "Start Order" is pressed
const ESP32_GUIDE_AFTER_ROUTE_START = false;
const ESP32_HEARTBEAT_MS = 30000;
let esp32TaskSig = '';
let esp32TaskSentAt = 0;
let esp32TaskInFlight = false;
let esp32TaskRetryAt = 0;

function collectEsp32Tasks() {
  const inReview = typeof batchCtx !== 'undefined' && batchCtx && batchCtx.stage === 'review';
  if (ESP32_GUIDE_AFTER_ROUTE_START && inReview) return [];
  return tasks
    .filter(t => t.status === 'pending')
    .map(t => ({
      taskId: t.taskId,
      uid: String(t.uid || '').toUpperCase(),
      level: t.targetLevel,
      slot: t.targetSlot,
      mismatch: !!t.hadMismatch
    }));
}

function syncTasksToEsp32() {
  if (esp32TaskInFlight || Date.now() < esp32TaskRetryAt) return;
  const list = collectEsp32Tasks();
  const sig = JSON.stringify(list);
  const heartbeatDue = list.length > 0 && Date.now() - esp32TaskSentAt > ESP32_HEARTBEAT_MS;
  if (sig === esp32TaskSig && !heartbeatDue) return;

  esp32TaskInFlight = true;
  fetch(ESP32_HTTP_BASE + '/api/esp32/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: list.length > 0, tasks: list })
  })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      esp32TaskSig = sig;
      esp32TaskSentAt = Date.now();
    })
    .catch(err => {
            console.warn('[ESP32] Task sync failed, retrying in 5 seconds:', err.message);
      esp32TaskRetryAt = Date.now() + 5000;
    })
    .finally(() => { esp32TaskInFlight = false; });
}
setInterval(syncTasksToEsp32, 1000);

connectEsp32WebSocket();

/* ============================================
   Multi-order batch intake
   1. Tick several orders on the orders page -> press "Start task" -> enter the 3D view; highlight frames mark the racks to visit and the slots show the goods shape
   2. Top right: "Start Order" (find the route) / "Change Order" (go back to the orders page to reselect)
   3. Number of routes in the search animation = 2x that of a single rack, drawn only as lines while searching (no distance shown)
   4. Finally: a "line" on the floor shows the shortest route through all racks, and "arrows" on the racks point at the slots
   ============================================ */
const BATCH_ROUTE_LINES = SEARCH_COLORS.length * 2;   // a single rack animation has at most 6 lines, a batch has 2x
const BATCH_SEARCH_MS = 3000;
const BATCH_PICK_MS = 800;

function ensureBatchUI() {
  if (!document.getElementById('batchStyles')) {
    const st = document.createElement('style');
    st.id = 'batchStyles';
    st.textContent = `
      #batchActionBar { display: none; position: fixed; top: 16px; right: 16px; z-index: 1600; gap: 10px; }
      body.task-mode.batch-review #batchActionBar { display: flex; }
      #batchActionBar button {
        padding: 12px 22px; border-radius: 999px; border: 1px solid var(--border);
        font-weight: 800; font-size: 14px; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); background: var(--surface); color: var(--text);
      }
      #batchActionBar #batchStartBtn { background: #22c55e; border-color: #22c55e; color: #fff; }
      .orders-batch-bar {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        margin: 0 0 14px; padding: 12px 14px; background: #1d2733; border-radius: 10px; color: #f3f0e8;
      }
      .orders-batch-bar #ordersBatchInfo { margin-right: auto; font-size: 14px; }
      .order-pick { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; margin-right: auto; }
      .order-pick input { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: #22c55e; }
    `;
    document.head.appendChild(st);
  }
  if (!document.getElementById('batchActionBar')) {
    const bar = document.createElement('div');
    bar.id = 'batchActionBar';
    bar.innerHTML = `
            <button id="batchStartBtn" type="button">Start Order</button>
            <button id="batchChangeBtn" type="button">Change Order</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#batchStartBtn').addEventListener('click', runBatchRoute);
    bar.querySelector('#batchChangeBtn').addEventListener('click', changeBatchOrders);
  }
}
ensureBatchUI();

function setBatchStage(stage) {
  document.body.classList.toggle('batch-review', stage === 'review');
  if (batchCtx) batchCtx.stage = stage;
}

// ---------- Accept orders after ticking ----------
function startBatchFromSelection() {
  const ids = Array.from(selectedOrderIds).filter(id => orderQueue.some(o => o.orderId === id));
  if (ids.length === 0) {
        showErrorToast('Please tick the orders to accept first');
    return;
  }
  if (ids.length === 1) {
    selectedOrderIds = new Set();
    startTaskFromOrder(ids[0]);
    return;
  }
  try {
    startBatchOrders(ids);
  } catch (e) {
    console.error(e);
        showErrorToast('Failed to accept orders: ' + e.message);
  }
}

function startBatchOrders(ids) {
  if (hasActiveOrder()) {
        showErrorToast('An order is already in progress. End or cancel it first');
    return;
  }
  if (!config.racks.length) {
        showErrorToast('There are no racks to assign a task to');
    return;
  }
  if (ids.length > BATCH_MAX_ORDERS) {
        showErrorToast(`At most ${BATCH_MAX_ORDERS} orders at once`);
    return;
  }
  const orders = ids.map(id => orderQueue.find(o => o.orderId === id)).filter(Boolean);
  if (orders.length < 2) return;

  const rrBackup = workerRoundRobinIndex;
  const worker = nextWorker();
  if (!worker) {
        showErrorToast('All workers are busy; a new task cannot be assigned for now');
    return;
  }

    // Pick empty slots one by one and reserve them first, so that each order gets a different slot
  const maxSlots = Math.max(1, Math.floor(config.warehouse.slotsPerLevel || 3));
  const picked = [];
  const rollback = () => {
    picked.forEach(pk => {
      if (pk.rack.occupancy[pk.level][pk.slot] === 'reserved') pk.rack.occupancy[pk.level][pk.slot] = false;
    });
    workerRoundRobinIndex = rrBackup;
  };
  for (const order of orders) {
    const target = findBestSlot();
    if (!target) {
      rollback();
            showErrorToast('Not enough empty slots to accept this many orders at once');
      return;
    }
    ensureOccupancy(target.rack, maxSlots);
    target.rack.occupancy[target.level][target.slot] = 'reserved';
    picked.push({ order, rack: target.rack, level: target.level, slot: target.slot });
  }

  const batchTasks = picked.map(pk => {
    const goodsRecord = {
      id: makeSimpleId('g'),
            source: pk.order.itemCode || '(not entered)',
            model: pk.order.itemCode || '(not entered)',
      productionOrder: pk.order.orderId,
      sizeCategory: pk.order.itemType,
      uid: pk.order.uid || makeUid()
    };
    goodsRecords.push(goodsRecord);
    const task = {
      taskId: makeSimpleId('t'),
      goodsId: goodsRecord.id,
      uid: goodsRecord.uid,
      source: goodsRecord.source,
      model: goodsRecord.model,
      productionOrder: goodsRecord.productionOrder,
      sizeCategory: pk.order.itemType,
      targetRackId: pk.rack.id,
      targetLevel: pk.level,
      targetSlot: pk.slot,
      assignedWorker: worker,
      status: 'pending',
      hadMismatch: false,
      mismatchCount: 0,
      batch: true
    };
    tasks.push(task);
    return task;
  });

  ids.forEach(id => {
    const idx = orderQueue.findIndex(o => o.orderId === id);
    if (idx >= 0) orderQueue.splice(idx, 1);
  });
  selectedOrderIds = new Set();

  activeOrderCtx = {
    batch: true,
    order: orders[0],
    taskId: batchTasks[0].taskId,
    goodsId: batchTasks[0].goodsId,
    orders,
    taskIds: batchTasks.map(t => t.taskId)
  };
  batchCtx = { orders, tasks: batchTasks, stage: 'review', plan: null };

  renderOrdersUI();
  renderTaskUI();
  updateStats();
  syncJsonFromConfig();
  enterTaskMode();
  refreshBatchHighlights();
  showBatchSlotMarkers();
  setBatchStage('review');
    showScoreToast(`${worker} accepted ${batchTasks.length} orders. Check the racks, then press "Start Order"`);
}

// ---------- 3D markers (highlight frames, slot boxes, names, arrows pointing at slots) ----------
function clearBatchHighlightMeshes() {
  batchHighlights.forEach(h => {
    h.tween.stop();
    rackGroup.remove(h.mesh);
    h.mesh.geometry.dispose();
    h.mesh.material.dispose();
  });
  batchHighlights = [];
}

function removeBatchLabel(obj) {
  if (obj.userData && obj.userData.tween) obj.userData.tween.stop();
  rackGroup.remove(obj);
  obj.traverse(n => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) {
      if (n.material.map) n.material.map.dispose();
      n.material.dispose();
    }
  });
}

function hideBatchHighlights() {
  clearBatchHighlightMeshes();
  batchStopLabels.forEach(removeBatchLabel);
  batchStopLabels = [];
}

// Rack highlight frames (completed slots lose their box, label and arrow; the floor route line stays until everything is done)
function refreshBatchHighlights() {
  clearBatchHighlightMeshes();
  if (!batchCtx) return;
  const pending = batchCtx.tasks.filter(t => t.status === 'pending');
  const c = config.warehouse;
  const seen = new Set();
  pending.forEach(t => {
    if (seen.has(t.targetRackId)) return;
    seen.add(t.targetRackId);
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const pos = rack ? rackPositions[rack.id] : null;
    if (!pos) return;
    const geo = new THREE.BoxGeometry(c.rackWidth + 0.4, c.rackHeight + 0.4, c.rackDepth + 0.4);
    const edges = new THREE.EdgesGeometry(geo);
    geo.dispose();
    const mat = new THREE.LineBasicMaterial({ color: 0xff9500, transparent: true, opacity: 1, depthTest: false });
    const mesh = new THREE.LineSegments(edges, mat);
    mesh.position.set(pos.x, c.rackHeight / 2, pos.z);
    mesh.renderOrder = 998;
    rackGroup.add(mesh);
    const tween = new TWEEN.Tween(mat)
      .to({ opacity: 0.3 }, 500)
      .repeat(Infinity)
      .yoyo(true)
      .easing(TWEEN.Easing.Quadratic.InOut)
      .start();
    batchHighlights.push({ mesh, tween });
  });
  const pendingIds = new Set(pending.map(t => t.taskId));
  batchStopLabels = batchStopLabels.filter(o => {
    if (pendingIds.has(o.userData.taskId)) return true;
    removeBatchLabel(o);
    return false;
  });
}

// After a successful placement: if the batch still has unfinished tasks only update the markers; clear all displays once everything is done
function afterPlacementVisuals(task) {
  if (batchCtx && batchCtx.tasks.includes(task)) {
    const remaining = batchCtx.tasks.filter(t => t.status === 'pending');
    if (remaining.length > 0) {
      refreshBatchHighlights();
      return;
    }
    batchCtx = null;
    document.body.classList.remove('batch-review');
  }
  hideOptimalPath();
  finishOrderIfDone();
}

// All goods of the order placed: return to the normal Viewer mode (do not stay on the task / start-order screen)
function finishOrderIfDone() {
  if (!activeOrderCtx || hasActiveOrder()) return;
  if (document.body.classList.contains('task-mode')) {
        // Wait a moment so the placement animation and score toast show first
    setTimeout(() => {
      if (activeOrderCtx && !hasActiveOrder()) exitTaskMode();
    }, 800);
  } else {
    activeOrderCtx = null;
    document.body.classList.remove('order-active');
  }
}

// Big label (drawn above the rack so the rack does not block it)
function makeBigTag(text, hex) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + hex.toString(16).padStart(6, '0');
  ctx.globalAlpha = 0.95;
  ctx.fillRect(6, 6, 500, 116);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#111111';
  let fontSize = 64;
  ctx.font = `bold ${fontSize}px sans-serif`;
  while (ctx.measureText(text).width > 470 && fontSize > 28) {
    fontSize -= 4;
    ctx.font = `bold ${fontSize}px sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 66);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(4.4, 1.1, 1);
  sprite.renderOrder = 999;
  return sprite;
}

// Target slot: shown as "what the goods look like" (cyan semi-transparent goods box, blinking)
function ensureBatchGhosts() {
  if (!batchCtx) return;
  batchCtx.tasks.filter(t => t.status === 'pending').forEach(t => {
    if (batchStopLabels.some(o => o.userData.kind === 'ghost' && o.userData.taskId === t.taskId)) return;
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const target = rack ? slotWorldPosition(rack, t.targetLevel, t.targetSlot) : null;
    if (!target) return;
    const size = config.goodsSizes?.[t.sizeCategory] || config.goodsSizes?.large;

    const geo = new THREE.BoxGeometry(size.width, size.height, size.depth);
    const mat = new THREE.MeshStandardMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55, depthTest: false });
    const ghost = new THREE.Mesh(geo, mat);
    ghost.position.set(target.x, target.y + size.height / 2 + 0.08, target.z);
    ghost.renderOrder = 998;
    ghost.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false })
    ));
    ghost.userData.taskId = t.taskId;
    ghost.userData.kind = 'ghost';
    ghost.userData.tween = new TWEEN.Tween(mat)
      .to({ opacity: 0.2 }, 600)
      .repeat(Infinity)
      .yoyo(true)
      .easing(TWEEN.Easing.Quadratic.InOut)
      .start();
    rackGroup.add(ghost);
    batchStopLabels.push(ghost);
  });
}

// Slot box + slot name (shown above the rack)
function showBatchSlotMarkers() {
  if (!batchCtx) return;
  ensureBatchGhosts();
  const c = config.warehouse;
  const stack = {};
  batchCtx.tasks.filter(t => t.status === 'pending').forEach(t => {
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const target = rack ? slotWorldPosition(rack, t.targetLevel, t.targetSlot) : null;
    const pos = rack ? rackPositions[rack.id] : null;
    if (!target || !pos) return;
    if (batchStopLabels.some(o => o.userData.kind === 'label' && o.userData.taskId === t.taskId)) return;

    const n = stack[rack.id] || 0;
    stack[rack.id] = n + 1;
    const tag = makeBigTag(slotLabel(rack.id, t.targetLevel, t.targetSlot), 0x00e5ff);
    tag.position.set(target.x, c.rackHeight + 1.4 + n * 1.3, pos.z);
    tag.userData.taskId = t.taskId;
    tag.userData.kind = 'label';
    rackGroup.add(tag);
    batchStopLabels.push(tag);
  });
}

// Arrow: thin shaft + cone head, pointing from a to b
function makeBatchArrow(a, b, shaftR, headR, maxHead) {
  const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = dir.length() || 0.01;
  const dirN = dir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const headLen = Math.min(maxHead, len * 0.55);
  const shaftLen = Math.max(0.01, len - headLen);

  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.95 });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 10), mat);
  shaft.position.set(a.x + dirN.x * shaftLen / 2, a.y + dirN.y * shaftLen / 2, a.z + dirN.z * shaftLen / 2);
  shaft.quaternion.setFromUnitVectors(up, dirN);
  shaft.renderOrder = 997;
  group.add(shaft);

  const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 16), mat);
  head.position.set(b.x - dirN.x * headLen / 2, b.y - dirN.y * headLen / 2, b.z - dirN.z * headLen / 2);
  head.quaternion.setFromUnitVectors(up, dirN);
  head.renderOrder = 997;
  group.add(head);

  return group;
}

// Thin line from the end of the floor route straight up to the arrow
function makeBatchStem(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 0.01;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, len, 8),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.6 })
  );
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  mesh.renderOrder = 996;
  return mesh;
}

// ---------- Route calculation: the shortest route through all racks ----------
function computeBatchPlan(pendingTasks, onDone) {
  const c = config.warehouse;
  const start = getActiveStartPoint();
  const grid = buildPathfindingGrid();
  const gap = 1.2;

  const stops = [];
  for (const t of pendingTasks) {
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const pos = rack ? rackPositions[rack.id] : null;
    const target = rack ? slotWorldPosition(rack, t.targetLevel, t.targetSlot) : null;
    if (!pos || !target) { onDone(null); return; }
    stops.push({
      task: t, rack, level: t.targetLevel, slot: t.targetSlot,
      sides: [
        { x: target.x, z: pos.z - c.rackDepth / 2 - gap },
        { x: target.x, z: pos.z + c.rackDepth / 2 + gap }
      ]
    });
  }

    // Nodes: 0 = start point; 1 + i*2 + s = the aisle entrance on side s of the i-th slot
  const nodes = [{ x: start.x, z: start.z }];
  stops.forEach(s => s.sides.forEach(pt => nodes.push(pt)));

  const pairs = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (a > 0 && Math.floor((a - 1) / 2) === Math.floor((b - 1) / 2)) continue;
      pairs.push([a, b]);
    }
  }

  const segs = new Map();
  let idx = 0;
  const step = () => {
    const t0 = performance.now();
    while (idx < pairs.length && performance.now() - t0 < 12) {
      const [a, b] = pairs[idx++];
      let seg = null;
      const raw = aStarPath(grid, nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z, null, null);
      if (raw) {
        const tail = raw[raw.length - 1];
        if (Math.hypot(tail.x - nodes[b].x, tail.z - nodes[b].z) <= 0.6) {
          const pts = simplifyPath([{ x: nodes[a].x, z: nodes[a].z }].concat(raw, [{ x: nodes[b].x, z: nodes[b].z }]));
          seg = { pts, len: pathLength(pts) };
        }
      }
      segs.set(a + '-' + b, seg);
    }
    if (idx < pairs.length) {
      setTimeout(step, 0);
      return;
    }
    onDone(buildBatchPlan(stops, nodes, segs));
  };
  setTimeout(step, 0);
}

function buildBatchPlan(stops, nodes, segs) {
  const k = stops.length;
  const segOf = (u, v) => {
    const s = segs.get(u < v ? u + '-' + v : v + '-' + u);
    if (!s) return null;
    return { len: s.len, pts: u < v ? s.pts : s.pts.slice().reverse() };
  };

    // List all combinations of "visiting order x which side of each rack to use" and compute the total distance
  const combos = [];
  const order = [];
  const used = new Array(k).fill(false);
  const rec = () => {
    if (order.length === k) {
      for (let mask = 0; mask < (1 << k); mask++) {
        let prev = 0, total = 0, ok = true;
        const seq = [0];
        for (let i = 0; i < k; i++) {
          const node = 1 + order[i] * 2 + ((mask >> i) & 1);
          const s = segOf(prev, node);
          if (!s) { ok = false; break; }
          total += s.len;
          prev = node;
          seq.push(node);
        }
        if (ok) combos.push({ seq, total });
      }
      return;
    }
    for (let i = 0; i < k; i++) {
      if (used[i]) continue;
      used[i] = true; order.push(i);
      rec();
      order.pop(); used[i] = false;
    }
  };
  rec();
  if (combos.length === 0) return null;

  combos.sort((a, b) => a.total - b.total);
  const best = combos[0];
  const picked = combos.filter(cb => cb.total <= best.total * 3).slice(0, BATCH_ROUTE_LINES);

  const buildPts = (cb) => {
    let pts = [];
    for (let i = 0; i < cb.seq.length - 1; i++) {
      const s = segOf(cb.seq[i], cb.seq[i + 1]);
      pts = pts.concat(i === 0 ? s.pts : s.pts.slice(1));
    }
    return pts;
  };

  return {
    stops,
    nodes,
    bestSeq: best.seq,
    order: best.seq.slice(1).map(n => Math.floor((n - 1) / 2)),
    candidates: picked.map((cb, i) => ({
      pts: densifyPath(buildPts(cb), 0.25),
      color: SEARCH_COLORS[i % SEARCH_COLORS.length],
      isBest: i === 0
    }))
  };
}

// ---------- Start Order / Change Order ----------
function runBatchRoute() {
  if (!batchCtx || batchCtx.stage !== 'review') return;
  const pending = batchCtx.tasks.filter(t => t.status === 'pending');
  if (pending.length === 0) return;

  const ctx = batchCtx;
  setBatchStage('computing');
    showScoreToast('Finding the shortest route through all racks…');
  computeBatchPlan(pending, plan => {
        if (batchCtx !== ctx) return;          // cancelled during the calculation
    if (!plan) {
            showErrorToast('No route found that visits all racks');
      setBatchStage('review');
      return;
    }
    clearSearchAnimation();
    const token = ++searchAnimToken;
    ctx.plan = plan;
    setBatchStage('running');
    playBatchSearchAnimation(plan, cands => finishBatchRoute(plan, token, cands), token);
  });
}

function changeBatchOrders() {
  if (!batchCtx || batchCtx.stage !== 'review') return;
  const ids = batchCtx.orders.map(o => o.orderId);
    cancelActiveOrder();                       // release reserved slots, put orders back in the list, return to the orders page
    selectedOrderIds = new Set(ids);           // keep the original selection so it is easy to edit
  renderOrdersUI();
    showScoreToast('Back to the order list. You can pick orders again');
}

// ---------- Route search animation (draws lines only, no distance shown) ----------
function playBatchSearchAnimation(plan, onDone, token) {
  const alive = () => token === searchAnimToken;

  const cands = plan.candidates.map((cd, i) => {
    const rb = makeRibbon(cd.pts, cd.isBest ? 0.16 : 0.11, cd.color, 0.045 + (i % 4) * 0.002, cd.isBest ? 0.95 : 0.8);
    addSearchObject(rb.mesh);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 8),
      new THREE.MeshBasicMaterial({ color: cd.color, depthTest: false })
    );
    head.renderOrder = 6;
    head.position.set(cd.pts[0].x, 0.15, cd.pts[0].z);
    addSearchObject(head);
    return { cd, rb, head };
  });
  const maxN = Math.max(...cands.map(x => x.cd.pts.length));

  const s1 = { t: 0 };
  const tween1 = new TWEEN.Tween(s1)
    .to({ t: 1 }, BATCH_SEARCH_MS)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .onUpdate(() => {
      if (!alive()) return;
      cands.forEach(x => {
        const n = x.cd.pts.length;
        const idx = Math.min(n - 1, Math.floor(s1.t * maxN));
        x.rb.mesh.geometry.setDrawRange(0, idx * 6);
        const p = x.cd.pts[idx];
        x.head.position.set(p.x, 0.15, p.z);
      });
    })
    .onComplete(() => {
      if (!alive()) return;
      cands.forEach(x => x.rb.mesh.geometry.setDrawRange(0, x.rb.segCount * 6));
    });

  const s2 = { t: 0 };
  const tween2 = new TWEEN.Tween(s2)
    .to({ t: 1 }, BATCH_PICK_MS)
    .easing(TWEEN.Easing.Quadratic.InOut)
    .onStart(() => {
      if (!alive()) return;
      cands.forEach(x => {
        x.head.visible = false;
                if (x.cd.isBest) x.rb.mesh.material.color.set(0x00e5ff);   // the nearest route turns cyan
      });
    })
    .onUpdate(() => {
      if (!alive()) return;
      cands.forEach(x => {
        if (!x.cd.isBest) x.rb.mesh.material.opacity = 0.8 - 0.65 * s2.t;
      });
    })
    .onComplete(() => {
      if (!alive()) return;
      onDone(cands);
    });

  tween1.chain(tween2);
  searchAnimTweens.push(tween1, tween2);
  tween1.start();
}

function finishBatchRoute(plan, token, cands) {
  if (token !== searchAnimToken) return;

    // Keep the "nearest route" line on the floor; remove the other candidate routes and leading dots
  cands.forEach(x => {
    const removeList = x.cd.isBest ? [x.head] : [x.rb.mesh, x.head];
    removeList.forEach(o => {
      rackGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      const i = searchAnimObjects.indexOf(o);
      if (i >= 0) searchAnimObjects.splice(i, 1);
    });
  });

  ensureBatchGhosts();

    // Replace the original slot names with big labels that carry the visiting order
  batchStopLabels = batchStopLabels.filter(o => {
    if (o.userData.kind !== 'label') return true;
    removeBatchLabel(o);
    return false;
  });

  const c = config.warehouse;
  const stack = {};
  plan.order.forEach((stopIdx, n) => {
    const st = plan.stops[stopIdx];
    const pt = plan.nodes[plan.bestSeq[n + 1]];
    const target = slotWorldPosition(st.rack, st.level, st.slot);
    const pos = rackPositions[st.rack.id];
    if (!target || !pos) return;

    const k = stack[st.rack.id] || 0;
    stack[st.rack.id] = k + 1;
    const tag = makeBigTag(`${n + 1}. ${slotLabel(st.rack.id, st.level, st.slot)}`, 0x00e5ff);
    tag.position.set(target.x, c.rackHeight + 1.4 + k * 1.3, pos.z);
    tag.userData.taskId = st.task.taskId;
    tag.userData.kind = 'label';
    rackGroup.add(tag);
    batchStopLabels.push(tag);

        // On the rack: in front of the slot, at the same height, place an arrow pointing at the slot; connect it with a thin line back to the end of the floor route
    const size = config.goodsSizes?.[st.task.sizeCategory] || config.goodsSizes?.large;
    const slotY = target.y + size.height / 2 + 0.08;
    const sign = pt.z < pos.z ? -1 : 1;
    const faceZ = target.z + sign * (size.depth / 2 + 0.1);
    const pointer = new THREE.Group();
    pointer.add(makeBatchArrow(
      { x: target.x, y: slotY, z: pt.z },
      { x: target.x, y: slotY, z: faceZ },
      0.09, 0.4, 0.8
    ));
    pointer.add(makeBatchStem(
      { x: pt.x, y: 0.1, z: pt.z },
      { x: target.x, y: slotY, z: pt.z }
    ));
    pointer.userData.taskId = st.task.taskId;
    pointer.userData.kind = 'pointer';
    rackGroup.add(pointer);
    batchStopLabels.push(pointer);
  });

  setBatchStage('route');
    showScoreToast(`Found the shortest route through ${plan.stops.length} slots`);
}

// ===== Live worker status bar (green = available, yellow = working) =====
var workerStatusBarSig = '';
function updateWorkerStatusBar() {
  const box = document.getElementById('workerStatusList');
  if (!box) return;
  const info = workerPool.map(w => {
    const list = tasks.filter(t => t.assignedWorker === w && t.status === 'pending');
        if (list.length === 0) return { w, busy: false, text: 'Available', sub: '' };
    const t = list[0];
    const rack = config.racks.find(r => r.id === t.targetRackId);
    const spot = list.length > 1
            ? `${list.length} tasks`
      : (rack ? slotLabel(rack.id, t.targetLevel, t.targetSlot) : '');
    const needFix = list.some(x => x.hadMismatch);
        return { w, busy: true, text: needFix ? 'Needs correction' : 'Working', sub: spot };
  });
  const sig = JSON.stringify(info);
  if (sig === workerStatusBarSig) return;
  workerStatusBarSig = sig;
  const chipsHtml = info.map(i => `
    <div class="worker-chip ${i.busy ? 'busy' : 'idle'}">
      <span class="worker-dot"></span>
            <span class="worker-name">Worker ${i.w}</span>
            <span class="worker-state">${i.text}${i.sub ? ' · ' + i.sub : ''}</span>
    </div>`).join('');
  box.innerHTML = chipsHtml;

    // Viewer mode: top left inside the 3D view, 001, 002, 003 from top to bottom
  let vbar = document.getElementById('viewerWorkerBar');
  if (!vbar) {
    vbar = document.createElement('div');
    vbar.id = 'viewerWorkerBar';
    vbar.className = 'viewer-worker-bar';
    (document.querySelector('.viewer') || document.body).appendChild(vbar);
  }
  vbar.innerHTML = chipsHtml;
}

// Viewer mode: score box at the top right inside the 3D view (always shown, even at 0)
var viewerScoreSig = '';
function updateViewerScoreBox() {
  let box = document.getElementById('viewerScoreBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'viewerScoreBox';
    box.className = 'viewer-score-box';
    (document.querySelector('.viewer') || document.body).appendChild(box);
  }
  const sig = workerPool.map(w => workerScores[w] || 0).join(',');
  if (sig === viewerScoreSig && box.innerHTML) return;
  viewerScoreSig = sig;
  box.innerHTML = workerPool.map(w => `
    <div class="vs-row">
            <span class="vs-name">Worker ${w}</span>
      <span class="vs-score">${workerScores[w] || 0}</span>
    </div>`).join('');
}

setInterval(updateWorkerStatusBar, 500);
setInterval(updateViewerScoreBox, 300);
updateWorkerStatusBar();
updateViewerScoreBox();
