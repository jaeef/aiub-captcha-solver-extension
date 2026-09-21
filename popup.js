// popup.js — toggle auto-solver + auto-submit, show last captcha result.

const $ = (id) => document.getElementById(id);

function renderStatus(last) {
  const el = $("status");
  const dot = $("dot");
  if (!last) {
    el.className = "";
    el.textContent = "No captcha yet. Ready.";
    dot.className = "";
    return;
  }
  if (last.ok) {
    el.className = "ok";
    el.textContent = "Solved: " + (last.text || "?") + " → " + last.answer;
    dot.className = "on";
  } else {
    el.className = "bad";
    el.textContent = "Skipped: " + (last.reason || "unknown");
    dot.className = "";
  }
}

// Clean concise hint.
$("hint").textContent = "Automatically solves math captchas on AIUB portal.";

// Init toggles (default ON) + last status.
chrome.storage.local.get(["enabled", "autoSubmit", "lastCaptcha"], (v) => {
  $("enabled").checked = v.enabled !== false;
  $("autoSubmit").checked = v.autoSubmit === true; // default OFF
  renderStatus(v.lastCaptcha);
});

$("enabled").addEventListener("change", (e) => {
  chrome.storage.local.set({ enabled: e.target.checked });
});

$("autoSubmit").addEventListener("change", (e) => {
  chrome.storage.local.set({ autoSubmit: e.target.checked });
});

// Live-update status while popup open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastCaptcha) renderStatus(changes.lastCaptcha.newValue);
});

// ---- Feedback (Google Form prefill) ----
// SETUP (one time):
//   1. Create a Google Form with ONE "short answer" (or "paragraph") question.
//   2. Top-right ⋮ menu -> "Get pre-filled link". Type any text in the answer -> "Get link".
//   3. The copied link looks like:
//        https://docs.google.com/forms/d/e/1FAIpQL.../viewform?usp=pp_url&entry.123456789=hello
//      Split it: everything up to "/viewform" is FEEDBACK_FORM; the "entry.NNNN" is FEEDBACK_ENTRY.
//   4. Paste both below. Until then the button opens a placeholder that won't record anything.
const FEEDBACK_FORM = "https://docs.google.com/forms/d/e/1FAIpQLSfGViQi5RWwQo27_Slv32wBEsiJd4zhvpPNxdCOM4krnfgcbw/viewform";

// Feedback link -> open the Google Form in a new tab (user fills + submits there).
$("feedbackLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: FEEDBACK_FORM });
});
