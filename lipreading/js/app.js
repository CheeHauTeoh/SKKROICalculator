// LipType — type by mouthing words at your camera.
// Camera → MediaPipe Face Landmarker → lip features → DTW recognizer → text.
// Everything runs in the browser; no video or features leave the device.

import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
import { extractFrame, resample, smooth, roundSeq, LIP_OUTER, LIP_INNER } from "./features.js";
import { Recognizer } from "./recognizer.js";
import { AutoSegmenter } from "./segmenter.js";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const STORAGE_KEY = "liptype.v1";
const TARGET_SAMPLES = 5;
const MAX_SAMPLES = 12;
const MIN_FRAMES = 6;

const STARTER = [
  { label: "yes" }, { label: "no" }, { label: "hello" }, { label: "thank you" },
  { label: "help" }, { label: "water" },
  { label: "delete", action: "delete-word" }, { label: "new line", action: "newline" },
];
const ACTION_NAMES = { text: "Type text", "delete-word": "Delete last word", newline: "New line", clear: "Clear all" };

const $ = (sel) => document.querySelector(sel);
const el = {
  video: $("#video"), overlay: $("#overlay"), status: $("#status"), rec: $("#rec"),
  meter: $("#meter-fill"), output: $("#output"), candidates: $("#candidates"), hint: $("#hint"),
  holdBtn: $("#hold"), holdLabel: $("#hold-label"), copy: $("#copy"), undo: $("#undo"), clear: $("#clear"),
  phraseInput: $("#phrase-input"), phraseAction: $("#phrase-action"), addPhrase: $("#add-phrase"),
  starter: $("#starter"), phraseList: $("#phrase-list"), trainTarget: $("#train-target"),
  selftest: $("#selftest"), selftestOut: $("#selftest-out"), exportBtn: $("#export"), importInput: $("#import"),
  mode: $("#mode"), strictness: $("#strictness"), autotype: $("#autotype"), learn: $("#learn"), showLips: $("#show-lips"),
  tabs: document.querySelectorAll("[role=tab]"), panels: document.querySelectorAll("[role=tabpanel]"),
};

// ---------- state ----------
let vocab = loadVocab();
const settings = loadSettings();
const recognizer = new Recognizer({ strictness: settings.strictness });
const segmenter = new AutoSegmenter();
let featureNames = null;
let trainTargetId = null;
let holding = false;
let holdFrames = [];
let history = [];
let lastRecognition = null; // { prevText, seq, candidates }
let faceSeenAt = 0;

refit();
applySettingsToUI();
renderPhrases();
updateHint();

// ---------- persistence ----------
function loadVocab() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && Array.isArray(v.phrases)) return v;
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return { version: 1, featureNames: null, phrases: [] };
}

function saveVocab() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vocab));
  } catch {
    toast("Couldn't save to this browser (storage full or blocked). Use Export to keep your vocabulary.");
  }
}

function loadSettings() {
  const d = { mode: "hold", strictness: 1, autotype: true, learn: true, showLips: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STORAGE_KEY + ".settings") || "{}") }; } catch { return d; }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY + ".settings", JSON.stringify(settings)); } catch { /* non-critical */ }
}

function refit() {
  recognizer.strictness = settings.strictness;
  recognizer.fit(vocab.phrases.filter((p) => p.samples.length > 0));
}

// ---------- camera + model ----------
let landmarker = null;

async function start() {
  setStatus("Starting camera…", "wait");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
  } catch (err) {
    setStatus("Camera blocked: " + (err?.message || err) + ". Allow camera access (needs https or localhost).", "error");
    return;
  }

  setStatus("Loading lip tracker…", "wait");
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
  } catch (err) {
    setStatus("Couldn't load the lip tracker: " + (err?.message || err), "error");
    return;
  }
  setStatus("Looking for your face…", "wait");
  requestAnimationFrame(loop);
}

let lastVideoTime = -1;
function loop() {
  const v = el.video;
  if (v.readyState >= 2 && v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    const now = performance.now();
    let result = null;
    try { result = landmarker.detectForVideo(v, now); } catch { /* skip frame */ }
    const aspect = v.videoWidth / v.videoHeight || 4 / 3;
    const frame = result ? extractFrame(result, aspect) : null;
    draw(result);
    if (frame) {
      faceSeenAt = now;
      if (Math.abs(frame.yaw) > 0.3) setStatus("Face the camera more directly", "warn");
      else setStatus(holding || segmenter.speaking ? "Reading lips…" : "Lips tracked", "ok");
      onFeatureFrame(now, frame.vector, frame.names, frame.lipOpen);
    } else if (now - faceSeenAt > 500) {
      setStatus("No face found — move into the frame, light your face", "warn");
    }
  }
  requestAnimationFrame(loop);
}

