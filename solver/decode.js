// decode.js — JS port of captcha_seqcnn.py decode()/OPS logic. Pure, no deps.
// Slot classes: 0-9 digits, 10='+', 11='-', 12='*', 13=blank.
(function (root) {
  "use strict";

  var OPS_INV = { 10: "+", 11: "-", 12: "*" };
  var BLANK = 13;
  var NUM_CLASSES = 14;
  var N_SLOTS = 5;

  // slots: [a_tens, a_ones, op, b_tens, b_ones] -> integer answer, or null.
  function decode(slots) {
    var a_t = slots[0], a_o = slots[1], op = slots[2], b_t = slots[3], b_o = slots[4];
    if (!(op in OPS_INV) || a_o > 9 || b_o > 9) return null;

    var a;
    if (a_t === BLANK) a = a_o;
    else if (a_t <= 9) a = a_t * 10 + a_o;
    else return null;

    var b;
    if (b_t === BLANK) b = b_o;
    else if (b_t <= 9) b = b_t * 10 + b_o;
    else return null;

    var o = OPS_INV[op];
    if (o === "+") return a + b;
    if (o === "-") return a - b;
    return a * b;
  }

  // Human-readable equation string, e.g. "76-42". Mirrors predict_equation()'s txt.
  function slotsToText(slots) {
    var out = "";
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s === BLANK) out += "_";
      else if (s in OPS_INV) out += OPS_INV[s];
      else out += String(s);
    }
    return out;
  }

  // logits: array of N_SLOTS Float32Array(NUM_CLASSES). Returns {slots, minConf}.
  function argmaxSoftmax(logits) {
    var slots = [];
    var minConf = 1;
    for (var s = 0; s < logits.length; s++) {
      var row = logits[s];
      // softmax (numerically stable) + argmax in one pass.
      var max = -Infinity, arg = 0;
      for (var k = 0; k < row.length; k++) {
        if (row[k] > max) { max = row[k]; arg = k; }
      }
      var sum = 0;
      for (var j = 0; j < row.length; j++) sum += Math.exp(row[j] - max);
      var conf = 1 / sum; // exp(max-max)=1 over sum
      // Guard NaN/Inf logits (broken/over-quantized model): treat as zero confidence
      // so the gate rejects instead of passing garbage as "confident".
      if (!isFinite(conf)) conf = 0;
      slots.push(arg);
      if (conf < minConf) minConf = conf;
    }
    return { slots: slots, minConf: minConf };
  }

  root.Decode = {
    OPS_INV: OPS_INV,
    BLANK: BLANK,
    NUM_CLASSES: NUM_CLASSES,
    N_SLOTS: N_SLOTS,
    decode: decode,
    slotsToText: slotsToText,
    argmaxSoftmax: argmaxSoftmax,
  };
})(typeof self !== "undefined" ? self : this);
