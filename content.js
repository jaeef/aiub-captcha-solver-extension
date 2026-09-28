// content.js — runs on https://portal.aiub.edu/*.
// Primary job: when the captcha image appears, solve it with the local model and type the
// answer into the captcha field. Never touches or reads credentials into storage.
// The user types ID/password themselves; only the captcha is automated.
// Optional (opt-in "autoSubmit" toggle, default OFF): after a CONFIDENT fill, if the user
// has already typed both credentials, click the login submit button. Capped per page load.

const SEL = {
  captchaContainer: "#captcha",
  captchaImage: "#CaptchaImage",
  captchaInput: "#CaptchaInputText",
  usernameInput: "#username",
  passwordInput: "#password",
  submitButton: "button[type='submit']",
  // Refresh/reload control that swaps #CaptchaImage for a fresh captcha WITHOUT
  // submitting the form. Set this to the exact selector once you inspect it
  // (e.g. "#RefreshCaptcha" or "a.captcha-refresh"). If left "", findRefresh()
  // falls back to a heuristic scan near the captcha.
  captchaRefresh: "",
};
// Gates calibrated on 1025 labeled captchas against the retrained models/captcha.onnx
// (tools/calibrate.py). That model is 99.41% accurate ungated but reports a LOWER
// softmax scale than the old one, so the old 0.90 gates rerolled ~96% of captchas.
// Curve: precision 100% at conf>=0.50, >=99.5% at conf>=0.20. Re-run calibrate.py if
// the model is retrained again.
const MIN_CONF = 0.20;        // hard floor: below this the answer is discarded (99.8% coverage).
const RETRY_CONF = 0.40;      // below this, reroll instead of filling (98% filled directly, 99.6% correct).
const AUTOSUBMIT_CONF = 0.50; // strictest — a wrong submit burns a login attempt (100% precision, 0 wrong/963).
const MAX_REFRESH = 5;        // cap rerolls per episode (so 5 captchas tried max)
const MAX_SUBMITS = 5;        // max auto-submits per rolling window (lockout guard, survives reloads).
                              // Kept below the portal's failed-login lockout threshold; lower this
                              // further if AIUB locks accounts after fewer than 5 bad attempts.
const SUBMIT_WINDOW_MS = 10 * 60 * 1000; // rolling window for the auto-submit cap
const MAX_TRANSIENT = 5;      // retries for transient solver failures (timeout/not-ready) per image
const DEBUG = false;          // set true to log solve details to the console
const log = (...a) => DEBUG && console.log("[captcha]", ...a);

const $ = (s) => document.querySelector(s);

// On-page badge so you can see what's happening without the console.
// Clean modern pill, anchored beside the captcha box (flips left when it would
// overflow the right edge). States: neutral | ok | warn | green | err. The
// "spin" state pulses the status dot (used while solving). Terminal states
// auto-hide after a few seconds; active (spinning) states stay until they end.
const BADGE_STYLE_ID = "cs-badge-style";
const BADGE_HIDE_MS = 4000;
let badgeEl = null;
let badgeHideTimer = null;

