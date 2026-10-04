(() => {
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installPlayerManaPotionModule = function installPlayerManaPotionModule(bot) {
  if (!bot || bot.playerManaPotion) return bot?.playerManaPotion || null;

  const configStorageKey = "minibiaBot.playerManaPotion.config";
  const sectionId = "minibia-bot-player-mana-potion-section";
  const state = { running: false, timerId: null, targetTimerId: null, uiObserver: null, lastAttemptAt: 0, lastUseAt: 0 };
  const config = Object.assign({
    enabled: false,
    playerName: "",
    hotbarSlot: 1,
    scanMs: 100,
    retryMs: 250,
    cooldownMs: 1025,
    targetDelayMs: 100
  }, bot.storage.get(configStorageKey, {}) || {});

  function persistConfig() { bot.storage.set(configStorageKey, { ...config }); }
  function normalizeName(value) { return String(value || "").trim().toLowerCase(); }
  function normalizeSlot(value) {
    const slot = Math.trunc(Number(value));
    return Number.isFinite(slot) && slot >= 1 && slot <= 12 ? slot : null;
  }
  function getPosition(value) {
    const raw = value?.getPosition?.() || value?.__position || value?.position || value;
    if (!raw) return null;
    const x = Number(raw.x), y = Number(raw.y), z = Number(raw.z);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
      ? { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) } : null;
  }
  function distance(a, b) {
    if (!a || !b || a.z !== b.z) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  config.playerName = String(config.playerName || "").trim();
  config.hotbarSlot = normalizeSlot(config.hotbarSlot) || 1;
  config.scanMs = Math.max(75, Math.trunc(Number(config.scanMs) || 100));
  config.retryMs = Math.max(100, Math.trunc(Number(config.retryMs) || 250));
  config.cooldownMs = 1025;
  config.targetDelayMs = 100;
  config.enabled = !!config.enabled;

  function findTarget() {
    const wanted = normalizeName(config.playerName);
    if (!wanted) return null;
    return (bot.xray?.getVisiblePlayers?.({ sameFloorOnly: true }) || [])
      .find(p => normalizeName(p?.name) === wanted) || null;
  }
  function isInRange(player) {
    return distance(getPosition(bot.getPlayerPosition?.()), getPosition(player)) <= 1;
  }
  function getGameCanvas() {
    return Array.from(document.querySelectorAll("canvas"))
      .map(canvas => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(x => x.rect.width >= 200 && x.rect.height >= 150)
      .sort((a,b) => b.rect.width*b.rect.height - a.rect.width*a.rect.height)[0] || null;
  }
  function dispatchScreenClick(canvas, clientX, clientY) {
    const common = { bubbles:true, cancelable:true, composed:true, clientX, clientY,
      screenX:clientX, screenY:clientY, button:0, buttons:1, detail:1, view:window };
    try {
      if (typeof PointerEvent === "function") {
        canvas.dispatchEvent(new PointerEvent("pointermove",{...common,pointerId:1,pointerType:"mouse",isPrimary:true}));
        canvas.dispatchEvent(new PointerEvent("pointerdown",{...common,pointerId:1,pointerType:"mouse",isPrimary:true}));
        canvas.dispatchEvent(new PointerEvent("pointerup",{...common,buttons:0,pointerId:1,pointerType:"mouse",isPrimary:true}));
      }
      canvas.dispatchEvent(new MouseEvent("mousemove",common));
      canvas.dispatchEvent(new MouseEvent("mousedown",common));
      canvas.dispatchEvent(new MouseEvent("mouseup",{...common,buttons:0}));
      canvas.dispatchEvent(new MouseEvent("click",{...common,buttons:0}));
      return true;
    } catch (_) { return false; }
  }
  function clickPlayer(player) {
    const me = getPosition(bot.getPlayerPosition?.());
    const target = getPosition(player);
    const info = getGameCanvas();
    if (!me || !target || !info || target.z !== me.z || distance(me,target) > 1) return false;
    const {canvas,rect} = info;
    const tw = rect.width/17, th = rect.height/13;
    const x = rect.left + ((target.x-me.x+8.5)*tw);
    const y = rect.top + ((target.y-me.y+6.5)*th);
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    return dispatchScreenClick(canvas,x,y);
  }
  function finishTarget() {
    state.targetTimerId = null;
    if (!state.running || !config.enabled) return false;
    const target = findTarget();
    if (!target || !isInRange(target)) return false;
    const used = clickPlayer(target);
    if (used) state.lastUseAt = Date.now();
    return used;
  }
  function tryUse(now=Date.now()) {
    if (!state.running || !config.enabled || state.targetTimerId != null) return false;
    const slot = normalizeSlot(config.hotbarSlot);
    if (!slot || now-state.lastUseAt < config.cooldownMs || now-state.lastAttemptAt < config.retryMs) return false;
    const target = findTarget();
    if (!target || !isInRange(target)) return false;
    state.lastAttemptAt = now;
    if (!bot.clickHotbar?.(slot-1)) return false;
    state.targetTimerId = window.setTimeout(finishTarget, config.targetDelayMs);
    return true;
  }
  function tick() {
    if (!state.running || !config.enabled) return;
    try { tryUse(); } catch (e) { bot.log?.("Mana potion player tick failed", e?.message || e); }
    finally { if (state.running && config.enabled) state.timerId = window.setTimeout(tick, config.scanMs); }
  }
  function syncUi() {
    const toggle=document.getElementById("minibia-bot-player-mana-potion-enabled");
    const name=document.getElementById("minibia-bot-player-mana-potion-name");
    const hotkey=document.getElementById("minibia-bot-player-mana-potion-hotkey");
    if(toggle) toggle.checked=state.running;
    if(name && document.activeElement!==name) name.value=config.playerName;
    if(hotkey && document.activeElement!==hotkey) hotkey.value=String(config.hotbarSlot);
  }
  function installUi() {
    if(document.getElementById(sectionId)){syncUi();return true;}
    const anchor=document.getElementById("minibia-bot-player-uh-section");
    if(!anchor?.parentElement) return false;
    const section=document.createElement("div");
    section.id=sectionId; section.className="mb-section";
    section.innerHTML=`<div class="mb-label">Mana Potion Player</div><div class="mb-stack">
      <label class="mb-field"><span class="mb-field-label">Player Name</span><input type="text" id="minibia-bot-player-mana-potion-name" placeholder="Exact player name"></label>
      <label class="mb-field"><span class="mb-field-label">Mana Potion Crosshair Hotkey</span><input type="number" id="minibia-bot-player-mana-potion-hotkey" min="1" max="12"></label>
      <label class="mb-toggle"><input type="checkbox" id="minibia-bot-player-mana-potion-enabled"><span>Enable Mana Potion Player</span></label>
      <div class="mb-small-note">Uses the mana-potion crosshair hotkey when the named player is within 1 square on the same floor. Cooldown: 1025 ms.</div>
    </div>`;
    anchor.insertAdjacentElement("afterend",section);
    section.querySelector("#minibia-bot-player-mana-potion-name")?.addEventListener("change",e=>updateConfig({playerName:e.target.value}));
    section.querySelector("#minibia-bot-player-mana-potion-hotkey")?.addEventListener("change",e=>updateConfig({hotbarSlot:e.target.value}));
    section.querySelector("#minibia-bot-player-mana-potion-enabled")?.addEventListener("change",e=>e.target.checked?start():stop());
    syncUi(); return true;
  }
  function stopObserver(){state.uiObserver?.disconnect();state.uiObserver=null;}
  function ensureUi() {
    if(installUi()){stopObserver();return true;}
    if(state.uiObserver)return false;
    state.uiObserver=new MutationObserver(()=>{if(installUi())stopObserver();});
    state.uiObserver.observe(document.documentElement||document.body,{childList:true,subtree:true});
    return false;
  }
  function updateConfig(next={}) {
    if("playerName" in next) next.playerName=String(next.playerName||"").trim();
    if("hotbarSlot" in next) next.hotbarSlot=normalizeSlot(next.hotbarSlot)||config.hotbarSlot;
    if("enabled" in next) next.enabled=!!next.enabled;
    Object.assign(config,next,{cooldownMs:1025,targetDelayMs:100});
    persistConfig(); syncUi(); return {...config};
  }
  function start(overrides={}) {
    updateConfig({...overrides,enabled:true});
    if(state.running)return false;
    state.running=true; ensureUi(); tick(); syncUi(); return true;
  }
  function stop(options={}) {
    state.running=false;
    if(state.timerId!=null){window.clearTimeout(state.timerId);state.timerId=null;}
    if(state.targetTimerId!=null){window.clearTimeout(state.targetTimerId);state.targetTimerId=null;}
    stopObserver();
    if(options.persistEnabled!==false){config.enabled=false;persistConfig();}
    syncUi(); return true;
  }
  function status(){const t=findTarget();return {running:state.running,config:{...config},target:t?{name:t.name,position:getPosition(t),distance:distance(getPosition(bot.getPlayerPosition?.()),getPosition(t))}:null,lastAttemptAt:state.lastAttemptAt,lastUseAt:state.lastUseAt,targetPending:state.targetTimerId!=null};}
  bot.playerManaPotion={start,stop,status,updateConfig,tryUse,findTarget,isInRange,config};
  ensureUi();
  if(config.enabled)start();
  bot.addCleanup?.(()=>stop({persistEnabled:false}));
  return bot.playerManaPotion;
};
if(window.minibiaBot) window.__minibiaBotBundle.installPlayerManaPotionModule(window.minibiaBot);


  const bundle = window.__minibiaBotBundle || window.__minibiaBotReloadBundle || {};
  const persistedEnabledModules = [
    ["rune", "minibiaBot.rune.config"],
    ["runeV2", "minibiaBot.runeV2.config"],
    ["runeV3", "minibiaBot.runeV3.config"],
    ["heal", "minibiaBot.heal.config"],
    ["antiParalyze", "minibiaBot.antiParalyzeV2.config"],
    ["damageTtsAlert", "minibiaBot.damageTtsAlert.config"],
    ["invisible", "minibiaBot.invisible.config"],
    ["magicShield", "minibiaBot.magicShield.config"],
    ["attack", "minibiaBot.attack.config"],
    ["attackAoe", "minibiaBot.attackAoe.config"],
    ["greatFireballV2", "minibiaBot.greatFireballV2.config"],
    ["fireball", "minibiaBot.fireball.config"],
    ["fireballV2", "minibiaBot.fireballV2.config"],
    ["lureMode", "minibiaBot.lure.config"],
    ["attackExclude", "minibiaBot.attackExclude.config"],
    ["attackPriority", "minibiaBot.attackPriority.config"],
    ["redTextAlert", "minibiaBot.redTextAlert.config"],
    ["cave", "minibiaBot.cave.config"],
    ["caveForwardLoop", "minibiaBot.caveForwardLoop.config"],
    ["equipRing", "minibiaBot.equipRing.config"],
    ["mining", "minibiaBot.mining.config"],
    ["eat", "minibiaBot.eat.config"],
    ["talk", "minibiaBot.talk.config"],
    ["runeMakerDrop", "minibiaBot.runeMakerDrop.config"],
    ["maxLight", "minibiaBot.maxLight.config"],
  ];

  function getPersistedEnabledSnapshot(bot) {
    const snapshot = {};
    const status = typeof bot?.status === "function" ? bot.status() : null;
    persistedEnabledModules.forEach(([moduleName]) => {
      const enabled = status?.[moduleName]?.config?.enabled;
      if (typeof enabled === "boolean") snapshot[moduleName] = enabled;
    });
    return snapshot;
  }

  function restorePersistedEnabledSnapshot(snapshot) {
    persistedEnabledModules.forEach(([moduleName, storageKey]) => {
      if (typeof snapshot?.[moduleName] !== "boolean") return;
      try {
        const rawValue = window.localStorage.getItem(storageKey);
        const config = rawValue ? JSON.parse(rawValue) : {};
        config.enabled = snapshot[moduleName];
        window.localStorage.setItem(storageKey, JSON.stringify(config));
      } catch (error) {
        console.error("[minibia-bot] failed to restore persisted enabled state", { module: moduleName, error });
      }
    });
  }

  function forceAttackAndCaveDisabled() {
    ["minibiaBot.attack.config", "minibiaBot.cave.config"].forEach((storageKey) => {
      try {
        const rawValue = window.localStorage.getItem(storageKey);
        const config = rawValue ? JSON.parse(rawValue) : {};
        config.enabled = false;
        window.localStorage.setItem(storageKey, JSON.stringify(config));
      } catch (error) {
        console.error("[minibia-bot] failed to disable startup module", { storageKey, error });
      }
    });
  }

  function removePanelDebugSection() {
    const debugToggle = document.getElementById("minibia-bot-debug-enabled");
    const debugSection = debugToggle?.closest?.(".mb-section");
    if (debugSection) {
      debugSection.remove();
      return true;
    }
    const labels = Array.from(document.querySelectorAll("#minibia-bot-panel .mb-label"));
    const debugLabel = labels.find((label) => String(label.textContent || "").trim().toLowerCase() === "debug");
    debugLabel?.closest?.(".mb-section")?.remove();
    return !!debugLabel;
  }

  function installGmKillSwitchBelowGithub(bot) {
    let attempts = 0;
    const placeControl = () => {
      const githubSection = document.getElementById("minibia-bot-github-waypoints-section");
      if (!githubSection) return false;
      const gmModule = bot.gmDefaultChatKillSwitch;
      if (typeof gmModule?.ensurePanelControls === "function") {
        gmModule.ensurePanelControls();
        gmModule.ensureUnknownMonsterControls?.();
        const section = document.getElementById("minibia-bot-gm-kill-switch-section");
        if (!section) return false;
        if (githubSection.nextElementSibling !== section) githubSection.insertAdjacentElement("afterend", section);
        return !!section.querySelector("#minibia-bot-gm-pause-enabled");
      }
      return false;
    };
    if (placeControl()) return;
    const timerId = window.setInterval(() => {
      attempts += 1;
      if (placeControl() || attempts >= 80) window.clearInterval(timerId);
    }, 250);
    bot.addCleanup?.(() => window.clearInterval(timerId));
  }

  function installPauseBreakToggle(bot) {
    let paused = false;
    let resumeSnapshot = { cave: false, attack: false, greatFireballV2: false, fireball: false, fireballV2: false, lureMode: false };

    function isTypingTarget(target) {
      if (!(target instanceof Element)) return false;
      return !!target.closest("input, textarea, select, [contenteditable=\"true\"]");
    }

    function updatePanelState() {
      const panel = document.getElementById("minibia-bot-panel");
      if (!panel) return;
      panel.dataset.pauseBreakPaused = paused ? "true" : "false";
      panel.style.outline = paused ? "3px solid #d93025" : "";
      panel.title = paused ? "PAUSED — press Pause/Break to resume Cavebot, Auto Attack, GFB, Fireball, Fireball 2.0, and Lure Mode" : "";
    }

    function pause() {
      if (paused) return false;
      resumeSnapshot = {
        cave: !!bot.cave?.status?.().running,
        attack: !!bot.attack?.status?.().running,
        greatFireballV2: !!bot.greatFireballV2?.status?.().running,
        fireball: !!bot.fireball?.status?.().running,
        fireballV2: !!bot.fireballV2?.status?.().running,
        lureMode: !!bot.lureMode?.status?.().running,
      };
      if (resumeSnapshot.lureMode) bot.lureMode.stop({ persistEnabled: false });
      if (resumeSnapshot.fireballV2) bot.fireballV2.stop({ persistEnabled: false });
      if (resumeSnapshot.fireball) bot.fireball.stop({ persistEnabled: false });
      if (resumeSnapshot.greatFireballV2) bot.greatFireballV2.stop({ persistEnabled: false });
      if (resumeSnapshot.attack) bot.attack.stop({ persistEnabled: false });
      if (resumeSnapshot.cave || bot.cave?.status?.().running) bot.cave.stop({ persistEnabled: false });
      paused = true;
      updatePanelState();
      bot.log("Pause/Break paused Cavebot, Auto Attack, GFB, Fireball, Fireball 2.0, and Lure Mode", { ...resumeSnapshot });
      return true;
    }

    function resume() {
      if (!paused) return false;
      const snapshot = { ...resumeSnapshot };
      paused = false;
      resumeSnapshot = { cave: false, attack: false, greatFireballV2: false, fireball: false, fireballV2: false, lureMode: false };
      if (snapshot.cave) bot.cave?.start?.();
      if (snapshot.attack) bot.attack?.start?.();
      if (snapshot.greatFireballV2) bot.greatFireballV2?.start?.();
      if (snapshot.fireball) bot.fireball?.start?.();
      if (snapshot.fireballV2) bot.fireballV2?.start?.();
      if (snapshot.lureMode) bot.lureMode?.start?.();
      updatePanelState();
      bot.log("Pause/Break resumed Cavebot, Auto Attack, GFB, Fireball, Fireball 2.0, and Lure Mode", snapshot);
      return true;
    }

    function toggle() { return paused ? resume() : pause(); }
    function onKeyDown(event) {
      const isPauseBreak = event.key === "Pause" || event.code === "Pause" || event.keyCode === 19;
      if (!isPauseBreak || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }

    document.addEventListener("keydown", onKeyDown, true);
    bot.addCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
    bot.pauseBreak = { pause, resume, toggle, status: () => ({ paused, resumeSnapshot: { ...resumeSnapshot } }) };
    updatePanelState();
  }

  function installLureCaveProgressPreserver(bot) {
    if (!bot?.cave?.start || !bot.cave?.stop || !bot.cave?.status || !bot.cave?.setCurrentIndex) return null;
    const originalStart = bot.cave.start.bind(bot.cave);
    const originalStop = bot.cave.stop.bind(bot.cave);
    const state = { pending: null, restoreCount: 0, lastRestoreAt: 0 };
    function getLureMode() { const lureStatus = bot.lureMode?.status?.() || null; return Number(lureStatus?.config?.mode) === 2 ? 2 : 1; }
    function lureOwnsCave() { const lureStatus = bot.lureMode?.status?.() || null; if (!lureStatus?.running) return false; const mode = getLureMode(); return mode === 2 ? !!lureStatus?.mode2?.active : (!!lureStatus?.clearingPack || !!lureStatus?.resumeCaveAfterClear); }
    function snapshotProgress() { const caveStatus = bot.cave.status(); const routeLength = Array.isArray(caveStatus?.route) ? caveStatus.route.length : 0; if (!caveStatus?.running || routeLength <= 0) return null; return { currentIndex: Math.max(0, Math.min(routeLength - 1, Math.trunc(Number(caveStatus.currentIndex) || 0))), direction: Number(caveStatus.direction) < 0 ? -1 : 1, routeLength, waypoint: caveStatus.currentWaypoint ? { ...caveStatus.currentWaypoint } : null, capturedAt: Date.now() }; }
    function stopCurrentMovement() { const targets = [window.gameClient?.world?.pathfinder, window.gameClient?.player, window.gameClient?.world].filter(Boolean); ["stop", "cancel", "clear", "clearPath", "stopWalking", "cancelWalking", "stopAutoWalk", "reset"].forEach((name) => { targets.forEach((target) => { if (typeof target?.[name] !== "function") return; try { target[name](); } catch (_) {} }); }); }
    bot.cave.stop = function lureAwareCaveStop(options = {}) { if (lureOwnsCave()) { const snapshot = snapshotProgress(); if (snapshot) { state.pending = snapshot; bot.log?.("lure preserved cave waypoint before takeover", { index: snapshot.currentIndex + 1, direction: snapshot.direction, routeLength: snapshot.routeLength, waypoint: snapshot.waypoint }); } if (getLureMode() === 1 && bot.cave.status()?.running) { stopCurrentMovement(); return true; } } return originalStop(options); };
    bot.cave.start = function lureAwareCaveStart(...args) { const pending = state.pending ? { ...state.pending } : null; const alreadyRunning = !!bot.cave.status()?.running; const result = alreadyRunning ? true : originalStart(...args); if (!pending || !bot.cave.status()?.running) return result; const currentStatus = bot.cave.status(); const routeLength = Array.isArray(currentStatus?.route) ? currentStatus.route.length : 0; if (!routeLength) { state.pending = null; return result; } const restoreIndex = Math.max(0, Math.min(routeLength - 1, pending.currentIndex)); bot.cave.setCurrentIndex(restoreIndex); const restoredWaypoint = bot.cave.status()?.currentWaypoint || null; stopCurrentMovement(); if (restoredWaypoint) { try { bot.cave.goToWaypoint?.(restoredWaypoint); } catch (_) {} } state.pending = null; state.restoreCount += 1; state.lastRestoreAt = Date.now(); bot.log?.("lure restored cave waypoint after takeover", { index: restoreIndex + 1, directionBeforeLure: pending.direction, routeLength, waypoint: restoredWaypoint }); return result; };
    bot.lureCaveProgressPreserver = { status: () => ({ pending: state.pending ? { ...state.pending } : null, restoreCount: state.restoreCount, lastRestoreAt: state.lastRestoreAt }) };
    return bot.lureCaveProgressPreserver;
  }

  function boot(currentBundle = bundle) {
    const previousEnabledSnapshot = getPersistedEnabledSnapshot(window.minibiaBot);
    if (window.minibiaBot?.destroy) window.minibiaBot.destroy();
    restorePersistedEnabledSnapshot(previousEnabledSnapshot);
    forceAttackAndCaveDisabled();

    const bot = currentBundle.createBot();
    currentBundle.installPzModule(bot);
    currentBundle.installXrayModule(bot);
    currentBundle.installPanicModule(bot);
    currentBundle.installGmDefaultChatKillSwitch?.(bot);
    currentBundle.installRuneModule(bot);
    currentBundle.installHealModule(bot);
    currentBundle.installAntiParalyzeModule?.(bot);
    currentBundle.installSpellTimerModule?.(bot);
    currentBundle.installHasteParalyzeMonsterRangeGuard?.(bot);
    currentBundle.installDamageTtsAlertModule?.(bot);
    currentBundle.installAutoInvisibleModule(bot);
    currentBundle.installAutoMagicShieldModule(bot);
    currentBundle.installAutoAttackModule(bot);
    bot.attack?.updateConfig?.({ enabled: false, maxTargetDistanceX: 7, maxTargetDistanceY: 5, runeCooldownMs: 2000 });
    bot.attack?.stop?.();
    currentBundle.installAutoAttackExcludeModule?.(bot);
    currentBundle.installAutoAttackAoeModule?.(bot);
    currentBundle.installRedTextAlertModule?.(bot);
    currentBundle.installCaveModule(bot);
    bot.cave?.updateConfig?.({ enabled: false });
    bot.cave?.stop?.();
    currentBundle.installCaveForwardLoopModule?.(bot);
    currentBundle.installCaveArrowKeysModule?.(bot);
    currentBundle.installEquipRingModule(bot);
    currentBundle.installMiningModule?.(bot);
    currentBundle.installAutoEatModule(bot);
    currentBundle.installPlayerManaPotionModule?.(bot);
    currentBundle.installTalkModule(bot);
    currentBundle.installMaxLightModule?.(bot);
    currentBundle.installPanel(bot);
    currentBundle.installCaveWaypointActionsModule?.(bot);
    currentBundle.installFireFieldTileScannerModule?.(bot);
    currentBundle.installNativeFieldDiagnosticModule?.(bot);

    bot.ui.inject();
    bot.spellTimer?.ensureUi?.();
    window.setTimeout(() => bot.spellTimer?.ensureUi?.(), 0);
    window.setTimeout(() => bot.spellTimer?.ensureUi?.(), 250);
    const ensureCaveWaypointActionControls = () => {
      const caveSection = document.getElementById("minibia-bot-cave-add")?.closest(".mb-section");
      if (!caveSection) return false;
      let select = document.getElementById("minibia-bot-cave-waypoint-action");
      if (!select) {
        const field = document.createElement("label"); field.className = "mb-field";
        const label = document.createElement("span"); label.className = "mb-field-label"; label.textContent = "Waypoint Action";
        select = document.createElement("select"); select.id = "minibia-bot-cave-waypoint-action";
        [["walk","Walk"],["rope","Use Rope"],["ropeSpell","Rope Spell (Exani Tera)"],["haste","Haste Waypoint"],["shovel","Use Shovel"],["wait","Waypoint Wait (1 Minute)"],["use","Use"],["blueFlame","Blue Flame"]].forEach(([value,text]) => { const option=document.createElement("option"); option.value=value; option.textContent=text; select.appendChild(option); });
        field.append(label, select);
        const pathfinder = caveSection.querySelector("#minibia-bot-cave-pathfinder-mode")?.closest(".mb-field");
        if (pathfinder) pathfinder.insertAdjacentElement("beforebegin", field); else caveSection.querySelector(".mb-stack")?.appendChild(field);
      }
      if (select && !select.querySelector('option[value="use"]')) {
        const option = document.createElement("option");
        option.value = "use";
        option.textContent = "Use";
        select.appendChild(option);
      }
      if (select && !select.querySelector('option[value="blueFlame"]')) {
        const option = document.createElement("option");
        option.value = "blueFlame";
        option.textContent = "Blue Flame";
        select.appendChild(option);
      }
      if (!document.getElementById("minibia-bot-cave-haste-spell")) {
        const field=document.createElement("label"); field.className="mb-field"; field.id="minibia-bot-cave-haste-spell-field";
        const label=document.createElement("span"); label.className="mb-field-label"; label.textContent="Haste Spell";
        const input=document.createElement("input"); input.type="text"; input.id="minibia-bot-cave-haste-spell"; input.placeholder="Enter spell, e.g. utani hur"; input.autocomplete="off";
        field.append(label,input); select.insertAdjacentElement("afterend",field);
      }
      const hasteField=document.getElementById("minibia-bot-cave-haste-spell-field");
      if (hasteField) hasteField.style.display=select.value==="haste" ? "" : "none";
      return true;
    };
    if (!ensureCaveWaypointActionControls()) {
      const observer=new MutationObserver(()=>{ if (ensureCaveWaypointActionControls()) observer.disconnect(); });
      observer.observe(document.documentElement,{childList:true,subtree:true});
      window.setTimeout(()=>observer.disconnect(),10000);
    }
    currentBundle.installQuickControlsSettingsModule?.(bot);
    currentBundle.installRuneV3KeyboardModule?.(bot);
    bot.gmDefaultChatKillSwitch?.injectPanelControl?.();
    bot.maxLight?.injectControls?.();
    currentBundle.installRuneMakerDropModule?.(bot);
    currentBundle.installAutoAttackPriorityModule?.(bot);
    currentBundle.installGreatFireballV2Module?.(bot);
    currentBundle.installFireballModule?.(bot);
    currentBundle.installFireballV2Module?.(bot);
    currentBundle.installLureModeModule?.(bot);
    currentBundle.installCaptchaAlarmModule?.(bot);
    installPauseBreakToggle(bot);
    installLureCaveProgressPreserver(bot);
    currentBundle.installGithubWaypointLibraryModule?.(bot);
    installGmKillSwitchBelowGithub(bot);
    window.setTimeout(() => {
      bot.gmDefaultChatKillSwitch?.ensurePanelControls?.();
      bot.gmDefaultChatKillSwitch?.ensureUnknownMonsterControls?.();
      bot.spellTimer?.ensureUi?.();
    }, 0);
    window.setTimeout(() => {
      bot.gmDefaultChatKillSwitch?.ensurePanelControls?.();
      bot.gmDefaultChatKillSwitch?.ensureUnknownMonsterControls?.();
      bot.spellTimer?.ensureUi?.();
    }, 250);
    removePanelDebugSection();
    window.setTimeout(removePanelDebugSection, 0);
    bot.caveArrowKeys?.ensureDropdownOption?.();
    document.getElementById("minibia-bot-waypoint-profiles-section")?.remove();
    bot.start = (...args) => bot.rune.start(...args);
    bot.stop = (...args) => bot.rune.stop(...args);
    bot.reload = () => window.minibiaBotReload?.();
    bot.status = () => ({
      version: bot.version.number,
      branch: bot.version.branch,
      commit: bot.version.commit,
      pz: { home: bot.pz.getHomePz() },
      xray: bot.xray.status(),
      panic: bot.panic.status(),
      gmDefaultChatKillSwitch: bot.gmDefaultChatKillSwitch?.status?.() || null,
      rune: bot.rune.status(),
      runeV2: bot.runeV2?.status?.() || null,
      runeV3: bot.runeV3?.status?.() || null,
      heal: bot.heal.status(),
      antiParalyze: bot.antiParalyze?.status?.() || null,
      spellTimer: bot.spellTimer?.status?.() || null,
      damageTtsAlert: bot.damageTtsAlert?.status?.() || null,
      invisible: bot.invisible.status(),
      magicShield: bot.magicShield.status(),
      attack: bot.attack.status(),
      attackExclude: bot.attackExclude?.status?.() || null,
      attackAoe: bot.attackAoe?.status?.() || null,
      attackPriority: bot.attackPriority?.status?.() || null,
      greatFireballV2: bot.greatFireballV2?.status?.() || null,
      fireball: bot.fireball?.status?.() || null,
      fireballV2: bot.fireballV2?.status?.() || null,
      lureMode: bot.lureMode?.status?.() || null,
      redTextAlert: bot.redTextAlert?.status?.() || null,
      cave: bot.cave.status(),
      caveForwardLoop: bot.caveForwardLoop?.status?.() || null,
      caveArrowKeys: bot.caveArrowKeys?.status?.() || null,
      equipRing: bot.equipRing.status(),
      mining: bot.mining?.status?.() || null,
      eat: bot.eat.status(),
      playerManaPotion: bot.playerManaPotion?.status?.() || null,
      nativeFieldDiagnostic: bot.nativeFieldDiagnostic?.status?.() || null,
      talk: bot.talk.status(),
      runeMakerDrop: bot.runeMakerDrop?.status?.() || null,
      maxLight: bot.maxLight?.status?.() || null,
      captchaAlarm: bot.captchaAlarm?.status?.() || null,
      pauseBreak: bot.pauseBreak?.status?.() || null,
    });

    window.minibiaBot = bot;
    if (window.__minibiaLoaderRuntime) window.__minibiaLoaderRuntime.bot = bot;
    return bot;
  }

  window.minibiaBotReload = (nextBundle = window.__minibiaBotReloadBundle || window.__minibiaBotBundle || bundle) => boot(nextBundle);
  boot();
})();
