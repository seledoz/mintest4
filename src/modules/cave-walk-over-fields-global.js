window.__minibiaBotBundle = window.__minibiaBotBundle || {};

(function installGlobalCaveFieldPathing() {
  // Support both the classic Tibia field IDs (2118-2127/neutral 2131-2133)
  // and the older OTServer-style IDs already used by this client.
  const FIRE_FIELD_IDS = new Set([
    1487, 1488, 1489,
    1492, 1493, 1494,
    1500, 1501, 1502,
    2118, 2119, 2120,
    2123, 2124, 2125,
    2131, 2132, 2133,
  ]);
  const FIRE_FIELD_PATTERN = /(?:fire|flame)\s*(?:field|wall|damage|ground|tile)/i;
  const POISON_FIELD_IDS = new Set([2127]);
  const POISON_FIELD_PATTERN = /(?:poison|venom)\s*(?:field|wall|damage|ground|tile)/i;
  // Fire 2123-2125 and poison 2127 must be accepted by every CaveBot
  // pathing mode. Other fire stages remain controlled by Walk Over Fields.
  const ALWAYS_WALKABLE_FIRE_FIELD_IDS = new Set([2123, 2124, 2125]);
  const ALWAYS_WALKABLE_POISON_FIELD_IDS = new Set([2127]);
  const state = { timerId: null, installed: false, patchedTiles: new Set() };

  function getDefinition(thing) {
    const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
    if (!Number.isFinite(id)) return null;
    const client = window.gameClient;
    return client?.itemDefinitionsByCid?.[id]
      || client?.itemDefinitionsBySid?.[id]
      || client?.itemDefinitions?.[id]
      || null;
  }

  function getThings(tile) {
    if (!tile) return [];
    const result = [];
    const add = (value) => {
      if (!value) return;
      if (Array.isArray(value)) value.forEach(add);
      else if (!result.includes(value)) result.push(value);
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
    return result;
  }

  function isAlwaysWalkableFireFieldTile(tile) {
    for (const thing of getThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (ALWAYS_WALKABLE_FIRE_FIELD_IDS.has(id)) return true;
    }
    return false;
  }

  function isPoisonFieldTile(tile) {
    for (const thing of getThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (POISON_FIELD_IDS.has(id)) return true;
      const definition = getDefinition(thing);
      const text = [
        thing?.name, thing?.itemName, thing?.field, thing?.fieldType,
        thing?.type, thing?.thingType, thing?.category,
        definition?.name, definition?.properties?.name,
        definition?.properties?.field, definition?.properties?.type,
        definition?.properties?.category,
      ].filter(Boolean).map(String).join(" ");
      if (POISON_FIELD_PATTERN.test(text) || /\bpoison\s*field\b/i.test(text)) return true;
    }
    return false;
  }

  function isAlwaysWalkableFieldTile(tile) {
    return isAlwaysWalkableFireFieldTile(tile) || isPoisonFieldTile(tile);
  }

  function isFireFieldTile(tile) {
    for (const thing of getThings(tile)) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      if (FIRE_FIELD_IDS.has(id)) return true;
      const definition = getDefinition(thing);
      const text = [
        thing?.name, thing?.itemName, thing?.field, thing?.fieldType,
        thing?.type, thing?.thingType, thing?.category,
        definition?.name, definition?.properties?.name,
        definition?.properties?.field, definition?.properties?.type,
        definition?.properties?.category,
      ].filter(Boolean).map(String).join(" ");
      if (FIRE_FIELD_PATTERN.test(text) || /\bfire\s*field\b/i.test(text)) return true;
    }
    return false;
  }

  const definitionPatches = new Map();

  function patchFieldDefinitions(bot) {
    const status = bot.cave?.status?.();
    const enabled = !!status?.config?.walkOverFields;
    const client = window.gameClient;
    if (!client) return;

    const containers = [
      client.itemDefinitionsByCid,
      client.itemDefinitionsBySid,
      client.itemDefinitions,
    ].filter(Boolean);

    for (const container of containers) {
      for (const id of [...FIRE_FIELD_IDS, ...POISON_FIELD_IDS]) {
        const definition = container[id];
        // The three MinTest3 fire-field stages 2123-2125 are always ordinary
        // walkable squares. Patch their definition even when Walk Over Fields
        // is disabled, because the native pathfinder may use item-definition
        // collision flags instead of the tile isWalkable() wrapper.
        const isPoison = POISON_FIELD_IDS.has(id);
        const alwaysWalkable = ALWAYS_WALKABLE_FIRE_FIELD_IDS.has(id) ||
          ALWAYS_WALKABLE_POISON_FIELD_IDS.has(id) || isPoison;
        if (!definition || definitionPatches.has(definition)) continue;
        if (!enabled && !alwaysWalkable) continue;
        const props = definition.properties && typeof definition.properties === "object"
          ? definition.properties
          : definition;
        const keys = [
          "walkable", "walkableTile", "passable", "pathable",
          "blocking", "blocksMovement", "blocksWalk", "blockMovement",
          "block", "blocks", "unwalkable", "impassable",
        ];
        const original = {};
        let changed = false;
        for (const key of keys) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
          original[key] = props[key];
          if (key === "blocking" || key === "blocksMovement" || key === "blocksWalk" ||
              key === "blockMovement" || key === "block" || key === "blocks" ||
              key === "unwalkable" || key === "impassable") {
            props[key] = false;
          } else {
            props[key] = true;
          }
          changed = true;
        }
        if (changed) definitionPatches.set(definition, {
          props,
          original,
          alwaysWalkable: ALWAYS_WALKABLE_FIRE_FIELD_IDS.has(id) || isPoison,
        });
      }
    }

    if (!enabled) {
      for (const [definition, patch] of definitionPatches) {
        // Keep 2123-2125 patched permanently: these are unconditional
        // CaveBot walkable squares, not optional Walk Over Fields tiles.
        if (patch.alwaysWalkable) continue;
        for (const [key, value] of Object.entries(patch.original)) patch.props[key] = value;
        definitionPatches.delete(definition);
      }
    }
  }

  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];
    for (const chunk of chunks) {
      if (!Array.isArray(chunk?.tiles)) continue;
      for (const tile of chunk.tiles) if (tile) tiles.push(tile);
    }
    return tiles;
  }

  function patchFieldObject(object, bot) {
    if (!object || typeof object !== "object") return false;
    const alwaysWalkable = isAlwaysWalkableFieldTile(object) || isFireFieldTile(object);
    if (!alwaysWalkable) return false;
    let changed = false;
    const patchContainer = (target) => {
      if (!target || typeof target !== "object") return;
      for (const key of Object.keys(target)) {
        if (!/(walk|path|pass|block|collision|obstacle|solid|impass|unwalk)/i.test(key)) continue;
        if (typeof target[key] !== "boolean") continue;
        try {
          target[key] = /^(?:block|blocks|blocking|blocksMovement|blocksWalk|blockMovement|unwalkable|impassable|isBlocking|blocksPath|blocksPathfinding|collision|collides|obstacle|solid)$/i.test(key) ? false : true;
          changed = true;
        } catch (_) {}
      }
    };
    patchContainer(object);
    patchContainer(object.properties);
    patchContainer(object.definition);
    return changed;
  }

  function patchFieldMethods(object, bot) {
    if (!object || typeof object !== "object") return;
    const methods = ["isWalkable", "isPassable", "isPathable", "isBlocking", "blocksMovement", "canWalk", "blocksPath", "blocksPathfinding"];
    for (const name of methods) {
      if (typeof object[name] !== "function" || object[name].__globalCaveFieldWalkable) continue;
      const original = object[name];
      const wrapper = function globalCaveFieldObjectPassability(...args) {
        if (isAlwaysWalkableFieldTile(this) || (bot.cave?.status?.()?.config?.walkOverFields && isFireFieldTile(this))) {
          return name === "isBlocking" || name === "blocksMovement" || name === "blocksPath" || name === "blocksPathfinding" ? false : true;
        }
        return original.apply(this, args);
      };
      wrapper.__globalCaveFieldWalkable = true;
      wrapper.__globalCaveFieldOriginal = original;
      try { object[name] = wrapper; } catch (_) {}
    }
  }

  function patchTile(tile, bot) {
    if (!tile || typeof tile.isWalkable !== "function") return false;
    if (tile.isWalkable.__globalCaveFieldWalkable) return true;
    const original = tile.isWalkable;
    const wrapper = function globalCaveFieldWalkable(...args) {
      const status = bot.cave?.status?.();
      if (isAlwaysWalkableFieldTile(this) ||
          (status?.config?.walkOverFields && isFireFieldTile(this))) return true;
      return original.apply(this, args);
    };
    wrapper.__globalCaveFieldWalkable = true;
    wrapper.__globalCaveFieldOriginal = original;
    tile.isWalkable = wrapper;
    state.patchedTiles.add(tile);
    return true;
  }

  function patchPrototype(bot, from = null, to = null) {
    const position = bot.getPlayerPosition?.();
    if (!position) return false;

    let tile = null;
    try {
      tile = window.gameClient?.world?.getTileFromWorldPosition?.(
        new Position(Number(position.x), Number(position.y), Number(position.z))
      );
    } catch (_) {}

    const prototype = tile && Object.getPrototypeOf(tile);
    if (!prototype) return false;

    // Native Pathfinder.search() explicitly rejects any intermediate tile for
    // which Tile.isNotPathable() is true. Fire stages 2123-2125 and poison
    // 2127 carry DatFlagNotPathable, even though CaveBot must treat them as
    // ordinary walkable squares. Patch this exact native pathfinding predicate
    // rather than relying only on Tile.isWalkable().
    const isAlwaysPathableFieldTile = (candidate) => {
      if (!candidate) return false;
      const items = Array.isArray(candidate.items) ? candidate.items : [];
      for (const item of items) {
        const id = Number(item?.id ?? item?.itemId ?? item?.serverId ?? item?.clientId);
        if (ALWAYS_WALKABLE_FIRE_FIELD_IDS.has(id) ||
            ALWAYS_WALKABLE_POISON_FIELD_IDS.has(id)) {
          return true;
        }
      }
      return false;
    };

    const pathabilityName = "isNotPathable";
    const current = prototype[pathabilityName];
    if (typeof current === "function" && !current.__globalCaveFieldNativePathability) {
      const wrapper = function globalCaveFieldNativePathability(...args) {
        if (isAlwaysPathableFieldTile(this)) return false;

        const status = bot.cave?.status?.();
        if (status?.config?.walkOverFields && isFireFieldTile(this)) {
          return false;
        }

        return current.apply(this, args);
      };

      wrapper.__globalCaveFieldNativePathability = true;
      wrapper.__globalCaveFieldNativePathabilityOriginal = current;

      try {
        Object.defineProperty(prototype, pathabilityName, {
          value: wrapper,
          writable: true,
          configurable: true,
        });
      } catch (_) {
        try { prototype[pathabilityName] = wrapper; } catch (_) {}
      }
    }

    // Keep the existing walkability patches for CaveBot's other pathing
    // checks. The critical native Pathfinder.search() check above is separate.
    const predicates = [
      "isWalkable", "isPassable", "isPathable",
      "isBlocking", "blocksMovement", "canWalk"
    ];

    for (const name of predicates) {
      if (typeof prototype[name] !== "function" || prototype[name].__globalCaveFieldWalkable) continue;

      const original = prototype[name];
      const wrapper = function globalCaveFieldPassability(...args) {
        if (isAlwaysPathableFieldTile(this) ||
            (bot.cave?.status?.()?.config?.walkOverFields && isFireFieldTile(this))) {
          if (name === "isBlocking" || name === "blocksMovement") return false;
          return true;
        }
        return original.apply(this, args);
      };

      wrapper.__globalCaveFieldWalkable = true;
      wrapper.__globalCaveFieldWalkableOriginal = original;

      try {
        Object.defineProperty(prototype, name, {
          value: wrapper,
          writable: true,
          configurable: true,
        });
      } catch (_) {
        try { prototype[name] = wrapper; } catch (_) {}
      }
    }

    return true;
  }

  function patchAllLoadedTiles(bot, from = null, to = null) {
    // Do not scan every loaded map tile here. Besides being unnecessary for
    // native pathfinding, that approach caused large FPS drops on big maps.
    // The previous implementation also called getTileThings(), which is not
    // a global API in this client and crashed the entire source loader.
    //
    // Keep this path intentionally small: patch the item definitions and the
    // tile prototype used by the native pathfinder. The native pathfinder can
    // then evaluate field tiles normally without a loaded-chunk scan.
    patchFieldDefinitions(bot);
    patchPrototype(bot, from, to);
  }

  function installPathfinderGuard(bot) {
    const pathfinder = window.gameClient?.world?.pathfinder;
    if (!pathfinder || typeof pathfinder.findPath !== "function") return false;
    if (pathfinder.findPath.__globalCaveFieldGuard) return true;

    // Keep the game's native movement/pathfinding algorithm. Only change
    // field collision passability; ordinary fire stages still honor the toggle.
    const originalFindPath = pathfinder.findPath;
    function guardedFindPath(...args) {
      const status = bot.cave?.status?.();
      // Always refresh the unconditional 2123-2125 collision patch before
      // native pathfinding. Other field stages remain controlled by the toggle.
      patchAllLoadedTiles(bot, args[0], args[1]);
      // Native pathfinder caches can retain a collision matrix created before
      // the unconditional 2123-2125 patches were installed. Invalidate the
      // native cache immediately before each CaveBot path request.
      try {
        if (typeof pathfinder.setPathfindCache === "function") {
          pathfinder.setPathfindCache(null);
        }
      } catch (_) {}
      const result = originalFindPath.apply(this, args);
      try {
        bot.logDebug?.("cave native pathfinder request", {
          from: args[0] ? { x: Number(args[0].x), y: Number(args[0].y), z: Number(args[0].z) } : null,
          to: args[1] ? { x: Number(args[1].x), y: Number(args[1].y), z: Number(args[1].z) } : null,
          resultType: Array.isArray(result) ? "array" : typeof result,
          resultLength: Array.isArray(result) ? result.length : null,
        });
      } catch (_) {}
      return result;
    }
    guardedFindPath.__globalCaveFieldGuard = true;
    guardedFindPath.__globalCaveFieldOriginal = originalFindPath;
    pathfinder.findPath = guardedFindPath;
    return true;
  }

  function install() {
    const bot = window.minibiaBot;
    if (!bot?.cave) return false;
    patchAllLoadedTiles(bot);
    installPathfinderGuard(bot);
    state.installed = true;
    return true;
  }

  function start() {
    if (install()) return;
    let attempts = 0;
    state.timerId = window.setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 80) {
        window.clearInterval(state.timerId);
        state.timerId = null;
      }
    }, 250);
  }

  start();
})();