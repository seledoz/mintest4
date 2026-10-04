(() => {
  // Only the newest loader may evaluate sources or boot a bot.
  const loaderRuntime = window.__minibiaLoaderRuntime || { generation: 0, activeToken: 0, bot: null };
  const loaderGeneration = loaderRuntime.generation + 1;
  loaderRuntime.generation = loaderGeneration;
  loaderRuntime.activeToken = loaderGeneration;
  window.__minibiaLoaderRuntime = loaderRuntime;
  const isCurrentLoader = () => window.__minibiaLoaderRuntime?.activeToken === loaderGeneration;
  const destroyKnownBot = () => {
    const bots = [window.__minibiaLoaderRuntime?.bot, window.minibiaBot].filter(Boolean);
    const seen = new Set();
    for (const bot of bots) {
      if (seen.has(bot)) continue;
      seen.add(bot);
      try { bot.destroy?.(); } catch (error) { console.warn("[minibia-bot] Existing bot cleanup failed", error); }
    }
    if (window.__minibiaLoaderRuntime) window.__minibiaLoaderRuntime.bot = null;
  };

  const repository = "seledoz/mintest4";
  // Pin the runtime to the exact commit so a stale CDN/browser response cannot mix old module code with the current loader.
  const ref = "778b4a0ba73bb9e84ea5666a026d0c61ef997ed1";
  const rawBaseUrl = `https://raw.githubusercontent.com/${repository}/${ref}`;
  const sourceFiles = [
    "src/version.js",
    "src/core.js",
    "src/modules/pz.js",
    "src/modules/xray.js",
    "src/modules/panic.js",
    "src/modules/gm-default-chat-kill-switch.js",
    "src/modules/rune.js",
    "src/modules/heal.js",
    "src/modules/spell-timer.js",
    "src/modules/anti-paralyze.js",
    "src/modules/haste-paralyze-monster-range-guard.js",
    "src/modules/damage-tts-alert.js",
    "src/modules/auto-invisible.js",
    "src/modules/auto-magic-shield.js",
    "src/modules/auto-attack-exclude.js",
    "src/modules/auto-attack.js",
    "src/modules/auto-target-v2.js",
    "src/modules/auto-attack-priority.js",
    "src/modules/auto-attack-rune-cooldown.js",
    "src/modules/auto-attack-rune-retry.js",
    "src/modules/auto-attack-block-follow-while-targeted.js",
    "src/modules/auto-attack-aoe.js",
    "src/modules/great-fireball-v2.js",
    "src/modules/fireball.js",
    "src/modules/auto-attack-aoe-layout.js",
    "src/modules/lure-mode.js",
    "src/modules/aoe-cooldown-input-fix.js",
    "src/modules/low-cap-alarm.js",
    "src/modules/mining.js",
    "src/modules/red-text-alert.js",
    "src/modules/cave.js",
    "src/modules/cave-walk-over-fields-global.js",
    "src/modules/cave-forward-loop.js",
    "src/modules/cave-arrow-keys.js",
    "src/modules/cave-waypoint-actions.js",
    "src/modules/fire-field-tile-scanner.js",
    "src/modules/equip-ring.js",
    "src/modules/auto-eat.js",
    "src/modules/talk.js",
    "src/modules/rune-maker-drop.js",
    "src/modules/rune-maker-drop-modern-ids.js",
    "src/modules/quick-controls-settings.js",
    "src/ui/panel.js",
    "src/modules/auto-attack-rune-toggle.js",
    "src/modules/auto-target-v2-panel.js",
    "src/modules/panel-scroll.js",
    "src/modules/github-waypoint-library.js",
    "src/modules/captcha-alarm.js",
    "src/main.js",
    "src/modules/auto-attack-sticky-target.js",
    "src/modules/explosion-on-crosshairs.js",
    "src/modules/remove-legacy-great-fireball.js",
    "src/modules/anti-paralyze-toggle-fix.js",
    "src/modules/player-mana-potion.js",
    "src/modules/player-screen-alert.js",
    "src/modules/monster-xray-alarm.js",
    "src/modules/emergency-mana-ring.js",
    "src/modules/auto-attack-keep-distance.js",
    "src/modules/auto-attack-keep-distance-bootstrap.js",
    "src/modules/great-fireball-v2-screen-click-fix.js",
    "src/modules/xray-overlay-floor-mode.js",
    "src/modules/rune-maker-drop-inspector.js",
    "src/modules/github-waypoint-delete-button.js",
    "src/modules/profiles.js"
  ];

  function purgeLegacyCaveWaitDelay() {
    const waitButton = document.getElementById("minibia-bot-cave-wait-add");
    const waitInput = document.getElementById("minibia-bot-cave-wait-minutes");
    const waitStatus = document.getElementById("minibia-bot-cave-wait-status");
    const waitRow = waitButton?.closest?.(".mb-row") || waitInput?.closest?.(".mb-row") || waitStatus?.closest?.(".mb-row");
    if (waitRow) waitRow.remove();
    else { waitButton?.remove(); waitInput?.remove(); waitStatus?.remove(); }
    try { window.minibiaBot?.storage?.set?.("minibiaBot.cave.waitDelays", {}); } catch (_) {}
    try { delete window.__minibiaCaveWaitDelayInstalled; } catch (_) { window.__minibiaCaveWaitDelayInstalled = false; }
    const pathfinder = window.gameClient?.world?.pathfinder;
    if (!pathfinder || typeof pathfinder.findPath !== "function") return;
    let findPath = pathfinder.findPath;
    for (let depth = 0; depth < 8; depth += 1) {
      if (findPath?.__minibiaCaveWaitGuard && typeof findPath.__minibiaWaitBaseFindPath === "function") { findPath = findPath.__minibiaWaitBaseFindPath; continue; }
      if (findPath?.__minibiaWaitDelayGuard && typeof findPath.__minibiaWaitDelayOriginal === "function") { findPath = findPath.__minibiaWaitDelayOriginal; continue; }
      if (findPath?.__minibiaCaveWaitGuard && typeof findPath.__originalFindPath === "function") { findPath = findPath.__originalFindPath; continue; }
      break;
    }
    if (findPath !== pathfinder.findPath) pathfinder.findPath = findPath;
  }

  function installUiCompatibilityShim() {
    if (document.__minNewUiCompatibilityShimInstalled) return;
    const originalGetElementById = document.getElementById.bind(document);
    document.getElementById = function getElementByIdWithMinNewCompat(id) {
      if (id === "k9x-panel") return originalGetElementById("minibia-bot-panel") || originalGetElementById(id);
      return originalGetElementById(id);
    };
    document.__minNewUiCompatibilityShimInstalled = true;
  }

  function blankPanelTitle() {
    const title = document.querySelector("#minibia-bot-panel .mb-title");
    if (title) { title.textContent = ""; title.setAttribute("title", ""); title.style.fontSize = "0"; title.style.minHeight = "16px"; title.style.flex = "1 1 auto"; }
  }
  function syncCollapseButtons() {
    const panel = document.getElementById("minibia-bot-panel"); if (!panel) return; const collapsed = panel.dataset.collapsed === "true";
    panel.querySelectorAll("#minibia-bot-collapse, #minibia-bot-collapse-left").forEach((button) => { button.textContent = collapsed ? "+" : "−"; button.setAttribute("aria-label", collapsed ? "Maximize panel" : "Minimize panel"); button.setAttribute("title", collapsed ? "Maximize" : "Minimize"); });
  }
  function ensureLeftCollapseButton() {
    const panel=document.getElementById("minibia-bot-panel"),titlebar=panel?.querySelector?.(".mb-titlebar"),rightButton=panel?.querySelector?.("#minibia-bot-collapse"); if(!panel||!titlebar||!rightButton)return;
    let leftButton=panel.querySelector("#minibia-bot-collapse-left"); if(!leftButton){leftButton=rightButton.cloneNode(true);leftButton.id="minibia-bot-collapse-left";titlebar.prepend(leftButton);leftButton.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();rightButton.click();window.setTimeout(syncCollapseButtons,0);});}
    if(!document.__minNewCollapseButtonSyncInstalled){document.__minNewCollapseButtonSyncInstalled=true;document.addEventListener("click",e=>{if(e.target?.closest?.("#minibia-bot-collapse"))window.setTimeout(syncCollapseButtons,0);});} syncCollapseButtons();
  }
  function removePanelDebugSection(){const t=document.getElementById("minibia-bot-debug-enabled"),s=t?.closest?.(".mb-section");if(s){s.remove();return;}const labels=Array.from(document.querySelectorAll("#minibia-bot-panel .mb-label"));const l=labels.find(x=>String(x.textContent||"").trim().toLowerCase()==="debug");l?.closest?.(".mb-section")?.remove();}
  function removePanicRunnerSection(){const b=document.getElementById("minibia-bot-set-home"),s=b?.closest?.(".mb-section");if(s){s.remove();return;}document.getElementById("minibia-bot-home")?.closest?.(".mb-section")?.remove();document.getElementById("minibia-bot-panic-unknown")?.closest?.(".mb-section")?.remove();document.getElementById("minibia-bot-panic-health")?.closest?.(".mb-section")?.remove();document.getElementById("minibia-bot-panic-return")?.closest?.(".mb-section")?.remove();}
  function keepPanelTitleBlank(){blankPanelTitle();ensureLeftCollapseButton();removePanelDebugSection();removePanicRunnerSection();let attempts=0;const timerId=window.setInterval(()=>{blankPanelTitle();ensureLeftCollapseButton();removePanelDebugSection();removePanicRunnerSection();purgeLegacyCaveWaitDelay();attempts+=1;if(attempts>=20)window.clearInterval(timerId);},250);}
  function normalizeCavePathfinderModeUi(){
    const select=document.getElementById("minibia-bot-cave-pathfinder-mode");
    if(!select)return;
    const desired=[["game","Game"],["direct","Direct"],["smartA","Smart A"],["smartAField","Smart A + Field Crossing"],["arrow","Arrow / D-pad"]];
    const current=select.value;
    select.replaceChildren();
    for(const [value,label] of desired){const option=document.createElement("option");option.value=value;option.textContent=label;select.appendChild(option);}
    select.value=desired.some(([value])=>value===current)?current:"game";
  }
  function addSafeUiPerformanceOptimizations(code,path){
    if(path==="src/core.js")code=code.replace("  startReconnectWatcher();","  // Reconnect watcher temporarily disabled for FPS testing.");
    if(path==="src/modules/auto-attack.js")code=code.replace("      maxTargetDistanceX: 7,","      maxTargetDistanceX: 5,").replace("    return dx <= maxTargetDistanceX && dy <= maxTargetDistanceY;","    return dx <= Math.min(5, maxTargetDistanceX) && dy <= Math.min(5, maxTargetDistanceY) && Math.max(dx, dy) <= 5;");
    if(path==="src/modules/cave.js")code=code.replace(`        if (config.pathfinderMode === 'astar') {
          const target = bot.attack?.getCurrentTarget?.() || null;
          if (target) {
            const chaseResult = chaseTarget(target);
            bot.logDebug("cave combat chase", { chasing: chaseResult, targetId: target.id, targetName: target.name || "Mob", targetPos: normalizePosition(target.getPosition?.() || target.__position) });
          } else bot.logDebug("cave combat no target to chase");
        }
`,"");
    if(path==="src/modules/lure-mode.js"){code=code.replace("    nextMode2StepAt: 0,\n","    nextMode2StepAt: 0,\n    mode2StepStartPosition: null,\n    mode2WaitingForStep: false,\n").replace(`      if (status.mode === 2 && status.luring) {
        state.nextMode2StepAt = Date.now() + status.stepDelayMs;
        return limitPathToOneStep(path);
      }`,`      if (status.mode === 2 && status.luring) {
        const startPosition = playerPos();
        state.mode2StepStartPosition = startPosition;
        state.mode2WaitingForStep = !!startPosition;
        return limitPathToOneStep(path);
      }`).replace(`    state.lastStatus = status;

    if (state.clearingPack`,`    state.lastStatus = status;

    if (status.mode === 2 && status.luring && state.mode2WaitingForStep) {
      const currentPosition = playerPos();
      const startPosition = state.mode2StepStartPosition;
      if (currentPosition && startPosition && dist(currentPosition, startPosition) >= 1) {
        stopCurrentPath();
        state.nextMode2StepAt = Date.now() + status.stepDelayMs;
        state.mode2WaitingForStep = false;
        state.mode2StepStartPosition = null;
        status = getLureStatus();
        state.lastStatus = status;
        bot.log?.("lure mode 2 completed paced step", { stepDelayMs: status.stepDelayMs, nextStepAt: state.nextMode2StepAt, farthestDistance: status.farthestDistance, maxDistance: status.maxDistance });
      }
    }

    if (state.clearingPack`).replace(`    state.nextMode2StepAt = 0;
    patchPathfinder();`,`    state.nextMode2StepAt = 0;
    state.mode2StepStartPosition = null;
    state.mode2WaitingForStep = false;
    patchPathfinder();`).replace(`    state.nextMode2StepAt = 0;
    state.lastStatus = getOffStatus();`,`    state.nextMode2StepAt = 0;
    state.mode2StepStartPosition = null;
    state.mode2WaitingForStep = false;
    state.lastStatus = getOffStatus();`).replace(`      state.nextMode2StepAt = 0;
    }`,`      state.nextMode2StepAt = 0;
      state.mode2StepStartPosition = null;
      state.mode2WaitingForStep = false;
    }`);}
    if(path==="src/ui/panel.js"){code=code.replace(`  function refreshVisibleCreatures() {
    const list = document.getElementById("minibia-bot-visible-creatures-list");
    if (!list) return;`,`  function refreshVisibleCreatures() {
    const list = document.getElementById("minibia-bot-visible-creatures-list");
    if (!list || isPanelCollapsed()) return;`).replace(`    const visibleCreaturesTimerId = window.setInterval(refreshVisibleCreatures, 1000);`,`    const visibleCreaturesTimerId = window.setInterval(() => {
      if (!isPanelCollapsed()) refreshVisibleCreatures();
    }, 1000);`).replace(`    const talkStatusTimerId = window.setInterval(refreshTalkStatus, 1000);`,`    const talkStatusTimerId = window.setInterval(() => {
      if (!isPanelCollapsed()) refreshTalkStatus();
    }, 1000);`).replace(`    const caveStatusTimerId = window.setInterval(() => {
      refreshCaveStatus();`,`    const caveStatusTimerId = window.setInterval(() => {
      if (isPanelCollapsed()) return;
      refreshCaveStatus();`)}
    return code;
  }
  function ensureCavebotWaypointActionPanel(){
    const add=document.getElementById("minibia-bot-cave-add");
    const section=add?.closest(".mb-section");
    if(!add||!section)return false;
    let select=document.getElementById("minibia-bot-cave-waypoint-action");
    if(!select){
      const field=document.createElement("label"); field.className="mb-field";
      const label=document.createElement("span"); label.className="mb-field-label"; label.textContent="Waypoint Action";
      select=document.createElement("select"); select.id="minibia-bot-cave-waypoint-action";
      [["walk","Walk"],["rope","Use Rope"],["ropeSpell","Rope Spell (Exani Tera)"],["haste","Haste Waypoint"],["shovel","Use Shovel"],["wait","Waypoint Wait (1 Minute)"],["use","Use"],["blueFlame","Blue Flame"]].forEach(([v,t])=>{const o=document.createElement("option");o.value=v;o.textContent=t;select.appendChild(o)});
      field.append(label,select); const row=add.closest(".mb-row"); if(row)row.insertAdjacentElement("afterend",field); else add.insertAdjacentElement("afterend",field);
    }
    if(!document.getElementById("minibia-bot-cave-haste-spell")){
      const field=document.createElement("label"); field.className="mb-field"; field.id="minibia-bot-cave-haste-spell-field";
      const label=document.createElement("span"); label.className="mb-field-label"; label.textContent="Haste Spell";
      const input=document.createElement("input"); input.type="text"; input.id="minibia-bot-cave-haste-spell"; input.placeholder="Enter spell, e.g. utani hur"; input.autocomplete="off";
      field.append(label,input); select.closest(".mb-field")?.insertAdjacentElement("afterend",field);
    }
    return true;
  }
  function watchForCavebotWaypointActionPanel(){
    ensureCavebotWaypointActionPanel();
    if(window.__minibiaCaveWaypointPanelObserver)return;
    const observer=new MutationObserver(()=>{ensureCavebotWaypointActionPanel();});
    window.__minibiaCaveWaypointPanelObserver=observer;
    observer.observe(document.documentElement,{childList:true,subtree:true});
    if(!window.__minibiaCaveWaypointPanelInterval){
      window.__minibiaCaveWaypointPanelInterval=window.setInterval(()=>{ensureCavebotWaypointActionPanel();},250);
    }
  }
  async function loadSourceFile(path){
    if (!isCurrentLoader()) throw new Error("stale Minibia loader aborted");
    const sourceBaseUrl = rawBaseUrl;
    const url=`${sourceBaseUrl}/${path}?t=${Date.now()}-${Math.random()}`;
    const response=await fetch(url,{cache:"no-store"});
    if(!response.ok)throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
    const rawCode=await response.text();
    if (!isCurrentLoader()) throw new Error("stale Minibia loader aborted");
    if(!rawCode||!rawCode.trim())throw new Error(`Failed to load ${path}: empty response`);
    const sourceUrl=`${rawBaseUrl}/${path}`;
    const evaluate=(source)=>{try{new Function(source);(0,eval)(`${source}\n//# sourceURL=${sourceUrl}`);return null;}catch(evaluationError){return evaluationError;}};
    let code=addSafeUiPerformanceOptimizations(rawCode,path);
    // Runtime guard for stale cached cave.js copies: the rope observer previously
    // used previousPosition after the local variable was renamed to previous.
    // Normalize that legacy identifier before evaluation so an old CDN/browser
    // response cannot crash the CaveBot observer.
    if (path === "src/modules/cave.js") {
      code = code.replaceAll("previousPosition", "previous");
    }
    if(path==="src/version.js")code=code.replaceAll("%%BRANCH%%",ref).replaceAll("%%COMMIT%%","source-loader").replaceAll("%%DATE%%",new Date().toISOString());
    // A newer loader can start while this source is being transformed.
    // Re-check immediately before eval so an older loader can never execute
    // a module after ownership has moved to the newer loader.
    if (!isCurrentLoader()) throw new Error("stale Minibia loader aborted");
    let evaluationError=evaluate(code);
    if(evaluationError&&code!==rawCode){console.warn(`[minibia-bot] ${path} transformed source failed; retrying original source`,evaluationError);evaluationError=evaluate(rawCode);}
    if(evaluationError&&path==="src/modules/cave-waypoint-actions.js"){
      const fallbackUrl="https://raw.githubusercontent.com/seledoz/mintest4/778b4a0ba73bb9e84ea5666a026d0c61ef997ed1/src/modules/cave-waypoint-actions.js";
      console.warn("[minibia-bot] Cave waypoint actions failed from main; loading known-good fallback commit",fallbackUrl,evaluationError);
      const fallbackResponse=await fetch(`${fallbackUrl}?t=${Date.now()}-${Math.random()}`,{cache:"no-store"});
      if(!fallbackResponse.ok)throw evaluationError;
      const fallbackCode=await fallbackResponse.text();
      const fallbackError=evaluate(fallbackCode);
      if(!fallbackError)return;
      console.error("[minibia-bot] Known-good Cave waypoint actions fallback also failed",fallbackError);
      throw fallbackError;
    }
    if(evaluationError){console.error(`[minibia-bot] Failed to evaluate ${path}`,evaluationError);throw evaluationError;}
  }
  async function load(){
    if (!isCurrentLoader()) return;
    destroyKnownBot();
    if (!isCurrentLoader()) return;
    window.__minibiaLoaderRuntime.bot = window.minibiaBot || null;
    purgeLegacyCaveWaitDelay();
    installUiCompatibilityShim();
    delete window.__minibiaBotBundle;
    window.__minibiaBotBundle = {};
    window.__minibiaBotBundle.__minibiaLoaderGeneration = loaderGeneration;
    window.__minibiaLoaderRuntime.bot = null;
    for (const path of sourceFiles) {
      if (!isCurrentLoader()) return;
      await loadSourceFile(path);
    }
    if (!isCurrentLoader()) return;
    purgeLegacyCaveWaitDelay();
    watchForCavebotWaypointActionPanel();
    window.setTimeout(() => { if (isCurrentLoader()) watchForCavebotWaypointActionPanel(); }, 250);
    window.setTimeout(() => { if (isCurrentLoader()) watchForCavebotWaypointActionPanel(); }, 1000);
    keepPanelTitleBlank();
    normalizeCavePathfinderModeUi();
    window.setTimeout(() => { if (isCurrentLoader()) normalizeCavePathfinderModeUi(); }, 250);
    window.setTimeout(() => { if (isCurrentLoader()) normalizeCavePathfinderModeUi(); }, 1000);
    console.log(`[minibia-bot] Loaded source files from ${repository}@${ref} (loader ${loaderGeneration})`);
  }
  load().catch(loaderError=>console.error("[minibia-bot] Source loader failed",loaderError));
})();