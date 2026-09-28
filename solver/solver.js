// solver.js — ties pure-JS preprocess + onnxruntime-web inference into solve().
// Loaded in the offscreen document AFTER vendor/ort.min.js, solver/decode.js,
// solver/preprocess.js.
(function (root) {
  "use strict";

  // fp32 by default: exact parity with the trained model (verified 0 argmax drift).
  // int8 (models/captcha.int8.onnx) is ~4x smaller but showed ~17% argmax drift on
  // random inputs — only switch to it AFTER validating accuracy on real captchas.
  var MODEL_URL = chrome.runtime.getURL("models/captcha.onnx");
  var INPUT_NAME = "input";
  var OUT_NAMES = ["slot_0", "slot_1", "slot_2", "slot_3", "slot_4"];
  var NUM_CLASSES = root.Decode.NUM_CLASSES;

  var _session = null;
  var _initPromise = null;

  function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async function () {
      // Single-threaded, no proxy worker -> no blob: worker needed (CSP-safe).
      root.ort.env.wasm.numThreads = 1;
      root.ort.env.wasm.proxy = false;
      // Point ort at the bundled wasm binaries (no CDN — CSP-safe).
      root.ort.env.wasm.wasmPaths = {
        mjs: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.mjs"),
        wasm: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.wasm")
      };
      _session = await root.ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return _session;
    })().catch(function (e) {
      // Don't cache a permanently-rejected init; allow a later retry to recover.
      _initPromise = null;
      throw e;
    });
    return _initPromise;
  }

  // pngUint8: Uint8Array of the captcha PNG. minConf: reject below this.
  // Returns { answer: string|null, conf: number, text: string, info: string }.
  async function solve(pngUint8, minConf) {
    if (minConf == null) minConf = 0.5;
    await init();

    var x = await root.Preprocess.preprocessPngBytes(pngUint8);
    var tensor = new root.ort.Tensor("float32", x, [1, 1, root.Preprocess.IMG_H, root.Preprocess.IMG_W]);

    var feeds = {};
    feeds[INPUT_NAME] = tensor;
    var results = await _session.run(feeds);

    var logits = OUT_NAMES.map(function (name) {
      var t = results[name];
      if (!t) throw new Error("model output missing: " + name);
      return t.data; // Float32Array(NUM_CLASSES)
    });
    // Guard against a mismatched export.
    if (logits[0].length !== NUM_CLASSES) {
      throw new Error("unexpected class count: " + logits[0].length);
    }

    var am = root.Decode.argmaxSoftmax(logits);
    var text = root.Decode.slotsToText(am.slots);
    var ans = root.Decode.decode(am.slots);

    // NOTE (M1): division is UNDETECTABLE here — the model has no ÷ class (decode.js OPS = + - *),
    // so a division captcha is mis-read as +/-/* and returns a WRONG answer, not null. Only the
    // unreadable/negative cases below can be surfaced. Confirm the portal never uses division.
    if (ans === null) return { answer: null, conf: am.minConf, text: text, info: "unreadable(" + text + ")" };
    if (ans < 0) return { answer: null, conf: am.minConf, text: text, info: "negative not supported(" + text + ")" };
    if (am.minConf < minConf) {
      return { answer: null, conf: am.minConf, text: text, info: "low-confidence(" + text + "=" + ans + ")" };
    }
    return { answer: String(ans), conf: am.minConf, text: text, info: text + "=" + ans };
  }

  root.Solver = { init: init, solve: solve };
})(typeof self !== "undefined" ? self : this);
