window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installCaveModule = function installCaveModule(bot) {
  // Every CaveBot module load gets a new generation. Old timer callbacks can
  // survive a reload long enough to fire once; generation checks make those
  // stale callbacks harmless even if the previous instance was not destroyed.
  const caveRuntime = window.__minibiaCaveRuntime || { generation: 0 };
  caveRuntime.generation += 1;
  window.__minibiaCaveRuntime = caveRuntime;
  const caveGeneration = caveRuntime.generation;
  const isCurrentCaveGeneration = () => window.__minibiaCaveRuntime?.generation === caveGeneration;
  // Remove the old waypoint-tolerance pathfinder wrapper if it is still
  // present in the current game runtime from an earlier module load.
  // This restores the native pathfinder for every CaveBot pathing mode.
  try {
    const pathfinder = window.gameClient?.world?.pathfinder;
    if (pathfinder?.findPath?.__caveWaypointTolerancePatched &&
        typeof pathfinder.findPath.__originalFindPath === "function") {
      pathfinder.findPath = pathfinder.findPath.__originalFindPath;
    }
  } catch (_) {}
  const configStorageKey = "minibiaBot.cave.config";
  const routeStorageKey = "minibiaBot.cave.route";
  const transitionStorageKey = "minibiaBot.cave.transitions";
  const presetStorageKey = "minibiaBot.cave.presets";
  const defaultPresetName = "Default";
  const minimapOverlayRootId = "minibia-bot-cave-minimap-overlay";
  const minimapOverlayStyleId = "minibia-bot-cave-minimap-overlay-style";
  const ladderItemIds = new Set([1948, 1968]);
  const ropeNamePattern = /\brope\b/i;
  const shovelNamePattern = /\bshovel\b/i;
  const shovelTargetNamePatterns = [
    /\bstone pile\b/i,
    /\bloose stone pile\b/i,
    /\bgravel pile\b/i,
    /\bdirt pile\b/i,
  ];
  // CaveBot field walking uses the same fire-field definition as the
  // existing "Walk Over Fields" toggle. When enabled, pathfinding treats
  // fire-field tiles as walkable instead of returning "no way".
  // Support both the classic Tibia field IDs and the older OTServer-style IDs.
  const FIRE_FIELD_IDS = new Set([
    1487, 1488, 1489,
    1492, 1493, 1494,
    1500, 1501, 1502,
    2118, 2119, 2120,
    2123, 2124, 2125,
    2131, 2132, 2133,
  ]);
  const FIRE_FIELD_PATTERN = /(?:fire|flame)\s*(?:field|wall|damage|ground|tile)/i;
  // Poison fields are intentionally treated as walkable by CaveBot. They are
  // damage tiles, not blockers, so pathing must be allowed to cross them.
  // Classic Tibia poison-field stages. Some servers use the newer 1503 stage too.
  const POISON_FIELD_IDS = new Set([2127]);
  const POISON_FIELD_PATTERN = /(?:poison|venom)\s*(?:field|wall|damage|ground|tile)/i;
  // These three fire-field stages are always treated as ordinary walkable
  // squares by every CaveBot pathing mode, independent of the Walk Over Fields toggle.
  const ALWAYS_WALKABLE_FIRE_FIELD_IDS = new Set([2123, 2124, 2125]);
  const state = {
    running: false,
    timerId: null,
    observerTimerId: null,
    currentIndex: 0,
    direction: 1,
    lastPathAt: 0,
    lastPositionKey: null,
    lastProgressAt: 0,
    lastStairsUseAt: 0,
    lastObservedPosition: null,
    pendingTransitionSource: null,
    ropeLockedTarget: null,
    ropeLockedApproach: null,
    ropeUsePending: false,
    ropeUsePendingAt: 0,
    ropeUsePendingTarget: null,
    pausedForCombat: false,
    tickCount: 0,
  };
  const minimapOverlayState = {
    timerId: null,
    lastViewportKey: null,
  };

  const storedConfig = bot.storage.get(configStorageKey, {}) || {};
  if (Object.prototype.hasOwnProperty.call(storedConfig, "waypointTolerance")) {
    delete storedConfig.waypointTolerance;
    bot.storage.set(configStorageKey, storedConfig);
  }

  const config = Object.assign(
    {
      tickMs: 200,
      repathMs: 1500,
      enabled: false,
      activePresetName: defaultPresetName,
      pathfinderMode: 'game',
      walkOverFields: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 200;

  function normalizePresetName(value) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    return normalized || null;
  }

  function cloneValue(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function normalizePreset(value) {
    if (!value) {
      return null;
    }

    const name = normalizePresetName(value.name);
    if (!name) {
      return null;
    }

    return {
      name,
      route: normalizeRoute(value.route),
      transitions: normalizeTransitions(value.transitions),
    };
  }

  function normalizePresets(value) {
    const entries = Array.isArray(value) ? value : [];
    const deduped = new Map();

    entries.map(normalizePreset).filter(Boolean).forEach((preset) => {
      deduped.set(preset.name.toLowerCase(), preset);
    });

    return Array.from(deduped.values());
  }

  let route = normalizeRoute(bot.storage.get(routeStorageKey, []));
  let transitions = normalizeTransitions(bot.storage.get(transitionStorageKey, []));
  let presets = normalizePresets(bot.storage.get(presetStorageKey, []));

  if (!presets.length && (route.length || transitions.length)) {
    presets = [{
      name: defaultPresetName,
      route: route.map((waypoint) => cloneValue(waypoint)),
      transitions: transitions.map((transition) => cloneValue(transition)),
    }];
  }

  function getPresetNames() {
    return presets.map((preset) => preset.name);
  }

  function getPresetByName(name) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) {
      return null;
    }

    return presets.find((preset) => preset.name.toLowerCase() === normalizedName.toLowerCase()) || null;
  }

  function getActivePresetName() {
    const configuredName = normalizePresetName(config.activePresetName);
    if (configuredName && getPresetByName(configuredName)) {
      return getPresetByName(configuredName).name;
    }

    if (presets.length) {
      return presets[0].name;
    }

    return configuredName || defaultPresetName;
  }

  function persistPresets() {
    bot.storage.set(
      presetStorageKey,
      presets.map((preset) => ({
        name: preset.name,
        route: preset.route.map((waypoint) => ({ ...waypoint })),
        transitions: preset.transitions.map((transition) => cloneValue(transition)),
      }))
    );
  }

  function persistLegacyActivePreset() {
    bot.storage.set(routeStorageKey, route.map((waypoint) => ({ ...waypoint })));
    bot.storage.set(transitionStorageKey, transitions.map((transition) => cloneValue(transition)));
  }

  function setActivePresetName(name) {
    config.activePresetName = normalizePresetName(name) || defaultPresetName;
    persistConfig();
    return config.activePresetName;
  }

  function upsertPreset(name, nextRoute = route, nextTransitions = transitions) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) {
      return null;
    }

    const preset = {
      name: normalizedName,
      route: normalizeRoute(nextRoute).map((waypoint) => cloneValue(waypoint)),
      transitions: normalizeTransitions(nextTransitions).map((transition) => cloneValue(transition)),
    };
    const existingIndex = presets.findIndex((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase());

    if (existingIndex >= 0) {
      presets[existingIndex] = preset;
    } else {
      presets.push(preset);
    }

    persistPresets();
    return preset;
  }

  function persistActivePreset() {
    upsertPreset(getActivePresetName(), route, transitions);
    persistLegacyActivePreset();
  }

  function loadPresetState(name) {
    const preset = getPresetByName(name);
    if (!preset) {
      return null;
    }

    route = normalizeRoute(preset.route);
    transitions = normalizeTransitions(preset.transitions);
    state.currentIndex = 0;
    state.direction = 1;
    state.pendingTransitionSource = null;
    setActivePresetName(preset.name);
    persistLegacyActivePreset();
    return preset;
  }

  const initialActivePreset = getActivePresetName();
  if (loadPresetState(initialActivePreset)) {
    config.activePresetName = initialActivePreset;
  } else {
    setActivePresetName(initialActivePreset);
  }

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function persistRoute() {
    persistActivePreset();
  }

  function normalizePosition(value) {
    if (!value) {
      return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
    };
  }

  const PATHFINDER_CONFIG = {
    pathCacheTTL: 2000,
    matrixCacheTTL: 2000,
  };

  const pathCache = new Map();
  const matrixCache = new Map();

  function findBestIndex(openSet) {
    let bestIndex = 0;
    let bestF = openSet[0].f;
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].f < bestF) {
        bestF = openSet[i].f;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function aStarPath(start, goal, getWalkable, getNeighbors, tolerance = 0) {
    const startZ = start.z;
    const openSet = [{ x: start.x, y: start.y, z: startZ, f: 0, g: 0, h: 0, parent: null }];
    const closedSet = new Set();
    const key = (p) => `${p.x},${p.y}`;

    while (openSet.length > 0) {
      const bestIndex = findBestIndex(openSet);
      const current = openSet[bestIndex];
      openSet[bestIndex] = openSet[openSet.length - 1];
      openSet.pop();
      const currentKey = key(current);

      if (Math.max(Math.abs(current.x - goal.x), Math.abs(current.y - goal.y)) <= tolerance) {
        const path = [];
        let node = current;
        while (node) {
          path.unshift({ x: node.x, y: node.y, z: node.z });
          node = node.parent;
        }
        return path;
      }

      closedSet.add(currentKey);

      for (const neighbor of getNeighbors(current)) {
        const nKey = key(neighbor);
        if (closedSet.has(nKey)) continue;
        if (!getWalkable(neighbor.x, neighbor.y)) continue;

        const g = current.g + 1;
        const h = Math.abs(neighbor.x - goal.x) + Math.abs(neighbor.y - goal.y);
        const f = g + h;
        const existing = openSet.find(n => n.x === neighbor.x && n.y === neighbor.y);
        if (existing) {
          if (g < existing.g) {
            existing.g = g;
            existing.f = f;
            existing.parent = current;
          }
        } else {
          openSet.push({ x: neighbor.x, y: neighbor.y, z: startZ, f, g, h, parent: current });
        }
      }
    }
    return null;
  }

  function isFireFieldTileForCavePathing(tile) {
    if (!tile) return false;
    for (const thing of getTileThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (FIRE_FIELD_IDS.has(id)) return true;
      const definition = getThingDefinition(thing?.id);
      const text = [
        thing?.name, thing?.itemName, thing?.field, thing?.fieldType,
        thing?.type, thing?.thingType, thing?.category,
        thing?.properties?.name, thing?.properties?.field,
        thing?.properties?.type, thing?.properties?.category,
        definition?.name, definition?.properties?.name,
        definition?.properties?.field, definition?.properties?.type,
        definition?.properties?.category,
      ].filter(Boolean).map(String).join(" ");
      if (FIRE_FIELD_PATTERN.test(text) || /\bfire\s*field\b/i.test(text)) return true;
    }
    return false;
  }

  function isTileWithAlwaysWalkableFireFieldId(tile) {
    if (!tile) return false;
    for (const thing of getTileThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (ALWAYS_WALKABLE_FIRE_FIELD_IDS.has(id)) return true;
    }
    return false;
  }

  function isPoisonFieldTileForCavePathing(tile) {
    if (!tile) return false;
    for (const thing of getTileThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (POISON_FIELD_IDS.has(id)) return true;
      const definition = getThingDefinition(thing?.id);
      const text = [
        thing?.name, thing?.itemName, thing?.field, thing?.fieldType,
        thing?.type, thing?.thingType, thing?.category,
        thing?.properties?.name, thing?.properties?.field,
        thing?.properties?.type, thing?.properties?.category,
        definition?.name, definition?.properties?.name,
        definition?.properties?.field, definition?.properties?.type,
        definition?.properties?.category,
      ].filter(Boolean).map(String).join(" ");
      if (POISON_FIELD_PATTERN.test(text) || /\bpoison\s*field\b/i.test(text)) return true;
    }
    return false;
  }

  function patchFieldWalkabilityForCavePathing() {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position) return false;
    let tile = null;
    try {
      tile = getTileAt(position);
    } catch (_) {}
    const prototype = tile && Object.getPrototypeOf(tile);
    if (!prototype || typeof prototype.isWalkable !== "function") return false;
    if (prototype.__caveBotWalkOverFieldsApplied) return true;
    const original = prototype.isWalkable;
    const wrapper = function caveBotWalkOverFieldsIsWalkable(...args) {
      if (isTileWithAlwaysWalkableFireFieldId(this) ||
          isPoisonFieldTileForCavePathing(this) ||
          (config.walkOverFields && isFireFieldTileForCavePathing(this))) return true;
      return original.apply(this, args);
    };
    wrapper.__caveBotWalkOverFieldsApplied = true;
    wrapper.__caveBotWalkOverFieldsOriginal = original;
    prototype.isWalkable = wrapper;
    prototype.__caveBotWalkOverFieldsApplied = true;
    return true;
  }

  function getAStarWalkabilityMatrix(position, z) {
    const cacheKey = `matrix_${z}`;
    const cached = matrixCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PATHFINDER_CONFIG.matrixCacheTTL) {
      return cached.matrix;
    }

    const chunks = window.gameClient?.world?.chunks || [];
    const matrix = new Map();
    try {
      for (const chunk of chunks) {
        if (!chunk?.tiles) continue;
        for (const tile of chunk.tiles) {
          if (!tile?.__position || tile.__position.z !== z) continue;
          const key = `${tile.__position.x},${tile.__position.y}`;
          const walkable = tile.isWalkable ? tile.isWalkable() : false;
          matrix.set(key, isTileWithAlwaysWalkableFireFieldId(tile) ||
            isPoisonFieldTileForCavePathing(tile) ||
            (config.walkOverFields && isFireFieldTileForCavePathing(tile)) ? true : walkable);
        }
      }
    } catch (e) {
      return matrix;
    }

    matrixCache.set(cacheKey, { matrix, at: Date.now() });
    return matrix;
  }

  function getAStarNeighbors(current, matrix) {
    const dirs = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];
    return dirs.map(d => ({ x: current.x + d.x, y: current.y + d.y }))
      .filter(n => matrix.get(`${n.x},${n.y}`) === true);
  }

  function getCachedPath(from, to) {
    const key = [from.x, from.y, from.z, to.x, to.y, to.z].join(",");
    const entry = pathCache.get(key);
    if (entry && Date.now() - entry.at < PATHFINDER_CONFIG.pathCacheTTL) return entry.path;
    return null;
  }

  function setCachedPath(from, to, path) {
    const key = [from.x, from.y, from.z, to.x, to.y, to.z].join(",");
    pathCache.set(key, { path, at: Date.now() });
  }

  function findPathAStar(from, to) {
    patchFieldWalkabilityForCavePathing();
    from = normalizePosition(from);
    to = normalizePosition(to);
    if (!from || !to) return null;
    if (from.x === to.x && from.y === to.y && from.z === to.z) return [];
    if (from.z !== to.z) return null;

    const cached = getCachedPath(from, to);
    if (cached) return cached;

    const matrix = getAStarWalkabilityMatrix(from, from.z);
    const tolerance = 0;
    const path = aStarPath(from, to,
      (x, y) => matrix.get(`${x},${y}`) === true,
      (node) => getAStarNeighbors(node, matrix),
      tolerance
    );

    if (path) setCachedPath(from, to, path);
    return path;
  }

  function cleanupPathCache() {
    const now = Date.now();
    for (const [key, entry] of pathCache) {
      if (now - entry.at >= PATHFINDER_CONFIG.pathCacheTTL) pathCache.delete(key);
    }
    for (const [key, entry] of matrixCache) {
      if (now - entry.at >= PATHFINDER_CONFIG.matrixCacheTTL) matrixCache.delete(key);
    }
  }

  const MAX_STUCK_COUNT = 3;
  const stuckCounts = new Map();

  function antiStuckFallback(tile) {
    const key = `${tile.x},${tile.y}`;
    const count = (stuckCounts.get(key) || 0) + 1;
    stuckCounts.set(key, count);
    if (count >= MAX_STUCK_COUNT) return { action: 'skip_waypoint' };
    return { action: 'repath' };
  }

  function resetStuckCounts(key) {
    if (key) stuckCounts.delete(key);
    else stuckCounts.clear();
  }

  const chaseState = { targetId: null, startedAt: 0, lastDistance: Infinity, stallCount: 0 };
  const CHASE_TIMEOUT_MS = 15000;
  const CHASE_MAX_STALL = 5;
  const CHASE_MAX_DISTANCE = 8;

  function findAdjacentWalkablePositionForCave(targetPosition, playerPosition) {
    if (!targetPosition || !playerPosition) return null;
    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];
    offsets.sort((a, b) => {
      const da = Math.abs(targetPosition.x + a.x - playerPosition.x) + Math.abs(targetPosition.y + a.y - playerPosition.y);
      const db = Math.abs(targetPosition.x + b.x - playerPosition.x) + Math.abs(targetPosition.y + b.y - playerPosition.y);
      return da - db;
    });
    for (const offset of offsets) {
      const position = new Position(targetPosition.x + offset.x, targetPosition.y + offset.y, targetPosition.z);
      const tile = window.gameClient?.world?.getTileFromWorldPosition?.(position);
      if (tile?.isWalkable?.()) return normalizePosition(position);
    }
    return null;
  }

  function chaseTarget(target) {
    if (!target) return false;
    const now = Date.now();
    const playerPos = normalizePosition(bot.getPlayerPosition());
    const targetPos = normalizePosition(target.getPosition?.() || target.__position);
    if (!playerPos || !targetPos || playerPos.z !== targetPos.z) return false;
    if (!isOnScreen(targetPos, playerPos)) return giveUpChase(target, 'offscreen');
    const distance = Math.abs(playerPos.x - targetPos.x) + Math.abs(playerPos.y - targetPos.y);
    if (distance > CHASE_MAX_DISTANCE) return giveUpChase(target, 'too far');
    if (chaseState.targetId !== target.id) {
      chaseState.targetId = target.id;
      chaseState.startedAt = now;
      chaseState.lastDistance = distance;
      chaseState.stallCount = 0;
    }
    if (now - chaseState.startedAt > CHASE_TIMEOUT_MS) return giveUpChase(target, 'timeout');
    if (distance >= chaseState.lastDistance) {
      chaseState.stallCount++;
      if (chaseState.stallCount > CHASE_MAX_STALL) return giveUpChase(target, 'stalled');
    } else chaseState.stallCount = 0;
    chaseState.lastDistance = distance;
    const adjacent = findAdjacentWalkablePositionForCave(targetPos, playerPos);
    if (!adjacent) return giveUpChase(target, 'no walkable adjacent');
    const to = new Position(adjacent.x, adjacent.y, playerPos.z);
    try {
      window.gameClient?.world?.pathfinder?.findPath?.(playerPos, to);
      return true;
    } catch (e) {
      return giveUpChase(target, 'pathfind error');
    }
  }

  function giveUpChase(target, reason) {
    chaseState.targetId = null;
    bot.log("cave gave up chase", { targetId: target?.id, reason });
    return false;
  }

  const VIEWPORT_DX = 8;
  const VIEWPORT_DY = 6;

  function isOnScreen(pos, playerPos) {
    if (!pos || !playerPos) return false;
    return Math.abs(pos.x - playerPos.x) <= VIEWPORT_DX &&
      Math.abs(pos.y - playerPos.y) <= VIEWPORT_DY &&
      pos.z === playerPos.z;
  }

  function filterPathToViewport(path, playerPos) {
    if (!path || !path.length) return path;
    const onScreen = path.filter(p => isOnScreen(p, playerPos));
    if (onScreen.length > 0) return onScreen;
    const extended = path.filter(p =>
      Math.abs(p.x - playerPos.x) <= VIEWPORT_DX * 2 &&
      Math.abs(p.y - playerPos.y) <= VIEWPORT_DY * 2 &&
      p.z === playerPos.z
    );
    if (extended.length > 0) return [extended[0]];
    return path.slice(0, 1);
  }

  function normalizeWaypoint(waypoint) {
    const position = normalizePosition(waypoint);
    if (!position) return null;
    // Keep waypoint action metadata with the waypoint itself. The action
    // module also maintains its legacy sidecar storage, but embedding the
    // metadata prevents Save/Load from turning action waypoints into Walk.
    const normalized = { ...position };
    if (typeof waypoint?.action === "string" && waypoint.action.trim()) {
      normalized.action = waypoint.action.trim();
    }
    if (typeof waypoint?.useDirection === "string" && waypoint.useDirection.trim()) {
      normalized.useDirection = waypoint.useDirection.trim().toUpperCase();
    }
    return normalized;
  }
  function normalizeRoute(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeWaypoint).filter(Boolean);
  }
  function normalizeTransition(transition) {
    if (!transition) return null;
    const from = normalizePosition(transition.from || transition);
    const to = normalizePosition(transition.to || { x: transition.targetX, y: transition.targetY, z: transition.targetZ });
    if (!from || !to || from.z === to.z) return null;
    const count = Math.max(1, Math.trunc(Number(transition.count) || 1));
    const lastSeenAt = Math.max(0, Math.trunc(Number(transition.lastSeenAt) || Date.now()));
    return { from, to, count, lastSeenAt };
  }
  function normalizeTransitions(value) {
    if (!Array.isArray(value)) return [];
    const deduped = new Map();
    value.map(normalizeTransition).filter(Boolean).forEach((transition) => deduped.set(getPositionKey(transition.from), transition));
    return Array.from(deduped.values());
  }
  function getRoute() { return route.map((waypoint) => cloneValue(waypoint)); }
  function setWaypointMetadata(index, metadata = {}) {
    const normalizedIndex = Math.trunc(Number(index));
    if (!Number.isFinite(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= route.length) return null;
    const waypoint = route[normalizedIndex];
    if (!waypoint) return null;
    if (metadata.action != null) waypoint.action = String(metadata.action).trim();
    if (metadata.useDirection != null) waypoint.useDirection = String(metadata.useDirection).trim().toUpperCase();
    if (!waypoint.action) delete waypoint.action;
    if (!waypoint.useDirection) delete waypoint.useDirection;
    persistRoute();
    return cloneValue(waypoint);
  }
  function getTransitions() { return transitions.map((transition) => cloneValue(transition)); }
  function persistTransitions() { persistActivePreset(); }

  function savePreset(name, options = {}) {
    const preset = upsertPreset(name, route, transitions);
    if (!preset) { bot.log("cave preset name is required"); return null; }
    if (options.activate !== false) {
      setActivePresetName(preset.name);
      persistLegacyActivePreset();
    }
    bot.log("cave preset saved", { name: preset.name, waypoints: preset.route.length, transitions: preset.transitions.length });
    return { name: preset.name, route: preset.route.map((waypoint) => cloneValue(waypoint)), transitions: preset.transitions.map((transition) => cloneValue(transition)) };
  }

  function createPreset(name) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) { bot.log("cave preset name is required"); return null; }
    if (getPresetByName(normalizedName)) { bot.log("cave preset already exists", { name: normalizedName }); return null; }
    if (state.running) stop();
    const preset = upsertPreset(normalizedName, [], []);
    if (!preset) return null;
    loadPresetState(preset.name);
    bot.log("cave preset created", { name: preset.name });
    return { name: preset.name, route: [], transitions: [] };
  }

  function loadPreset(name) {
    const preset = getPresetByName(name);
    if (!preset) { bot.log("cave preset not found", { name }); return null; }
    if (state.running) stop();
    loadPresetState(preset.name);
    bot.log("cave preset loaded", { name: preset.name, waypoints: route.length, transitions: transitions.length });
    return { name: preset.name, route: getRoute(), transitions: getTransitions() };
  }

  function deletePreset(name) {
    const preset = getPresetByName(name);
    if (!preset) { bot.log("cave preset not found", { name }); return false; }
    presets = presets.filter((entry) => entry.name.toLowerCase() !== preset.name.toLowerCase());
    persistPresets();
    if (preset.name.toLowerCase() === getActivePresetName().toLowerCase()) {
      const fallbackPreset = presets[0] || null;
      if (state.running) stop();
      if (fallbackPreset) loadPresetState(fallbackPreset.name);
      else {
        route = [];
        transitions = [];
        state.currentIndex = 0;
        state.direction = 1;
        state.pendingTransitionSource = null;
        setActivePresetName(defaultPresetName);
        persistLegacyActivePreset();
      }
    }
    bot.log("cave preset deleted", { name: preset.name });
    return true;
  }

  function getCurrentWaypoint() {
    if (!route.length) return null;
    if (state.currentIndex < 0 || state.currentIndex >= route.length) state.currentIndex = 0;
    return route[state.currentIndex] || null;
  }
  function getPositionKey(position) { return position ? `${position.x},${position.y},${position.z}` : null; }
  function getDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return Number.POSITIVE_INFINITY;
    return Math.abs(Number(from.x) - Number(to.x)) + Math.abs(Number(from.y) - Number(to.y));
  }
  function isBesideOrSameTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return false;
    return Math.abs(Number(from.x) - Number(to.x)) <= 1 && Math.abs(Number(from.y) - Number(to.y)) <= 1;
  }
  function isAdjacentTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return false;
    const dx = Math.abs(Number(from.x) - Number(to.x));
    const dy = Math.abs(Number(from.y) - Number(to.y));
    return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
  }
  function getDistanceToWaypoint(position, waypoint) {
    if (!position || !waypoint) return null;
    return getDistance(position, waypoint);
  }
  function isSameTile(a, b) {
    if (!a || !b) return false;
    return Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y) && Number(a.z) === Number(b.z);
  }
  function findClosestWaypointIndex(position) {
    if (!position || !route.length) return 0;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    route.forEach((waypoint, index) => {
      const distance = getDistanceToWaypoint(position, waypoint);
      if (!Number.isFinite(distance)) return;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    return bestIndex;
  }

  function getTileAt(position) {
    if (!position) return null;
    return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(position.x, position.y, position.z)) || null;
  }
  function getTilePosition(tile) { return normalizePosition(tile?.__position); }
  function getThingDefinition(itemId) {
    if (!itemId) return null;
    return window.gameClient?.itemDefinitionsByCid?.[itemId] || window.gameClient?.itemDefinitionsBySid?.[itemId] || window.gameClient?.itemDefinitions?.[itemId] || null;
  }
  function getThingName(thing) {
    const definition = getThingDefinition(thing?.id);
    return String(definition?.properties?.name || thing?.name || "").trim().toLowerCase();
  }
  function isLadderThing(thing) {
    if (!thing?.id) return false;
    if (ladderItemIds.has(Number(thing.id))) return true;
    return getThingName(thing).includes("ladder");
  }
  function isFloorChangeThing(thing) {
    const definition = getThingDefinition(thing?.id);
    return !!definition?.properties?.floorchange || isLadderThing(thing);
  }
  function isFloorChangeTile(tile) {
    const tilePosition = getTilePosition(tile);
    if (!tilePosition) return false;
    if (isFloorChangeThing(tile)) return true;
    return Array.isArray(tile.items) && tile.items.some((item) => isFloorChangeThing(item));
  }
  function getTileThings(tile) {
    if (!tile) return [];
    const things = [];
    const add = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      if (!things.includes(value)) things.push(value);
    };
    add(tile);
    add(tile.items);
    add(tile.things);
    add(tile.objects);
    add(tile.topThing);
    try { add(tile.getItems?.()); } catch (_) {}
    try { add(tile.getThings?.()); } catch (_) {}
    try { add(tile.getObjects?.()); } catch (_) {}
    try { add(tile.getTopThing?.()); } catch (_) {}
    return things;
  }
  function tileHasNamedThing(tile, needle) {
    const value = String(needle || "").trim().toLowerCase();
    if (!value) return false;
    return getTileThings(tile).some((thing) => getThingName(thing).includes(value));
  }
  function isLadderTile(tile) { return getTileThings(tile).some((thing) => isLadderThing(thing)); }
  function isStairsTile(tile) { return tileHasNamedThing(tile, "stairs"); }
  function isHoleTile(tile) { return tileHasNamedThing(tile, "hole"); }
  function isRopeSpotTile(tile) { return tileHasNamedThing(tile, "rope spot"); }
  function isRopeTargetTile(tile) { return isHoleTile(tile) || isRopeSpotTile(tile); }
  function isShovelTargetThing(thing) {
    const name = getThingName(thing);
    if (!name) return false;
    return shovelTargetNamePatterns.some((pattern) => pattern.test(name));
  }
  function isShovelTargetTile(tile) { return getTileThings(tile).some((thing) => isShovelTargetThing(thing)); }

  function isTransitionCandidateTile(tile, waypoint, position) {
    if (!tile) return false;
    if (isFloorChangeTile(tile)) return true;
    const hasWaypointDelta = waypoint && position && Number.isFinite(waypoint.z) && Number.isFinite(position.z);
    if (!hasWaypointDelta) return false;
    if (waypoint.z > position.z) return isShovelTargetTile(tile);
    if (waypoint.z < position.z) return isRopeTargetTile(tile);
    return false;
  }
  function getFloorChangeTileBias(tile, position, waypoint) {
    if (!tile || !position || !waypoint || position.z === waypoint.z) return 0;
    const goingDown = waypoint.z > position.z;
    const goingUp = waypoint.z < position.z;
    if (goingDown) {
      if (isLadderTile(tile)) return -30;
      if (isHoleTile(tile)) return -20;
      if (isStairsTile(tile)) return 25;
    }
    if (goingUp) {
      if (isStairsTile(tile)) return -20;
      if (isHoleTile(tile)) return 20;
    }
    return 0;
  }
  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];
    for (const chunk of chunks) {
      if (!chunk?.tiles) continue;
      for (const tile of chunk.tiles) if (tile?.__position) tiles.push(tile);
    }
    return tiles;
  }

  function ensureMinimapOverlayStyle() {
    if (document.getElementById(minimapOverlayStyleId)) return;
    const style = document.createElement("style");
    style.id = minimapOverlayStyleId;
    style.textContent = `#${minimapOverlayRootId}{position:fixed;inset:0;pointer-events:none;z-index:999997}#${minimapOverlayRootId} canvas{position:fixed;pointer-events:none}`;
    document.head.appendChild(style);
  }
  function ensureMinimapOverlayRoot() {
    let root = document.getElementById(minimapOverlayRootId);
    if (root) return root;
    root = document.createElement("div");
    root.id = minimapOverlayRootId;
    root.innerHTML = '<canvas></canvas>';
    document.body.appendChild(root);
    return root;
  }
  function destroyMinimapOverlayElements() {
    document.getElementById(minimapOverlayRootId)?.remove();
    document.getElementById(minimapOverlayStyleId)?.remove();
  }
  function getMinimapCanvas() { return window.gameClient?.renderer?.minimap?.minimap?.canvas || document.getElementById("minimap") || null; }
  function getMinimapViewport() {
    const canvas = getMinimapCanvas();
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { canvas, rect };
  }
  function getWaypointCanvasPoint(waypoint, viewport, playerPosition, minimap) {
    if (!waypoint || !viewport || !playerPosition || !minimap) return null;
    const renderLayer = Number(minimap.__renderLayer);
    if (Number.isFinite(renderLayer) && waypoint.z !== renderLayer) return null;
    const zoomLevel = Number(minimap.__zoomLevel);
    const zoomScale = Number.isFinite(zoomLevel) && zoomLevel >= 0 ? Math.pow(2, zoomLevel) : 1;
    const internalWidth = Number(viewport.canvas.width) || 160;
    const internalHeight = Number(viewport.canvas.height) || 160;
    const internalX = (internalWidth / 2) + (waypoint.x - playerPosition.x) * zoomScale;
    const internalY = (internalHeight / 2) + (waypoint.y - playerPosition.y) * zoomScale;
    return {
      x: internalX * (viewport.rect.width / internalWidth),
      y: internalY * (viewport.rect.height / internalHeight),
    };
  }
  function renderMinimapOverlay() {
    const viewport = getMinimapViewport();
    const minimap = window.gameClient?.renderer?.minimap;
    const playerPosition = normalizePosition(bot.getPlayerPosition());
    const root = ensureMinimapOverlayRoot();
    const canvas = root.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!viewport || !minimap || !playerPosition || !route.length) { canvas.width = 0; canvas.height = 0; return; }
    const rect = viewport.rect;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    const viewportKey = [
      Math.round(rect.left * 100), Math.round(rect.top * 100),
      Math.round(rect.width * 100), Math.round(rect.height * 100),
      playerPosition.x, playerPosition.y, playerPosition.z,
      Number(minimap.__renderLayer) || 0, Number(minimap.__zoomLevel) || 0,
    ].join(":");
    if (minimapOverlayState.lastViewportKey === viewportKey) return;
    minimapOverlayState.lastViewportKey = viewportKey;
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    // Keep the overlay locked to the minimap's exact fractional viewport.
    // Rounding the viewport position every 250ms made the waypoint layer
    // visibly jump as the minimap/camera moved.
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const visibleWaypoints = route.map((waypoint, index) => ({ waypoint, index, point: getWaypointCanvasPoint(waypoint, viewport, playerPosition, minimap) })).filter((entry) => entry.point);
    if (!visibleWaypoints.length) return;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    for (let index = 1; index < visibleWaypoints.length; index += 1) {
      const previous = visibleWaypoints[index - 1];
      const current = visibleWaypoints[index];
      if (current.index !== previous.index + 1) continue;
      context.strokeStyle = "rgba(92, 228, 196, 0.7)";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(previous.point.x, previous.point.y);
      context.lineTo(current.point.x, current.point.y);
      context.stroke();
    }
    visibleWaypoints.forEach(({ point, index }) => {
      const isCurrent = state.running && index === state.currentIndex;
      const radius = isCurrent ? 7 : 5;
      context.fillStyle = isCurrent ? "#ffcf5a" : "#2bd1c4";
      context.strokeStyle = isCurrent ? "#6a2400" : "#083f49";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = "bold 11px Verdana, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), point.x, point.y);
    });
    context.restore();
  }
  function startMinimapOverlay() {
    if (minimapOverlayState.timerId != null) return;
    ensureMinimapOverlayStyle();
    minimapOverlayState.lastViewportKey = null;
    const renderFrame = () => {
      if (!isCurrentCaveGeneration()) return;
      renderMinimapOverlay();
      minimapOverlayState.timerId = window.setTimeout(renderFrame, 100);
    };
    renderMinimapOverlay();
    minimapOverlayState.timerId = window.setTimeout(renderFrame, 100);
  }

  function stopMinimapOverlay() {
    if (minimapOverlayState.timerId != null) {
      window.clearTimeout(minimapOverlayState.timerId);
      minimapOverlayState.timerId = null;
    }
    minimapOverlayState.lastViewportKey = null;
    destroyMinimapOverlayElements();
  }

  function getNearbyTransitionTiles(position, waypoint, radius = 8) {
    if (!position) return [];
    return getLoadedTiles().map((tile) => ({ tile, position: getTilePosition(tile) })).filter((entry) =>
      entry.position && entry.position.z === position.z && Math.abs(entry.position.x - position.x) <= radius && Math.abs(entry.position.y - position.y) <= radius && isTransitionCandidateTile(entry.tile, waypoint, position)
    );
  }
  function findTransitionTileNearPosition(position, waypoint, radius = 1) {
    if (!position) return null;
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    getNearbyTransitionTiles(position, waypoint, radius).forEach((entry) => {
      const distance = getDistance(position, entry.position);
      if (!Number.isFinite(distance)) return;
      if (distance < bestDistance) { bestDistance = distance; best = entry; }
    });
    return best;
  }
  function findBestKnownTransition(position, waypoint) {
    if (!position || !waypoint) return null;
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    transitions.forEach((transition) => {
      if (transition.from.z !== position.z || transition.to.z !== waypoint.z) return;
      const playerDistance = getDistance(position, transition.from);
      const landingDistance = getDistance(transition.to, waypoint);
      if (!Number.isFinite(playerDistance) || !Number.isFinite(landingDistance)) return;
      const score = playerDistance * 10 + landingDistance;
      if (score < bestScore) { bestScore = score; best = transition; }
    });
    return best;
  }
  function findNearbyTransitionTile(position, waypoint) {
    if (!position || !waypoint) return null;
    const waypointDistance = Math.abs(position.x - waypoint.x) + Math.abs(position.y - waypoint.y);
    const radius = Math.max(4, Math.min(20, waypointDistance + 2));
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const candidates = getNearbyTransitionTiles(position, waypoint, radius);

    bot.logDebug("[ROPE TRACE] SEARCH", {
      position,
      waypoint,
      radius,
      candidateCount: candidates.length,
    });

    candidates.forEach((entry, candidateIndex) => {
      const playerDistance = getDistance(position, entry.position);
      const tileToWaypointDistance = Math.abs(entry.position.x - waypoint.x) + Math.abs(entry.position.y - waypoint.y);
      const bias = getFloorChangeTileBias(entry.tile, position, waypoint);
      const score = playerDistance * 10 + tileToWaypointDistance + bias;
      const isRopeTarget = isRopeTargetTile(entry.tile);
      const isHole = isHoleTile(entry.tile);
      const isRopeSpot = isRopeSpotTile(entry.tile);
      const isFloorChange = isFloorChangeTile(entry.tile);

      bot.logDebug("[ROPE TRACE] CANDIDATE", {
        candidateIndex,
        position: entry.position,
        playerDistance,
        waypointDistance: tileToWaypointDistance,
        bias,
        score,
        isRopeTarget,
        isHole,
        isRopeSpot,
        isFloorChange,
        selected: score < bestScore,
      });

      if (score < bestScore) {
        bestScore = score;
        best = {
          tile: entry.tile,
          position: entry.position,
          playerDistance,
          waypointDistance: tileToWaypointDistance,
          score,
          bias,
          candidateIndex,
        };
      }
    });

    bot.logDebug("[ROPE TRACE] SELECTED", best ? {
      position: best.position,
      score: best.score,
      bias: best.bias,
      playerDistance: best.playerDistance,
      waypointDistance: best.waypointDistance,
      candidateIndex: best.candidateIndex,
    } : {
      position: null,
      reason: "no transition candidates",
    });

    return best;
  }

  function isAtWaypoint(position, waypoint) {
    if (!position || !waypoint) return false;
    return (
      Number(position.x) === Number(waypoint.x) &&
      Number(position.y) === Number(waypoint.y) &&
      Number(position.z) === Number(waypoint.z)
    );
  }

  function patchRopeSpellWaypointWalkability(waypoint) {
    if (!waypoint || bot.cave?.getWaypointActions == null) return false;
    const index = Math.trunc(Number(state.currentIndex) || 0);
    if (bot.cave?.getWaypointActions?.()[index] !== "ropeSpell") return false;

    const activeRoute = bot.cave?.getRoute?.() || [];
    const activeWaypoint = activeRoute[index];
    if (!activeWaypoint) return false;

    const tile = getTileAt(activeWaypoint);
    if (!tile) return false;

    const isActiveRopeWaypointTile = (candidate) => {
      const position = getTilePosition(candidate);
      return !!(
        bot.cave?.status?.()?.running &&
        bot.cave?.getWaypointActions?.()[Math.trunc(Number(state.currentIndex) || 0)] === "ropeSpell" &&
        position &&
        position.x === activeWaypoint.x &&
        position.y === activeWaypoint.y &&
        position.z === activeWaypoint.z
      );
    };

    let patched = false;
    const patchObject = (target, marker) => {
      if (!target || typeof target.isWalkable !== "function") return;
      if (target[marker]) {
        patched = true;
        return;
      }
      const original = target.isWalkable;
      const wrapper = function caveBotRopeSpellWalkability(...args) {
        if (isActiveRopeWaypointTile(this)) return true;
        return original.apply(this, args);
      };
      wrapper.__caveBotRopeSpellWalkabilityApplied = true;
      wrapper.__caveBotRopeSpellWalkabilityOriginal = original;
      target.isWalkable = wrapper;
      target[marker] = true;
      patched = true;
    };

    // Patch the actual hole tile first. This is important because the game
    // pathfinder can hold a tile instance/class different from the player's
    // current tile prototype.
    patchObject(tile, "__caveBotRopeSpellTileWalkabilityApplied");

    // Also patch the tile's prototype and inherited prototype chain so both
    // the game pathfinder and the A* matrix see the exact rope waypoint as
    // walkable.
    let prototype = Object.getPrototypeOf(tile);
    while (prototype) {
      patchObject(prototype, "__caveBotRopeSpellRopeWalkabilityApplied");
      prototype = Object.getPrototypeOf(prototype);
    }

    if (patched) {
      matrixCache.clear();
      pathCache.clear();
    }
    return patched;
  }
  function stepOntoExactUseWaypoint(waypoint, from) {
    const currentIndex = Math.trunc(Number(state.currentIndex) || 0);
    if (bot.cave?.getWaypointActions?.()[currentIndex] !== "use") return false;
    const fromPos = normalizePosition(from);
    const waypointPos = normalizePosition(waypoint);
    if (!fromPos || !waypointPos || fromPos.z !== waypointPos.z || Math.abs(fromPos.x - waypointPos.x) + Math.abs(fromPos.y - waypointPos.y) !== 1) return false;
    const stepped = bot.caveArrowKeys?.stepToPosition?.(waypointPos);
    if (!stepped) return false;
    state.lastPathAt = Date.now();
    bot.log("cave Use waypoint stepped onto exact tile", { ...waypoint, index: currentIndex + 1, pathfinderMode: config.pathfinderMode });
    return true;
  }

  function stepOntoExactRopeSpellWaypoint(waypoint, from) {
    const currentIndex = Math.trunc(Number(state.currentIndex) || 0);
    const action = bot.cave?.getWaypointActions?.()[currentIndex];
    const fromPos = normalizePosition(from);
    const waypointPos = normalizePosition(waypoint);
    if (
      action !== "ropeSpell" ||
      !fromPos ||
      !waypointPos ||
      fromPos.z !== waypointPos.z ||
      Math.abs(fromPos.x - waypointPos.x) + Math.abs(fromPos.y - waypointPos.y) !== 1
    ) {
      return false;
    }

    const stepped = bot.caveArrowKeys?.stepToPosition?.(waypointPos);
    if (!stepped) return false;

    state.lastPathAt = Date.now();
    bot.log("cave Rope Spell stepped onto exact waypoint tile", {
      ...waypoint,
      index: currentIndex + 1,
      pathfinderMode: config.pathfinderMode,
    });
    return true;
  }

  function pathContainsAlwaysWalkableFireField(path) {
    if (!Array.isArray(path)) return false;
    return path.some((position) => {
      const tile = getTileAt(position);
      return isTileWithAlwaysWalkableFireFieldId(tile);
    });
  }

  function hasAlwaysWalkableFireFieldBetween(fromPos, toPos) {
    if (!fromPos || !toPos || fromPos.z !== toPos.z) return false;
    const dx = Math.sign(toPos.x - fromPos.x);
    const dy = Math.sign(toPos.y - fromPos.y);
    let x = fromPos.x;
    let y = fromPos.y;
    const maxSteps = Math.max(Math.abs(toPos.x - fromPos.x), Math.abs(toPos.y - fromPos.y));
    for (let step = 0; step <= maxSteps; step += 1) {
      const tile = getTileAt({ x, y, z: fromPos.z });
      if (isTileWithAlwaysWalkableFireFieldId(tile)) return true;
      if (x === toPos.x && y === toPos.y) break;
      // For cardinal routes this follows the exact corridor. For diagonal
      // routes it advances both axes, which is sufficient to detect a
      // fire-field waypoint/corridor before native pathing is attempted.
      if (x !== toPos.x) x += dx;
      if (y !== toPos.y) y += dy;
    }
    return false;
  }

  function stepDirectlyTowardFireFieldWaypoint(fromPos, toPos) {
    if (!fromPos || !toPos || fromPos.z !== toPos.z) return false;
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    if (dx === 0 && dy === 0) return false;

    // Prefer the larger axis so a diagonal route progresses deterministically.
    let next = null;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
      next = { x: fromPos.x + Math.sign(dx), y: fromPos.y, z: fromPos.z };
    } else if (dy !== 0) {
      next = { x: fromPos.x, y: fromPos.y + Math.sign(dy), z: fromPos.z };
    }
    if (!next) return false;

    const tile = getTileAt(next);
    const passable = isTileWithAlwaysWalkableFireFieldId(tile) || !!tile?.isWalkable?.();
    if (!passable) return false;

    const stepped = bot.caveArrowKeys?.stepToPosition?.(next);
    if (!stepped) return false;

    state.lastPathAt = Date.now();
    bot.log("cave direct fire-field route step", {
      from: fromPos,
      to: next,
      waypoint: toPos,
      fireFieldRoute: true,
    });
    return true;
  }

  function pathContainsFireField(path) {
    if (!config.walkOverFields || !Array.isArray(path)) return false;
    return path.some((position) => {
      const tile = getTileAt(position);
      return isFireFieldTileForCavePathing(tile);
    });
  }

  function pathContainsPoisonField(path) {
    if (!Array.isArray(path)) return false;
    return path.some((position) => isPoisonFieldTileForCavePathing(getTileAt(position)));
  }

  function stepAlongPoisonFieldPath(path, fromPos) {
    if (!Array.isArray(path) || !fromPos) return false;
    const next = path.find((position) => position &&
      (position.x !== fromPos.x || position.y !== fromPos.y || position.z !== fromPos.z));
    if (!next) return false;
    const nextPos = normalizePosition(next);
    if (!nextPos || nextPos.z !== fromPos.z) return false;
    const tile = getTileAt(nextPos);
    if (!(isPoisonFieldTileForCavePathing(tile) || !!tile?.isWalkable?.())) return false;
    if (!bot.caveArrowKeys?.stepToPosition?.(nextPos)) return false;
    state.lastPathAt = Date.now();
    bot.logDebug("cave stepped onto/through poison field", { from: fromPos, to: nextPos, poisonFieldRoute: true });
    return true;
  }

  function stepAlongWalkOverFieldPath(path, fromPos) {
    if (!Array.isArray(path) || !fromPos) return false;
    const next = path.find((position) => {
      if (!position) return false;
      return position.x !== fromPos.x || position.y !== fromPos.y || position.z !== fromPos.z;
    });
    if (!next) return false;

    const nextPos = normalizePosition(next);
    if (!nextPos || nextPos.z !== fromPos.z) return false;

    // The native pathfinder can reject fire-field tiles even though CaveBot
    // considers them walkable. When the route contains a fire field, follow
    // the already-validated CaveBot A* route one tile at a time instead of
    // handing the route back to the native collision/pathfinder.
    const stepped = bot.caveArrowKeys?.stepToPosition?.(nextPos);
    if (!stepped) return false;

    state.lastPathAt = Date.now();
    bot.logDebug("cave stepped along Walk Over Fields route", {
      from: fromPos,
      to: nextPos,
      fireFieldRoute: true,
      pathfinderMode: config.pathfinderMode,
    });
    return true;
  }

  function goToWaypoint(waypoint) {
    patchFieldWalkabilityForCavePathing();
    patchRopeSpellWaypointWalkability(waypoint);
    const from = bot.getPlayerPosition();
    if (!from || !waypoint) return false;

    const now = Date.now();

    {
      const fromPos = normalizePosition(from);
      const waypointPos = normalizePosition(waypoint);

      if (config.pathfinderMode === 'astar') {
        const path = findPathAStar(fromPos, waypointPos);

        if (path && path.length > 0) {
        const playerPos = fromPos;

        const waypointOnScreen = waypointPos && isOnScreen(waypointPos, playerPos);
        let targetTile = null;

        if (waypointOnScreen) {
          // Always pass the actual waypoint to the native pathfinder.
          // Do not substitute an adjacent/staged destination.
          targetTile = waypointPos;
        } else {
          const visiblePath = filterPathToViewport(path, playerPos);
          if (visiblePath && visiblePath.length > 1) {
            targetTile = visiblePath[visiblePath.length - 1];
          } else if (visiblePath && visiblePath.length === 1) {
            targetTile = visiblePath[0];
          } else {
            targetTile = path[Math.min(VIEWPORT_DX, path.length - 1)];
          }
        }

        if (targetTile && !(targetTile.x === playerPos.x && targetTile.y === playerPos.y)) {
          const to = new Position(targetTile.x, targetTile.y, playerPos.z);
          try {
            window.gameClient?.world?.pathfinder?.findPath?.(from, to);
            state.lastPathAt = now;
            bot.log("cave A* pathing to waypoint", {
              ...waypoint,
              index: state.currentIndex + 1,
              total: route.length,
              targetTile,
              pathLength: path.length,
              waypointOnScreen,
            });
            return true;
          } catch (error) {
            bot.log("cave A* pathing failed to target tile, falling back", {
              targetTile,
              error: error?.message || error,
            });
          }
        }
      } else {
        bot.log("cave A* pathfinding failed, falling back to game pathfinder", {
          ...waypoint,
          index: state.currentIndex + 1,
          total: route.length,
        });
        }
      }
    }

    const fromPos = normalizePosition(from);
    const waypointPos = normalizePosition(waypoint);
    if (fromPos && waypointPos && fromPos.z === waypointPos.z) {
      }

    const to = new Position(waypoint.x, waypoint.y, waypoint.z);

    try {
      const nativePathfinder = window.gameClient?.world?.pathfinder;
      const findPath = nativePathfinder?.findPath;
      if (typeof findPath !== "function") throw new Error("native pathfinder.findPath is unavailable");
      const result = findPath.call(nativePathfinder, from, to);
      state.lastPathAt = now;
      bot.log("cave pathing to waypoint", {
        ...waypoint,
        index: state.currentIndex + 1,
        total: route.length,
        nativeResultType: Array.isArray(result) ? "array" : typeof result,
        nativeResultLength: Array.isArray(result) ? result.length : null,
      });
      return true;
    } catch (error) {
      bot.log("cave pathing failed", {
        ...waypoint,
        from: fromPos,
        to: waypointPos,
        error: error?.message || String(error),
        errorName: error?.name || null,
      });
      return false;
    }
  }

  function goToPosition(position) { if (!position) return false; return goToWaypoint(position); }
  function markPendingTransitionSource(source) {
    const normalized = normalizePosition(source);
    if (!normalized) return;
    state.pendingTransitionSource = { ...normalized, at: Date.now() };
  }
  function upsertTransition(from, to) {
    const normalizedFrom = normalizePosition(from);
    const normalizedTo = normalizePosition(to);
    if (!normalizedFrom || !normalizedTo || normalizedFrom.z === normalizedTo.z) return null;
    const key = getPositionKey(normalizedFrom);
    const index = transitions.findIndex((transition) => getPositionKey(transition.from) === key);
    const next = { from: normalizedFrom, to: normalizedTo, count: index >= 0 ? transitions[index].count + 1 : 1, lastSeenAt: Date.now() };
    if (index >= 0) transitions[index] = next;
    else transitions.push(next);
    persistTransitions();
    bot.log("cave learned floor transition", next);
    return cloneValue(next);
  }
  function resolveObservedTransitionSource(previousPosition) {
    const pending = normalizePosition(state.pendingTransitionSource);
    if (pending && pending.z === previousPosition.z) return pending;
    const currentTile = getTileAt(previousPosition);
    if (currentTile && isFloorChangeTile(currentTile)) return previousPosition;
    const nearby = findTransitionTileNearPosition(previousPosition, null, 1);
    if (nearby?.position) return nearby.position;
    return null;
  }
  function observePosition() {
    const current = normalizePosition(bot.getPlayerPosition());
    if (!current) return;
    const previous = state.lastObservedPosition;
    if (previous && !isSameTile(previous, current) && previous.z !== current.z) {
      const source = resolveObservedTransitionSource(previous);
      if (source) upsertTransition(source, current);
      state.pendingTransitionSource = null;
      bot.logDebug("[ROPE TRACE] FLOOR TRANSITION CONFIRMED", {
        from: previous,
        to: current,
        pendingTarget: cloneValue(state.ropeUsePendingTarget),
        lockedTarget: cloneValue(state.ropeLockedTarget),
      });
      clearRopeUsePending("floor transition confirmed");
      state.ropeLockedTarget = null;
      state.ropeLockedApproach = null;
    }
    state.lastObservedPosition = current;
  }

  function getEquipment() { return window.gameClient?.player?.equipment || null; }
  function getOpenContainers() { return Array.from(window.gameClient?.player?.__openedContainers || []); }
  function findAdjacentWalkablePosition(targetPosition, playerPosition) {
    if (!targetPosition || !playerPosition) return null;
    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];
    offsets.sort((a, b) => {
      const da = Math.abs(targetPosition.x + a.x - playerPosition.x) + Math.abs(targetPosition.y + a.y - playerPosition.y);
      const db = Math.abs(targetPosition.x + b.x - playerPosition.x) + Math.abs(targetPosition.y + b.y - playerPosition.y);
      return da - db;
    });
    for (const offset of offsets) {
      const position = new Position(targetPosition.x + offset.x, targetPosition.y + offset.y, targetPosition.z);
      const tile = window.gameClient?.world?.getTileFromWorldPosition?.(position);
      if (tile?.isWalkable?.()) return normalizePosition(position);
    }
    return null;
  }
  function isRopeItem(item) { const name = getThingName(item); return !!name && ropeNamePattern.test(name); }
  function isShovelItem(item) { const name = getThingName(item); return !!name && shovelNamePattern.test(name); }
  function findToolSource(predicate) {
    const equipment = getEquipment();
    if (equipment?.slots) {
      for (let slotIndex = 0; slotIndex < equipment.slots.length; slotIndex += 1) {
        const item = equipment.getSlotItem?.(slotIndex);
        if (predicate(item)) return { which: equipment, index: slotIndex, item, location: "equipment" };
      }
    }
    for (const container of getOpenContainers()) {
      const slots = container?.slots || [];
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const item = container.getSlotItem?.(slotIndex);
        if (predicate(item)) return { which: container, index: slotIndex, item, location: "container" };
      }
    }
    return null;
  }
  function findRopeSource() { return findToolSource(isRopeItem); }
  function findShovelSource() { return findToolSource(isShovelItem); }
  function useToolOnTile(tool, targetTile, targetPosition, actionLabel, now = Date.now(), lockedApproach = null) {
    if (!tool || !targetTile || !targetPosition) return false;
    const playerPosition = normalizePosition(bot.getPlayerPosition());
    if (!playerPosition) return false;
    if (!isAdjacentTile(playerPosition, targetPosition)) {
      const adjacentPosition = lockedApproach || findAdjacentWalkablePosition(targetPosition, playerPosition);
      if (adjacentPosition) return goToPosition(adjacentPosition);
      return false;
    }
    window.gameClient?.mouse?.__handleItemUseWith?.({ which: tool.which, index: tool.index }, { which: targetTile, index: 0xFF });
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(targetPosition);
    bot.log(actionLabel, { source: targetPosition, toolLocation: tool.location, toolSlot: tool.index, toolName: getThingName(tool.item) });
    return true;
  }
  const ROPE_USE_PENDING_TIMEOUT_MS = 3500;

  function clearRopeUsePending(reason = "cleared") {
    state.ropeUsePending = false;
    state.ropeUsePendingAt = 0;
    state.ropeUsePendingTarget = null;
    bot.logDebug("cave cleared pending rope use", { reason });
  }

  function isRopeUsePendingForTarget(targetPosition, now = Date.now()) {
    if (!state.ropeUsePending) return false;
    if (state.ropeUsePendingAt && now - state.ropeUsePendingAt >= ROPE_USE_PENDING_TIMEOUT_MS) {
      clearRopeUsePending("timeout");
      state.ropeLockedTarget = null;
      state.ropeLockedApproach = null;
      return false;
    }
    const pendingTarget = normalizePosition(state.ropeUsePendingTarget);
    return !!pendingTarget && !!targetPosition &&
      getPositionKey(pendingTarget) === getPositionKey(targetPosition);
  }

  function useRopeOnTile(targetTile, targetPosition, now = Date.now(), lockedApproach = null) {
    if (isRopeUsePendingForTarget(targetPosition, now)) {
      bot.logDebug("cave blocked duplicate rope use while transition is pending", {
        target: normalizePosition(targetPosition),
        pendingForMs: now - state.ropeUsePendingAt,
      });
      return true;
    }
    const ropeSource = findRopeSource();
    bot.logDebug("[ROPE TRACE] USE ATTEMPT", {
      target: normalizePosition(targetPosition),
      source: normalizePosition(ropeSource),
      playerPosition: normalizePosition(bot.getPlayerPosition()),
      pending: state.ropeUsePending,
    });
    const moved = useToolOnTile(ropeSource, targetTile, targetPosition, "cave roped transition tile", now, lockedApproach);
    bot.logDebug("[ROPE TRACE] USE RESULT", {
      target: normalizePosition(targetPosition),
      moved,
      playerPosition: normalizePosition(bot.getPlayerPosition()),
    });
    if (moved && isAdjacentTile(normalizePosition(bot.getPlayerPosition()), targetPosition)) {
      state.ropeUsePending = true;
      state.ropeUsePendingAt = now;
      state.ropeUsePendingTarget = normalizePosition(targetPosition);
      bot.logDebug("cave rope use accepted; waiting for floor transition before another rope use", {
        target: state.ropeUsePendingTarget,
        timeoutMs: ROPE_USE_PENDING_TIMEOUT_MS,
      });
      bot.logDebug("[ROPE TRACE] PENDING", {
        target: state.ropeUsePendingTarget,
        pendingAt: state.ropeUsePendingAt,
        timeoutMs: ROPE_USE_PENDING_TIMEOUT_MS,
      });
    }
    return moved;
  }
  function useShovelOnTile(targetTile, targetPosition, now = Date.now()) { return useToolOnTile(findShovelSource(), targetTile, targetPosition, "cave shoveled transition tile", now); }
  function useFloorChangeTile(target, waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    const targetPosition = normalizePosition(target?.position);
    const targetTile = target?.tile || (targetPosition ? getTileAt(targetPosition) : null);
    if (!position || !targetPosition || !targetTile) return false;
    if (now - state.lastStairsUseAt < 250) return true;
    if (waypoint?.z < position.z && isRopeTargetTile(targetTile)) return useRopeOnTile(targetTile, targetPosition, now);
    if (!isFloorChangeTile(targetTile)) {
      if (waypoint?.z > position.z && isShovelTargetTile(targetTile)) return useShovelOnTile(targetTile, targetPosition, now);
      return false;
    }
    if (isLadderTile(targetTile)) {
      window.gameClient?.mouse?.use?.({ which: targetTile, index: 0xFF });
      state.lastStairsUseAt = now;
      state.lastPathAt = now;
      markPendingTransitionSource(targetPosition);
      bot.log("cave used ladder tile", { source: targetPosition, targetZ: waypoint?.z ?? null });
      return true;
    }
    if (!isSameTile(position, targetPosition)) return goToPosition(targetPosition);
    const currentTile = getTileAt(position);
    if (!currentTile || !isFloorChangeTile(currentTile)) return false;
    window.gameClient?.mouse?.use?.({ which: currentTile, index: 0xFF });
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(position);
    bot.log("cave used floor-change tile", { source: position, targetZ: waypoint?.z ?? null });
    return true;
  }
  function handleFloorChange(waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position || !waypoint || position.z === waypoint.z) return false;

    // Rope floor changes are now owned by the Magic Rope waypoint action.
    // CaveBot must not scan nearby rope holes, walk to an approach square,
    // or send its own rope-use request here. It simply waits for the actual
    // Z-level change produced by the waypoint action, then the normal tick
    // resumes automatically.
    if (waypoint.z < position.z) {
      bot.logDebug("[ROPE TRACE] WAITING FOR MAGIC ROPE FLOOR CHANGE", {
        position,
        waypoint,
        waypointIndex: state.currentIndex + 1,
        pendingMagicRope: true,
      });
      return true;
    }

    // Non-rope floor changes (for example ladders/shovels) keep their
    // existing handling.
    const visibleCandidate = findNearbyTransitionTile(position, waypoint);
    if (visibleCandidate) {
      const moved = useFloorChangeTile(visibleCandidate, waypoint, now);
      if (moved) {
        bot.log("cave probing visible floor-change tile", {
          tileX: visibleCandidate.position.x,
          tileY: visibleCandidate.position.y,
          tileZ: visibleCandidate.position.z,
          targetZ: waypoint.z,
        });
        return true;
      }
    }

    const knownTransition = findBestKnownTransition(position, waypoint);
    if (knownTransition) {
      const target = { tile: getTileAt(knownTransition.from), position: knownTransition.from };
      const moved = useFloorChangeTile(target, waypoint, now);
      if (moved) {
        bot.log("cave using learned floor transition", { from: knownTransition.from, to: knownTransition.to, waypoint });
        return true;
      }
      bot.log("cave learned transition unavailable, falling back to live scan", {
        from: knownTransition.from,
        to: knownTransition.to,
        waypoint,
      });
    }
    return false;
  }

  function advanceWaypoint() {
    if (!route.length) return null;
    if (route.length === 1) return route[0];

    const previousDirection = state.direction;
    let nextIndex = state.currentIndex + state.direction;
    if (nextIndex >= route.length) {
      state.direction = -1;
      nextIndex = route.length - 2;
    } else if (nextIndex < 0) {
      state.direction = 1;
      nextIndex = 1;
    }

    // A waypoint can be visited again after the route reaches an endpoint.
    // Clear the native pathfinder's cached movement state whenever the route
    // advances (especially when direction reverses) so the next pass starts
    // with a fresh path instead of reusing stale movement state.
    try {
      window.gameClient?.world?.pathfinder?.setPathfindCache?.(null);
    } catch (_) {}
    state.lastPathAt = 0;
    state.lastProgressAt = Date.now();
    state.lastPositionKey = getPositionKey(bot.getPlayerPosition());

    state.currentIndex = Math.max(0, Math.min(route.length - 1, nextIndex));
    const nextWaypoint = getCurrentWaypoint();
    bot.log("cave advanced waypoint", {
      index: state.currentIndex + 1,
      total: route.length,
      direction: state.direction,
      directionChanged: previousDirection !== state.direction,
      waypoint: nextWaypoint,
    });
    return nextWaypoint;
  }
  function scheduleNextTick() {
    if (!isCurrentCaveGeneration() || !state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }
  function tick() {
    if (!isCurrentCaveGeneration() || !state.running) return;
    try {
      observePosition();
      cleanupPathCache();
      if (!route.length) { stop(); return; }
      const position = normalizePosition(bot.getPlayerPosition());
      const positionKey = getPositionKey(position);
      const now = Date.now();
      const attackStatus = bot.attack?.status?.() || null;
      state.tickCount += 1;
      if (state.tickCount % 5 === 0) {
        const waypoint = getCurrentWaypoint();
        const dist = waypoint && position ? getDistanceToWaypoint(position, waypoint) : null;
        bot.logDebug("cave tick summary", { pos: position, waypointIndex: state.currentIndex + 1, waypointTotal: route.length, distance: Number.isFinite(dist) ? dist : null, direction: state.direction, pausedForCombat: state.pausedForCombat, combatDurationMs: Number(attackStatus?.combatDurationMs || 0), combatTargetCount: Number(attackStatus?.targetCount || 0), pathfinderMode: config.pathfinderMode, stuckForMs: state.lastProgressAt ? now - state.lastProgressAt : 0 });
      }
      const shouldPauseForCombat = !!attackStatus?.combatActive && Number(attackStatus?.combatDurationMs || 0) < 60000;
      if (shouldPauseForCombat) {
        if (!state.pausedForCombat) {
          try {
            window.gameClient?.world?.pathfinder?.setPathfindCache?.(null);
          } catch (error) {
            bot.logDebug("cave failed to stop waypoint movement for combat", { error: error?.message || error });
          }
          state.pausedForCombat = true;
          resetStuckCounts();
          bot.log("cave paused for auto attack", { combatDurationMs: Number(attackStatus?.combatDurationMs || 0), targetCount: Number(attackStatus?.targetCount || 0) });
        }
        if (config.pathfinderMode === 'astar') {
          const target = bot.attack?.getCurrentTarget?.() || null;
          if (target) {
            const chaseResult = chaseTarget(target);
            bot.logDebug("cave combat chase", { chasing: chaseResult, targetId: target.id, targetName: target.name || "Mob", targetPos: normalizePosition(target.getPosition?.() || target.__position) });
          } else bot.logDebug("cave combat no target to chase");
        }
        return;
      }
      if (state.pausedForCombat) {
        state.pausedForCombat = false;
        resetStuckCounts();
        bot.log("cave resumed after auto attack", { combatDurationMs: Number(attackStatus?.combatDurationMs || 0), targetCount: Number(attackStatus?.targetCount || 0) });
      }
      if (positionKey && positionKey !== state.lastPositionKey) {
        state.lastPositionKey = positionKey;
        state.lastProgressAt = now;
        resetStuckCounts();
      }
      let waypoint = getCurrentWaypoint();
      if (!waypoint) { stop(); return; }

      // Waypoint actions, especially Use, must run from the CaveBot's
      // authoritative tick so movement and action execution cannot race.
      const waypointActionRunner = bot.cave?.executeWaypointAction;
      if (typeof waypointActionRunner === "function") {
        const actionHandled = waypointActionRunner();
        if (actionHandled) return;
      }

      const blockingWaypointAction = !!bot.cave?.isWaypointActionBlocking?.(state.currentIndex);
      const exactWaypoint = !!position && position.x === waypoint.x && position.y === waypoint.y && position.z === waypoint.z;
      // Action waypoints must never be auto-advanced by the normal
      // tolerance check. Use/Rope Spell may intentionally require the
      // player to be exactly on the waypoint tile.
      if (!blockingWaypointAction && isAtWaypoint(position, waypoint)) {
        const dist = getDistanceToWaypoint(position, waypoint);
        bot.logDebug("cave reached waypoint", { index: state.currentIndex + 1, waypoint, distance: Number.isFinite(dist) ? dist : null });
        waypoint = advanceWaypoint();
      }
      if (!waypoint) { bot.logDebug("cave no waypoint after advance, stopping"); return; }
      if (blockingWaypointAction && exactWaypoint) {
        // Once on the exact tile, the action runner owns the waypoint until
        // it explicitly advances. Before that, normal movement may continue
        // toward the exact tile, but the tolerance check above must not skip it.
        bot.logDebug("cave holding exact action waypoint", { index: state.currentIndex + 1, waypoint });
        return;
      }
      if (position && waypoint.z !== position.z) {
        bot.logDebug("cave floor change needed", { fromZ: position.z, toZ: waypoint.z, waypointIndex: state.currentIndex + 1, waypoint });
        bot.logDebug("[ROPE TRACE] FLOOR CHANGE REQUEST", {
          position,
          waypoint,
          waypointIndex: state.currentIndex + 1,
          direction: state.direction,
          lockedTarget: cloneValue(state.ropeLockedTarget),
          lockedApproach: cloneValue(state.ropeLockedApproach),
          pendingTarget: cloneValue(state.ropeUsePendingTarget),
          pending: state.ropeUsePending,
        });
        handleFloorChange(waypoint, now);
        return;
      }
      const timeSinceProgress = now - (state.lastProgressAt || now);
      const isStuck = timeSinceProgress >= 5000 && state.lastPositionKey === positionKey && positionKey != null;
      if (isStuck && config.pathfinderMode === 'astar') {
        const fallback = antiStuckFallback(waypoint);
        bot.log("cave anti-stuck triggered", { action: fallback.action, waypoint, stuckForMs: timeSinceProgress, attempt: (stuckCounts.get(`${waypoint.x},${waypoint.y}`) || 0) });
        if (fallback.action === 'skip_waypoint') {
          resetStuckCounts(`${waypoint.x},${waypoint.y}`);
          const skipped = getCurrentWaypoint();
          bot.logDebug("cave skipping stuck waypoint", { skippedWaypoint: waypoint, nextWaypoint: skipped, stuckForMs: timeSinceProgress });
          advanceWaypoint();
          return;
        }
        if (fallback.action === 'repath') resetStuckCounts(`${waypoint.x},${waypoint.y}`);
      }
      const shouldRepath = now - state.lastPathAt >= config.repathMs || !state.lastProgressAt || now - state.lastProgressAt >= config.repathMs;
      if (shouldRepath) {
        const dist = getDistanceToWaypoint(position, waypoint);
        bot.logDebug("cave pathing to waypoint", { index: state.currentIndex + 1, from: position, to: waypoint, distance: Number.isFinite(dist) ? dist : null, timeSinceLastPath: now - state.lastPathAt });
        goToWaypoint(waypoint);
      } else bot.logDebug("cave waiting for path", { timeSinceLastPath: now - state.lastPathAt, repathThreshold: config.repathMs });
    } catch (error) {
      const snapshot = { position: normalizePosition(bot.getPlayerPosition()), currentIndex: state.currentIndex, direction: state.direction, waypoint: getCurrentWaypoint(), routeLength: route.length, pausedForCombat: state.pausedForCombat, combatDurationMs: Number(bot.attack?.status?.()?.combatDurationMs || 0), pathfinderMode: config.pathfinderMode, error: error?.message || error };
      bot.log("cave tick failed", snapshot);
    } finally {
      scheduleNextTick();
    }
  }

  function startObserver() {
    if (state.observerTimerId != null) return;
    state.observerTimerId = window.setInterval(() => {
      try { observePosition(); } catch (error) { bot.log("cave observer failed", error?.message || error); }
    }, 200);
  }
  function stopObserver() {
    if (state.observerTimerId == null) return;
    window.clearInterval(state.observerTimerId);
    state.observerTimerId = null;
  }
  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 200;
    persistConfig();
    if (!route.length) { bot.log("cave bot cannot start without waypoints"); return false; }
    if (state.running) { bot.log("cave bot already running"); return false; }
    const position = normalizePosition(bot.getPlayerPosition());
    state.running = true;
    state.currentIndex = findClosestWaypointIndex(position);
    state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) state.direction = 1;
    state.lastPathAt = 0;
    state.lastPositionKey = getPositionKey(position);
    state.lastProgressAt = Date.now();
    state.ropeLockedTarget = null;
    state.ropeLockedApproach = null;
    clearRopeUsePending("cave bot started");
    state.pausedForCombat = false;
    bot.log("cave bot started", { waypoints: route.length, currentIndex: state.currentIndex + 1, direction: state.direction, waypoint: getCurrentWaypoint() });
    tick();
    return true;
  }
  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    stopObserver();
    // Keep the waypoint overlay alive while CaveBot is stopped. The main
    // bootstrap intentionally calls stop() after installing CaveBot, and
    // destroying the overlay here made all loaded waypoints disappear from
    // the minimap before the user could start CaveBot.
    startMinimapOverlay();
    if (shouldPersistEnabled) { config.enabled = false; persistConfig(); }
    state.pausedForCombat = false;
    state.ropeLockedTarget = null;
    state.ropeLockedApproach = null;
    clearRopeUsePending("cave bot stopped");
    bot.log("cave bot stopped");
    return true;
  }
  function addWaypoint(waypoint) {
    const normalized = normalizeWaypoint(waypoint);
    if (!normalized) return null;
    route.push(normalized);
    persistRoute();
    bot.log("cave waypoint added", { ...normalized, total: route.length });
    return cloneValue(normalized);
  }
  function addWaypointCurrentSpot() {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position) { bot.log("could not read current position for cave waypoint"); return null; }
    return addWaypoint(position);
  }
  function clearWaypoints() {
    route = [];
    state.currentIndex = 0;
    state.direction = 1;
    persistRoute();
    bot.log("cave route cleared");
    if (state.running) stop();
    return [];
  }
  function clearTransitions() {
    transitions = [];
    state.pendingTransitionSource = null;
    persistTransitions();
    bot.log("cave learned transitions cleared");
    return [];
  }
  function removeLastWaypoint() {
    if (!route.length) return null;
    const removed = route.pop();
    if (state.currentIndex >= route.length) state.currentIndex = Math.max(0, route.length - 1);
    if (route.length <= 1) state.direction = 1;
    persistRoute();
    bot.log("cave waypoint removed", removed);
    if (!route.length && state.running) stop();
    return removed;
  }
  function setCurrentIndex(index, directionOverride = null) {
    if (!route.length) { state.currentIndex = 0; state.direction = 1; return 0; }
    const nextIndex = Math.max(0, Math.min(route.length - 1, Math.trunc(Number(index) || 0)));
    state.currentIndex = nextIndex;
    if (route.length <= 1) {
      state.direction = 1;
    } else if (Number(directionOverride) === 1 || Number(directionOverride) === -1) {
      state.direction = Number(directionOverride);
    } else {
      state.direction = nextIndex >= route.length - 1 ? -1 : 1;
    }
    return state.currentIndex;
  }
  function status() {
    const position = normalizePosition(bot.getPlayerPosition());
    const waypoint = getCurrentWaypoint();
    return {
      running: state.running,
      config: { ...config },
      route: getRoute(),
      transitions: getTransitions(),
      presetNames: getPresetNames(),
      activePresetName: getActivePresetName(),
      currentIndex: state.currentIndex,
      direction: state.direction,
      currentWaypoint: cloneValue(waypoint),
      distanceToWaypoint: getDistanceToWaypoint(position, waypoint),
      lastPathAt: state.lastPathAt,
      lastProgressAt: state.lastProgressAt,
      pendingTransitionSource: cloneValue(state.pendingTransitionSource),
      ropeUsePending: state.ropeUsePending,
      ropeUsePendingAt: state.ropeUsePendingAt,
      ropeUsePendingTarget: cloneValue(state.ropeUsePendingTarget),
      pausedForCombat: state.pausedForCombat,
    };
  }
  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    config.tickMs = 200;
    persistConfig();
    bot.log("cave config updated", { ...config });
    return { ...config };
  }

  startObserver();
  bot.addCleanup(stopObserver);
  bot.addCleanup(function () {
    resetStuckCounts();
    pathCache.clear();
    matrixCache.clear();
  });
  startMinimapOverlay();
  bot.addCleanup(stopMinimapOverlay);
  if (config.enabled && route.length) start();

  bot.cave = {
    start,
    stop,
    status,
    updateConfig,
    config,
    getRoute,
    setWaypointMetadata,
    getTransitions,
    getPresetNames,
    getActivePresetName,
    getCurrentWaypoint,
    createPreset,
    savePreset,
    loadPreset,
    deletePreset,
    addWaypoint,
    addWaypointCurrentSpot,
    clearWaypoints,
    clearTransitions,
    removeLastWaypoint,
    setCurrentIndex,
    goToWaypoint,
    goToPosition,
    handleFloorChange,
    findClosestWaypointIndex,
    findRopeSource,
    findShovelSource,
    inspectNearbyTiles: (radius = 1) => {
      const position = normalizePosition(bot.getPlayerPosition());
      if (!position) return [];
      return getLoadedTiles()
        .map((tile) => ({ tile, position: getTilePosition(tile) }))
        .filter((entry) => entry.position && entry.position.z === position.z && Math.abs(entry.position.x - position.x) <= radius && Math.abs(entry.position.y - position.y) <= radius)
        .map((entry) => ({
          position: entry.position,
          isFloorChange: isFloorChangeTile(entry.tile),
          isHole: isHoleTile(entry.tile),
          isRopeTarget: isRopeTargetTile(entry.tile),
          isShovelTarget: isShovelTargetTile(entry.tile),
          names: getTileThings(entry.tile).map((thing) => getThingName(thing)).filter(Boolean),
        }));
    },
    isAtWaypoint,
  };
};