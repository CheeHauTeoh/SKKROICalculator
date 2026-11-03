# LipType — type by mouthing words

A browser app that turns lip movements into typed text. You train it on your own face with the phrases you need, then mouth them at the camera to type. It runs entirely on-device: no video, images or features are uploaded.

> **Status: working prototype.** The pipeline (camera → lip tracking → features → recognizer → text) runs end to end in Chromium. Recognition logic is unit-tested on synthetic data. **Accuracy on real faces has not been measured yet.** That's the next step and needs you in front of a camera.

## Run it

```bash
cd lipreading
python3 -m http.server 8000
# open http://localhost:8000 (camera access needs https or localhost)
```

Tests: `node --test lipreading/tests/*.test.mjs`

Once merged to `main`, the Pages workflow also publishes it at `<your-pages-url>/lipreading/`, which works on phones because Pages serves over https.

### How to use

1. **Train tab:** add phrases (or load the starter set), choose **Record**, then hold the button (or Space) while you mouth the phrase. Do about 5 takes per phrase and vary them a little: slightly different speed, head position and lighting.
2. **Run self-test** to see leave-one-out accuracy and which phrases get confused with each other.
3. **Type tab:** hold and mouth a phrase. If the app is confident, it types the phrase. Otherwise it shows candidates for you to tap. Tapping a candidate fixes the text and, by default, adds that take as a new training sample.
4. Phrases can also be **actions**: delete last word, new line, clear.

---

## What the research says, and what it means for the design

