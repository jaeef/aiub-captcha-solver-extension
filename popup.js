// popup.js — toggle auto-solver + auto-submit, show last captcha result.

const $ = (id) => document.getElementById(id);

const HINT_LINES = [
  "Captcha shows up, I solve it cause your brain checked out years ago.",
  "I do math instantly. You'd still be counting on fingers. Type ID/pass, genius.",
  "Robot brain: solving equations. Human brain: buffering forever. Just log in already.",
  "Captcha crushed in milliseconds. You couldn't solve it by finals week. You're welcome.",
  "I handle math so your two remaining brain cells don't have to collide.",
  "Solved it before you finished reading the question. Login now, slowpoke.",
  "Captcha shows up, I do your homework. Your brain stays unemployed, as usual.",
  "Math happens. I handle it cause you clearly can't. Type ID/pass, hero.",
  "I solve captchas so you don't strain that smooth brain. You're welcome, lazy royalty.",
  "Robot brain: online. Human brain: retired early. Just type ID/pass, champ.",
  "I do math so you don't have to remember how. Login like the potato you are.",
  "Captcha appears, I crush it in milliseconds. You couldn't do 7+2 without a calculator anyway.",
  "Solved. You're still trying to remember what a variable is. Type ID/pass.",
  "I calculate, you vegetate. Fair split. Login now.",
  "Captcha destroyed instantly. Your GPA thanks me. Type ID/pass.",
  "I do the thinking, you do the clicking. Balance restored.",
  "Math solved before your coffee even kicked in. Login, legend.",
  "Captcha never stood a chance. Neither did your attention span. Log in.",
  "I'm out here solving equations while you forgot the order of operations. Type ID/pass.",
  "Zero effort from you, as usual. Captcha's dead. Log in, sleepyhead.",
];

const IDLE_LINES = ["No captcha yet. Chilling.", "Waiting... math is scary, I know."];
const OK_PREFIX = ["Solved (ez):", "Did it, you're welcome:", "Math destroyed:"];
const BAD_PREFIX = ["Skipped, blame this:", "Nope, couldn't:"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function renderStatus(last) {
  const el = $("status");
  const dot = $("dot");
  if (!last) {
    el.className = "";
    el.textContent = pick(IDLE_LINES);
    dot.className = "";
    return;
  }
  if (last.ok) {
    el.className = "ok";
    el.textContent = pick(OK_PREFIX) + " " + (last.text || "?") + " → " + last.answer;
    dot.className = "on";
  } else {
    el.className = "bad";
    el.textContent = pick(BAD_PREFIX) + " " + (last.reason || "unknown");
    dot.className = "";
  }
}

// Fresh roast line every time the popup opens.
$("hint").textContent = pick(HINT_LINES);

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
