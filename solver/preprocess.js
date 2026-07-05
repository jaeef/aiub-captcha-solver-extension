// preprocess.js — pure-JS port of captcha_seqcnn.py preprocess(). NO OpenCV.
// OpenCV.js was dropped: its embind build calls `new Function(...)`, which MV3's
// extension CSP (script-src 'self' 'wasm-unsafe-eval'; no 'unsafe-eval') forbids, so
// it threw EvalError at load and every solve timed out. This reimplements the exact
// pipeline (grayscale, Otsu, 8-conn denoise, 3x3 close, bbox crop, INTER_AREA resize)
// with plain arrays. Verified against cv2: 20/20 identical model predictions, max
// per-pixel diff 1/255 (rounding only). See tools/ for the parity harness.
(function (root) {
  "use strict";

  var IMG_H = 40, IMG_W = 140;
  var MIN_AREA = 18; // speckle cutoff, matches Python CC_STAT_AREA >= 18

  // PIL Image.convert("L") fixed-point luma: (R*19595 + G*38470 + B*7471 + 0x8000) >> 16.
  // Byte-exact vs PIL (verified). Input RGBA (canvas), output Uint8Array(w*h).
  function toGray(rgba, w, h) {
    var g = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      var A = rgba[p + 3], r, gg, b;
      if (A === 255) {
        r = rgba[p]; gg = rgba[p + 1]; b = rgba[p + 2];
      } else {
        // Straight-alpha composite over white (transparent -> white). When A==255 this is
        // identity, so verified opaque-input parity with PIL is preserved.
        var inv = 255 - A;
        r  = (rgba[p]     * A + 255 * inv + 127) / 255 | 0;
        gg = (rgba[p + 1] * A + 255 * inv + 127) / 255 | 0;
        b  = (rgba[p + 2] * A + 255 * inv + 127) / 255 | 0;
      }
      g[i] = (r * 19595 + gg * 38470 + b * 7471 + 0x8000) >> 16;
    }
    return g;
  }

  // Otsu threshold on a 256-bin histogram (matches cv2.threshold(...THRESH_OTSU)).
  function otsuThreshold(gray) {
    var hist = new Float64Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length;
    var sumAll = 0;
    for (var t = 0; t < 256; t++) sumAll += t * hist[t];
    var sumB = 0, wB = 0, best = -1, thr = 0;
    for (t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      var mB = sumB / wB;
      var mF = (sumAll - sumB) / wF;
      var d = mB - mF;
      var varBetween = wB * wF * d * d;
      if (varBetween > best) { best = varBetween; thr = t; }
    }
    return thr;
  }

  // THRESH_BINARY_INV: text (gray <= thr) -> 255, else 0.
  function thresholdInv(gray, thr) {
    var bw = new Uint8Array(gray.length);
    for (var i = 0; i < gray.length; i++) bw[i] = gray[i] <= thr ? 255 : 0;
    return bw;
  }

  // Keep only 8-connected components with area >= MIN_AREA (drop speckle).
  // Returns Uint8Array(w*h) of 0/255. Mirrors connectedComponentsWithStats + filter.
  function denoiseComponents(bw, w, h) {
    var clean = new Uint8Array(w * h);
    var lab = new Int32Array(w * h).fill(-1);
    var stack = new Int32Array(w * h); // reused DFS frontier (pixel indices)
    for (var start = 0; start < bw.length; start++) {
      if (bw[start] !== 255 || lab[start] !== -1) continue;
      var sp = 0;
      stack[sp++] = start; lab[start] = start; // mark visited (id value unused)
      var comp = []; // pixel indices in this component
      while (sp > 0) {
        var idx = stack[--sp];
        comp.push(idx);
        var y = (idx / w) | 0, x = idx - y * w;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var nidx = ny * w + nx;
            if (bw[nidx] === 255 && lab[nidx] === -1) { lab[nidx] = start; stack[sp++] = nidx; }
          }
        }
      }
      if (comp.length >= MIN_AREA) {
        for (var k = 0; k < comp.length; k++) clean[comp[k]] = 255;
      }
    }
    return clean;
  }

  // Morphological CLOSE with a 3x3 ellipse SE (== cross: center + 4-neighbours).
  // close = erode(dilate(img)). Border: dilate treats OOB as 0 (min), erode as 255 (max),
  // matching OpenCV's morphologyDefaultBorderValue sentinel. In-place-safe via temp buffers.
  var CROSS = [[-1, 0], [0, -1], [0, 0], [0, 1], [1, 0]];
  function morph(img, w, h, isErode) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var acc = isErode ? 255 : 0;
        for (var s = 0; s < CROSS.length; s++) {
          var ny = y + CROSS[s][0], nx = x + CROSS[s][1];
          var v;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) {
            v = isErode ? 255 : 0; // OOB sentinel
          } else {
            v = img[ny * w + nx];
          }
          if (isErode) { if (v < acc) acc = v; }
          else { if (v > acc) acc = v; }
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  }
  function morphClose(img, w, h) {
    return morph(morph(img, w, h, false), w, h, true);
  }

  // OpenCV INTER_AREA 1D weight table (computeResizeAreaTab). Handles both shrink and
  // enlarge; verified against cv2 recovered impulse weights. Returns per-dst array of
  // {s: srcIndex, wt: weight} with weights summing to 1.
  function areaTab(ssize, dsize) {
    var scale = ssize / dsize;
    var tabs = new Array(dsize);
    for (var dx = 0; dx < dsize; dx++) {
      var fsx1 = dx * scale, fsx2 = fsx1 + scale;
      var cellW = Math.min(scale, ssize - fsx1);
      var sx1 = Math.ceil(fsx1);
      var sx2 = Math.min(Math.floor(fsx2), ssize - 1);
      if (sx1 > sx2) sx1 = sx2;
      var row = [];
      if (sx1 - fsx1 > 1e-3) row.push({ s: sx1 - 1, wt: (sx1 - fsx1) / cellW });
      for (var sx = sx1; sx < sx2; sx++) row.push({ s: sx, wt: 1.0 / cellW });
      if (fsx2 - sx2 > 1e-3) row.push({ s: sx2, wt: Math.min(Math.min(fsx2 - sx2, 1.0), cellW) / cellW });
      tabs[dx] = row;
    }
    return tabs;
  }

  // Round half to even (banker's), matching OpenCV cvRound / lrint. Minimizes ±1 drift.
  function roundHalfEven(v) {
    var r = Math.round(v);
    if (Math.abs(v - Math.trunc(v)) === 0.5) { // exact .5 -> round to even
      var f = Math.floor(v);
      r = (f % 2 === 0) ? f : f + 1;
    }
    return r;
  }

  // Resize src (Uint8Array, sw x sh) to IMG_W x IMG_H via separable INTER_AREA.
  // Returns Float32Array(IMG_H*IMG_W) in [0,1].
  function resizeArea(src, sw, sh) {
    var Tx = areaTab(sw, IMG_W);
    var Ty = areaTab(sh, IMG_H);
    // Horizontal pass: sh x IMG_W (float).
    var tmp = new Float64Array(sh * IMG_W);
    for (var dx = 0; dx < IMG_W; dx++) {
      var rx = Tx[dx];
      for (var y = 0; y < sh; y++) {
        var acc = 0;
        for (var i = 0; i < rx.length; i++) acc += src[y * sw + rx[i].s] * rx[i].wt;
        tmp[y * IMG_W + dx] = acc;
      }
    }
    // Vertical pass: IMG_H x IMG_W (float), then round + normalize.
    var out = new Float32Array(IMG_H * IMG_W);
    for (var dy = 0; dy < IMG_H; dy++) {
      var ry = Ty[dy];
      for (var x = 0; x < IMG_W; x++) {
        var a = 0;
        for (var j = 0; j < ry.length; j++) a += tmp[ry[j].s * IMG_W + x] * ry[j].wt;
        var u8 = roundHalfEven(a);
        if (u8 < 0) u8 = 0; else if (u8 > 255) u8 = 255;
        out[dy * IMG_W + x] = u8 / 255;
      }
    }
    return out;
  }

  // imageData: ImageData (RGBA) of the decoded captcha PNG.
  // Returns Float32Array(IMG_H*IMG_W) in [0,1], white text on black, denoised.
  function preprocessImageData(imageData) {
    var w = imageData.width, h = imageData.height;
    var gray = toGray(imageData.data, w, h);
    var thr = otsuThreshold(gray);
    var bw = thresholdInv(gray, thr);
    var clean = denoiseComponents(bw, w, h);
    clean = morphClose(clean, w, h);

    // Crop to ink bbox so scale/position normalize.
    var x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (clean[y * w + x] > 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    var src = clean, sw = w, sh = h;
    if (x1 >= 0) {
      sw = x1 - x0 + 1; sh = y1 - y0 + 1;
      src = new Uint8Array(sw * sh);
      for (var cy = 0; cy < sh; cy++) {
        for (var cx = 0; cx < sw; cx++) src[cy * sw + cx] = clean[(y0 + cy) * w + (x0 + cx)];
      }
    }
    return resizeArea(src, sw, sh);
  }

  // Decode PNG bytes -> ImageData via OffscreenCanvas, then preprocess.
  async function preprocessPngBytes(pngUint8) {
    var blob = new Blob([pngUint8], { type: "image/png" });
    // Disable color management / alpha premultiply so pixels match Python's raw decode
    // (PIL applies no ICC correction). Parity-critical.
    var bmp = await createImageBitmap(blob, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    try {
      var oc = new OffscreenCanvas(bmp.width, bmp.height);
      var ctx = oc.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
      ctx.drawImage(bmp, 0, 0);
      var imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return preprocessImageData(imgData);
    } finally {
      bmp.close();
    }
  }

  root.Preprocess = {
    IMG_H: IMG_H,
    IMG_W: IMG_W,
    preprocessImageData: preprocessImageData,
    preprocessPngBytes: preprocessPngBytes,
  };
})(typeof self !== "undefined" ? self : this);
