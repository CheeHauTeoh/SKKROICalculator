// Personal-vocabulary lip-reading recognizer.
//
// Approach: template matching with Dynamic Time Warping (DTW) + k-nearest
// neighbours. You record each phrase a few times; a new utterance is compared
// against every stored recording and the closest phrase wins. DTW lets the
// same phrase be spoken faster or slower and still line up frame-by-frame.
//
// Why not a big neural model here? Open-vocabulary lip reading is still a
// research problem (see README) and needs a GPU server. A small vocabulary
// trained on *your* face is the setup where lip reading is most reliable, and
// it runs entirely in the browser.

/** Compute per-dimension mean and standard deviation over all frames. */
export function computeStats(sequences) {
  let dims = 0;
  for (const s of sequences) if (s.length) { dims = s[0].length; break; }
  const mean = new Float64Array(dims);
  const sq = new Float64Array(dims);
  let n = 0;
  for (const seq of sequences) {
    for (const f of seq) {
      for (let k = 0; k < dims; k++) {
        mean[k] += f[k];
        sq[k] += f[k] * f[k];
      }
      n++;
    }
  }
  const std = new Float64Array(dims);
  for (let k = 0; k < dims; k++) {
    mean[k] = n ? mean[k] / n : 0;
    const v = n ? sq[k] / n - mean[k] * mean[k] : 0;
    // Floor the std so near-constant features don't explode into noise.
    std[k] = Math.max(Math.sqrt(Math.max(0, v)), 1e-3);
  }
  return { mean: Array.from(mean), std: Array.from(std) };
}

/**
 * Standardise a sequence and append velocity (delta) features. Lip reading
 * depends heavily on *movement* (closing for "p/b/m", rounding for "w/oo"),
 * so deltas carry much of the signal.
 */
export function prepare(seq, stats, deltaWeight = 0.75) {
  const z = seq.map((f) => f.map((x, k) => (x - stats.mean[k]) / stats.std[k]));
  return z.map((f, i) => {
    const prev = z[Math.max(0, i - 1)];
    const next = z[Math.min(z.length - 1, i + 1)];
    const d = f.map((_, k) => ((next[k] - prev[k]) / 2) * deltaWeight);
    return Float64Array.from([...f, ...d]);
  });
}

