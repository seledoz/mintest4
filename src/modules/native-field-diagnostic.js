(() => {
  window.__minibiaBotBundle = window.__minibiaBotBundle || {};

  window.__minibiaBotBundle.installNativeFieldDiagnosticModule = function installNativeFieldDiagnosticModule(bot) {
    if (!bot || bot.nativeFieldDiagnostic) return bot?.nativeFieldDiagnostic || null;

    const sectionId = "minibia-bot-native-field-diagnostic-section";
    const state = { lastResult: null, uiObserver: null };

    function normalizePosition(value) {
      const raw = value?.getPosition?.() || value?.__position || value?.position || value;
      if (!raw) return null;
      const x = Number(raw.x), y = Number(raw.y), z = Number(raw.z);
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        ? { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) }
        : null;
    }

    function getTile(position) {
      if (!position) return null;
      try {
        const PositionCtor = window.Position;
        const value = PositionCtor
          ? new PositionCtor(position.x, position.y, position.z)
          : position;
        return window.gameClient?.world?.getTileFromWorldPosition?.(value) || null;
      } catch (_) {
        return null;
      }
    }

    function getTileThings(tile) {
      if (!tile) return [];
      const values = [];
      const add = (value) => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(add); return; }
        if (!values.includes(value)) values.push(value);
      };
      add(tile);
      add(tile.items);
      add(tile.things);
      add(tile.objects);
      add(tile.gameObjects);
      add(tile.entities);
      return values;
    }

    function getDefinition(id) {
      if (!Number.isFinite(id)) return null;
      return window.gameClient?.itemDefinitionsByCid?.[id] ||
        window.gameClient?.itemDefinitionsBySid?.[id] ||
        window.gameClient?.itemDefinitions?.[id] || null;
    }

    function getThingInfo(thing) {
      const id = Number(thing?.id ?? thing?.itemId ?? thing?.serverId ?? thing?.clientId);
      const definition = getDefinition(id);
      const properties = definition?.properties || thing?.properties || {};
      const collision = {};
      for (const key of [
        "walkable", "walkableTile", "passable", "pathable", "blocking",
        "blocksMovement", "blocksWalk", "blockMovement", "block", "blocks",
        "unwalkable", "impassable"
      ]) {
        if (key in properties) collision[key] = properties[key];
        else if (key in (thing || {})) collision[key] = thing[key];
      }
      return {
        id: Number.isFinite(id) ? id : null,
        name: String(thing?.name ?? thing?.itemName ?? definition?.name ?? "").trim() || null,
        type: String(thing?.type ?? definition?.type ?? "").trim() || null,
        collision,
      };
    }

    function getNativePath(from, to) {
      const pathfinder = window.gameClient?.world?.pathfinder;
      if (typeof pathfinder?.findPath !== "function") {
        return { available: false, error: "native pathfinder.findPath unavailable" };
      }
      try {
        const PositionCtor = window.Position;
        const fromValue = PositionCtor ? new PositionCtor(from.x, from.y, from.z) : from;
        const toValue = PositionCtor ? new PositionCtor(to.x, to.y, to.z) : to;
        const result = pathfinder.findPath.call(pathfinder, fromValue, toValue);
        return {
          available: true,
          ok: Array.isArray(result) ? result.length > 0 : !!result,
          resultType: Array.isArray(result) ? "array" : typeof result,
          resultLength: Array.isArray(result) ? result.length : null,
          result
        };
      } catch (error) {
        return { available: true, ok: false, error: String(error?.message || error) };
      }
    }

    function findStandOnTest(target) {
      const candidates = [];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          const from = { x: target.x + dx, y: target.y + dy, z: target.z };
          const result = getNativePath(from, target);
          candidates.push({ from, ...result });
          if (result.ok) return { found: true, candidates };
        }
      }
      return { found: false, candidates };
    }

    function scanCurrentTile() {
      const position = normalizePosition(bot.getPlayerPosition?.());
      if (!position) throw new Error("Player position unavailable");

      const tile = getTile(position);
      if (!tile) throw new Error("Native tile unavailable at current position");

      const nativeWalkable = typeof tile.isWalkable === "function"
        ? (() => { try { return !!tile.isWalkable(); } catch (_) { return null; } })()
        : null;

      const things = getTileThings(tile).map(getThingInfo);
      const standOn = findStandOnTest(position);
      const result = {
        scannedAt: new Date().toISOString(),
        position,
        nativeTileIsWalkable: nativeWalkable,
        nativeStandOnExactSquare: standOn.found,
        standOnCandidates: standOn.candidates.map(({ from, ok, available, resultType, resultLength, error }) =>
          ({ from, ok, available, resultType, resultLength, error: error || null })),
        things
      };
      state.lastResult = result;
      renderResult();
      bot.log?.("Native field diagnostic scan", result);
      return result;
    }

    function formatResult(result) {
      if (!result) return "No scan yet.";
      const lines = [
        `Tile: ${result.position.x}, ${result.position.y}, ${result.position.z}`,
        `Native tile.isWalkable(): ${result.nativeTileIsWalkable === null ? "unavailable" : result.nativeTileIsWalkable ? "YES" : "NO"}`,
        `Native path to exact square: ${result.nativeStandOnExactSquare ? "YES" : "NO"}`,
        "",
        "Things on tile:"
      ];
      if (!result.things.length) lines.push("  (none exposed)");
      result.things.forEach((thing) => {
        lines.push(`  ID ${thing.id ?? "?"} | ${thing.name || "(unnamed)"} | type: ${thing.type || "?"}`);
        const entries = Object.entries(thing.collision);
        if (entries.length) lines.push("    collision: " + entries.map(([k,v]) => `${k}=${String(v)}`).join(", "));
      });
      return lines.join("\n");
    }

    function renderResult() {
      const output = document.getElementById("minibia-bot-native-field-diagnostic-result");
      if (output) output.textContent = formatResult(state.lastResult);
    }

    function installUi() {
      if (document.getElementById(sectionId)) { renderResult(); return true; }
      const anchor = document.getElementById("minibia-bot-cave-add")?.closest?.(".mb-section");
      if (!anchor?.parentElement) return false;

      const section = document.createElement("div");
      section.id = sectionId;
      section.className = "mb-section";
      section.innerHTML = `
        <div class="mb-label">Native Field Diagnostic</div>
        <div class="mb-stack">
          <div class="mb-small-note">Diagnostic only. This module never changes tile walkability or CaveBot pathing.</div>
          <button type="button" id="minibia-bot-native-field-diagnostic-scan">Scan Current Tile / Test Stand On</button>
          <pre id="minibia-bot-native-field-diagnostic-result" style="white-space:pre-wrap;font-size:11px;max-height:260px;overflow:auto;margin:6px 0 0;"></pre>
        </div>`;
      anchor.insertAdjacentElement("afterend", section);
      section.querySelector("#minibia-bot-native-field-diagnostic-scan")?.addEventListener("click", () => {
        try { scanCurrentTile(); } catch (error) {
          state.lastResult = { error: String(error?.message || error) };
          const output = document.getElementById("minibia-bot-native-field-diagnostic-result");
          if (output) output.textContent = "Scan failed: " + state.lastResult.error;
        }
      });
      renderResult();
      return true;
    }

    function ensureUi() {
      if (installUi()) {
        state.uiObserver?.disconnect();
        state.uiObserver = null;
        return true;
      }
      if (!state.uiObserver) {
        state.uiObserver = new MutationObserver(() => installUi());
        state.uiObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
      }
      return false;
    }

    bot.nativeFieldDiagnostic = { scanCurrentTile, status: () => ({ lastResult: state.lastResult }) };
    ensureUi();
    bot.addCleanup?.(() => {
      state.uiObserver?.disconnect();
      state.uiObserver = null;
      document.getElementById(sectionId)?.remove();
    });
    return bot.nativeFieldDiagnostic;
  };
})();
