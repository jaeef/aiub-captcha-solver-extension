# AIUB Captcha Auto-Solver

A Manifest V3 browser extension that auto-solves the **AIUB student portal** login captcha
(a small math equation, e.g. `76-42=?`) using a neural net that runs **entirely inside your
browser** — no server, no network calls, nothing leaves your machine.

> You log in yourself. The extension only reads the captcha image and types the answer into the
> captcha box. It never sees, stores, or transmits your ID or password.

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

## Install (local / unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open the AIUB portal login, focus then blur the username field so the captcha appears.
4. The captcha box gets filled automatically. Type your own ID/password and log in.

Works on Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi). Firefox support is planned.

## Options (toolbar popup)

- **Do my math for me** — auto-solve + fill the captcha (default ON).
- **Also click submit** — after a high-confidence fill, click Login, but only once your ID and
  password are already typed, behind a strict confidence gate and a reload-proof rate cap
  (default OFF, opt-in).
- **Feedback / Report bug** — opens a short Google Form.

## Privacy

- **No data collected.** No credentials are read into storage or sent anywhere.
- Local storage holds only: your toggle settings, the last solve status (for the popup), and
  auto-submit timestamps (to enforce the rate cap).

## Disclaimer

For convenience logging into **your own** AIUB account. Use responsibly and in line with the
portal's terms.
