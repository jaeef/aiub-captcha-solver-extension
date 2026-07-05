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
const MIN_CONF = 0.5;         // solver gate: below this, answer is treated as unknown
const RETRY_CONF = 0.90;      // below this, reroll for an easier captcha instead of filling (raised
                              // from 0.85 to cut confidently-wrong fills; relies on a working reroll)
const AUTOSUBMIT_CONF = 0.90; // gate for auto-submit: a wrong submit burns a login attempt
const MAX_REFRESH = 5;        // cap rerolls per episode (so 5 captchas tried max)
const MAX_SUBMITS = 8;        // max auto-submits per rolling window (lockout guard, survives reloads)
const SUBMIT_WINDOW_MS = 10 * 60 * 1000; // rolling window for the auto-submit cap
const MAX_TRANSIENT = 5;      // retries for transient solver failures (timeout/not-ready) per image
const DEBUG = false;          // set true to log solve details to the console
const log = (...a) => DEBUG && console.log("[captcha]", ...a);

const $ = (s) => document.querySelector(s);

// On-page badge so you can see what's happening without the console.
let badgeEl = null;
function badge(text, color) {
  if (!badgeEl) {
    badgeEl = document.createElement("div");
    badgeEl.style.cssText =
      "position:fixed;z-index:2147483647;top:8px;right:8px;padding:6px 10px;" +
      "font:12px system-ui,sans-serif;border-radius:6px;color:#fff;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.3);pointer-events:none;max-width:260px";
    document.documentElement.appendChild(badgeEl);
  }
  badgeEl.textContent = text;
  badgeEl.style.background = color || "#555";
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

// Locate the "new captcha" control. Prefer the explicit selector. The heuristic
// fallback is deliberately conservative: it only accepts a refresh-looking element
// that lives inside the captcha container (so it can't be a page-level submit/nav),
// and never one that could submit the form.
// Common explicit selectors tried before the heuristic. All still pass isUnsafeToClick,
// so none of these can be a form-submit even if a guess is wrong.
const REFRESH_GUESSES = [
  "#RefreshCaptcha", "#refreshCaptcha", "#btnRefreshCaptcha", "#reloadCaptcha",
  "a.captcha-refresh", ".captcha-refresh", ".captcha-reload",
  "[title*='refresh' i]", "[aria-label*='refresh' i]", "[title*='reload' i]",
];
function findRefresh() {
  if (SEL.captchaRefresh) {
    const e = $(SEL.captchaRefresh);
    if (e && !isUnsafeToClick(e)) return e;
    return null; // configured selector is authoritative; don't fall back past it
  }
  // Try common explicit refresh selectors first.
  for (const sel of REFRESH_GUESSES) {
    let e = null;
    try { e = $(sel); } catch (_) { /* invalid selector -> skip */ }
    if (e && !isUnsafeToClick(e)) return e;
  }
  const box = $(SEL.captchaContainer);
  if (!box) return null; // no captcha scope -> refuse to guess page-wide
  const cands = box.querySelectorAll('a, img, button, i, span, svg, [onclick], [role="button"]');
  for (const el of cands) {
    if (el.id === "CaptchaImage") continue; // that's the image itself
    if (isUnsafeToClick(el)) continue;
    // getAttribute('class') (not el.className) so SVG's SVGAnimatedString still reads as text.
    const hint = (el.id + " " + (el.getAttribute("class") || "") + " " + (el.getAttribute("onclick") || "") +
      " " + (el.getAttribute("href") || "") + " " + (el.getAttribute("title") || "") +
      " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("alt") || "") +
      " " + (el.getAttribute("src") || "")).toLowerCase();
    if (/refresh|reload|renew|regenerat|new\s*captcha|fa-(sync|refresh|redo|rotate)|bi-arrow|glyphicon-refresh/.test(hint)) return el;
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

// One storage round-trip for both toggles (default: enabled ON, autoSubmit OFF).
async function getSettings() {
  const v = await chrome.storage.local.get(["enabled", "autoSubmit"]);
  return { enabled: v.enabled !== false, autoSubmit: v.autoSubmit === true };
}

// True once the portal shows a logged-in page. Used to reset the auto-submit throttle so a
// fresh, legit session isn't blocked by a previous failed streak.
function loggedIn() {
  if (document.querySelector(".portal-body")) return true;
  if (/\/Student/i.test(location.href)) return true;
  // A logout affordance means we're definitely authenticated.
  if (document.querySelector("a[href*='logout' i], #logout, .logout, [href*='Logout']")) return true;
  // Login form gone AND not on a login URL -> treat as logged in. Used only to clear the
  // auto-submit throttle; if the form is gone there's no captcha to submit, so a false
  // positive here is harmless.
  const onLoginForm = !!(document.querySelector(SEL.usernameInput) && document.querySelector(SEL.passwordInput));
  if (!onLoginForm && !/login|signin|logon/i.test(location.href)) return true;
  return false;
}

// Rolling-window throttle that SURVIVES full page reloads (the portal reloads on a wrong
// answer, which would otherwise reset an in-memory counter and defeat the lockout guard).
// Records this submit and returns { allowed, count }.
async function recordSubmitAllowed() {
  const now = Date.now();
  const v = await chrome.storage.local.get("autoSubmitLog");
  const recent = (Array.isArray(v.autoSubmitLog) ? v.autoSubmitLog : [])
    .filter((t) => typeof t === "number" && now - t < SUBMIT_WINDOW_MS);
  if (recent.length >= MAX_SUBMITS) return { allowed: false, count: recent.length };
  recent.push(now);
  await chrome.storage.local.set({ autoSubmitLog: recent });
  return { allowed: true, count: recent.length };
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
  if (conf < AUTOSUBMIT_CONF) { badge("filled — auto-submit skipped (not confident enough)", "#c47f00"); return; }
  if (!credsPresent()) { badge("auto-submit: type ID + password first", "#c47f00"); return; }
  const btn = $(SEL.submitButton);
  if (!btn) return log("auto-submit: no submit button found");
  const gate = await recordSubmitAllowed();
  if (!gate.allowed) { badge("auto-submit paused (too many tries — check ID/password)", "#a00"); return; }
  log("auto-submit", gate.count, "/", MAX_SUBMITS);
  badge("submitting… (" + gate.count + "/" + MAX_SUBMITS + ")", "#2a8f2a");
  // Small delay so the fill's input/change events settle before the form submits.
  setTimeout(() => btn.click(), 300);
}

function reportStatus(patch) {
  chrome.storage.local.set({ lastCaptcha: patch });
}

async function trySolve() {
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
    badge("solving…", "#c47f00");

    const pngB64 = captchaPngB64(img);
    if (!pngB64) { log("could not read captcha pixels (tainted?)"); badge("cannot read image", "#a00"); return; }
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
        badge("skipped: " + reason, "#a00");
      } else {
        badge("retrying… (" + reason + ")", "#c47f00");
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
      badge("filled: " + text + " = " + ans, "#18a718ff");
      await maybeAutoSubmit(st.autoSubmit, conf); // opt-in; no-op unless toggle ON + creds typed
    } else if (refreshCount < MAX_REFRESH && clickRefresh()) {
      // Shaky -> reroll to an easier captcha. The new image retriggers trySolve.
      refreshCount++;
      const why = ans == null ? (r ? r.info : "no answer") : "low-conf " + conf.toFixed(2);
      log("reroll", refreshCount, "/", MAX_REFRESH, "-", why);
      badge("reroll " + refreshCount + "/" + MAX_REFRESH + " (" + why + ")", "#c47f00");
      // The refresh click swaps #CaptchaImage while we're still busy; nudge a re-solve
      // shortly after busy clears so we don't wait on the 1s poll for each reroll.
      setTimeout(trySolve, 400);
    } else {
      // Out of rerolls (or no refresh control) -> best effort so you can verify/fix.
      refreshCount = 0;
      if (ans != null) {
        fill();
        input.style.outline = "2px solid #c47f00";
        badge("filled (verify): " + text + " = " + ans, "#c47f00");
      } else {
        const reason = (r && r.info) || "no answer";
        reportStatus({ ok: false, reason });
        badge("skipped: " + reason, "#a00");
      }
    }
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    reportStatus({ ok: false, reason: m });
    badge("error: " + m, "#a00");
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
chrome.storage.local.remove("lastCaptcha");
// A logged-in page means the last login worked -> clear the auto-submit throttle.
if (loggedIn()) chrome.storage.local.remove("autoSubmitLog");

trySolve();
