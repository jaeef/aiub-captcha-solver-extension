# AIUB Captcha Auto-Solver

A Manifest V3 browser extension that auto-solves the **AIUB student portal** login captcha
(a small math equation, e.g. `76-42=?`) using a neural net that runs **entirely inside your
browser** — no server, no remote inference, no network calls to solve.

> You log in yourself. The extension only reads the captcha image and types the answer into the
> captcha box. It never sees, stores, or transmits your ID or password.

## Features

- Auto-solves the math captcha and fills the answer box — no typing.
- Confident answers are typed directly; uncertain ones auto-refresh to an easier captcha (max 5 rerolls).
- Opt-in auto-submit: after a high-confidence fill it clicks Login once your ID and password are typed
  (default OFF, rate-capped to protect your account).
- Live status in the popup + an on-page badge while solving.
- Works on Chromium (Chrome, Edge, Brave, Opera, Vivaldi) and Firefox.

## How it works

```
content script  → reads the captcha image pixels (canvas)
      ↓
background (service worker) → hands the image to an offscreen document
      ↓
offscreen solver → pure-JS preprocess → ONNX model (ONNX Runtime Web, bundled) → answer
      ↓
content script  → types the answer into the captcha field
```

- **On-device only.** The model (`models/captcha.onnx`) and ONNX Runtime (`vendor/`) are bundled;
  no CDN, no remote inference.
- **CSP-safe.** No `eval`, no inline scripts — image preprocessing is a pure-JS reimplementation
  of the training pipeline (no OpenCV, which would need `unsafe-eval`).
- **Your data stays local.** The captcha image is processed in-memory inside the extension and
  never leaves your machine.

## Install

### Chrome / Chromium

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `dist/aiub-captcha-solver-chrome` (the pre-built folder),
   or the repo root if you prefer to run from source.
3. Open the AIUB portal login page, focus then blur the username field so the captcha appears.
4. The captcha box fills automatically. Type your own ID/password and log in.

### Firefox

1. Build the Firefox package — run `bash build.sh`, which produces
   `dist/aiub-captcha-solver-firefox.zip`. No bash? Copy `models/captcha.onnx` into
   `dist/aiub-captcha-solver-firefox/models/` and re-zip the folder (forward-slash entries).
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick the zip (or its
   `manifest.json`).
3. Same as Chrome: open the portal login, blur the username field, captcha fills itself.

> **First solve is slow.** The model is ~168 MB and loads on your first captcha; a cold load on a
> low-end machine can take up to ~60 s (the extension retries automatically). Later solves reuse the
> loaded model and are fast.

## Usage (toolbar popup)

- **Do my math for me** — auto-solve + fill the captcha (default ON).
- **Also click submit** — after a high-confidence fill, click Login, but only once your ID and
  password are already typed, behind a strict confidence gate and a reload-proof rate cap
  (default OFF, opt-in).
- **Feedback / Report bug** — opens a short Google Form in a new tab (your choice — nothing is
  submitted without you).

## Accuracy notes

- Answers are gated on the model's confidence. Below a hard floor the answer is discarded; below a
  higher bar the extension refreshes to a new captcha instead of typing a shaky answer.
- **Wrong answers are possible.** If one slips through, the portal rejects login, a fresh captcha
  loads, and the extension re-solves — it's not perfect, just much faster than doing the math yourself.
- Negative results and division captchas are never filled (the portal doesn't use division).

## Privacy Policy

AIUB Captcha Auto-Solver does not collect, store, or transmit any personal data. All captcha recognition runs locally inside your browser. No information — including your login credentials — is ever sent to any server.

- **No data collected:** No credentials or personal identifiers are read, saved, or transmitted.
- **Local execution only:** Captcha image processing and ONNX neural network inference run 100% on your device.
- **Local storage only:** Browser local storage is used strictly to retain:
  - Your on/off toggle preferences (solver enabled, auto-submit enabled).
  - The last solve status message displayed in the toolbar popup.
  - Auto-submit timestamps strictly used to enforce rate-limiting.
- **Third parties:** Nothing is shared with the developer or any third party. The only external link is the optional Feedback button in the popup (a Google Form), which only opens if you explicitly click it.

## For developers

```
manifest.json          MV3 manifest (Chrome: storage + offscreen permissions)
manifest.firefox.json  Firefox manifest (storage only; no chrome.offscreen)
content.js             runs on portal.aiub.edu — detects the captcha, reads pixels, fills answer
background.js          Chrome service worker — owns the offscreen document, routes solves
offscreen.js           Chrome offscreen document — hosts the heavy solver
background.firefox.js  Firefox event page — runs the solver directly (no offscreen API there)
popup.html/js          toolbar UI — toggles + last status + feedback link
solver/
  decode.js            pure-JS decode + argmax/softmax (14 classes: 0-9, +, -, *, blank)
  preprocess.js        pure-JS port of the training preprocess (grayscale → Otsu → denoise → resize)
  solver.js            loads models/captcha.onnx via ONNX Runtime Web, solve(pngBytes)
models/captcha.onnx    the trained captcha model (~168 MB, fp32)
vendor/                bundled ONNX Runtime Web (ort.min.js + wasm binaries), no CDN
```

- **Confidence gates** live in `content.js`: `MIN_CONF` (discard below), `RETRY_CONF` (reroll below),
  `AUTOSUBMIT_CONF` (auto-submit only above). Rerolls are capped at 5; auto-submits at 5 per 10 minutes,
  guarded across reloads so a wrong-answer loop can't lock your account.
- **Chrome vs Firefox:** Chrome runs the solver in an offscreen document (kept alive across solves);
  Firefox runs it in the background event page, which may unload after idle — so the first solve after
  a pause reloads the model and is slower.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Captcha not auto-filling | Open the portal, focus then blur the username field to reveal the captcha; check the popup status/badge for a reason. |
| First solve very slow | Expected — the ~168 MB model is loading. Chrome may take up to ~60 s; Firefox up to ~60 s on cold start. |
| Badge shows "solving…" forever | Refresh the page and try again; report it if it repeats. |
| Nothing happens after a portal redesign | The extension uses fixed element IDs (`#CaptchaImage`, `#CaptchaInputText`). If AIUB changes them, solving stops — report it. |
| Incognito / private window | Extension needs to be enabled for incognito in `chrome://extensions` (or the Add-ons settings in Firefox). |
| Doesn't work in Firefox after update | Firefox temp add-ons reset on restart; reload it from `about:debugging`. |

## Disclaimer

For convenience logging into **your own** AIUB account. Use responsibly and in line with the
portal's terms.
