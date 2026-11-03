// Run with: node --test lipreading/tests
import test from "node:test";
import assert from "node:assert/strict";
import { dtw, Recognizer, computeStats, prepare } from "../js/recognizer.js";
import { resample, smooth, normaliseFace, geometricFeatures, extractFrame, LM } from "../js/features.js";
import { AutoSegmenter } from "../js/segmenter.js";

// Deterministic PRNG so tests are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// A fake "phrase": a smooth trajectory through a 6-D feature space.
function phraseShape(id) {
  return (u) => [0, 1, 2, 3, 4, 5].map((k) => Math.sin((id + 1) * (k + 1) * 0.7 * u + id * k) * (1 + 0.2 * k));
}
function utter(shape, rand, { frames = 30, warp = 0.25, noise = 0.08 } = {}) {
  const n = Math.round(frames * (1 + (rand() - 0.5) * warp * 2));
  const bend = 1 + (rand() - 0.5) * warp; // non-linear time warp
  return Array.from({ length: n }, (_, i) => {
    const u = Math.pow(i / (n - 1), bend) * Math.PI;
    return shape(u).map((x) => x + (rand() - 0.5) * 2 * noise);
  });
}

test("dtw is zero for identical sequences and tolerates time stretching", () => {
  const shape = phraseShape(1);
  const a = Array.from({ length: 20 }, (_, i) => shape((i / 19) * Math.PI));
  const slow = Array.from({ length: 34 }, (_, i) => shape((i / 33) * Math.PI));
  const other = Array.from({ length: 20 }, (_, i) => phraseShape(4)((i / 19) * Math.PI));
  assert.equal(dtw(a, a), 0);
  assert.ok(dtw(a, slow) < dtw(a, other) / 3, "stretched copy should be much closer than a different phrase");
  assert.equal(dtw([], a), Infinity);
});

test("recognizer learns a small vocabulary and rejects untrained input", () => {
  const rand = rng(42);
  const phrases = [0, 1, 2, 3, 5].map((id) => ({
    id: "p" + id,
    label: "phrase " + id,
    samples: Array.from({ length: 4 }, () => ({ seq: utter(phraseShape(id), rand) })),
  }));
  const r = new Recognizer().fit(phrases);

  const report = r.evaluate();
  assert.equal(report.total, 20);
  assert.ok(report.accuracy >= 0.95, `leave-one-out accuracy ${report.accuracy}`);

  let right = 0;
  for (const id of [0, 1, 2, 3, 5]) {
    for (let i = 0; i < 4; i++) {
      const out = r.recognize(utter(phraseShape(id), rand));
      if (out.best.phrase.id === "p" + id) right++;
    }
  }
  assert.ok(right >= 19, `fresh utterances recognised: ${right}/20`);

  // Something never trained should not be auto-typed.
  const junk = Array.from({ length: 30 }, () => [0, 0, 0, 0, 0, 0].map(() => (rand() - 0.5) * 6));
  assert.equal(r.recognize(junk).accepted, false);
});

test("confidences are a probability distribution over the top candidates", () => {
  const rand = rng(7);
  const phrases = [0, 1, 2].map((id) => ({
    id: "p" + id, label: "p" + id,
    samples: Array.from({ length: 3 }, () => ({ seq: utter(phraseShape(id), rand) })),
  }));
  const out = new Recognizer().fit(phrases).recognize(utter(phraseShape(2), rand));
  const sum = out.candidates.reduce((a, c) => a + c.confidence, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(out.candidates[0].phrase.id, "p2");
});

test("empty vocabulary recognises nothing", () => {
  const out = new Recognizer().fit([]).recognize([[1], [2], [3]]);
  assert.deepEqual(out, { accepted: false, best: null, candidates: [] });
});

test("prepare standardises and appends deltas", () => {
  const seq = [[1, 10], [2, 20], [3, 30]];
  const stats = computeStats([seq]);
  const p = prepare(seq, stats, 1);
  assert.equal(p[0].length, 4);
  assert.ok(Math.abs(p[1][0]) < 1e-9, "middle frame is the mean");
});

test("resample maps irregular timestamps to a fixed rate", () => {
  const frames = [{ t: 0, v: [0] }, { t: 30, v: [3] }, { t: 100, v: [10] }];
  const out = resample(frames, 25); // every 40 ms: 0, 40, 80
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[1][0] - 4) < 1e-9);
  assert.ok(Math.abs(out[2][0] - 8) < 1e-9);
  assert.equal(smooth(out).length, 3);
});