function draw(result) {
  const c = el.overlay;
  const v = el.video;
  if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const lm = result?.faceLandmarks?.[0];
  if (!lm || !settings.showLips) return;
  const active = holding || segmenter.speaking;
  ctx.lineWidth = Math.max(2, c.width / 320);
  ctx.strokeStyle = active ? "#ff5a5f" : "#3ddc97";
  for (const ring of [LIP_OUTER, LIP_INNER]) {
    ctx.beginPath();
    ring.forEach((i, n) => {
      const x = lm[i].x * c.width, y = lm[i].y * c.height;
      n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

// ---------- capture pipeline ----------
// Exposed for automated tests (no real face is available in CI).
window.__liptypeTest = { feedFrame: (t, v, names) => onFeatureFrame(t, v, names, 0), setHold };

function onFeatureFrame(t, vector, names, lipOpen) {
  if (!featureNames) featureNames = names;
  if (vocab.featureNames && vocab.featureNames.join() !== names.join()) {
    setStatus("This vocabulary was recorded with a different tracker version. Re-train or import a matching file.", "error");
    return;
  }
  el.meter.style.width = Math.min(100, (lipOpen / 0.25) * 100) + "%";

  if (settings.mode === "hold") {
    if (holding) holdFrames.push({ t, v: vector });
  } else {
    const seg = segmenter.push(t, vector);
    if (seg) handleSegment(seg);
  }
  el.rec.hidden = !(holding || segmenter.speaking);
}

function setHold(on) {
  if (settings.mode !== "hold") return;
  if (on && !holding) {
    holding = true;
    holdFrames = [];
    el.holdBtn.classList.add("active");
  } else if (!on && holding) {
    holding = false;
    el.holdBtn.classList.remove("active");
    el.rec.hidden = true;
    const frames = holdFrames;
    holdFrames = [];
    handleSegment(frames);
  }
}

function handleSegment(frames) {
  if (frames.length < MIN_FRAMES) {
    toast("Too short or lips not visible — try again.");
    return;
  }
  const seq = roundSeq(smooth(resample(frames, 25)), 4);
  if (trainTargetId) addSample(trainTargetId, seq);
  else recognizeSeq(seq);
}

// ---------- training ----------
function addPhrase(label, action = "text") {
  label = label.trim();
  if (!label) return null;
  const existing = vocab.phrases.find((p) => p.label.toLowerCase() === label.toLowerCase());
  if (existing) return existing;
  const p = { id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), label, action, samples: [] };
  vocab.phrases.push(p);
  saveVocab();
  renderPhrases();
  return p;
}

function addSample(phraseId, seq) {
  const p = vocab.phrases.find((x) => x.id === phraseId);
  if (!p) return;
  if (!vocab.featureNames) vocab.featureNames = featureNames;
  p.samples.push({ seq, at: Date.now() });
  if (p.samples.length > MAX_SAMPLES) p.samples.shift();
  saveVocab();
  refit();
  renderPhrases();
  if (trainTargetId === phraseId) {
    if (p.samples.length >= TARGET_SAMPLES) {
      toast(`“${p.label}” has ${p.samples.length} samples. Pick another phrase, or keep adding variety.`);
    } else {
      toast(`Sample ${p.samples.length}/${TARGET_SAMPLES} for “${p.label}” saved.`);
    }
  }
  updateHint();
}

function setTrainTarget(id) {
  trainTargetId = trainTargetId === id ? null : id;
  renderPhrases();
  updateHint();
}

function renderPhrases() {
  el.phraseList.replaceChildren();
  if (!vocab.phrases.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No phrases yet. Add your own or load the starter set.";
    el.phraseList.append(li);
  }
  for (const p of vocab.phrases) {
    const li = document.createElement("li");
    li.className = "phrase" + (p.id === trainTargetId ? " target" : "");
    const name = document.createElement("div");
    name.className = "phrase-name";
    name.textContent = p.label;
    if (p.action && p.action !== "text") {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = ACTION_NAMES[p.action];
      name.append(" ", tag);
    }
    const dots = document.createElement("div");
    dots.className = "dots";
    dots.setAttribute("aria-label", `${p.samples.length} samples`);
    for (let i = 0; i < Math.max(TARGET_SAMPLES, p.samples.length); i++) {
      const d = document.createElement("span");
      d.className = i < p.samples.length ? "dot on" : "dot";
      dots.append(d);
    }
    const rec = button(p.id === trainTargetId ? "Stop" : "Record", () => setTrainTarget(p.id), p.id === trainTargetId ? "primary" : "");
    const undo = button("−1", () => { p.samples.pop(); saveVocab(); refit(); renderPhrases(); }, "ghost", "Remove last sample");
    undo.disabled = !p.samples.length;
    const del = button("✕", () => {
      if (!confirm(`Delete “${p.label}” and its ${p.samples.length} samples?`)) return;
      vocab.phrases = vocab.phrases.filter((x) => x !== p);
      if (trainTargetId === p.id) trainTargetId = null;
      if (!vocab.phrases.some((x) => x.samples.length)) vocab.featureNames = null;
      saveVocab(); refit(); renderPhrases(); updateHint();
    }, "ghost", "Delete phrase");
    const actions = document.createElement("div");
    actions.className = "phrase-actions";
    actions.append(rec, undo, del);
    li.append(name, dots, actions);
    el.phraseList.append(li);
  }
  const p = vocab.phrases.find((x) => x.id === trainTargetId);
  el.trainTarget.textContent = p
    ? `Recording samples for “${p.label}”. ${settings.mode === "hold" ? "Hold the button (or Space) while you mouth it" : "Just mouth it, then pause"}.`
    : "Choose Record on a phrase to add samples.";
  el.trainTarget.classList.toggle("live", !!p);
}

function button(text, onClick, cls = "", title = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) { b.title = title; b.setAttribute("aria-label", title); }
  b.addEventListener("click", onClick);
  return b;
}

// ---------- recognition + typing ----------
function recognizeSeq(seq) {
  const out = recognizer.recognize(seq);
  if (!out.candidates.length) {
    toast("Train a few phrases first (Train tab).");
    return;
  }
  const prevText = el.output.value;
  lastRecognition = { prevText, seq, candidates: out.candidates, applied: null };
  if (out.accepted && settings.autotype) {
    applyPhrase(out.best.phrase);
    lastRecognition.applied = out.best.phrase;
  }
  renderCandidates(out);
}

function applyPhrase(phrase, base = el.output.value) {
  history.push(el.output.value);
  if (history.length > 100) history.shift();
  let text = base;
  switch (phrase.action) {
    case "delete-word": text = text.replace(/\s*\S+\s*$/, ""); break;
    case "newline": text = text + "\n"; break;
    case "clear": text = ""; break;
    default: text = text + (text && !/\s$/.test(text) ? " " : "") + phrase.label;
  }
  el.output.value = text;
  el.output.scrollTop = el.output.scrollHeight;
}

function renderCandidates(out) {
  el.candidates.replaceChildren();
  const lead = document.createElement("span");
  lead.className = "cand-lead";
  lead.textContent = out.accepted && settings.autotype ? "Typed:" : "Not sure — tap one:";
  el.candidates.append(lead);
  out.candidates.slice(0, 4).forEach((c, i) => {
    const b = button(`${c.phrase.label} · ${Math.round(c.confidence * 100)}%`, () => choose(c.phrase), i === 0 && out.accepted ? "chip best" : "chip");
    el.candidates.append(b);
  });
}

// User picked a candidate: replace whatever was auto-typed and learn from it.
function choose(phrase) {
  if (!lastRecognition) return;
  const { prevText, seq, applied } = lastRecognition;
  if (applied !== phrase) {
    applyPhrase(phrase, prevText);
    if (settings.learn) addSample(phrase.id, seq);
  }
  lastRecognition = null;
  el.candidates.replaceChildren();
}

function updateHint() {
  const trained = vocab.phrases.filter((p) => p.samples.length >= 2).length;
  el.hint.textContent = trainTargetId
    ? "Training mode is on — samples go to the selected phrase. Stop recording in the Train tab to type."
    : trained === 0
      ? "Start in the Train tab: record each phrase about 5 times."
      : settings.mode === "hold"
        ? "Hold the button (or Space) while you mouth a trained phrase."
        : "Mouth a trained phrase, then pause briefly.";
  el.holdBtn.hidden = settings.mode !== "hold";
}

// ---------- UI wiring ----------
function setStatus(text, kind) {
  if (el.status.textContent !== text) el.status.textContent = text;
  el.status.dataset.kind = kind;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

el.holdBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); el.holdBtn.setPointerCapture?.(e.pointerId); setHold(true); });
el.holdBtn.addEventListener("pointerup", () => setHold(false));
el.holdBtn.addEventListener("pointercancel", () => setHold(false));
el.holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());

