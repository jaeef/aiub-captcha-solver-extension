// offscreen.js — runs in the offscreen document. Owns the heavy solver.
// Receives SOLVE_OFFSCREEN messages from background, returns the answer.

function b64ToUint8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Guard (L1): if any solver script failed to load, self.Solver is undefined. Detect it, name
// the culprit in the console, and still register the listener so background gets a CLEAR reason
// instead of the cryptic "Receiving end does not exist" (which only means "no listener", not why).
var SOLVER_OK = !!(self.ort && self.Decode && self.Preprocess && self.Solver);
if (!SOLVER_OK) {
  var missing = [
    self.ort ? null : "vendor/ort.min.js",
    self.Decode ? null : "solver/decode.js",
    self.Preprocess ? null : "solver/preprocess.js",
    self.Solver ? null : "solver/solver.js",
  ].filter(Boolean).join(", ");
  console.error("[offscreen] solver scripts failed to load — missing globals from: " + missing);
} else {
  // Warm the model as soon as the doc loads so the first real solve is fast.
  self.Solver.init()
    .then(function () { console.log("[offscreen] solver ready (model loaded)"); })
    .catch(function (e) { console.error("[offscreen] solver init FAILED:", e); });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.target !== "offscreen" || msg.type !== "SOLVE_OFFSCREEN") return;
  if (!SOLVER_OK) {
    sendResponse({ ok: false, reason: "solver not loaded (offscreen scripts failed — see offscreen console)" });
    return true;
  }
  (async function () {
    try {
      var bytes = b64ToUint8(msg.pngB64);
      var res = await self.Solver.solve(bytes, msg.minConf);
      sendResponse({ ok: true, result: res });
    } catch (e) {
      sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});