// Build a fake 478-landmark face with a controllable mouth.
function fakeFace({ open = 0.02, width = 0.12, tilt = 0, scale = 1, shiftX = 0 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => {
    const c = Math.cos(tilt), s = Math.sin(tilt);
    pts[i] = { x: 0.5 + shiftX + (x * c - y * s) * scale, y: 0.5 + (x * s + y * c) * scale, z: 0 };
  };
  set(LM.rightEyeOuter, -0.1, -0.1);
  set(LM.leftEyeOuter, 0.1, -0.1);
  set(LM.noseTip, 0, 0);
  set(LM.mouthCornerR, -width / 2, 0.1);
  set(LM.mouthCornerL, width / 2, 0.1);
  set(LM.upperLipTop, 0, 0.08);
  set(LM.upperLipInner, 0, 0.095);
  set(LM.lowerLipInner, 0, 0.095 + open);
  set(LM.lowerLipBottom, 0, 0.115 + open);
  set(LM.innerCornerR, -width / 2 + 0.01, 0.1);
  set(LM.innerCornerL, width / 2 - 0.01, 0.1);
  return pts;
}

test("geometric features are invariant to head tilt, distance and position", () => {
  const base = geometricFeatures(normaliseFace(fakeFace()));
  const moved = geometricFeatures(normaliseFace(fakeFace({ tilt: 0.3, scale: 0.6, shiftX: 0.1 })));
  base.forEach((x, k) => assert.ok(Math.abs(x - moved[k]) < 1e-9, `feature ${k}: ${x} vs ${moved[k]}`));
  const opened = geometricFeatures(normaliseFace(fakeFace({ open: 0.06 })));
  assert.ok(opened[1] > base[1] * 2, "inner opening grows when the mouth opens");
});

test("extractFrame picks up mouth/jaw blendshapes only", () => {
  const result = {
    faceLandmarks: [fakeFace()],
    faceBlendshapes: [{ categories: [
      { categoryName: "browDownLeft", score: 0.5 },
      { categoryName: "jawOpen", score: 0.3 },
      { categoryName: "mouthPucker", score: 0.1 },
    ] }],
  };
  const f = extractFrame(result, 1);
  assert.deepEqual(f.names.slice(-2), ["bs.jawOpen", "bs.mouthPucker"]);
  assert.equal(f.vector.length, f.names.length);
  assert.equal(extractFrame({ faceLandmarks: [] }), null);
});

test("auto segmenter finds a burst of lip motion between rests", () => {
  const seg = new AutoSegmenter();
  const rand = rng(3);
  const found = [];
  let t = 0;
  const feed = (ms, motion) => {
    for (let end = t + ms; t < end; t += 33) {
      const v = [0, 0, 0].map((_, k) => (motion ? Math.sin(t / 60 + k) * 0.3 : 0) + (rand() - 0.5) * 0.002);
      const out = seg.push(t, v);
      if (out) found.push(out);
    }
  };
  feed(1500, false);
  feed(800, true);
  feed(1500, false);
  assert.equal(found.length, 1);
  const s = found[0];
  const start = s[0].t, end = s[s.length - 1].t;
  assert.ok(start >= 1200 && start <= 1700, `start ${start}`);
  assert.ok(end >= 2200 && end <= 2700, `end ${end}`);
});