const isTyping = () => ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !isTyping()) { e.preventDefault(); if (!e.repeat) setHold(true); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && holding) { e.preventDefault(); setHold(false); }
});

el.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el.output.value); toast("Copied."); }
  catch { el.output.select(); toast("Select-all done — press Ctrl/Cmd+C to copy."); }
});
el.undo.addEventListener("click", () => { if (history.length) el.output.value = history.pop(); el.candidates.replaceChildren(); });
el.clear.addEventListener("click", () => { history.push(el.output.value); el.output.value = ""; });

el.addPhrase.addEventListener("click", () => {
  const p = addPhrase(el.phraseInput.value, el.phraseAction.value);
  if (p) { el.phraseInput.value = ""; setTrainTarget(p.id); }
});
el.phraseInput.addEventListener("keydown", (e) => { if (e.key === "Enter") el.addPhrase.click(); });
el.starter.addEventListener("click", () => { STARTER.forEach((s) => addPhrase(s.label, s.action || "text")); toast("Starter phrases added. Record ~5 samples each."); });

el.selftest.addEventListener("click", () => {
  const r = recognizer.evaluate();
  el.selftestOut.replaceChildren();
  if (!r.total) { el.selftestOut.textContent = "Record at least 2 samples for 2+ phrases first."; return; }
  const p = document.createElement("p");
  p.textContent = `Leave-one-out accuracy: ${Math.round(r.accuracy * 100)}% (${r.correct}/${r.total} recordings).`;
  el.selftestOut.append(p);
  if (r.confusions.length) {
    const h = document.createElement("p");
    h.textContent = "Most confused (looks alike on the lips — add samples, or rename one phrase):";
    const ul = document.createElement("ul");
    r.confusions.slice(0, 5).forEach((c) => { const li = document.createElement("li"); li.textContent = `${c.pair} ×${c.count}`; ul.append(li); });
    el.selftestOut.append(h, ul);
  }
});

