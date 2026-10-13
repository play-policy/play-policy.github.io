/*
 * planner-toy.js
 * A small, dependency-free toy of the planning loop in "Dexterity from Supervised Play" (DSP),
 * for in-hand cube reorientation:
 *   sample N action chunks from a play prior, predict where each one takes the cube, score each
 *   chunk by its closest predicted approach to the goal, run the first 25 of its 50 steps, replan.
 *
 * What is made up (the UI says so too):
 *   - the "play policy" is a hand-written mix of yaw rotations about the palm normal, edge flips over
 *     the bottom edge that lines up with the fingers or the thumb, one corner flip, small corrections,
 *     regrasps that do not turn the cube, and settling into the nearest aligned grasp;
 *   - the "real" cube is a second, hidden model: flips fail half the time (the cube tips and falls
 *     back), turns slip, and each chunk drifts a little;
 *   - the "world model" is the commanded rotation plus a random error per proposal. Together with the
 *     hidden effects its 50-step error comes to about 28 deg, close to the 28.4 deg measured for the
 *     real model (paper Fig. 10), so a chunk that looks good in prediction can land worse.
 *
 * Browser: every <div class="ptoy" data-planner-toy></div> is mounted automatically.
 *          window.PlannerToy.mount(el, { proposals: 1024, speed: 1 }) mounts one by hand.
 * Node:    require() returns the same object; .core holds the DOM-free planner for tests.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.PlannerToy = api;
    api.autoMount();
  }
})(this, function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  var DT = 1 / 30;            // control period (s)
  var H = 50;                 // action chunk length (steps)
  var K = 50;                 // prediction horizon used for scoring (steps)
  var E = 25;                 // executed prefix before replanning (steps)
  var N_MAX = 1024;           // most proposals per replan
  var MAX_SEG = 20;           // segments per chunk (each lasts at least 3 steps)
  var BUDGET_S = 120;         // time budget per trial, as on the hardware
  var BUDGET_STEPS = Math.round(BUDGET_S / DT);
  var MAX_HIST = BUDGET_STEPS + 2 * E + 8;
  var END_HOLD_MS = 1500;     // a finished trial stays on screen this long
  var FAN_HOLD_MS = 400;      // at 1x, each new set of proposals is shown this long before it runs
  var LEGIBLE = 0.96;         // shown goals with a face this square to the camera are re-drawn
  var FAN_MAX = 64;           // proposals drawn in the plot
  var THRESH = [0.4, 0.6, 0.8];                 // rad
  var D2R = Math.PI / 180;
  var R2D = 180 / Math.PI;
  var INV_SQRT3 = 1 / Math.sqrt(3);
  var MIN_START_ERR = 90 * D2R;                 // goals start more than 90 deg away
  var PROPOSAL_OPTIONS = [1, 16, 128, 1024];
  var SPEED_OPTIONS = [1, 2, 4];

  var SEG_YAW = 0, SEG_EDGE = 1, SEG_CORNER = 2, SEG_FINE = 3, SEG_REGRASP = 4, SEG_SETTLE = 5;

  // Play prior. Human play keeps returning the cube to a few comfortable grasps, so the stand-in
  // moves it between the 24 orientations where the cube's faces line up with the palm. From a grasp
  // only a few flips are possible: over the bottom edge that lines up with the fingers (hand x) or
  // with the thumb (hand y), and one corner flip, each in one direction.
  // Probabilities, angle ranges (deg), durations (s) and average segment speeds (deg/s):
  var PRIOR = {
    wYaw: 0.34,
    wEdge: 0.22,
    wCorner: 0.06,
    wFine: 0.18,              // the remaining 0.20 is regrasps
    pSettle: 0.9,             // chance to settle first when more than settleDeg from a grasp
    settleDeg: 10,
    yawDeg: [30, 100],
    edgeDeg: [82, 98],
    cornerDeg: [112, 128],
    fineDeg: [3, 12],
    regraspS: [0.3, 0.8],
    speedDeg: [45, 90],
    fineSpeedDeg: [20, 50]
  };

  // What the hidden "real" cube does that the stand-in world model does not know about.
  var REAL = {
    yawScale: [0.7, 1.0],     // a yaw turns the cube by 70 to 100 % of the command
    flipSuccess: 0.5,         // flips land half the time ...
    flipScale: [0.85, 1.0],
    failPeak: [0.1, 0.3],     // ... otherwise the cube tips this far and falls back
    fineScale: [0.5, 1.0],
    settleScale: [0.9, 1.0],
    driftDegPerS: [0, 10],    // slow drift per chunk about a random axis
    wobbleDeg: 0.3            // per-step wobble
  };

  // Stand-in world model error: each proposal's prediction drifts away from the commanded motion about
  // a random axis, by a random angle (scale biasDeg) reached at the end of the horizon. biasDeg is set
  // so that, with the hidden effects above, the mean 50-step error is about 28 deg (core.modelError).
  var MODEL = { biasDeg: 11 };

  // The 24 rotations that map a cube onto itself, as [w, x, y, z]. Aligned grasps are these.
  var GRID = (function () {
    var h = Math.SQRT1_2, out = [
      [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
      [h, h, 0, 0], [h, -h, 0, 0], [h, 0, h, 0], [h, 0, -h, 0], [h, 0, 0, h], [h, 0, 0, -h],
      [0, h, h, 0], [0, h, -h, 0], [0, h, 0, h], [0, h, 0, -h], [0, 0, h, h], [0, 0, h, -h]
    ];
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sy = -1; sy <= 1; sy += 2) {
        for (var sz = -1; sz <= 1; sz += 2) out.push([0.5, 0.5 * sx, 0.5 * sy, 0.5 * sz]);
      }
    }
    return out;
  })();

  /* ------------------------------------------------------------------ math */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    return (Math.random() * 4294967296) >>> 0;
  }

  function uni(range, rng) {
    return range[0] + (range[1] - range[0]) * rng();
  }

  function gaussAbs(rng) {
    var u = rng() || 1e-12, v = rng();
    return Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }

  // Uniform random rotation (Shoemake). Quaternions are [w, x, y, z].
  function randomQuat(rng, out) {
    var u1 = rng(), u2 = rng(), u3 = rng();
    var a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    out[0] = a * Math.cos(2 * Math.PI * u2);
    out[1] = a * Math.sin(2 * Math.PI * u2);
    out[2] = b * Math.sin(2 * Math.PI * u3);
    out[3] = b * Math.cos(2 * Math.PI * u3);
    return out;
  }

  // Geodesic distance on SO(3) in rad.
  function quatDist(a, b) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) d = -d;
    if (d > 1) d = 1;
    return 2 * Math.acos(d);
  }

  // out = (aw, ax, ay, az) * b, then renormalized. out may alias b.
  function mulInto(aw, ax, ay, az, b, out) {
    var bw = b[0], bx = b[1], by = b[2], bz = b[3];
    var w = aw * bw - ax * bx - ay * by - az * bz;
    var x = aw * bx + ax * bw + ay * bz - az * by;
    var y = aw * by - ax * bz + ay * bw + az * bx;
    var z = aw * bz + ax * by - ay * bx + az * bw;
    var n = 1 / Math.sqrt(w * w + x * x + y * y + z * z);
    out[0] = w * n; out[1] = x * n; out[2] = y * n; out[3] = z * n;
    return out;
  }

  function sampleGoal(rng, start, out) {
    var tries = 0;
    do {
      randomQuat(rng, out);
      tries++;
    } while (quatDist(start, out) <= MIN_START_ERR && tries < 1000);
    return out;
  }

  /* ------------------------------------------------------------------ planner */

  // Every segment of a chunk rotates the cube about an axis that is fixed in the hand frame while it
  // runs, so a chunk is a hand-frame rotation sequence P_k and the commanded orientation is P_k * q0.
  // The stand-in model predicts B_k * P_k * q0, with B_k the proposal's own error. Scoring needs one
  // dot product per step, because <M q0, g> = <M, g q0^-1>.
  function Planner(seed) {
    this.rng = mulberry32(seed == null ? randomSeed() : seed);
    this.P = new Float64Array(N_MAX * H * 4);   // commanded rotation after step k of chunk i
    this.score = new Float64Array(N_MAX);       // best predicted |<B_k P_k, h>| over the horizon
    this.h = new Float64Array(4);               // g * conj(q0)
    this.bias = new Float64Array(N_MAX * 4);    // per-step error rotation of each proposal
    this.biasAxis = new Float64Array(N_MAX * 3);
    this.biasAng = new Float64Array(N_MAX);     // total error angle at step K (rad)
    this.segCount = new Int32Array(N_MAX);
    this.segType = new Int8Array(N_MAX * MAX_SEG);
    this.segAx = new Float64Array(N_MAX * MAX_SEG);
    this.segAy = new Float64Array(N_MAX * MAX_SEG);
    this.segAz = new Float64Array(N_MAX * MAX_SEG);
    this.segAng = new Float64Array(N_MAX * MAX_SEG);   // rad, signed
    this.segT = new Int32Array(N_MAX * MAX_SEG);       // full duration in steps
    this.segStart = new Int32Array(N_MAX * MAX_SEG);
    this.segLen = new Int32Array(N_MAX * MAX_SEG);     // steps inside this chunk
    this.best = 0;
    this.lastN = 0;
  }

  // Sample chunk i from the play prior, starting at orientation q0.
  Planner.prototype.sampleChunk = function (i, q0) {
    var rng = this.rng, P = this.P, pr = PRIOR;
    var o = i * H * 4, sb = i * MAX_SEG, ns = 0;
    var cYaw = pr.wYaw, cEdge = cYaw + pr.wEdge, cCorner = cEdge + pr.wCorner, cFine = cCorner + pr.wFine;
    var settleCos = Math.cos(0.5 * pr.settleDeg * D2R);   // compared with cos(half angle)
    var pw = 1, px = 0, py = 0, pz = 0;
    var k = 0;
    while (k < H) {
      // orientation at the start of this segment, as commanded: (pw, px, py, pz) * q0
      var qw = pw * q0[0] - px * q0[1] - py * q0[2] - pz * q0[3];
      var qx = pw * q0[1] + px * q0[0] + py * q0[3] - pz * q0[2];
      var qy = pw * q0[2] - px * q0[3] + py * q0[0] + pz * q0[1];
      var qz = pw * q0[3] + px * q0[2] - py * q0[1] + pz * q0[0];
      // body axes in the hand frame (columns of the rotation matrix)
      var c0x = 1 - 2 * (qy * qy + qz * qz), c0y = 2 * (qx * qy + qw * qz), c0z = 2 * (qx * qz - qw * qy);
      var c1x = 2 * (qx * qy - qw * qz), c1y = 1 - 2 * (qx * qx + qz * qz), c1z = 2 * (qy * qz + qw * qx);
      var c2x = 2 * (qx * qz + qw * qy), c2y = 2 * (qy * qz - qw * qx), c2z = 1 - 2 * (qx * qx + qy * qy);
      // nearest aligned grasp
      var bestDot = -1, gi = 0;
      for (var m = 0; m < 24; m++) {
        var G = GRID[m];
        var gd = G[0] * qw + G[1] * qx + G[2] * qy + G[3] * qz;
        if (gd < 0) gd = -gd;
        if (gd > bestDot) { bestDot = gd; gi = m; }
      }
      var type, ax = 0, ay = 0, az = 1, ang = 0, v = 1, T;
      if (bestDot < settleCos && rng() < pr.pSettle) {
        // settle: the hand-frame rotation G * q^-1 carries the cube into the grasp
        type = SEG_SETTLE;
        var Gs = GRID[gi];
        var dw = Gs[0] * qw + Gs[1] * qx + Gs[2] * qy + Gs[3] * qz;
        var dx = -Gs[0] * qx + Gs[1] * qw - Gs[2] * qz + Gs[3] * qy;
        var dy = -Gs[0] * qy + Gs[1] * qz + Gs[2] * qw - Gs[3] * qx;
        var dz = -Gs[0] * qz - Gs[1] * qy + Gs[2] * qx + Gs[3] * qw;
        if (dw < 0) { dw = -dw; dx = -dx; dy = -dy; dz = -dz; }
        var sl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
        ax = dx / sl; ay = dy / sl; az = dz / sl;
        ang = 2 * Math.atan2(sl, dw) * R2D;
        v = uni(pr.speedDeg, rng);
      } else {
        var r = rng();
        if (r < cYaw) {                                  // yaw about the palm normal, either way
          type = SEG_YAW;
          ang = uni(pr.yawDeg, rng) * (rng() < 0.5 ? -1 : 1);
          v = uni(pr.speedDeg, rng);
        } else if (r < cEdge) {                          // edge flip, one way only
          type = SEG_EDGE;
          var useX = rng() < 0.5;                        // body axis closest to the fingers or thumb
          var e0 = useX ? c0x : c0y, e1 = useX ? c1x : c1y, e2 = useX ? c2x : c2y;
          var a0 = Math.abs(e0), a1 = Math.abs(e1), a2 = Math.abs(e2);
          var pick = a0 >= a1 && a0 >= a2 ? 0 : (a1 >= a2 ? 1 : 2);
          var sg = (pick === 0 ? e0 : pick === 1 ? e1 : e2) < 0 ? -1 : 1;
          ax = sg * (pick === 0 ? c0x : pick === 1 ? c1x : c2x);
          ay = sg * (pick === 0 ? c0y : pick === 1 ? c1y : c2y);
          az = sg * (pick === 0 ? c0z : pick === 1 ? c1z : c2z);
          ang = uni(pr.edgeDeg, rng);
          v = uni(pr.speedDeg, rng);
        } else if (r < cCorner) {                        // corner flip about one diagonal, one way
          type = SEG_CORNER;
          var t0 = c0x + c0y + c0z < 0 ? -1 : 1;
          var t1 = c1x + c1y + c1z < 0 ? -1 : 1;
          var t2 = c2x + c2y + c2z < 0 ? -1 : 1;
          ax = (t0 * c0x + t1 * c1x + t2 * c2x) * INV_SQRT3;
          ay = (t0 * c0y + t1 * c1y + t2 * c2y) * INV_SQRT3;
          az = (t0 * c0z + t1 * c1z + t2 * c2z) * INV_SQRT3;
          ang = uni(pr.cornerDeg, rng);
          v = uni(pr.speedDeg, rng);
        } else if (r < cFine) {                          // small correction about any axis
          type = SEG_FINE;
          var zz = 2 * rng() - 1, ph = 2 * Math.PI * rng(), rr = Math.sqrt(1 - zz * zz);
          ax = rr * Math.cos(ph); ay = rr * Math.sin(ph); az = zz;
          ang = uni(pr.fineDeg, rng) * (rng() < 0.5 ? -1 : 1);
          v = uni(pr.fineSpeedDeg, rng);
        } else {                                         // regrasp: fingers move, the cube does not
          type = SEG_REGRASP;
        }
      }
      T = type === SEG_REGRASP ? Math.round(uni(pr.regraspS, rng) / DT) : Math.round(Math.abs(ang) / v / DT);
      if (T < 3) T = 3;
      var len = T < H - k ? T : H - k;
      var a = ang * D2R;
      if (ns < MAX_SEG) {
        var si = sb + ns;
        this.segType[si] = type;
        this.segAx[si] = ax; this.segAy[si] = ay; this.segAz[si] = az;
        this.segAng[si] = a;
        this.segT[si] = T;
        this.segStart[si] = k;
        this.segLen[si] = len;
        ns++;
      }
      for (var j = 1; j <= len; j++) {
        if (type === SEG_REGRASP) {
          P[o] = pw; P[o + 1] = px; P[o + 2] = py; P[o + 3] = pz;
        } else {
          var u = j / T;
          var half = 0.5 * a * u * u * (3 - 2 * u);     // smoothstep velocity envelope
          var c = Math.cos(half), s = Math.sin(half);
          var rx = ax * s, ry = ay * s, rz = az * s;
          P[o] = c * pw - rx * px - ry * py - rz * pz;
          P[o + 1] = c * px + rx * pw + ry * pz - rz * py;
          P[o + 2] = c * py - rx * pz + ry * pw + rz * px;
          P[o + 3] = c * pz + rx * py - ry * px + rz * pw;
        }
        o += 4;
      }
      pw = P[o - 4]; px = P[o - 3]; py = P[o - 2]; pz = P[o - 1];
      var pn = 1 / Math.sqrt(pw * pw + px * px + py * py + pz * pz);
      pw *= pn; px *= pn; py *= pn; pz *= pn;
      k += len;
    }
    this.segCount[i] = ns;

    // this proposal's model error: a rotation about a random axis that grows over the horizon
    var bzz = 2 * rng() - 1, bph = 2 * Math.PI * rng(), brr = Math.sqrt(1 - bzz * bzz);
    var bx = brr * Math.cos(bph), by = brr * Math.sin(bph);
    var bang = MODEL.biasDeg * D2R * gaussAbs(rng);
    var hb = 0.5 * bang / K, sb2 = Math.sin(hb);
    this.biasAxis[i * 3] = bx; this.biasAxis[i * 3 + 1] = by; this.biasAxis[i * 3 + 2] = bzz;
    this.biasAng[i] = bang;
    this.bias[i * 4] = Math.cos(hb);
    this.bias[i * 4 + 1] = bx * sb2;
    this.bias[i * 4 + 2] = by * sb2;
    this.bias[i * 4 + 3] = bzz * sb2;
  };

  // Sample n chunks, score each by its closest predicted approach to the goal, return the best index.
  Planner.prototype.plan = function (q0, g, n) {
    var cw = q0[0], cx = -q0[1], cy = -q0[2], cz = -q0[3];
    var gw = g[0], gx = g[1], gy = g[2], gz = g[3];
    var hw = gw * cw - gx * cx - gy * cy - gz * cz;
    var hx = gw * cx + gx * cw + gy * cz - gz * cy;
    var hy = gw * cy - gx * cz + gy * cw + gz * cx;
    var hz = gw * cz + gx * cy - gy * cx + gz * cw;
    var h = this.h;
    h[0] = hw; h[1] = hx; h[2] = hy; h[3] = hz;
    var P = this.P, score = this.score, bias = this.bias, best = 0, bestScore = -1;
    for (var i = 0; i < n; i++) {
      this.sampleChunk(i, q0);
      var dw = bias[i * 4], dx = bias[i * 4 + 1], dy = bias[i * 4 + 2], dz = bias[i * 4 + 3];
      var Bw = 1, Bx = 0, By = 0, Bz = 0;
      var o = i * H * 4, m = 0;
      for (var k = 0; k < K; k++, o += 4) {
        var nw = dw * Bw - dx * Bx - dy * By - dz * Bz;
        var nx = dw * Bx + dx * Bw + dy * Bz - dz * By;
        var ny = dw * By - dx * Bz + dy * Bw + dz * Bx;
        var nz = dw * Bz + dx * By - dy * Bx + dz * Bw;
        Bw = nw; Bx = nx; By = ny; Bz = nz;
        var Pw = P[o], Px = P[o + 1], Py = P[o + 2], Pz = P[o + 3];
        var Mw = Bw * Pw - Bx * Px - By * Py - Bz * Pz;
        var Mx = Bw * Px + Bx * Pw + By * Pz - Bz * Py;
        var My = Bw * Py - Bx * Pz + By * Pw + Bz * Px;
        var Mz = Bw * Pz + Bx * Py - By * Px + Bz * Pw;
        var d = Mw * hw + Mx * hx + My * hy + Mz * hz;
        if (d < 0) d = -d;
        if (d > m) m = d;
      }
      score[i] = m;
      if (m > bestScore) { bestScore = m; best = i; }
    }
    this.best = best;
    this.lastN = n;
    return best;
  };

  // Predicted distance (deg) after each of the K steps of chunk i, from the last plan() call.
  Planner.prototype.curve = function (i, out, offset) {
    var P = this.P, h = this.h, bias = this.bias, o = i * H * 4;
    var dw = bias[i * 4], dx = bias[i * 4 + 1], dy = bias[i * 4 + 2], dz = bias[i * 4 + 3];
    var Bw = 1, Bx = 0, By = 0, Bz = 0;
    for (var k = 0; k < K; k++, o += 4) {
      var nw = dw * Bw - dx * Bx - dy * By - dz * Bz;
      var nx = dw * Bx + dx * Bw + dy * Bz - dz * By;
      var ny = dw * By - dx * Bz + dy * Bw + dz * Bx;
      var nz = dw * Bz + dx * By - dy * Bx + dz * Bw;
      Bw = nw; Bx = nx; By = ny; Bz = nz;
      var Pw = P[o], Px = P[o + 1], Py = P[o + 2], Pz = P[o + 3];
      var Mw = Bw * Pw - Bx * Px - By * Py - Bz * Pz;
      var Mx = Bw * Px + Bx * Pw + By * Pz - Bz * Py;
      var My = Bw * Py - Bx * Pz + By * Pw + Bz * Px;
      var Mz = Bw * Pz + Bx * Py - By * Px + Bz * Pw;
      var d = Mw * h[0] + Mx * h[1] + My * h[2] + Mz * h[3];
      if (d < 0) d = -d;
      if (d > 1) d = 1;
      out[offset + k] = 2 * Math.acos(d) * R2D;
    }
  };

  // The model's predicted orientation after all K steps of chunk i, starting from q0.
  Planner.prototype.predictEnd = function (i, q0, out) {
    var o = (i * H + K - 1) * 4, P = this.P;
    var hb = 0.5 * this.biasAng[i], s = Math.sin(hb);
    out.set(q0);
    mulInto(P[o], P[o + 1], P[o + 2], P[o + 3], out, out);
    mulInto(Math.cos(hb), this.biasAxis[i * 3] * s, this.biasAxis[i * 3 + 1] * s, this.biasAxis[i * 3 + 2] * s, out, out);
    return out;
  };

  /* ------------------------------------------------------------------ the hidden "real" cube */

  // How the picked chunk actually plays out: each segment slips, and flips can fail.
  function ExecPlan() {
    this.n = 0;
    this.type = new Int8Array(MAX_SEG);
    this.ax = new Float64Array(MAX_SEG);
    this.ay = new Float64Array(MAX_SEG);
    this.az = new Float64Array(MAX_SEG);
    this.ang = new Float64Array(MAX_SEG);
    this.T = new Int32Array(MAX_SEG);
    this.start = new Int32Array(MAX_SEG);
    this.len = new Int32Array(MAX_SEG);
    this.scale = new Float64Array(MAX_SEG);
    this.fail = new Uint8Array(MAX_SEG);
    this.peak = new Float64Array(MAX_SEG);
    this.dax = 0; this.day = 0; this.daz = 0;
    this.drate = 0;           // drift per step (rad)
    this.seg = 0;
  }

  ExecPlan.prototype.load = function (pl, i, rng) {
    var sb = i * MAX_SEG, n = pl.segCount[i];
    this.n = n;
    for (var s = 0; s < n; s++) {
      var t = pl.segType[sb + s];
      this.type[s] = t;
      this.ax[s] = pl.segAx[sb + s]; this.ay[s] = pl.segAy[sb + s]; this.az[s] = pl.segAz[sb + s];
      this.ang[s] = pl.segAng[sb + s];
      this.T[s] = pl.segT[sb + s];
      this.start[s] = pl.segStart[sb + s];
      this.len[s] = pl.segLen[sb + s];
      this.fail[s] = 0;
      this.peak[s] = 0;
      if (t === SEG_YAW) {
        this.scale[s] = uni(REAL.yawScale, rng);
      } else if (t === SEG_EDGE || t === SEG_CORNER) {
        if (rng() < REAL.flipSuccess) {
          this.scale[s] = uni(REAL.flipScale, rng);
        } else {
          this.fail[s] = 1;
          this.peak[s] = uni(REAL.failPeak, rng);
          this.scale[s] = 0;
        }
      } else if (t === SEG_FINE) {
        this.scale[s] = uni(REAL.fineScale, rng);
      } else if (t === SEG_SETTLE) {
        this.scale[s] = uni(REAL.settleScale, rng);
      } else {
        this.scale[s] = 0;
      }
    }
    var zz = 2 * rng() - 1, ph = 2 * Math.PI * rng(), rr = Math.sqrt(1 - zz * zz);
    this.dax = rr * Math.cos(ph); this.day = rr * Math.sin(ph); this.daz = zz;
    this.drate = uni(REAL.driftDegPerS, rng) * D2R * DT;
    this.seg = 0;
  };

  // cumulative real angle of segment s after jj of its steps
  function phiAt(p, s, jj) {
    if (jj <= 0) return 0;
    var u = jj / p.T[s];
    if (u > 1) u = 1;
    if (p.type[s] === SEG_REGRASP) return 0;
    if (p.fail[s]) return p.ang[s] * p.peak[s] * Math.sin(Math.PI * u);
    return p.ang[s] * p.scale[s] * u * u * (3 - 2 * u);
  }

  // Apply step j (0-based within the chunk) of the real motion to q.
  ExecPlan.prototype.step = function (j, q, rng) {
    while (this.seg < this.n - 1 && j >= this.start[this.seg] + this.len[this.seg]) this.seg++;
    var s = this.seg, jj = j - this.start[s] + 1;
    if (this.n > 0) {
      var d = phiAt(this, s, jj) - phiAt(this, s, jj - 1);
      if (d !== 0) {
        var h = 0.5 * d, sn = Math.sin(h);
        mulInto(Math.cos(h), this.ax[s] * sn, this.ay[s] * sn, this.az[s] * sn, q, q);
      }
    }
    if (this.drate > 0) {
      var hd = 0.5 * this.drate, sd = Math.sin(hd);
      mulInto(Math.cos(hd), this.dax * sd, this.day * sd, this.daz * sd, q, q);
    }
    if (REAL.wobbleDeg > 0) {
      var nz = 2 * rng() - 1, nph = 2 * Math.PI * rng(), nr = Math.sqrt(1 - nz * nz);
      var nh = 0.5 * REAL.wobbleDeg * D2R * (rng() + rng() + rng() - 1.5) * 2;
      var ns = Math.sin(nh);
      mulInto(Math.cos(nh), nr * Math.cos(nph) * ns, nr * Math.sin(nph) * ns, nz * ns, q, q);
    }
  };

  /* ------------------------------------------------------------------ trial */

  function Trial(planner, noiseSeed) {
    this.planner = planner;
    this.q = new Float64Array([1, 0, 0, 0]);
    this.q0 = new Float64Array(4);
    this.g = new Float64Array([1, 0, 0, 0]);
    this.start = new Float64Array([1, 0, 0, 0]);
    this.exec = new ExecPlan();
    this.noise = mulberry32(noiseSeed == null ? randomSeed() : noiseSeed);
    this.stepInChunk = E;
    this.t = 0;                         // steps since the trial started
    this.err = 0;                       // rad
    this.minErr = 0;                    // rad
    this.first = [-1, -1, -1];          // first step within each threshold, -1 if not yet
    this.history = new Float32Array(MAX_HIST);
    this.histLen = 0;
    this.fan = new Float32Array(FAN_MAX * K);
    this.fanCount = 0;
    this.sel = new Float32Array(K);
    this.fanT = 0;                      // step at which the shown plan was made
    this.fanErr = 0;                    // deg at that step
    this.hasFan = false;
  }

  Trial.prototype.reset = function (start, goal, noiseSeed) {
    this.start.set(start);
    this.q.set(start);
    this.g.set(goal);
    if (noiseSeed != null) this.noise = mulberry32(noiseSeed);
    this.t = 0;
    this.stepInChunk = E;
    this.first[0] = this.first[1] = this.first[2] = -1;
    this.err = quatDist(this.q, this.g);
    this.minErr = this.err;
    this.histLen = 0;
    this.history[this.histLen++] = this.err * R2D;
    this.hasFan = false;
    this.fanCount = 0;
  };

  Trial.prototype.replan = function (n, recordFan) {
    var pl = this.planner;
    this.q0.set(this.q);
    var b = pl.plan(this.q0, this.g, n);
    this.exec.load(pl, b, this.noise);
    this.stepInChunk = 0;
    if (recordFan) {
      var count = 0;
      for (var i = 0; i < n && count < FAN_MAX; i++) {
        if (i === b) continue;
        pl.curve(i, this.fan, count * K);
        count++;
      }
      pl.curve(b, this.sel, 0);
      this.fanCount = count;
      this.fanT = this.t;
      this.fanErr = this.err * R2D;
      this.hasFan = true;
    }
  };

  Trial.prototype.step = function (n, recordFan) {
    if (this.stepInChunk >= E) this.replan(n, recordFan);
    this.exec.step(this.stepInChunk, this.q, this.noise);
    this.stepInChunk++;
    this.t++;
    var err = quatDist(this.q, this.g);
    this.err = err;
    if (err < this.minErr) this.minErr = err;
    if (this.histLen < MAX_HIST) this.history[this.histLen++] = err * R2D;
    for (var i = 0; i < 3; i++) {
      if (this.first[i] < 0 && err <= THRESH[i]) this.first[i] = this.t;
    }
  };

  // One headless trial: random start, goal more than 90 deg away, run until within 0.4 rad or 120 s.
  function runTrial(trial, n, rng, tmpA, tmpB) {
    randomQuat(rng, tmpA);
    sampleGoal(rng, tmpA, tmpB);
    trial.reset(tmpA, tmpB, (rng() * 4294967296) >>> 0);
    while (trial.t < BUDGET_STEPS && trial.first[0] < 0) trial.step(n, false);
    return [trial.first[0], trial.first[1], trial.first[2]];
  }

  // Success rates for n proposals over `trials` seeded trials (used by the node test).
  function runMany(n, trials, seed) {
    var trial = new Trial(new Planner(seed + 7919), seed + 31);
    var rng = mulberry32(seed);
    var a = new Float64Array(4), b = new Float64Array(4);
    var hits = [0, 0, 0], times = [];
    for (var t = 0; t < trials; t++) {
      var f = runTrial(trial, n, rng, a, b);
      for (var i = 0; i < 3; i++) if (f[i] >= 0) hits[i]++;
      if (f[0] >= 0) times.push(f[0] * DT);
    }
    times.sort(function (x, y) { return x - y; });
    return {
      n: n,
      trials: trials,
      sr: hits.map(function (h) { return h / trials; }),
      medianTime04: times.length ? times[Math.floor(times.length / 2)] : null,
      times: times
    };
  }

  // The stand-in model's 50-step error, measured like the paper's: from states visited during play,
  // compare the predicted orientation 50 steps ahead with where the hidden cube ends up. Also returns
  // the persistence baseline (predict no motion).
  function modelError(samples, seed) {
    var tr = new Trial(new Planner(seed), seed + 5);
    var probe = new Planner(seed + 3);
    var rng = mulberry32(seed + 11);
    var a = new Float64Array(4), b = new Float64Array(4), q = new Float64Array(4), pred = new Float64Array(4);
    var ex = new ExecPlan(), sum = 0, sumP = 0;
    randomQuat(rng, a);
    sampleGoal(rng, a, b);
    tr.reset(a, b, seed + 7);
    for (var c = 0; c < samples; c++) {
      for (var s = 0; s < E; s++) tr.step(1, false);     // play on, to visit realistic states
      probe.plan(tr.q, tr.q, 1);
      probe.predictEnd(0, tr.q, pred);
      q.set(tr.q);
      ex.load(probe, 0, rng);
      for (var j = 0; j < K; j++) ex.step(j, q, rng);
      sum += quatDist(pred, q);
      sumP += quatDist(tr.q, q);
    }
    return { err50: sum / samples * R2D, persistence: sumP / samples * R2D };
  }

  // Mean commanded angular speed (deg/s) of the play prior.
  function priorSpeed(samples, seed) {
    var pl = new Planner(seed || 1);
    var rng = mulberry32((seed || 1) + 17), q0 = new Float64Array(4);
    var sum = 0;
    for (var s = 0; s < samples; s++) {
      randomQuat(rng, q0);
      pl.sampleChunk(0, q0);
      var P = pl.P, prev = [1, 0, 0, 0], cur = [0, 0, 0, 0];
      for (var k = 0; k < H; k++) {
        cur[0] = P[k * 4]; cur[1] = P[k * 4 + 1]; cur[2] = P[k * 4 + 2]; cur[3] = P[k * 4 + 3];
        sum += quatDist(prev, cur);
        prev[0] = cur[0]; prev[1] = cur[1]; prev[2] = cur[2]; prev[3] = cur[3];
      }
    }
    return sum * R2D / (samples * H * DT);
  }

  /* ------------------------------------------------------------------ rendering helpers */

  // Cube corners (body frame) and faces: corner indices, body normal, color index.
  var CUBE_V = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  var CUBE_F = [
    [1, 2, 6, 5, 1, 0, 0, 0],
    [0, 4, 7, 3, -1, 0, 0, 1],
    [3, 7, 6, 2, 0, 1, 0, 2],
    [0, 1, 5, 4, 0, -1, 0, 3],
    [4, 5, 6, 7, 0, 0, 1, 4],
    [0, 3, 2, 1, 0, 0, -1, 5]
  ];
  // red, orange, green, blue, white, yellow: the colors of the cubes in the robot's HUD
  var FACE_RGB = [[200, 46, 44], [236, 120, 32], [46, 150, 72], [42, 92, 190], [228, 229, 224], [242, 192, 40]];
  var EDGE = 'rgba(22, 24, 26, 0.7)';

  function norm3(v) {
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  // Fixed oblique view like the cubes in the robot's HUD: about 25 deg down and 35 deg around the
  // palm normal, orthographic, so two or three faces show for almost every orientation.
  var CAM = (function () {
    var el = 25 * D2R, az = 35 * D2R;
    var c = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
    var f = [-c[0], -c[1], -c[2]];
    var r = norm3(cross3(f, [0, 0, 1]));
    var u = cross3(r, f);
    return { c: c, r: r, u: u };
  })();
  var LIGHT = norm3([0.35, -0.8, 1.15]);

  // Largest |face normal . view direction|; near 1 means one face points straight at the camera.
  function faceOn(q) {
    var w = q[0], x = q[1], y = q[2], z = q[3], c = CAM.c;
    var a = Math.abs((1 - 2 * (y * y + z * z)) * c[0] + 2 * (x * y + w * z) * c[1] + 2 * (x * z - w * y) * c[2]);
    var b = Math.abs(2 * (x * y - w * z) * c[0] + (1 - 2 * (x * x + z * z)) * c[1] + 2 * (y * z + w * x) * c[2]);
    var d = Math.abs(2 * (x * z + w * y) * c[0] + 2 * (y * z - w * x) * c[1] + (1 - 2 * (x * x + y * y)) * c[2]);
    return Math.max(a, b, d);
  }

  function rotateGoalByDrag(q, dx, dy) {
    var drag = Math.sqrt(dx * dx + dy * dy);
    if (drag < 1e-6) return q;
    var ax = dy * CAM.r[0] + dx * CAM.u[0];
    var ay = dy * CAM.r[1] + dx * CAM.u[1];
    var az = dy * CAM.r[2] + dx * CAM.u[2];
    var n = Math.sqrt(ax * ax + ay * ay + az * az);
    var h = 0.5 * Math.min(drag, 80) * 0.012;
    var s = Math.sin(h) / n;
    return mulInto(Math.cos(h), ax * s, ay * s, az * s, q, q);
  }

  var _sx = new Float64Array(8), _sy = new Float64Array(8);

  function drawCube(ctx, q, cx, cy, s) {
    var w = q[0], x = q[1], y = q[2], z = q[3];
    var m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - w * z), m02 = 2 * (x * z + w * y);
    var m10 = 2 * (x * y + w * z), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - w * x);
    var m20 = 2 * (x * z - w * y), m21 = 2 * (y * z + w * x), m22 = 1 - 2 * (x * x + y * y);
    var c = CAM.c, r = CAM.r, u = CAM.u;
    var i, f;
    for (i = 0; i < 8; i++) {
      var bx = CUBE_V[i * 3], by = CUBE_V[i * 3 + 1], bz = CUBE_V[i * 3 + 2];
      var px = m00 * bx + m01 * by + m02 * bz;
      var py = m10 * bx + m11 * by + m12 * bz;
      var pz = m20 * bx + m21 * by + m22 * bz;
      _sx[i] = cx + s * (px * r[0] + py * r[1] + pz * r[2]);
      _sy[i] = cy - s * (px * u[0] + py * u[1] + pz * u[2]);
    }
    var vis = [];
    for (f = 0; f < 6; f++) {
      var F = CUBE_F[f];
      var nx = m00 * F[4] + m01 * F[5] + m02 * F[6];
      var ny = m10 * F[4] + m11 * F[5] + m12 * F[6];
      var nz = m20 * F[4] + m21 * F[5] + m22 * F[6];
      if (nx * c[0] + ny * c[1] + nz * c[2] > 1e-4) vis.push(f, nx, ny, nz);
    }
    // flat-shaded faces
    for (i = 0; i < vis.length; i += 4) {
      var Ff = CUBE_F[vis[i]];
      var lam = vis[i + 1] * LIGHT[0] + vis[i + 2] * LIGHT[1] + vis[i + 3] * LIGHT[2];
      var shade = 0.72 + 0.28 * (lam > 0 ? lam : 0);
      var rgb = FACE_RGB[Ff[7]];
      ctx.fillStyle = 'rgb(' + Math.round(rgb[0] * shade) + ',' + Math.round(rgb[1] * shade) + ',' +
        Math.round(rgb[2] * shade) + ')';
      ctx.beginPath();
      ctx.moveTo(_sx[Ff[0]], _sy[Ff[0]]);
      ctx.lineTo(_sx[Ff[1]], _sy[Ff[1]]);
      ctx.lineTo(_sx[Ff[2]], _sy[Ff[2]]);
      ctx.lineTo(_sx[Ff[3]], _sy[Ff[3]]);
      ctx.closePath();
      ctx.fill();
    }
    // thin edges in one stroke, so shared edges are no darker than the outline
    ctx.beginPath();
    for (i = 0; i < vis.length; i += 4) {
      var Fe = CUBE_F[vis[i]];
      ctx.moveTo(_sx[Fe[0]], _sy[Fe[0]]);
      ctx.lineTo(_sx[Fe[1]], _sy[Fe[1]]);
      ctx.lineTo(_sx[Fe[2]], _sy[Fe[2]]);
      ctx.lineTo(_sx[Fe[3]], _sy[Fe[3]]);
      ctx.closePath();
    }
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(x) {
    return Math.round(x * 100) + '%';
  }
  // A readable tick spacing for an axis spanning `span` seconds with room for about `maxTicks` labels.
  function tickStep(span, maxTicks) {
    var steps = [0.5, 1, 2, 5, 10, 20, 30, 60];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= maxTicks) return steps[i];
    return 60;
  }

  /* ------------------------------------------------------------------ UI */

  var instanceCount = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function Toy(root, opts) {
    opts = opts || {};
    this.root = root;
    this.id = 'ptoy' + (++instanceCount);
    var dataN = parseInt(root.getAttribute('data-proposals'), 10);
    var dataSpeed = parseFloat(root.getAttribute('data-speed'));
    this.n = opts.proposals || (PROPOSAL_OPTIONS.indexOf(dataN) >= 0 ? dataN : 1024);
    this.speed = opts.speed || (SPEED_OPTIONS.indexOf(dataSpeed) >= 0 ? dataSpeed : 2);
    var seed = opts.seed == null ? randomSeed() : opts.seed;
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.planner = new Planner(seed);
    this.trial = new Trial(this.planner);
    this.cmpOn = false;       // "Compare with play only"
    this.cmp = null;          // the play-only trial, created on first use
    this.trialSeed = 0;       // hidden-cube seed shared by both trials
    this.tmpA = new Float64Array(4);
    this.tmpB = new Float64Array(4);
    this.goalPreview = new Float64Array(4);
    this.goalHit = null;
    this.goalDragging = false;
    this.goalHot = false;
    this.goalMoved = false;
    this.goalPointerId = null;
    this.goalLastX = 0;
    this.goalLastY = 0;
    this.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.userPaused = this.reduced;
    this.visible = false;
    this.pageVisible = !document.hidden;
    this.raf = 0;
    this.lastTs = 0;
    this.acc = 0;
    this.ended = false;       // the trial is over and stays on screen for END_HOLD_MS
    this.holdLeft = 0;        // ms before the next goal
    this.fanHold = 0;         // ms left showing a fresh set of proposals before they run (1x only)
    this.xmax = 4;            // end of the time axis (s); eases toward axisTarget()
    this.narrow = false;
    this.results = {};        // n -> { trials, hits: [3], times: [] }
    this.batch = null;
    this.colors = null;
    this._tick = this.tick.bind(this);
    this.build();
    this.bindGoalInput();
    this.readColors();
    this.newGoal(true);
    this.observe();
    this.resize();
  }

  Toy.prototype.build = function () {
    var self = this, root = this.root;
    root.classList.add('ptoy');
    root.setAttribute('data-ptoy-mounted', '');
    root.textContent = '';

    var stage = el('div', 'ptoy__stage');
    var view = el('div', 'ptoy__view');
    this.cubeCanvas = el('canvas', 'ptoy__cube');
    this.cubeCanvas.setAttribute('role', 'img');
    this.cubeCanvas.setAttribute('aria-label', 'Current and goal cube orientations; drag the goal cube or use the arrow keys to rotate it');
    this.cubeCanvas.setAttribute('title', 'Drag the goal cube to rotate it');
    this.cubeCanvas.tabIndex = 0;
    view.appendChild(this.cubeCanvas);

    var plotWrap = el('div', 'ptoy__plotwrap');
    this.plotCanvas = el('canvas', 'ptoy__plot');
    this.plotCanvas.setAttribute('role', 'img');
    this.plotCanvas.setAttribute('aria-label',
      'Error to the goal over simulated time, with the predicted error of the sampled chunks');
    plotWrap.appendChild(this.plotCanvas);
    // compact legend, shown only when the plot is too narrow for labels at the line ends
    var legend = el('ul', 'ptoy__legend');
    function key(cls, text) {
      var li = el('li');
      var k = el('span', 'ptoy__key ' + cls);
      k.setAttribute('aria-hidden', 'true');
      li.appendChild(k);
      var t = el('span', null, text);
      li.appendChild(t);
      legend.appendChild(li);
      return { li: li, key: k, text: t };
    }
    this.legSoFar = key('ptoy__key--err', 'so far');
    this.legCmp = key('ptoy__key--cmp', 'play only');
    this.legCmp.li.hidden = true;
    key('ptoy__key--sel', 'picked chunk');
    key('ptoy__key--prop', 'proposals');
    plotWrap.appendChild(legend);
    stage.appendChild(view);
    stage.appendChild(plotWrap);
    root.appendChild(stage);

    var controls = el('div', 'ptoy__controls');

    function segmented(labelText, options, current, fmt, onPick) {
      var field = el('div', 'ptoy__field');
      var lab = el('span', 'ptoy__label', labelText);
      lab.id = self.id + '-' + labelText.replace(/\W+/g, '-').toLowerCase();
      var seg = el('div', 'ptoy__seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-labelledby', lab.id);
      var buttons = options.map(function (v) {
        var b = el('button', null, fmt(v));
        b.type = 'button';
        b.setAttribute('aria-pressed', v === current ? 'true' : 'false');
        b.addEventListener('click', function () {
          buttons.forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
          onPick(v);
        });
        seg.appendChild(b);
        return b;
      });
      field.appendChild(lab);
      field.appendChild(seg);
      controls.appendChild(field);
      return buttons;
    }

    this.nButtons = segmented('Proposals per replan', PROPOSAL_OPTIONS, this.n,
      function (v) { return v === 1 ? '1 (play only)' : fmtInt(v); },
      function (v) { self.setProposals(v); });
    segmented('Speed', SPEED_OPTIONS, this.speed,
      function (v) { return v + '×'; },
      function (v) { self.speed = v; if (v !== 1) self.fanHold = 0; });

    var actions = el('div', 'ptoy__actions');
    function button(text, onClick) {
      var b = el('button', null, text);
      b.type = 'button';
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    }
    this.btnGoal = button('New goal', function () { self.newGoal(true); self.render(); });
    this.btnPause = button(this.userPaused ? 'Play' : 'Pause', function () {
      self.userPaused = !self.userPaused;
      self.btnPause.textContent = self.userPaused ? 'Play' : 'Pause';
      self.updateLoop();
    });
    this.btnCmp = button('Compare with play only', function () { self.setCompare(!self.cmpOn); });
    this.btnCmp.setAttribute('aria-pressed', 'false');
    this.btnBatch = button('Run 20 trials', function () { self.runBatch(20); });
    controls.appendChild(actions);
    root.appendChild(controls);

    var readout = el('dl', 'ptoy__readout');
    function item(label) {
      var d = el('div');
      d.appendChild(el('dt', null, label));
      var dd = el('dd', null, '');
      d.appendChild(dd);
      readout.appendChild(d);
      return dd;
    }
    this.rTime = item('simulated time');
    this.rErr = item('error to goal');
    this.rCmp = item('play only');
    this.rCmp.parentNode.hidden = true;
    this.rTh = [item('within 0.4 rad'), item('within 0.6 rad'), item('within 0.8 rad')];
    root.appendChild(readout);

    this.status = el('p', 'ptoy__status');
    this.status.setAttribute('aria-live', 'polite');
    root.appendChild(this.status);

    this.resultsBox = el('div', 'ptoy__results');
    this.resultsBox.hidden = true;
    root.appendChild(this.resultsBox);

    root.appendChild(el('p', 'ptoy__note',
      'This browser toy replaces the learned policy and world model with hand-written motions and calibrated prediction error.'));
  };

  Toy.prototype.goalPoint = function (e) {
    var rect = this.cubeCanvas.getBoundingClientRect();
    var sx = rect.width ? (this.cubeCanvas._cssW || rect.width) / rect.width : 1;
    var sy = rect.height ? (this.cubeCanvas._cssH || rect.height) / rect.height : 1;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  };

  Toy.prototype.goalContains = function (x, y) {
    var h = this.goalHit;
    if (!h) return false;
    var dx = x - h.x, dy = y - h.y;
    return dx * dx + dy * dy <= h.r * h.r;
  };

  Toy.prototype.setGoalHot = function (hot) {
    hot = !!hot;
    if (hot === this.goalHot) return;
    this.goalHot = hot;
    this.cubeCanvas.classList.toggle('is-goal-hot', hot);
    if (this.colors) this.drawCubes();
  };

  Toy.prototype.commitGoal = function (goal) {
    this.tmpA.set(this.trial.q);
    this.tmpB.set(goal);
    this.trialSeed = (this.rng() * 4294967296) >>> 0;
    this.trial.reset(this.tmpA, this.tmpB, this.trialSeed);
    this.trial.replan(this.n, true);
    if (this.cmpOn) {
      this.cmp.reset(this.tmpA, this.tmpB, this.trialSeed);
      this.cmp.replan(1, false);
    }
    this.ended = false;
    this.holdLeft = 0;
    this.xmax = 4;
    this.fanHold = this.speed === 1 ? FAN_HOLD_MS : 0;
    this.acc = 0;
    this.setStatus('Goal updated, ' + Math.round(this.trial.err * R2D) + '° away.');
    this.render();
  };

  Toy.prototype.bindGoalInput = function () {
    var self = this, cv = this.cubeCanvas;
    this._goalDown = function (e) {
      if (e.button != null && e.button !== 0) return;
      var p = self.goalPoint(e);
      if (!self.goalContains(p[0], p[1])) return;
      e.preventDefault();
      self.goalPreview.set(self.trial.g);
      self.goalDragging = true;
      self.goalMoved = false;
      self.goalPointerId = e.pointerId;
      self.goalLastX = p[0];
      self.goalLastY = p[1];
      self.goalHot = true;
      cv.classList.add('is-goal-hot', 'is-goal-dragging');
      if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
      try { cv.focus({ preventScroll: true }); } catch (_) { cv.focus(); }
      self.updateLoop();
      self.drawCubes();
    };
    this._goalMove = function (e) {
      var p = self.goalPoint(e);
      if (!self.goalDragging) {
        if (e.pointerType !== 'touch') self.setGoalHot(self.goalContains(p[0], p[1]));
        return;
      }
      if (e.pointerId !== self.goalPointerId) return;
      var dx = p[0] - self.goalLastX, dy = p[1] - self.goalLastY;
      self.goalLastX = p[0];
      self.goalLastY = p[1];
      if (dx || dy) {
        rotateGoalByDrag(self.goalPreview, dx, dy);
        self.goalMoved = true;
        self.drawCubes();
      }
    };
    this._goalEnd = function (e) {
      if (!self.goalDragging || e.pointerId !== self.goalPointerId) return;
      var commit = e.type !== 'pointercancel' && self.goalMoved;
      var p = self.goalPoint(e);
      self.goalDragging = false;
      self.goalPointerId = null;
      cv.classList.remove('is-goal-dragging');
      self.setGoalHot(e.pointerType !== 'touch' && self.goalContains(p[0], p[1]));
      if (cv.releasePointerCapture && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) {
        cv.releasePointerCapture(e.pointerId);
      }
      if (commit) self.commitGoal(self.goalPreview);
      else self.drawCubes();
      self.updateLoop();
    };
    this._goalLeave = function () {
      if (!self.goalDragging) self.setGoalHot(false);
    };
    this._goalLost = function (e) {
      if (!self.goalDragging || e.pointerId !== self.goalPointerId) return;
      self.goalDragging = false;
      self.goalMoved = false;
      self.goalPointerId = null;
      cv.classList.remove('is-goal-dragging');
      self.setGoalHot(false);
      self.drawCubes();
      self.updateLoop();
    };
    this._goalFocus = function () { self.setGoalHot(true); };
    this._goalBlur = function () { self.setGoalHot(false); };
    this._goalKey = function (e) {
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -12;
      else if (e.key === 'ArrowRight') dx = 12;
      else if (e.key === 'ArrowUp') dy = -12;
      else if (e.key === 'ArrowDown') dy = 12;
      else return;
      e.preventDefault();
      self.goalPreview.set(self.trial.g);
      rotateGoalByDrag(self.goalPreview, dx, dy);
      self.commitGoal(self.goalPreview);
      self.updateLoop();
    };
    cv.addEventListener('pointerdown', this._goalDown);
    cv.addEventListener('pointermove', this._goalMove);
    cv.addEventListener('pointerup', this._goalEnd);
    cv.addEventListener('pointercancel', this._goalEnd);
    cv.addEventListener('pointerleave', this._goalLeave);
    cv.addEventListener('lostpointercapture', this._goalLost);
    cv.addEventListener('focus', this._goalFocus);
    cv.addEventListener('blur', this._goalBlur);
    cv.addEventListener('keydown', this._goalKey);
  };

  Toy.prototype.readColors = function () {
    var cs = window.getComputedStyle(this.root);
    function v(name, fallback) {
      var x = cs.getPropertyValue(name);
      return x && x.trim() ? x.trim() : fallback;
    }
    this.colors = {
      ink: v('--ptoy-ink', '#16181a'),
      secondary: v('--ptoy-secondary', '#50555b'),
      muted: v('--ptoy-muted', '#858b91'),
      hairline: v('--ptoy-hairline', '#e3e5e8'),
      thresh: v('--ptoy-thresh', '#b9bfc5'),
      accent: v('--ptoy-accent', '#0072b2'),
      proposal: v('--ptoy-proposal', '#e69f00'),
      play: v('--ptoy-play', '#9aa0a6'),
      page: v('--ptoy-page', '#ffffff')
    };
    this.fontSans = cs.fontFamily || 'sans-serif';
    this.fontMono = v('--ptoy-mono', '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace');
  };

  // Restart the current start and goal (both trials), e.g. after changing a setting.
  Toy.prototype.replay = function () {
    this.trial.reset(this.trial.start, this.trial.g, this.trialSeed);
    this.trial.replan(this.n, true);
    if (this.cmpOn) {
      this.cmp.reset(this.trial.start, this.trial.g, this.trialSeed);
      this.cmp.replan(1, false);
    }
    this.ended = false;
    this.xmax = 4;
    this.fanHold = this.speed === 1 ? FAN_HOLD_MS : 0;
    this.acc = 0;
  };

  Toy.prototype.setProposals = function (n) {
    this.n = n;
    if (this.nButtons) {
      for (var i = 0; i < this.nButtons.length; i++) {
        this.nButtons[i].setAttribute('aria-pressed', PROPOSAL_OPTIONS[i] === n ? 'true' : 'false');
      }
    }
    // replay the same start and goal so settings can be compared directly
    this.replay();
    this.setStatus('Same start and goal, now with ' + fmtInt(n) +
      (n === 1 ? ' proposal per replan (the play prior alone).' : ' proposals per replan.'));
    this.render();
  };

  Toy.prototype.setCompare = function (on) {
    this.cmpOn = !!on;
    this.btnCmp.setAttribute('aria-pressed', this.cmpOn ? 'true' : 'false');
    if (this.cmpOn && !this.cmp) this.cmp = new Trial(new Planner(randomSeed()));
    this.rCmp.parentNode.hidden = !this.cmpOn;
    this.legCmp.li.hidden = !this.cmpOn;
    this.legSoFar.text.textContent = this.cmpOn ? 'planner' : 'so far';
    this.legSoFar.key.className = 'ptoy__key ' + (this.cmpOn ? 'ptoy__key--plan' : 'ptoy__key--err');
    this.replay();
    this.setStatus(this.cmpOn ?
      'Same start, goal and slips: play only on the left, the planner on the right.' :
      'Same start and goal, planner only.');
    this.render();
  };

  Toy.prototype.newGoal = function (fromCurrent) {
    var start = this.tmpA, goal = this.tmpB, tries = 0;
    if (fromCurrent && this.trial.histLen > 0) {
      start.set(this.trial.q);
    } else {
      do { randomQuat(this.rng, start); } while (faceOn(start) > LEGIBLE && ++tries < 50);
    }
    // Goals follow the paper's protocol (more than 90 deg away). Ones that would show a single face
    // head-on are re-drawn so the goal cube stays readable; headless trials use every goal.
    tries = 0;
    do { sampleGoal(this.rng, start, goal); } while (faceOn(goal) > LEGIBLE && ++tries < 50);
    this.trialSeed = (this.rng() * 4294967296) >>> 0;
    this.trial.reset(start, goal, this.trialSeed);
    this.trial.replan(this.n, true);
    if (this.cmpOn) {
      this.cmp.reset(start, goal, this.trialSeed);
      this.cmp.replan(1, false);
    }
    this.ended = false;
    this.xmax = 4;
    this.fanHold = this.speed === 1 ? FAN_HOLD_MS : 0;
    this.acc = 0;
    this.setStatus('New goal, ' + Math.round(this.trial.err * R2D) + '° away.');
  };

  Toy.prototype.setStatus = function (text) {
    if (this.status) this.status.textContent = text;
  };

  Toy.prototype.observe = function () {
    var self = this;
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) self.visible = entries[i].isIntersecting;
        self.updateLoop();
      }, { threshold: 0.1 });
      this.io.observe(this.root);
    } else {
      this.visible = true;
    }
    this._onVis = function () {
      self.pageVisible = !document.hidden;
      self.updateLoop();
    };
    document.addEventListener('visibilitychange', this._onVis);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(function () { self.resize(); });
      this.ro.observe(this.cubeCanvas);
      this.ro.observe(this.plotCanvas);
    } else {
      this._onResize = function () { self.resize(); };
      window.addEventListener('resize', this._onResize);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { self.readColors(); self.render(); });
    }
    this.updateLoop();
  };

  Toy.prototype.updateLoop = function () {
    var run = !this.userPaused && this.visible && this.pageVisible && !this.goalDragging;
    if (run && !this.raf) {
      this.lastTs = 0;
      this.raf = window.requestAnimationFrame(this._tick);
    } else if (!run && this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  Toy.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var list = [this.cubeCanvas, this.plotCanvas];
    for (var i = 0; i < list.length; i++) {
      var cv = list[i];
      var w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) continue;
      var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) {
        cv.width = bw;
        cv.height = bh;
      }
      cv._cssW = w;
      cv._cssH = h;
      cv._dpr = dpr;
    }
    // labels at the line ends need room; narrow plots get the compact legend instead
    var narrow = !!this.plotCanvas._cssW && this.plotCanvas._cssW < 440;
    if (narrow !== this.narrow) {
      this.narrow = narrow;
      this.root.classList.toggle('ptoy--narrow', narrow);
    }
    this.render();
  };

  Toy.prototype.tick = function (ts) {
    if (!this.lastTs) this.lastTs = ts;
    var dtWall = Math.min(0.1, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    if (this.ended) {
      this.holdLeft -= dtWall * 1000;
      if (this.holdLeft <= 0) this.newGoal(true);
    } else if (this.fanHold > 0) {
      this.fanHold -= dtWall * 1000;
      this.acc = 0;
    } else {
      this.acc += dtWall * this.speed;
      var steps = 0;
      while (this.acc >= DT && steps < 16) {
        var held = this.advance();
        this.acc -= DT;
        steps++;
        if (held || this.ended) { this.acc = 0; break; }
      }
      if (steps >= 16) this.acc = 0;
      this.easeAxis(dtWall);
    }
    this.render();
    var run = !this.userPaused && this.visible && this.pageVisible && !this.goalDragging;
    this.raf = run ? window.requestAnimationFrame(this._tick) : 0;
  };

  // One control step for the planner (and the play-only cube when comparing). Returns true when a
  // fresh set of proposals is being shown before it runs.
  // A trial ends the moment the planner's error first drops below 0.4 rad, like the hardware clips,
  // or at 120 s.
  Toy.prototype.advance = function () {
    var tr = this.trial, cmp = this.cmpOn ? this.cmp : null;
    if (tr.stepInChunk >= E) {
      tr.replan(this.n, true);
      if (cmp) cmp.replan(1, false);
      if (this.speed === 1) {
        this.fanHold = FAN_HOLD_MS;
        return true;
      }
    }
    tr.step(this.n, true);
    if (cmp) cmp.step(1, false);
    var tail = cmp ? ' Play only came within ' + Math.round(cmp.minErr * R2D) + '° in that time.' : '';
    if (tr.first[0] >= 0) {
      this.endTrial('Reached 0.4 rad (22.9°) after ' + (tr.first[0] * DT).toFixed(1) + ' s.' + tail);
    } else if (tr.t >= BUDGET_STEPS || tr.histLen >= MAX_HIST) {
      this.endTrial('Not reached in ' + BUDGET_S + ' s.' + tail);
    }
    return false;
  };

  Toy.prototype.endTrial = function (msg) {
    this.ended = true;
    this.holdLeft = END_HOLD_MS;
    this.fanHold = 0;
    this.setStatus(msg);
  };

  // The time axis ends a little after now, and far enough out to show the latest plan.
  Toy.prototype.axisTarget = function () {
    var tr = this.trial, t = tr.t * DT + 1;
    if (tr.hasFan) t = Math.max(t, (tr.fanT + K) * DT);
    return Math.max(4, t);
  };

  Toy.prototype.easeAxis = function (dtWall) {
    var target = this.axisTarget();
    if (target > this.xmax) this.xmax += (target - this.xmax) * (1 - Math.exp(-6 * dtWall));
  };

  Toy.prototype.render = function () {
    this.drawCubes();
    this.drawPlot();
    this.updateReadout();
  };

  Toy.prototype.updateReadout = function () {
    var tr = this.trial;
    setText(this.rTime, (tr.t * DT).toFixed(1) + ' s');
    setText(this.rErr, Math.round(tr.err * R2D) + '°');
    if (this.cmpOn) setText(this.rCmp, Math.round(this.cmp.err * R2D) + '° to goal');
    for (var i = 0; i < 3; i++) {
      setText(this.rTh[i], tr.first[i] >= 0 ? (tr.first[i] * DT).toFixed(1) + ' s' : 'not yet');
    }
  };

  Toy.prototype.drawCubes = function () {
    var cv = this.cubeCanvas;
    if (!cv._cssW) return;
    var ctx = cv.getContext('2d'), W = cv._cssW, Hh = cv._cssH, col = this.colors;
    ctx.setTransform(cv._dpr, 0, 0, cv._dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    var self = this;
    function caption(x, y, name, err) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = col.secondary;
      ctx.font = '12px ' + self.fontSans;
      ctx.fillText(name, x, y);
      ctx.fillStyle = col.ink;
      ctx.font = '13px ' + self.fontMono;
      ctx.fillText(Math.round(err * R2D) + '° to goal', x, y + 17);
    }
    // Cube positions use the worst-case projected radius, sqrt(3) times the half-size, so no
    // orientation reaches the canvas edge or another cube.
    var R3 = 1.7321;
    var goal = this.goalDragging ? this.goalPreview : this.trial.g;
    function goalHandle(x, y, r) {
      if (!self.goalHot && !self.goalDragging) return;
      ctx.save();
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = self.goalDragging ? 2 : 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
    }
    if (!this.cmpOn) {
      var m = Math.min(W, Hh * 1.15);
      var big = m * 0.19, small = m * 0.075;
      var gx = W - 8 - R3 * small, gy = 8 + R3 * small;
      var cy = Hh * 0.45;
      var cx = Math.min(W * 0.4, gx - R3 * small - R3 * big - 6);
      drawCube(ctx, this.trial.q, cx, cy, big);
      drawCube(ctx, goal, gx, gy, small);
      this.goalHit = { x: gx, y: gy, r: Math.max(24, R3 * small + 8) };
      goalHandle(gx, gy, R3 * small + 6);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = col.secondary;
      ctx.font = '12px ' + this.fontSans;
      ctx.fillText('drag goal', gx, gy + R3 * small + 14);
      caption(cx, Math.min(Hh - 26, cy + big * 1.8 + 16), 'current', this.trial.err);
    } else {
      // goal on top, play only on the left, planner on the right; sized so that the goal, the two
      // cubes and their two-line captions always fit
      var s2 = Math.min((Hh - 50) / (3 * R3), (W * 0.24 - 4) / R3, W * 0.125);
      var gS = s2 * 0.5;
      var gyy = 8 + R3 * gS;
      var ly = gyy + R3 * gS + 6 + R3 * s2;
      drawCube(ctx, goal, W * 0.5, gyy, gS);
      this.goalHit = { x: W * 0.5, y: gyy, r: Math.max(24, R3 * gS + 8) };
      goalHandle(W * 0.5, gyy, R3 * gS + 6);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col.secondary;
      ctx.font = '12px ' + this.fontSans;
      ctx.fillText('drag goal', W * 0.5 + R3 * gS + 6, gyy);
      drawCube(ctx, this.cmp.q, W * 0.26, ly, s2);
      drawCube(ctx, this.trial.q, W * 0.74, ly, s2);
      var capY = Math.min(Hh - 22, ly + R3 * s2 + 13);
      caption(W * 0.26, capY, 'play only', this.cmp.err);
      caption(W * 0.74, capY, 'planner', this.trial.err);
    }
  };

  Toy.prototype.drawPlot = function () {
    var cv = this.plotCanvas;
    if (!cv._cssW) return;
    var ctx = cv.getContext('2d'), W = cv._cssW, Hh = cv._cssH, col = this.colors, tr = this.trial;
    var cmp = this.cmpOn ? this.cmp : null;
    ctx.setTransform(cv._dpr, 0, 0, cv._dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    var L = 40, R = this.narrow ? 58 : 100, T = 24, B = 40;
    var pw = W - L - R, ph = Hh - T - B;
    if (pw < 60 || ph < 60) return;
    var n = tr.histLen, tNow = (n - 1) * DT;
    var xmax = Math.max(this.xmax, tNow + 0.2);
    function X(s) { return L + pw * s / xmax; }
    function Y(deg) { return T + ph * (1 - deg / 180); }
    var i, k, y;
    var placed = [];          // label boxes already drawn, for collision checks

    // grid and y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = col.hairline;
    ctx.fillStyle = col.muted;
    ctx.font = '11px ' + this.fontMono;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var grid = [0, 60, 120, 180];
    for (i = 0; i < grid.length; i++) {
      y = Math.round(Y(grid[i])) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillText(grid[i] + '°', L - 6, y);
    }

    // threshold lines, labeled at the right edge
    var gap = ph * (34.4 - 22.9) / 180;
    var full = gap >= 12.5;
    ctx.strokeStyle = col.thresh;
    ctx.textAlign = 'left';
    ctx.font = (gap >= 11 ? 11 : 10) + 'px ' + this.fontMono;
    for (i = 0; i < 3; i++) {
      var deg = THRESH[i] * R2D;
      y = Math.round(Y(deg)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillStyle = col.secondary;
      var lab = full || i === 2 ? THRESH[i].toFixed(1) + ' rad' : THRESH[i].toFixed(1);
      ctx.fillText(lab, L + pw + 6, y);
      placed.push([L + pw + 4, y - 6, L + pw + 6 + ctx.measureText(lab).width + 2, y + 6]);
    }

    // x ticks
    var stepS = tickStep(xmax, Math.max(3, Math.floor(pw / 56)));
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '11px ' + this.fontMono;
    ctx.strokeStyle = col.thresh;
    for (var s = 0; s <= xmax + 1e-6; s += stepS) {
      var x = Math.round(X(s)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, T + ph); ctx.lineTo(x, T + ph + 4); ctx.stroke();
      var sr = Math.round(s * 10) / 10;
      ctx.fillText(sr % 1 === 0 ? String(sr) : sr.toFixed(1), x, T + ph + 7);
    }
    if (xmax >= BUDGET_S) {
      var xb = Math.round(X(BUDGET_S)) + 0.5;
      ctx.strokeStyle = col.thresh;
      ctx.beginPath(); ctx.moveTo(xb, T); ctx.lineTo(xb, T + ph); ctx.stroke();
      ctx.fillStyle = col.secondary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('120 s budget', xb - 4, T + 14);
    }
    // axis titles
    ctx.font = '12px ' + this.fontSans;
    ctx.fillStyle = col.secondary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('error to goal', L, 14);
    ctx.textAlign = 'right';
    ctx.fillText('simulated time (s)', L + pw, Hh - 4);

    function polyHistory(trial) {
      var m = trial.histLen, stride = Math.max(1, Math.floor(m / pw));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(trial.history[0]));
      for (var j = stride; j < m; j += stride) ctx.lineTo(X(j * DT), Y(trial.history[j]));
      ctx.lineTo(X((m - 1) * DT), Y(trial.history[m - 1]));
      ctx.stroke();
    }

    // data, clipped to the plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T - 2, pw, ph + 4);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (cmp) {
      ctx.strokeStyle = col.play;
      ctx.lineWidth = 2.25;
      polyHistory(cmp);
    }
    var showFan = tr.hasFan && !this.ended;
    var fanEnd = null, selEnd = null;
    if (showFan) {
      var x0 = X(tr.fanT * DT), y0 = Y(tr.fanErr);
      ctx.strokeStyle = col.proposal;
      ctx.globalAlpha = tr.fanCount > 24 ? 0.22 : 0.4;
      ctx.lineWidth = 1;
      var ends = [];
      for (i = 0; i < tr.fanCount; i++) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        for (k = 0; k < K; k++) ctx.lineTo(X((tr.fanT + k + 1) * DT), Y(tr.fan[i * K + k]));
        ctx.stroke();
        ends.push(tr.fan[i * K + K - 1]);
      }
      ctx.globalAlpha = 1;
      if (ends.length) {
        ends.sort(function (p, q) { return p - q; });
        fanEnd = ends[Math.floor(ends.length / 2)];
      }
      // picked chunk: what the model predicts for the steps after the executed prefix, drawn faint
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = cmp ? 1.5 : 2;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(X((tr.fanT + E) * DT), Y(tr.sel[E - 1]));
      for (k = E; k < K; k++) ctx.lineTo(X((tr.fanT + k + 1) * DT), Y(tr.sel[k]));
      ctx.stroke();
      // the 25 steps that run
      ctx.globalAlpha = cmp ? 0.7 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (k = 0; k < E; k++) ctx.lineTo(X((tr.fanT + k + 1) * DT), Y(tr.sel[k]));
      ctx.stroke();
      ctx.globalAlpha = 1;
      selEnd = tr.sel[K - 1];
    }
    // what actually happened
    ctx.strokeStyle = cmp ? col.accent : col.ink;
    ctx.lineWidth = cmp ? 2.5 : 2;
    polyHistory(tr);
    ctx.restore();

    // current points, with a ring in the page color
    function dot(trial, color) {
      var px = X((trial.histLen - 1) * DT), py = Y(trial.history[trial.histLen - 1]);
      ctx.fillStyle = col.page;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, 2 * Math.PI); ctx.fill();
      return [px, py];
    }
    var cmpDot = cmp ? dot(cmp, col.play) : null;
    var trDot = dot(tr, cmp ? col.accent : col.ink);

    if (this.narrow) return;

    // labels at the line ends, nudged apart, skipped when there is no room
    ctx.font = '12px ' + this.fontSans;
    ctx.fillStyle = col.secondary;
    ctx.textBaseline = 'middle';
    function overlaps(b) {
      for (var j = 0; j < placed.length; j++) {
        var p = placed[j];
        if (b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]) return true;
      }
      return false;
    }
    function place(text, x, yy, align, dir) {
      var w = ctx.measureText(text).width;
      var tries = [0, dir * 13, -dir * 13, dir * 26, -dir * 26];
      for (var j = 0; j < tries.length; j++) {
        var yt = yy + tries[j];
        if (yt < T + 4 || yt > T + ph - 2) continue;
        var x0b = align === 'right' ? x - w : x;
        var box = [x0b - 2, yt - 7, x0b + w + 2, yt + 7];
        if (box[0] < 2 || box[2] > W - 2) continue;
        if (overlaps(box)) continue;
        ctx.fillStyle = col.page;              // halo, so grid and threshold lines do not cut the text
        ctx.globalAlpha = 0.85;
        ctx.fillRect(box[0], box[1] + 1, box[2] - box[0], box[3] - box[1] - 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col.secondary;
        ctx.textAlign = align;
        ctx.fillText(text, x, yt);
        placed.push(box);
        return true;
      }
      return false;
    }
    // next to the current point, on the side away from the incoming line
    function nearDot(text, trial, pt) {
      var m = trial.histLen, back = Math.max(0, m - 1 - 30);
      var rising = trial.history[m - 1] > trial.history[back];
      place(text, pt[0] - 9, pt[1] + (rising ? -12 : 12), 'right', rising ? -1 : 1);
    }
    nearDot(cmp ? 'planner' : 'so far', tr, trDot);
    if (cmp) nearDot('play only', cmp, cmpDot);
    if (showFan) {
      var xe = Math.min(X((tr.fanT + K) * DT), L + pw) + 6;
      place('picked chunk', xe, Y(selEnd), 'left', 1);
      if (fanEnd != null) place('proposals', xe, Y(fanEnd), 'left', -1);
    }
  };

  /* --- headless trials, run in slices so the page stays responsive --- */

  Toy.prototype.runBatch = function (count) {
    if (this.batch) return;
    var self = this, n = this.n;
    var trial = new Trial(new Planner(randomSeed()));
    var rng = mulberry32(randomSeed());
    var a = new Float64Array(4), b = new Float64Array(4);
    var job = { n: n, done: 0, hits: [0, 0, 0], times: [] };
    this.batch = job;
    this.btnBatch.disabled = true;
    var active = false;

    function startTrial() {
      randomQuat(rng, a);
      sampleGoal(rng, a, b);
      trial.reset(a, b, (rng() * 4294967296) >>> 0);
      active = true;
    }
    function slice() {
      var t0 = performance.now();
      while (performance.now() - t0 < 12) {
        if (!active) startTrial();
        for (var s = 0; s < E && trial.t < BUDGET_STEPS && trial.first[0] < 0; s++) trial.step(n, false);
        if (trial.t >= BUDGET_STEPS || trial.first[0] >= 0) {
          for (var i = 0; i < 3; i++) if (trial.first[i] >= 0) job.hits[i]++;
          if (trial.first[0] >= 0) job.times.push(trial.first[0] * DT);
          job.done++;
          active = false;
          if (job.done >= count) break;
        }
      }
      self.btnBatch.textContent = 'Running ' + Math.min(job.done + 1, count) + ' of ' + count;
      if (job.done < count) {
        setTimeout(slice, 0);
      } else {
        self.finishBatch(job);
      }
    }
    this.btnBatch.textContent = 'Running 1 of ' + count;
    setTimeout(slice, 0);
  };

  Toy.prototype.finishBatch = function (job) {
    var r = this.results[job.n] || { trials: 0, hits: [0, 0, 0], times: [] };
    r.trials += job.done;
    for (var i = 0; i < 3; i++) r.hits[i] += job.hits[i];
    r.times = r.times.concat(job.times);
    this.results[job.n] = r;
    this.batch = null;
    this.btnBatch.disabled = false;
    this.btnBatch.textContent = 'Run 20 trials';
    this.renderResults();
    this.setStatus(fmtInt(job.done) + ' trials with ' + fmtInt(job.n) +
      (job.n === 1 ? ' proposal' : ' proposals') + ' per replan: within 0.4 rad in ' +
      fmtPct(job.hits[0] / job.done) + ', 0.6 rad in ' + fmtPct(job.hits[1] / job.done) +
      ', 0.8 rad in ' + fmtPct(job.hits[2] / job.done) + '.');
  };

  Toy.prototype.renderResults = function () {
    var box = this.resultsBox, res = this.results;
    var keys = Object.keys(res).map(Number).sort(function (x, y) { return x - y; });
    box.textContent = '';
    if (!keys.length) { box.hidden = true; return; }
    var cap = el('p', 'ptoy__caption', 'Toy trials in this browser (not results from the paper)');
    cap.id = this.id + '-cap';
    box.appendChild(cap);
    box.appendChild(el('p', 'ptoy__subcaption',
      'Share of trials that came within each threshold in 120 s, and the median time to reach 0.4 rad.'));
    var table = el('table');
    table.setAttribute('aria-labelledby', cap.id);
    var thead = el('thead'), hr = el('tr');
    ['Proposals', '0.4 rad', '0.6 rad', '0.8 rad', 'Median to 0.4', 'Trials'].forEach(function (h, i) {
      var th = el('th', i > 0 ? 'ptoy__num' : null, h);
      th.scope = 'col';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    keys.forEach(function (n) {
      var r = res[n], tr = el('tr');
      var times = r.times.slice().sort(function (x, y) { return x - y; });
      var med = times.length ? times[Math.floor(times.length / 2)].toFixed(1) + ' s' : 'none';
      var th = el('th', null, n === 1 ? '1 (play only)' : fmtInt(n));
      th.scope = 'row';
      tr.appendChild(th);
      for (var i = 0; i < 3; i++) tr.appendChild(el('td', 'ptoy__num', fmtPct(r.hits[i] / r.trials)));
      tr.appendChild(el('td', 'ptoy__num', med));
      tr.appendChild(el('td', 'ptoy__num', fmtInt(r.trials)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var scroller = el('div', 'ptoy__tablewrap');
    scroller.appendChild(table);
    box.appendChild(scroller);
    box.hidden = false;
  };

  Toy.prototype.destroy = function () {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.io) this.io.disconnect();
    if (this.ro) this.ro.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._goalDown) {
      this.cubeCanvas.removeEventListener('pointerdown', this._goalDown);
      this.cubeCanvas.removeEventListener('pointermove', this._goalMove);
      this.cubeCanvas.removeEventListener('pointerup', this._goalEnd);
      this.cubeCanvas.removeEventListener('pointercancel', this._goalEnd);
      this.cubeCanvas.removeEventListener('pointerleave', this._goalLeave);
      this.cubeCanvas.removeEventListener('lostpointercapture', this._goalLost);
      this.cubeCanvas.removeEventListener('focus', this._goalFocus);
      this.cubeCanvas.removeEventListener('blur', this._goalBlur);
      this.cubeCanvas.removeEventListener('keydown', this._goalKey);
    }
    document.removeEventListener('visibilitychange', this._onVis);
    this.root.removeAttribute('data-ptoy-mounted');
    this.root.classList.remove('ptoy--narrow');
    this.root.textContent = '';
  };

  function mount(node, opts) {
    if (!node || node.hasAttribute('data-ptoy-mounted')) return node && node._ptoy;
    var toy = new Toy(node, opts);
    node._ptoy = toy;
    return toy;
  }

  function autoMount() {
    function go() {
      var nodes = document.querySelectorAll('[data-planner-toy]');
      for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  }

  return {
    mount: mount,
    autoMount: autoMount,
    core: {
      Planner: Planner,
      Trial: Trial,
      ExecPlan: ExecPlan,
      runTrial: runTrial,
      runMany: runMany,
      modelError: modelError,
      priorSpeed: priorSpeed,
      mulberry32: mulberry32,
      randomQuat: randomQuat,
      quatDist: quatDist,
      PRIOR: PRIOR,
      REAL: REAL,
      MODEL: MODEL,
      constants: { DT: DT, H: H, K: K, E: E, N_MAX: N_MAX, BUDGET_S: BUDGET_S, THRESH: THRESH }
    }
  };
});