function frameDist(a, b) {
  let s = 0;
  for (let k = 0; k < a.length; k++) {
    const d = a[k] - b[k];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * DTW distance with a Sakoe–Chiba band and the symmetric step pattern
 * (diagonal steps weighted 2), normalised by n + m so long and short phrases
 * are comparable.
 */
export function dtw(a, b, bandFraction = 0.35) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;
  const band = Math.max(Math.abs(n - m) + 1, Math.ceil(bandFraction * Math.max(n, m)));
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const centre = Math.round((i * m) / n);
    const jLo = Math.max(1, centre - band);
    const jHi = Math.min(m, centre + band);
    for (let j = jLo; j <= jHi; j++) {
      const d = frameDist(a[i - 1], b[j - 1]);
      cur[j] = Math.min(prev[j - 1] + 2 * d, prev[j] + d, cur[j - 1] + d);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

/**
 * A trained vocabulary.
 * phrases: [{ id, label, action, samples: [{ seq: number[][] }] }]
 */
export class Recognizer {
  constructor(options = {}) {
    this.k = options.k ?? 2;
    this.deltaWeight = options.deltaWeight ?? 0.75;
    this.strictness = options.strictness ?? 1; // higher = rejects more
    this.phrases = [];
    this.stats = null;
    this.prepared = [];
    this.threshold = Infinity;
  }

  /** Rebuild normalisation statistics, prepared templates and the reject threshold. */
  fit(phrases) {
    this.phrases = phrases;
    const all = phrases.flatMap((p) => p.samples.map((s) => s.seq));
    if (!all.length) {
      this.stats = null;
      this.prepared = [];
      this.threshold = Infinity;
      return this;
    }
    this.stats = computeStats(all);
    this.prepared = phrases.map((p) => ({
      phrase: p,
      templates: p.samples.map((s) => prepare(s.seq, this.stats, this.deltaWeight)),
    }));
    this.threshold = this._calibrateThreshold();
    return this;
  }

  /** Distance from a prepared query to each phrase (mean of its k nearest templates). */
  _score(query, exclude = null) {
    const scores = [];
    for (const { phrase, templates } of this.prepared) {
      const ds = [];
      templates.forEach((t, idx) => {
        if (exclude && exclude.phrase === phrase && exclude.idx === idx) return;
        ds.push(dtw(query, t));
      });
      if (!ds.length) continue;
      ds.sort((x, y) => x - y);
      const k = Math.min(this.k, ds.length);
      let s = 0;
      for (let i = 0; i < k; i++) s += ds[i];
      scores.push({ phrase, distance: s / k });
    }
    scores.sort((x, y) => x.distance - y.distance);
    return scores;
  }

  /**
   * Reject threshold from leave-one-out. For each recording we measure how far
   * it is from the rest of its own phrase ("own") and from the nearest other
   * phrase ("other"). Utterances well beyond the own-distance are probably
   * something you never trained. Because takes recorded back-to-back can be
   * unrealistically similar, the threshold is never set below the midpoint
   * between typical own- and other-phrase distances.
   */
  _calibrateThreshold() {
    const own = [];
    const other = [];
    for (const { phrase, templates } of this.prepared) {
      templates.forEach((t, idx) => {
        const scores = this._score(t, { phrase, idx });
        const s = scores.find((x) => x.phrase === phrase);
        const o = scores.find((x) => x.phrase !== phrase);
        if (s && Number.isFinite(s.distance)) own.push(s.distance);
        if (o && Number.isFinite(o.distance)) other.push(o.distance);
      });
    }
    if (own.length < 2) return Infinity;
    const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const mean = own.reduce((a, b) => a + b, 0) / own.length;
    const sd = Math.sqrt(own.reduce((a, b) => a + (b - mean) ** 2, 0) / own.length);
    const spread = mean + 2.5 * sd;
    const midpoint = other.length ? (median(own) + median(other)) / 2 : spread * 2;
    return Math.max(spread, midpoint);
  }

  /**
   * Recognise one utterance.
   * @param {number[][]} seq resampled raw feature frames
   * @returns {{ accepted:boolean, best:object|null, candidates:{phrase,distance,confidence}[] }}
   */
  recognize(seq) {
    if (!this.stats || seq.length < 3) return { accepted: false, best: null, candidates: [] };
    const q = prepare(seq, this.stats, this.deltaWeight);
    const scores = this._score(q);
    if (!scores.length) return { accepted: false, best: null, candidates: [] };

    // Relative confidence: softmax over negative distances, temperature set by
    // the spread of the top candidates.
    const top = scores.slice(0, 5);
    const temp = Math.max(0.05, (top[top.length - 1].distance - top[0].distance) / 3 || 0.25);
    const exps = top.map((s) => Math.exp(-(s.distance - top[0].distance) / temp));
    const z = exps.reduce((a, b) => a + b, 0);
    const candidates = top.map((s, i) => ({ ...s, confidence: exps[i] / z }));

    const best = candidates[0];
    const limit = this.threshold / this.strictness;
    const margin = candidates.length > 1 ? candidates[1].distance / best.distance : Infinity;
    const accepted = best.distance <= limit && margin >= 1 + 0.03 * this.strictness;
    return { accepted, best, candidates };
  }

  /**
   * Leave-one-out self-test: recognise every stored recording against all the
   * others. Shows which phrases look alike on the lips (e.g. "bat" vs "pat").
   */
  evaluate() {
    let correct = 0;
    let total = 0;
    const confusions = new Map();
    for (const { phrase, templates } of this.prepared) {
      templates.forEach((t, idx) => {
        const scores = this._score(t, { phrase, idx });
        if (!scores.length) return;
        total++;
        const guess = scores[0].phrase;
        if (guess === phrase) correct++;
        else {
          const key = `${phrase.label} → ${guess.label}`;
          confusions.set(key, (confusions.get(key) ?? 0) + 1);
        }
      });
    }
    return {
      total,
      correct,
      accuracy: total ? correct / total : null,
      confusions: [...confusions.entries()].sort((a, b) => b[1] - a[1]).map(([pair, count]) => ({ pair, count })),
    };
  }
}