### 1. Lips carry less information than speech
- Several phonemes look identical on the lips. The phoneme-to-viseme mapping is one-to-many (e.g. /p/, /b/, /m/). In one controlled study, human observers decoded about **44%** of spoken messages. Scored by phonemes, humans and an automatic system both reached just over **50%**. The authors suggest the human advantage comes mostly from using context. ([Fernandez-Lopez et al., 2017, arXiv:1704.08028](https://arxiv.org/abs/1704.08028))
- A University of Kansas study reported that about **a third of spoken English words look like at least one other word** on the lips. ([KU News](https://news.ku.edu/news/article/study-reveals-what-people-really-see-when-they-read-lips))

**Design implication (my inference):** an app can't get perfect accuracy from pixels alone. It needs constraints such as a known vocabulary, context or a language model, plus an easy way to correct mistakes. That's why LipType shows ranked candidates, lets you tap to correct, and has a self-test that flags look-alike phrases.

### 2. Accuracy depends heavily on how constrained the task is
| Task | Result | Source |
|---|---|---|
| GRID corpus (fixed grammar, small vocabulary), LipNet | 95.2% sentence accuracy (overlapped-speaker split) | [Assael et al., arXiv:1611.01599](https://arxiv.org/abs/1611.01599) |
| LRW (500 isolated words, BBC TV, 1000+ speakers) | Word-level benchmark; later papers report ~76–83% word accuracy (figures vary by paper) | [“Pushing the boundaries of audiovisual word recognition…”, arXiv:1811.01194](https://arxiv.org/abs/1811.01194), [Chung et al., “Lip Reading Sentences in the Wild”](https://arxiv.org/abs/1611.05358) |
| LRS3 (open vocabulary TED talks), AV-HuBERT | 32.5% WER with 30 h of labels; 26.9% with 433 h + self-training | [Shi et al., arXiv:2201.02184](https://arxiv.org/abs/2201.02184) |
| LRS3, Auto-AVSR (visual-only) | ~19–20% WER as reported in the repo READMEs (numbers differ across checkpoints and revisions) | [mpc001/auto_avsr](https://github.com/mpc001/auto_avsr), [arXiv:2303.14307](https://arxiv.org/abs/2303.14307) |

**Design implication (my inference):** open-vocabulary lip reading is still roughly 1 wrong word in 5 under benchmark conditions, and it needs a large model on a GPU. A small, known vocabulary is where lip reading works best. So version 1 is a personal-vocabulary recognizer that runs in the browser.

### 3. Models get worse on people they weren't trained on
- Lip readers lose accuracy on unseen speakers because lip appearance varies. Speaker-adaptive methods tune a pretrained model to one user: user-dependent padding ([Kim et al., ECCV 2022, arXiv:2208.04498](https://arxiv.org/abs/2208.04498)), and vision + language adaptation with LoRA ([Yeo et al., AAAI 2025, arXiv:2409.00986](https://arxiv.org/abs/2409.00986)).

**Design implication:** personalization is the lever with the biggest payoff. LipType is fully speaker-dependent: every template comes from your own face. "Learn from my corrections" keeps adapting as you use it.

### 4. Capturing the lips
- **MediaPipe Face Landmarker** returns 3-D face landmarks and 52 blendshape scores per frame in the browser. Left/right blendshapes refer to the subject's face, so mirrored input flips them. ([Google AI Edge docs](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js))
- Lip landmark indices (corners 61/291, inner lip centres 13/14, and so on) come from the face-mesh topology. ([landmark reference](https://dev.to/metsander/mediapipe-face-mesh-all-478-landmark-points-5ec8))
- Deep VSR models instead crop a mouth region of interest (ROI) and learn from its pixels. ROI size is a design choice; 88×88 and 96×96 crops are common. ([Ma et al., arXiv:2303.09455](https://arxiv.org/abs/2303.09455); [ROI study, arXiv:2003.03206](https://arxiv.org/abs/2003.03206))

---

## How LipType captures and reads lips

```
camera (unmirrored frames) ─► MediaPipe Face Landmarker (478 landmarks + blendshapes)
   ─► features.js   per-frame vector: 12 lip-geometry features + mouth/jaw blendshapes
   │                 geometry is rotated to the eye line and scaled by inter-ocular
   │                 distance, so head tilt, distance and position cancel out
   ─► segmenter      hold-to-mouth, or automatic "visual voice activity detection"
   │                 (lip-motion energy with an adaptive noise floor + hysteresis)
   ─► resample to 25 Hz ─► 3-frame smoothing
   ─► recognizer.js  standardise per feature + add velocity (deltas)
                     DTW (Sakoe–Chiba band, symmetric steps) against every recording
                     k-NN per phrase → ranked candidates + confidence
                     reject threshold calibrated by leave-one-out on your data
   ─► type it / show candidates / learn from the correction
```

| File | Role |
|---|---|
| `js/features.js` | Pose-normalised lip features, resampling, smoothing |
| `js/recognizer.js` | DTW, k-NN, reject threshold, leave-one-out self-test |
| `js/segmenter.js` | Automatic start/end-of-utterance detection |
| `js/app.js` | Camera, MediaPipe, UI, storage (localStorage + export/import) |
| `tests/core.test.mjs` | Unit tests (`node --test`) |

## Known limitations
- **No real-face accuracy numbers yet.** Tests use synthetic trajectories, and the in-browser test uses Chromium's fake camera, which has no face in it.
- Template matching scales to tens of phrases, not thousands. Each new utterance is compared with every recording.
- Recordings depend on the tracker version. If MediaPipe's blendshape set changes, the app detects the mismatch and asks you to re-train.
- Automatic mode can fire on yawning, chewing or smiling. Hold mode is more reliable.
- Vocabulary lives in this browser's localStorage. Use Export to back it up or move it to another device.

## Roadmap (proposals, not yet built)
1. **Measure on real faces:** record 10–20 phrases × 5 takes, then test in a later session with different lighting. That tells us whether the features are good enough.
2. **Learned visual features:** add a small mouth-ROI encoder (pretrained on LRW-style data) running with ONNX Runtime Web, and use its embeddings instead of hand-made geometry for the DTW / few-shot matcher.
3. **Open vocabulary:** an optional server running a pretrained VSR model such as Auto-AVSR on mouth-ROI clips from the browser. Combine it with a personal language model and speaker adaptation (see section 3). Trade-offs: GPU cost, latency and privacy, since video would leave the device. Check `crop_mouth.py` in the Auto-AVSR repo for its exact preprocessing before building this.
4. **Native mobile:** MediaPipe also ships Android and iOS SDKs, which would allow an always-available keyboard extension.