function injectBadgeStyle() {
  if (document.getElementById(BADGE_STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = BADGE_STYLE_ID;
  st.textContent =
    ".cs-badge{position:fixed;z-index:2147483647;pointer-events:none;max-width:280px;" +
    "display:flex;align-items:center;gap:7px;padding:8px 14px 8px 12px;" +
    "font:600 13px system-ui,sans-serif;color:#fff;letter-spacing:.2px;border-radius:999px;" +
    "background:linear-gradient(135deg,#3a3d45,#26282f);border:1px solid rgba(255,255,255,.14);" +
    "box-shadow:0 4px 14px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.08) inset;" +
    "transition:opacity .3s ease,transform .2s ease;}" +
    ".cs-badge::before{content:'';width:8px;height:8px;border-radius:50%;background:#6b6c74;" +
    "box-shadow:0 0 6px currentColor;flex:none;}" +
    ".cs-badge.ok{background:linear-gradient(135deg,#1fae3a,#17a02f);border-color:rgba(255,255,255,.25);" +
    "box-shadow:0 4px 14px rgba(24,167,24,.4),0 1px 0 rgba(255,255,255,.18) inset;}" +
    ".cs-badge.ok::before{background:#d9ffb0;}" +
    ".cs-badge.green{background:linear-gradient(135deg,#33b548,#2a8f2a);border-color:rgba(255,255,255,.24);" +
    "box-shadow:0 4px 14px rgba(42,143,42,.4),0 1px 0 rgba(255,255,255,.18) inset;}" +
    ".cs-badge.green::before{background:#d9ffb0;}" +
    ".cs-badge.warn{background:linear-gradient(135deg,#e09a12,#c47f00);border-color:rgba(255,255,255,.22);" +
    "box-shadow:0 4px 14px rgba(196,127,0,.4),0 1px 0 rgba(255,255,255,.16) inset;}" +
    ".cs-badge.warn::before{background:#ffe9b0;}" +
    ".cs-badge.err{background:linear-gradient(135deg,#c42e2e,#a00);border-color:rgba(255,255,255,.2);" +
    "box-shadow:0 4px 14px rgba(170,0,0,.4),0 1px 0 rgba(255,255,255,.14) inset;}" +
    ".cs-badge.err::before{background:#ffc9c9;}" +
    ".cs-badge.spin::before{animation:cs-badge-pulse 1s ease-in-out infinite;}" +
    "@keyframes cs-badge-pulse{0%,100%{opacity:.35;transform:scale(.85);}50%{opacity:1;transform:scale(1.15);}}" +
    ".cs-badge.hide{opacity:0;}" +
    "@media (prefers-reduced-motion:reduce){.cs-badge{transition:none;}" +
    ".cs-badge.spin::before{animation:none;}}";
  document.head.appendChild(st);
}

function positionBadge() {
  const anchor = $(SEL.captchaInput);
  if (!anchor) { // fallback: top-right corner
    badgeEl.style.left = "auto";
    badgeEl.style.right = "8px";
    badgeEl.style.top = "8px";
    return;
  }
  const r = anchor.getBoundingClientRect();
  const pad = 15;
  badgeEl.style.right = "auto";
  let left = r.right + pad;
  if (left + badgeEl.offsetWidth > window.innerWidth - pad) left = r.left - badgeEl.offsetWidth - pad;
  badgeEl.style.left = left + "px";
  badgeEl.style.top = r.top + "px";
}

function badge(text, state) {
  if (!badgeEl) {
    injectBadgeStyle();
    badgeEl = document.createElement("div");
    badgeEl.className = "cs-badge";
    document.documentElement.appendChild(badgeEl);
    window.addEventListener("resize", positionBadge);
    window.addEventListener("scroll", positionBadge, true);
  }
  badgeEl.textContent = text;
  badgeEl.className = "cs-badge " + (state || "neutral");
  badgeEl.classList.toggle("spin", state === "spin");
  badgeEl.classList.remove("hide");
  positionBadge();
  clearTimeout(badgeHideTimer);
  if (state !== "spin") { // active solves stay visible until they finish
    badgeHideTimer = setTimeout(() => badgeEl.classList.add("hide"), BADGE_HIDE_MS);
  }
}

function isVisible(el) {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Read the DISPLAYED captcha pixels via canvas (same-origin, no taint). Never re-fetch
// img.src — a second GET can make the server rebind the answer to a fresh image.
function captchaPngB64(img) {
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  try {
    return c.toDataURL("image/png").split(",")[1];
  } catch (e) {
    return null;
  }
}

let lastHandledSrc = null; // avoid re-solving the same image
let busy = false;
let refreshCount = 0;      // rerolls used in the current low-confidence episode
let transientSrc = null;   // image src of the current transient-failure retry streak
let transientTries = 0;    // consecutive transient solver failures on transientSrc

// Would clicking this element risk submitting the login form or navigating away?
// On a public login page we must NEVER click something that could submit creds.
function isUnsafeToClick(el) {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "BUTTON" && type !== "button") return true; // default button type submits
  if (el.type === "submit" || el.type === "image") return true;
  if (el.closest("button[type='submit']")) return true;
  return false;
}

// Locate the "new captcha" refresh control safely.
const REFRESH_SELECTORS = [
  "#RefreshCaptcha", "#refreshCaptcha", "#btnRefreshCaptcha", "#reloadCaptcha",
  "a.captcha-refresh", ".captcha-refresh", ".captcha-reload",
  "[title*='refresh' i]", "[aria-label*='refresh' i]",
];
function findRefresh() {
  const target = SEL.captchaRefresh ? $(SEL.captchaRefresh) : null;
  if (target && !isUnsafeToClick(target)) return target;
  if (SEL.captchaRefresh) return null;

  for (const sel of REFRESH_SELECTORS) {
    try {
      const e = $(sel);
      if (e && !isUnsafeToClick(e)) return e;
    } catch (_) {}
  }
  return null;
}

// Click the refresh control -> portal loads a new #CaptchaImage. Returns true if clicked.
function clickRefresh() {
  const el = findRefresh();
  if (!el) return false;
  el.click();
  return true;
}

function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
}

// One storage round-trip for both toggles (default: enabled ON, autoSubmit OFF).
async function getSettings() {
  if (!isContextValid()) return { enabled: false, autoSubmit: false };
  try {
    const v = await chrome.storage.local.get(["enabled", "autoSubmit"]);
    return { enabled: v.enabled !== false, autoSubmit: v.autoSubmit === true };
  } catch (_) {
    return { enabled: false, autoSubmit: false };
  }
}

// True ONLY on a POSITIVE logged-in signal. This gates the permanent teardown of the
// poll+observer (trySolve), so it must never fire before the login form has rendered — a
// false positive here would silently disable the solver for the whole pageload. The old
// "login form absent + not a login URL" inference was removed for exactly that reason: at
// a root URL (portal.aiub.edu/) a slow-rendering form read as "logged in" and killed the
// watcher before the captcha ever appeared.
function loggedIn() {
  if (document.querySelector(".portal-body")) return true;
  if (/\/Student/i.test(location.href)) return true;
  // A logout affordance means we're definitely authenticated.
  if (document.querySelector("a[href*='logout' i], #logout, .logout, [href*='Logout']")) return true;
  return false;
}

// Rolling-window throttle that SURVIVES full page reloads (the portal reloads on a wrong
// answer, which would otherwise reset an in-memory counter and defeat the lockout guard).
// Records this submit and returns { allowed, count }.
async function recordSubmitAllowed() {
  if (!isContextValid()) return { allowed: false, count: 0 };
  const now = Date.now();
  try {
    const v = await chrome.storage.local.get("autoSubmitLog");
    const recent = (Array.isArray(v.autoSubmitLog) ? v.autoSubmitLog : [])
      .filter((t) => typeof t === "number" && now - t < SUBMIT_WINDOW_MS);
    if (recent.length >= MAX_SUBMITS) return { allowed: false, count: recent.length };
    recent.push(now);
    await chrome.storage.local.set({ autoSubmitLog: recent });
    return { allowed: true, count: recent.length };
  } catch (_) {
    return { allowed: false, count: 0 };
  }
}

// True only when the user has already typed BOTH credentials. We never fill or read these
// values — only check they are non-empty so auto-submit can't fire a blank login attempt.
function credsPresent() {
  const u = $(SEL.usernameInput);
  const p = $(SEL.passwordInput);
  return !!(u && p && u.value.trim() && p.value.trim());
}

// Opt-in: click the login submit button after a HIGH-confidence fill. Guarded by the
// autoSubmit flag, a stricter confidence gate (a wrong submit burns a login attempt),
// credential presence, and a reload-proof rolling cap so a wrong-answer loop can't spam
// the form and lock the account.
async function maybeAutoSubmit(autoSubmit, conf) {
  if (!autoSubmit) return;
  if (conf < AUTOSUBMIT_CONF) { badge("⚠ auto-submit skipped (low confidence)", "warn"); return; }
  if (!credsPresent()) { badge("⚠ type ID + password first", "warn"); return; }
  const btn = $(SEL.submitButton);
  if (!btn) return log("auto-submit: no submit button found");
  const gate = await recordSubmitAllowed();
  if (!gate.allowed) { badge("✕ auto-submit paused (too many tries — check ID/password)", "err"); return; }
  log("auto-submit", gate.count, "/", MAX_SUBMITS);
  badge("✓ submitting… (" + gate.count + "/" + MAX_SUBMITS + ")", "green");
  // Small delay so the fill's input/change events settle before the form submits.
  setTimeout(() => btn.click(), 300);
}

function reportStatus(patch) {
  if (!isContextValid()) return;
  try {
    chrome.storage.local.set({ lastCaptcha: patch }).catch?.(() => {});
  } catch (_) {}
}

async function trySolve() {
  if (!isContextValid()) { stopWatching(); return; }
  if (busy) return;
  // Once logged in, the captcha is gone for this session -> stop polling/observing (M3).
  if (loggedIn()) { stopWatching(); return; }
  const img = $(SEL.captchaImage);
  const input = $(SEL.captchaInput);
  if (!img) return log("no #CaptchaImage on page yet");
  if (!input) return log("no #CaptchaInputText on page yet");
  if (!isVisible($(SEL.captchaContainer) || img)) return log("captcha not visible yet");
  if (!img.complete || !img.naturalWidth) return log("captcha image not loaded yet");

  const src = img.currentSrc || img.src;
  if (src === lastHandledSrc) return; // already handled this exact captcha

  // Claim the slot SYNCHRONOUSLY before any await, so the 1s poll and the MutationObserver
  // can't both slip past the busy check and double-solve (and double-submit) the same image.
  busy = true;
  try {
    const st = await getSettings();
    if (!st.enabled) return log("auto-solver toggled OFF");

    log("solving captcha…", src);
    badge("⟳ solving…", "spin");

    const pngB64 = captchaPngB64(img);
    if (!pngB64) { log("could not read captcha pixels (tainted?)"); badge("✕ cannot read image", "err"); return; }
    const res = await chrome.runtime.sendMessage({ type: "SOLVE", pngB64, minConf: MIN_CONF });
    log("solver result:", res);

    // Transient failure (timeout, offscreen not ready, thrown error) -> do NOT mark handled;
    // a warm retry usually succeeds. Retry a few times, then give up to stop hammering.
    if (!res || !res.ok) {
      const reason = (res && res.reason) || "no response";
      transientTries = src === transientSrc ? transientTries + 1 : 1;
      transientSrc = src;
      if (transientTries >= MAX_TRANSIENT) {
        lastHandledSrc = src; // hard failure -> stop retrying this image
        reportStatus({ ok: false, reason });
        badge("✕ skipped: " + reason, "err");
      } else {
        // Surface the retry in the popup too, so it doesn't sit on a stale prior result
        // during a slow cold-load streak.
        reportStatus({ ok: false, reason: "retrying… (" + reason + ")" });
        badge("⟳ retrying… (" + reason + ")", "warn");
      }
      return;
    }

    // Deterministic verdict from here on -> this image is handled.
    lastHandledSrc = src;
    transientSrc = null; transientTries = 0;

    const r = res.result || null;
    const conf = r && typeof r.conf === "number" ? r.conf : 0;
    const ans = r && r.answer != null ? r.answer : null;
    const text = r ? r.text : "";

    const fill = () => {
      input.value = ans;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      input.style.outline = "2px solid #2a8f2a";
      reportStatus({ ok: true, answer: ans, text, conf });
    };

    if (ans != null && conf >= RETRY_CONF) {
      // Confident -> fill and end the episode.
      refreshCount = 0;
      fill();
      badge("✓ " + text + " = " + ans, "ok");
      await maybeAutoSubmit(st.autoSubmit, conf); // opt-in; no-op unless toggle ON + creds typed
    } else if (refreshCount < MAX_REFRESH && clickRefresh()) {
      // Shaky -> reroll to an easier captcha. The new image retriggers trySolve.
      refreshCount++;
      const why = ans == null ? (r ? r.info : "no answer") : "low-conf " + conf.toFixed(2);
      log("reroll", refreshCount, "/", MAX_REFRESH, "-", why);
      badge("⟳ " + why + " → new captcha (" + refreshCount + "/" + MAX_REFRESH + ")", "warn");
      // The refresh click swaps #CaptchaImage while we're still busy; nudge a re-solve
      // shortly after busy clears so we don't wait on the 1s poll for each reroll.
      setTimeout(trySolve, 400);
    } else {
      // Out of rerolls (or no refresh control) -> best effort so you can verify/fix.
      refreshCount = 0;
      if (ans != null) {
        fill();
        input.style.outline = "2px solid #c47f00";
        badge("⚠ " + text + " = " + ans + " → verify", "warn");
      } else {
        const reason = (r && r.info) || "no answer";
        reportStatus({ ok: false, reason });
        badge("✕ skipped: " + reason, "err");
      }
    }
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    reportStatus({ ok: false, reason: m });
    badge("✕ error: " + m, "err");
  } finally {
    busy = false;
  }
}

// The captcha can appear/refresh at any time (blur, wrong answer, manual reload). Watch
// the DOM for changes and also poll lightly as a safety net for src swaps. We only watch the
// "src" attribute (image swaps) and ignore mutations from our own badge, so badge/outline
// updates don't feed back into the observer.
const observer = new MutationObserver((muts) => {
  if (muts.some((m) => !(badgeEl && badgeEl.contains(m.target)))) trySolve();
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});
const pollId = setInterval(trySolve, 1000);

// Tear down the poll + observer once there's nothing left to watch (e.g. after login), so
// we don't keep running a 1s timer + mutation callbacks for the rest of the session (M3).
let watchStopped = false;
function stopWatching() {
  if (watchStopped) return;
  watchStopped = true;
  clearInterval(pollId);
  try { observer.disconnect(); } catch (_) {}
}

// Fresh page load: drop any stale status so the popup doesn't show a previous session's result.
if (isContextValid()) {
  try {
    chrome.storage.local.remove("lastCaptcha").catch?.(() => {});
    // A logged-in page means the last login worked -> clear the auto-submit throttle.
    if (loggedIn()) chrome.storage.local.remove("autoSubmitLog").catch?.(() => {});
  } catch (_) {}
}

trySolve();
