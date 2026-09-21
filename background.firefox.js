// background.firefox.js — Firefox build only. Firefox has no chrome.offscreen, but its MV3
// background (event page) has DOM + WASM, so the solver runs directly here. Same SOLVE message
// contract as Chrome's background.js + offscreen.js, so content.js is identical across browsers.
//
// Loaded via manifest "background.scripts" AFTER: vendor/ort.min.js, solver/decode.js,
// solver/preprocess.js, solver/solver.js — so self.ort / self.Decode / self.Preprocess /
// self.Solver already exist by the time this runs.

function b64ToUint8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Same guard as offscreen.js (L1): if a solver script failed to load, name the culprit and
// still register the listener so content.js gets a clear reason, not silence.
var SOLVER_OK = !!(self.ort && self.Decode && self.Preprocess && self.Solver);
if (!SOLVER_OK) {
  var missing = [
    self.ort ? null : "vendor/ort.min.js",
    self.Decode ? null : "solver/decode.js",
    self.Preprocess ? null : "solver/preprocess.js",
    self.Solver ? null : "solver/solver.js",
  ].filter(Boolean).join(", ");
  console.error("[bg-firefox] solver scripts failed to load — missing globals from: " + missing);
} else {
  // Warm the model so the first real solve is fast. (Firefox event pages are non-persistent,
  // so the model may reload after an idle unload — first solve after a pause is slower.)
  self.Solver.init()
    .then(function () { console.log("[bg-firefox] solver ready (model loaded)"); })
    .catch(function (e) { console.error("[bg-firefox] solver init FAILED:", e); });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== "SOLVE") return; // ignore anything else
  if (!SOLVER_OK) {
    sendResponse({ ok: false, reason: "solver not loaded (background scripts failed — see console)" });
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
