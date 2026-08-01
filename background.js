// background.js — MV3 service worker. Orchestrates the offscreen solver document.
// content.js -> {SOLVE} -> background ensures offscreen -> {SOLVE_OFFSCREEN} -> reply.

const OFFSCREEN_PATH = "offscreen.html";
const SOLVE_TIMEOUT_MS = 60000; // upper bound for a cold first solve (WASM + ~168MB model load).
                                // Raised from 30s: the retrained fp32 model is ~168MB, so a
                                // cold parse/load on a low-end machine can exceed 30s and time out
                                // the very first solve.
const OFFSCREEN_SEND_RETRIES = 5; // listener may not be ready right after create

// The offscreen document is created on first solve and intentionally kept alive for the
// browser session: it holds the loaded ONNX model (~168MB) in memory so later solves skip the
// multi-second model/WASM load. Deliberate memory-for-latency trade. Transient timeouts on
// the cold load are retried by content.js, so a slow first load no longer skips the captcha.
let creating = null; // shared promise; de-dupes concurrent createDocument calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }
  return false;
}

function ensureOffscreen() {
  // Set `creating` synchronously (before any await) so two concurrent callers share
  // one createDocument call instead of racing into "Only a single offscreen document".
  if (creating) return creating;
  creating = (async () => {
    if (await hasOffscreen()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"], // process captcha image bytes with WASM (ONNX Runtime)
        justification: "Run the captcha OCR model (ONNX Runtime, WASM) off the page.",
      });
    } catch (e) {
      if (!String(e).includes("Only a single offscreen")) throw e;
    }
  })();
  try {
    return creating;
  } finally {
    // Release the guard once settled so a later (post-teardown) call can recreate.
    creating.finally(() => { creating = null; });
  }
}

async function solveViaOffscreen(pngB64, minConf) {
  await ensureOffscreen();
  let lastErr = "no response from offscreen";
  for (let i = 0; i < OFFSCREEN_SEND_RETRIES; i++) {
    try {
      const res = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "SOLVE_OFFSCREEN",
        pngB64,
        minConf,
      });
      if (res) return res;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
      // "Receiving end does not exist" -> listener not up yet; back off and retry.
    }
    await sleep(150 * (i + 1));
  }
  return { ok: false, reason: lastErr };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "solver timeout" }), ms)
    ),
  ]);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "SOLVE") return; // ignore SOLVE_OFFSCREEN, etc.
  withTimeout(solveViaOffscreen(msg.pngB64, msg.minConf), SOLVE_TIMEOUT_MS)
    .then((res) => sendResponse(res || { ok: false, reason: "unknown" }))
    .catch((e) => sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }));
  return true; // async response
});
