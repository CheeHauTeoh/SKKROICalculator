// Utterance segmentation: decides when you start and stop mouthing a phrase.
//
// Two modes:
//  - "hold": you hold a key/button while mouthing (most reliable).
//  - "auto": a visual voice-activity detector watches lip motion energy and
//    opens/closes a segment with hysteresis, like an audio VAD does with volume.

export class AutoSegmenter {
  constructor(options = {}) {
    this.onFactor = options.onFactor ?? 3; // energy must exceed floor × this to start
    this.offFactor = options.offFactor ?? 1.6; // and drop below floor × this to stop
    this.minOn = options.minOn ?? 0.01; // absolute minimum start threshold
    this.startFrames = options.startFrames ?? 3; // consecutive active frames to start
    this.hangoverMs = options.hangoverMs ?? 450; // quiet time before closing
    this.minMs = options.minMs ?? 300;
    this.maxMs = options.maxMs ?? 4000;
    this.preRollMs = options.preRollMs ?? 200;
    this.reset();
  }

  reset() {
    this.floor = null;
    this.prev = null;
    this.energyEma = 0;
    this.active = false;
    this.run = 0;
    this.quietSince = null;
    this.buffer = []; // recent frames for pre-roll
    this.segment = [];
  }

  /**
   * Feed one frame. Returns a finished segment (array of {t, v}) or null.
   * @param {number} t timestamp in ms
   * @param {number[]} v raw feature vector
   */
  push(t, v) {
    let energy = 0;
    if (this.prev) {
      for (let k = 0; k < v.length; k++) energy += Math.abs(v[k] - this.prev[k]);
      energy /= v.length;
    }
    this.prev = v;
    this.energyEma = this.energyEma * 0.6 + energy * 0.4;
    const e = this.energyEma;
    if (this.floor === null) this.floor = e || 1e-4;

    const frame = { t, v };
    const onT = Math.max(this.floor * this.onFactor, this.minOn);
    const offT = Math.max(this.floor * this.offFactor, this.minOn * 0.6);

    if (!this.active) {
      this.buffer.push(frame);
      while (this.buffer.length && t - this.buffer[0].t > this.preRollMs) this.buffer.shift();
      if (e > onT) this.run++;
      else {
        this.run = 0;
        // Track the resting noise floor only while idle.
        this.floor = this.floor * 0.97 + e * 0.03;
      }
      if (this.run >= this.startFrames) {
        this.active = true;
        this.segment = [...this.buffer];
        this.quietSince = null;
      }
      return null;
    }

    this.segment.push(frame);
    const dur = t - this.segment[0].t;
    if (e < offT) this.quietSince ??= t;
    else this.quietSince = null;

    const ended = (this.quietSince !== null && t - this.quietSince >= this.hangoverMs) || dur >= this.maxMs;
    if (!ended) return null;

    // Trim the trailing quiet part, keeping a little tail.
    const cut = this.quietSince !== null ? this.quietSince + 120 : t;
    const seg = this.segment.filter((f) => f.t <= cut);
    this.active = false;
    this.run = 0;
    this.buffer = [];
    this.segment = [];
    const segDur = seg.length ? seg[seg.length - 1].t - seg[0].t : 0;
    return segDur >= this.minMs ? seg : null;
  }

  get speaking() {
    return this.active;
  }
}