el.exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(vocab)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "liptype-vocabulary.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
el.importInput.addEventListener("change", async () => {
  const f = el.importInput.files?.[0];
  if (!f) return;
  try {
    const v = JSON.parse(await f.text());
    if (!Array.isArray(v.phrases)) throw new Error("not a LipType vocabulary");
    vocab = v;
    saveVocab(); refit(); renderPhrases(); updateHint();
    toast(`Imported ${v.phrases.length} phrases.`);
  } catch (err) { toast("Import failed: " + err.message); }
  el.importInput.value = "";
});

function applySettingsToUI() {
  el.mode.value = settings.mode;
  el.strictness.value = settings.strictness;
  el.autotype.checked = settings.autotype;
  el.learn.checked = settings.learn;
  el.showLips.checked = settings.showLips;
}
el.mode.addEventListener("change", () => { settings.mode = el.mode.value; segmenter.reset(); setHold(false); saveSettings(); updateHint(); renderPhrases(); });
el.strictness.addEventListener("input", () => { settings.strictness = Number(el.strictness.value); recognizer.strictness = settings.strictness; saveSettings(); });
el.autotype.addEventListener("change", () => { settings.autotype = el.autotype.checked; saveSettings(); });
el.learn.addEventListener("change", () => { settings.learn = el.learn.checked; saveSettings(); });
el.showLips.addEventListener("change", () => { settings.showLips = el.showLips.checked; saveSettings(); });

el.tabs.forEach((tab) => tab.addEventListener("click", () => {
  el.tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  el.panels.forEach((p) => (p.hidden = p.id !== tab.getAttribute("aria-controls")));
}));

start();
