// Lip feature extraction.
//
// Turns one MediaPipe Face Landmarker result (478 landmarks + 52 blendshapes)
// into a compact, head-pose-normalised feature vector that describes the
// shape of the mouth in that frame. A spoken word is then a *sequence* of
// these vectors, which recognizer.js compares with dynamic time warping.
//
// Everything here is pure (no DOM, no camera), so it can be unit-tested in Node.

// MediaPipe face-mesh landmark indices used below.
export const LM = {
  rightEyeOuter: 33,
  leftEyeOuter: 263,
  noseTip: 1,
  mouthCornerR: 61, // subject's right
  mouthCornerL: 291, // subject's left
  upperLipTop: 0, // outer contour, top centre
  lowerLipBottom: 17, // outer contour, bottom centre
  upperLipInner: 13, // inner contour, top centre
  lowerLipInner: 14, // inner contour, bottom centre
  innerCornerR: 78,
  innerCornerL: 308,
};

// Outer and inner lip contours, used for drawing the overlay.
export const LIP_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIP_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

// Geometric features, all expressed in units of inter-ocular distance (IOD) in a
// frame where the eye line is horizontal, so they don't change when you move
// closer to the camera or tilt your head.
export const GEOMETRIC_NAMES = [
  "geo.width", // corner-to-corner mouth width
  "geo.innerOpen", // gap between the lips (inner contour)
  "geo.outerOpen", // outer contour height
  "geo.aspect", // innerOpen / width — round "oo" vs wide "ee"
  "geo.upperLipThick",
  "geo.lowerLipThick",
  "geo.upperLipY", // vertical position of the upper lip below the eyes
  "geo.lowerLipY", // vertical position of the lower lip (tracks jaw drop)
  "geo.cornerY", // average corner height relative to lip centre (smile/frown)
  "geo.cornerAsym", // left/right corner height difference
  "geo.protrusion", // lip z relative to mouth corners (pucker / "w", "oo")
  "geo.innerWidth", // inner-corner width
];

// Blendshapes that describe the mouth and jaw. Selected by name at runtime so
// we don't depend on the model's category order.
export function isMouthBlendshape(name) {
  return name.startsWith("mouth") || name.startsWith("jaw");
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Convert one face's landmarks into pose-normalised 2-D points plus z.
 * @param {{x:number,y:number,z:number}[]} landmarks normalised [0,1] coordinates
 * @param {number} aspect video width / height (landmark x and y have different scales)
 */
export function normaliseFace(landmarks, aspect = 1) {
  const px = (i) => ({ x: landmarks[i].x * aspect, y: landmarks[i].y, z: landmarks[i].z * aspect });
  const eR = px(LM.rightEyeOuter);
  const eL = px(LM.leftEyeOuter);
  const iod = dist2(eR, eL) || 1e-6;
  const angle = Math.atan2(eL.y - eR.y, eL.x - eR.x);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const origin = { x: (eR.x + eL.x) / 2, y: (eR.y + eL.y) / 2 };
  return {
    iod,
    point(i) {
      const p = px(i);
      const dx = (p.x - origin.x) / iod;
      const dy = (p.y - origin.y) / iod;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos, z: p.z / iod };
    },
  };
}

/** Rough yaw proxy: how far the nose tip sits from the eye midpoint, in IOD units. */
export function yawProxy(face) {
  return face.point(LM.noseTip).x;
}

export function geometricFeatures(face) {
  const p = (i) => face.point(i);
  const cR = p(LM.mouthCornerR);
  const cL = p(LM.mouthCornerL);
  const top = p(LM.upperLipTop);
  const bottom = p(LM.lowerLipBottom);
  const upIn = p(LM.upperLipInner);
  const lowIn = p(LM.lowerLipInner);
  const iR = p(LM.innerCornerR);
  const iL = p(LM.innerCornerL);

  const width = dist2(cR, cL);
  const innerOpen = Math.max(0, lowIn.y - upIn.y);
  const outerOpen = Math.max(0, bottom.y - top.y);
  const lipCentreY = (upIn.y + lowIn.y) / 2;
  const cornerMidY = (cR.y + cL.y) / 2;
  const cornerZ = (cR.z + cL.z) / 2;
  const lipZ = (top.z + bottom.z) / 2;

  return [
    width,
    innerOpen,
    outerOpen,
    innerOpen / (width || 1e-6),
    Math.max(0, upIn.y - top.y),
    Math.max(0, bottom.y - lowIn.y),
    top.y,
    bottom.y,
    lipCentreY - cornerMidY,
    cL.y - cR.y,
    cornerZ - lipZ,
    dist2(iR, iL),
  ];
}

/**
 * Build the full per-frame feature vector.
 * @param {object} result MediaPipe FaceLandmarkerResult
 * @param {number} aspect video width / height
 * @returns {{names:string[], vector:number[], face:object, lipOpen:number, yaw:number} | null}
 */
export function extractFrame(result, aspect = 1) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length < 300) return null;
  const face = normaliseFace(landmarks, aspect);
  const geo = geometricFeatures(face);

  const names = [...GEOMETRIC_NAMES];
  const vector = [...geo];
  const cats = result.faceBlendshapes?.[0]?.categories ?? [];
  for (const c of cats) {
    const name = c.categoryName;
    if (name && isMouthBlendshape(name)) {
      names.push("bs." + name);
      vector.push(c.score);
    }
  }
  return { names, vector, face, lipOpen: geo[1], yaw: yawProxy(face) };
}

/**
 * Resample an irregularly-timed sequence of frames onto a fixed-rate grid by
 * linear interpolation, so recordings made at different webcam frame rates
 * line up.
 * @param {{t:number, v:number[]}[]} frames t in milliseconds
 * @param {number} hz target rate
 */
export function resample(frames, hz = 25) {
  if (frames.length === 0) return [];
  if (frames.length === 1) return [frames[0].v.slice()];
  const step = 1000 / hz;
  const t0 = frames[0].t;
  const tEnd = frames[frames.length - 1].t;
  const out = [];
  let j = 0;
  for (let t = t0; t <= tEnd + 1e-9; t += step) {
    while (j < frames.length - 2 && frames[j + 1].t < t) j++;
    const a = frames[j];
    const b = frames[j + 1];
    const span = b.t - a.t;
    const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    out.push(a.v.map((x, k) => x + (b.v[k] - x) * w));
  }
  return out;
}

/** Centred moving average over time (window 3) to suppress landmark jitter. */
export function smooth(seq) {
  if (seq.length < 3) return seq.map((f) => f.slice());
  return seq.map((f, i) => {
    const a = seq[Math.max(0, i - 1)];
    const c = seq[Math.min(seq.length - 1, i + 1)];
    return f.map((x, k) => (a[k] + x + c[k]) / 3);
  });
}

/** Round every value so stored vocabularies stay small. */
export function roundSeq(seq, digits = 4) {
  const m = 10 ** digits;
  return seq.map((f) => f.map((x) => Math.round(x * m) / m));
}
