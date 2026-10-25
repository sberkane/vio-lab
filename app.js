(function () {
  "use strict";
  const $ = function (id) { return document.getElementById(id); };
  const COLORS = { ink: "#162b3c", muted: "#85949b", grid: "#e7eeea", teal: "#158b80", coral: "#cc715e", gold: "#bd994b" };
  const state = { manifest: null, experiments: null, study: 'odometry', dataset: null, run: null, index: 0, playing: false, time: 0, lastFrame: 0, lastDraw: 0, token: 0, cache: new Map(), azimuth: -0.94, elevation: 0.67, zoom: 1, bounds: null, charts: [], requestDraw: true };
  const scene = $("scene");
  const sceneContext = scene.getContext("2d");
  const plotDefinitions = [
    { id: "position-plot", group: "errors", key: "position_norm", logarithmic: false, color: COLORS.teal },
    { id: "velocity-plot", group: "errors", key: "velocity_norm", logarithmic: true, color: COLORS.teal },
    { id: "gravity-plot", group: "errors", key: "gravity_norm", logarithmic: true, color: COLORS.teal },
    { id: "tilt-plot", group: "errors", key: "tilt_deg", logarithmic: true, color: COLORS.teal },
    { id: "pe-plot", group: "diagnostics", key: "pe_lambda_min", logarithmic: false, color: COLORS.gold }
  ];
  function finite(value) { return typeof value === "number" && Number.isFinite(value); }
  async function readJSON(url) {
    if (window.VIO_DATA && Object.prototype.hasOwnProperty.call(window.VIO_DATA, url)) return window.VIO_DATA[url];
    const response = await fetch(url);
    if (!response.ok) throw new Error("Simulation data returned HTTP " + response.status + ".");
    return response.json();
  }
  function format(value, digits) {
    if (!finite(value)) return "—";
    const a = Math.abs(value);
    if (a === 0) return "0";
    if (a < 0.001 || a >= 10000) return value.toExponential(1).replace("e+", "e");
    return value.toFixed(digits === undefined ? (a < 1 ? 3 : a < 100 ? 2 : 1) : digits);
  }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { const length = Math.hypot.apply(null, a); return scale(a, 1 / (length || 1)); }
  function rotateQuaternion(vector, quaternion) {
    if (!quaternion || quaternion.length !== 4) return vector.slice();
    const norm = Math.hypot.apply(null, quaternion) || 1;
    const q = quaternion.map(function (v) { return v / norm; });
    const xyz = q.slice(0, 3);
    const uv = cross(xyz, vector);
    return add(vector, add(scale(uv, 2 * q[3]), scale(cross(xyz, uv), 2)));
  }
  function fitCanvas(canvas) {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: w, height: h, context: context };
  }
  function setPlaying(playing) {
    state.playing = !!playing;
    $("play-icon").textContent = playing ? "Ⅱ" : "▶";
    $("play-label").textContent = playing ? "Pause" : "Play";
    $("play-button").setAttribute("aria-label", playing ? "Pause simulation" : "Play simulation");
    state.lastFrame = 0;
  }
  function setIndex(index, updateTime) {
    if (!state.run) return;
    state.index = clamp(Math.round(index), 0, state.run.time.length - 1);
    if (updateTime !== false) state.time = state.run.time[state.index];
    $("timeline").value = state.index;
    $("current-time").textContent = state.run.time[state.index].toFixed(2) + " s";
    $("timeline").setAttribute("aria-valuetext", state.run.time[state.index].toFixed(2) + " seconds");
    const e = state.run.errors, d = state.run.diagnostics || {}, i = state.index;
    $("position-value").textContent = format(e.position_norm ? e.position_norm[i] : null);
    $("velocity-value").textContent = format(e.velocity_norm[i]);
    $("gravity-value").textContent = format(e.gravity_norm[i]);
    $("tilt-value").textContent = format(e.tilt_deg[i]);
    const pe = d.pe_lambda_min ? d.pe_lambda_min[i] : null;
    $("pe-value").textContent = finite(pe) && Math.abs(pe) < 1e-12 ? "≈0" : format(pe);
    const windowLength = state.run.meta.pe_window_s || state.manifest.sampling.pe_window_s;
    $("pe-window-note").textContent = finite(pe) ? windowLength.toFixed(2) + " s window · true geometry" : "Available after " + windowLength.toFixed(2) + " s";
    state.requestDraw = true;
  }
  function findTimeIndex(time) {
    const values = state.run.time;
    let a = 0, b = values.length - 1;
    while (a < b) { const mid = Math.ceil((a + b) / 2); if (values[mid] <= time) a = mid; else b = mid - 1; }
    return a;
  }
  function setBusy(busy) {
    $("loading-state").hidden = !busy;
    ["case-select", "count-select", "noise-select", "trial-select", "json-download", "csv-download", "play-button", "timeline"].forEach(function (id) { $(id).disabled = busy; });
  }
  function showError(error) {
    setBusy(false);
    $("error-banner").hidden = false;
    $("error-banner").textContent = "The simulation data could not be loaded. " + error.message + " Use the complete offline viewer or serve the demo folder locally.";
    $("play-button").disabled = true;
    $("json-download").disabled = true;
    $("csv-download").disabled = true;
    $("live-status").textContent = "Simulation data could not be loaded.";
  }
  function experimentEntries() { return state.experiments.datasets || state.experiments.runs || []; }
  function currentCase() { return state.manifest.cases.find(function (c) { return c.id === $("case-select").value; }); }
  function availableRuns() {
    if (state.study === 'ideal') return currentCase().runs;
    return experimentEntries().filter(function (r) { return r.study === state.study && r.case_id === $("case-select").value && r.noise_id === $("noise-select").value; });
  }
  function setStudy(study) {
    state.study = study;
    document.querySelectorAll('[data-study]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.study === study)); });
    const ideal = study === 'ideal', recovery = study === 'recovery';
    $("landmarks-toggle").checked = ideal;
    $("noise-field").hidden = ideal; $("trial-field").hidden = ideal;
    $("position-metric").hidden = ideal; $("pe-metric").hidden = !ideal;
    $("position-row").hidden = ideal; $("pe-row").hidden = !ideal;
    $("scale-select").value = study === 'odometry' ? 'linear' : 'log';
    $("diagnostics-heading").textContent = ideal ? 'Convergence & excitation' : recovery ? 'Recovery across trials' : 'Noise & drift';
    $("study-description").textContent = ideal ? 'These deterministic experiments compare landmark geometry and motion, including a deliberately unobservable straight-line case.' : recovery ? 'Velocity, gravity, and attitude start with random errors. The plots separate the recovery transient from the errors that remain under measurement noise.' : 'Position, attitude, velocity, and gravity start at their true values. Noise then determines the subsequent estimation error.';
    const previous = $("case-select").value || 'figure8';
    $("case-select").replaceChildren();
    state.manifest.cases.filter(function (entry) { return ideal || experimentEntries().some(function (r) { return r.case_id === entry.id; }); }).forEach(function (entry) {
      const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.label; $("case-select").append(option);
    });
    $("case-select").value = Array.from($("case-select").options).some(function (o) { return o.value === previous; }) ? previous : 'figure8';
    updateCounts(); loadRun();
  }
  function updateCounts() {
    const previous = Number($("count-select").value) || 8;
    const runs = availableRuns().slice().sort(function (a, b) { return a.landmark_count - b.landmark_count; });
    $("count-select").replaceChildren();
    runs.forEach(function (run) {
      const option = document.createElement("option");
      option.value = run.landmark_count;
      option.textContent = run.landmark_count;
      $("count-select").append(option);
    });
    const available = runs.map(function (r) { return r.landmark_count; });
    $("count-select").value = available.includes(previous) ? previous : available[0];
  }
  async function loadRun() {
    setPlaying(false);
    const token = ++state.token;
    const selectedCase = currentCase();
    const selectedRun = availableRuns().find(function (r) { return r.landmark_count === Number($("count-select").value); });
    setBusy(true);
    $("error-banner").hidden = true;
    $("case-description").textContent = selectedCase.description;
    try {
      if (!selectedRun) throw new Error('This combination is not available.');
      let run = state.cache.get(selectedRun.url);
      if (!run) {
        run = await readJSON(selectedRun.url);
        state.cache.set(selectedRun.url, run);
      }
      if (token !== state.token) return;
      if (!run.time || run.time.length < 2 || !run.truth || !run.estimate) throw new Error("The run format is incomplete.");
      state.dataset = run;
      state.runURL = selectedRun.url;
      $("timeline").max = run.time.length - 1;
      $("duration-label").textContent = run.time[run.time.length - 1].toFixed(2) + " s";
      $("landmark-label").textContent = run.landmarks.length + (run.landmarks.length === 1 ? " LANDMARK" : " LANDMARKS");
      $("trial-select").replaceChildren();
      const trials = run.trials && run.trials.length ? run.trials : [run];
      trials.forEach(function (trial, k) { const option = document.createElement('option'); option.value = k; option.textContent = 'Trial ' + (k + 1); $("trial-select").append(option); });
      $("trial-select").value = '0';
      selectTrial(false);
      setBusy(false);
      $("live-status").textContent = selectedCase.label + ", " + run.landmarks.length + " landmarks, loaded.";
    } catch (error) { if (token === state.token) showError(error); }
  }
  function selectTrial(keepTime) {
    const data = state.dataset, selected = Number($("trial-select").value) || 0;
    const trial = data.trials && data.trials.length ? data.trials[selected] : data;
    state.run = Object.assign({}, data, { estimate: trial.estimate || data.estimate, errors: trial.errors || data.errors });
    if (!state.run.errors.position_norm) state.run.errors = Object.assign({}, state.run.errors, { position_norm: state.run.truth.position.map(function (p, i) { return Math.hypot.apply(null, sub(p, state.run.estimate.position[i])); }) });
    const ensemble = data.ensemble, count = ensemble ? ensemble.trial_count : 1;
    $("trial-summary").textContent = count > 1 ? count + ' seeded trials · first ' + (data.trials ? data.trials.length : 1) + ' available for playback' : 'One deterministic reference run';
    $("trial-legend").textContent = 'Trial ' + (selected + 1);
    $("band-legend").hidden = !ensemble || count <= 1;
    $("metric-context").textContent = 'Errors for the displayed trial' + (state.study === 'ideal' ? '' : ' · trial ' + (selected + 1));
    $("scene-note").textContent = state.study === 'odometry' ? 'The true and estimated trajectories share the initial frame. The raw estimate is shown without alignment; subsequent position and yaw drift remain visible.' : state.study === 'recovery' ? 'Both positions start at the origin, but attitude, velocity, and gravity are initially perturbed. Position overlap is not a convergence guarantee; the raw transient and remaining yaw freedom are visible.' : 'The observer does not recover global translation or yaw. These position traces include an initial offset and are shown without alignment.';
    updateSettings(); computeBounds(); prepareCharts(); setIndex(keepTime ? state.index : 0);
  }
  function updateSettings() {
    const ideal = state.study === 'ideal', data = state.dataset, ensemble = data.ensemble;
    const text = ideal ? [
      'Exact continuous IMU and spherical-camera measurements; no measurement noise. The stored 0.05 s interval is a playback interval, not a camera sampling rate.',
      'The initial velocity, gravity, attitude, and position errors are fixed across landmark-count comparisons. The straight-line case deliberately violates the excitation condition.',
      'Excitation uses true geometry over complete 4π s windows. The deterministic Riccati matrix selects gains; it is not a statistical covariance.'
    ] : [
      'The motion and landmarks are translated together so the true and estimated initial positions are both zero. Odometry starts at the exact full state. For recovery, initial body-frame velocity and gravity errors have per-component standard deviations of 3 m/s and 1.5 m/s²; attitude uses a Gaussian rotation vector with 15° per component.',
      'Nominal smooth colored noise: a Cartesian bearing perturbation with component standard deviation 0.001 before normalization (0.2–2 Hz; approximately 1.4 mrad angular RMS), gyroscope 0.002 rad/s and accelerometer 0.02 m/s² per component (0.2–5 Hz). Elevated noise multiplies all amplitudes by four. Eight Gaussian-weighted sine/cosine frequencies define each noise process.',
      'Bearing and optical flow are perturbed consistently: flow is the exact derivative of the normalized noisy bearing. This is a continuous synthetic sensor model, with no bias, pixel processing, feature dropout, or finite field of view.',
      (ensemble && ensemble.trial_count > 1 ? ensemble.trial_count + ' seeded trials. Bands are pointwise empirical 5th–95th percentiles of error norms; the solid line is their median. Playback uses the first fixed trials, without selecting a favorable result. Noise paths and initial draws are paired across landmark counts and noise amplitudes.' : 'Noise-free odometry uses one deterministic exact-initialization reference. There is no statistical band for this run.'),
      'Position is evaluated in the common initial frame without subsequent alignment. Global yaw and translation remain unobservable. These finite-duration experiments assess sensitivity to the specified perturbations; they do not establish a stochastic stability guarantee.'
    ];
    const common = 'All cases use P(0) = I₆, S = 30 I₆, visual weight 5 per feature, and attitude gain 1.5. More features also increase the total visual weight.';
    const exact = ideal ? [
      'Fixed initial errors: R₀ xᵥ(0) = (−1.5, 1, −0.6) m/s and R₀ x_g(0) = (0.35, −0.2, 0.5) m/s², where xᵥ = vB − v̂B and x_g = gB − ĝB. R̂₀ = Exp([(π/180)(40, −30, 55)]×)R₀ and p̂₀ = p₀ + (0.8, −1, 0.5) m.',
      'Integration: DOP853, relative tolerance 2×10⁻⁹, absolute tolerance 2×10⁻¹¹, maximum step 0.05 s; saved output every 0.05 s. Landmark seed: 20261025.'
    ] : [
      'Noise definition for each independent three-component process: n(t) = (σ/√8) Σₖ₌₁⁸ [Aₖ cos(2πfₖt) + Bₖ sin(2πfₖt)], with independent Aₖ, Bₖ ∼ N(0, I₃). Camera frequencies: fₖ = 0.2·10^((k−1)/7) Hz; IMU frequencies: fₖ = 0.2·25^((k−1)/7) Hz. Coefficients are drawn once before integration.',
      'Camera measurements: bₘ = (b + η)/‖b + η‖ and ḃₘ = (I₃ − bₘbₘᵀ)(ḃ + η̇)/‖b + η‖. IMU measurements: ωₘ = ω + nω and aₘ = a + na. The observer forms sₘ = ḃₘ + ωₘ × bₘ. The selected profile is ' + data.meta.noise_label.toLowerCase() + '; no noise sets every amplitude to zero.',
      'Recovery initialization: independent δv ∼ N(0, 3²I₃) m/s, δg ∼ N(0, 1.5²I₃) m/s², and δθ ∼ N(0, (15π/180)²I₃) rad. R̂₀ = Exp(δθ×)R₀, v̂B,₀ = R₀ᵀ(v₀ + δv), ĝB,₀ = R₀ᵀ(g + δg), and p̂₀ = p₀ = 0. Matched odometry sets all three perturbations to zero.',
      'Seed convention: base seed 20261027, trial IDs 1–100, independent streams camera = 1, gyroscope = 2, acceleration = 3, initialization = 99. Each stream uses NumPy SeedSequence([base seed, trial ID, stream]) with the default PCG64 generator. All 20 landmark-noise paths are drawn before selecting a nested feature set. Landmark seed: 20261025.',
      'Within each sensor stream, all cosine coefficients are drawn first, then all sine coefficients: camera arrays have order frequency × landmark × Cartesian component (8 × 20 × 3), and IMU arrays have order frequency × Cartesian component (8 × 3). Initialization draws δv, then δg, then δθ.',
      'Integration: classical fourth-order Runge–Kutta, step 0.01 s, saved output every 0.1 s. Measurements are evaluated at the integration stages; these intervals are not sensor sampling rates. The quaternion is normalized after each completed step. Percentiles use linear interpolation across trials.'
    ];
    $("experiment-settings").replaceChildren(); text.concat(exact, [common]).forEach(function (line) { const p = document.createElement('p'); p.textContent = line; $("experiment-settings").append(p); });
    updateMotionSettings(data, ideal);
    $("sampling-note").textContent = data.time[data.time.length - 1] + ' s per run · continuous measurement model · fixed landmarks';
    const floor = $("scale-select").value === 'log' ? ' Log display floor: 10⁻⁸; original values remain in downloads.' : '';
    $("chart-note").textContent = (ideal ? 'The excitation curve uses true geometry and begins after a complete window. No statistical bands are used.' : ensemble && ensemble.trial_count > 1 ? 'Bands show pointwise variation across trials, not a confidence region for an individual trajectory. The dashed curve is the displayed trial.' : 'Exact initial state, noise-free measurements. Residual errors reflect numerical integration.') + floor + ' Click a plot to move the time cursor.';
    const rms = data.meta.summary && data.meta.summary.time_rms_position_norm;
    $("run-summary").hidden = !rms;
    if (rms) $("run-summary").textContent = 'Position RMS over the full run: ' + (ensemble.trial_count > 1 ? 'median ' : '') + format(rms.median) + ' m' + (ensemble.trial_count > 1 ? ' · 5th–95th percentiles ' + format(rms.p05) + '–' + format(rms.p95) + ' m.' : '.') + ' A final position error alone can hide drift along a looping path.';
  }
  function updateMotionSettings(data, ideal) {
    const container = $("motion-settings");
    container.replaceChildren();
    function paragraph(parent, text, className) { const p = document.createElement('p'); p.textContent = text; if (className) p.className = className; parent.append(p); }
    paragraph(container, 'Time t is in seconds, position is in meters, and all attitude angles are in radians. The rotation maps body coordinates to inertial coordinates: R(t) = Rz(ψ(t)) Ry(θ(t)) Rx(φ(t)).');
    const schedules = [
      { id: 'circle', name: 'Circular orbit', p: 'p_ref(t) = (3 cos(0.5t), 3 sin(0.5t), 0)', angles: ['φ(t) = 0.12 sin(0.6t)', 'θ(t) = 0.10 cos(0.4t)', 'ψ(t) = 0.5t + 0.3'] },
      { id: 'figure8', name: 'Spatial figure eight', p: 'p_ref(t) = (3 cos(0.5t), 2 sin(t), 1.2 sin(0.35t))', angles: ['φ(t) = 0.16 sin(0.6t)', 'θ(t) = 0.13 cos(0.45t)', 'ψ(t) = 0.28 sin(0.25t) + 0.15t'] },
      { id: 'straight', name: 'Straight translation', p: 'p_ref(t) = (−6 + 0.3t, −1, 0.5)', angles: ['φ(t) = 0.12 sin(0.7t)', 'θ(t) = 0.10 cos(0.35t)', 'ψ(t) = 0.25 sin(0.45t) + 0.5'] }
    ];
    const grid = document.createElement('div'); grid.className = 'motion-grid';
    schedules.forEach(function (schedule) {
      const card = document.createElement('section'); card.className = 'motion-card' + (schedule.id === data.meta.case_id ? ' selected-motion' : '');
      const heading = document.createElement('h3'); heading.textContent = schedule.name + (schedule.id === data.meta.case_id ? ' · selected' : ''); card.append(heading);
      paragraph(card, schedule.p, 'motion-formula'); schedule.angles.forEach(function (angle) { paragraph(card, angle, 'motion-formula'); });
      if (schedule.id === 'straight') paragraph(card, 'Available in Excitation examples.');
      grid.append(card);
    });
    container.append(grid);
    paragraph(container, ideal ? 'Selected study: p(t) = p_ref(t). The landmark coordinates below use the same inertial frame. The initial position estimate has the specified fixed offset.' : 'Selected study: p(t) = p_ref(t) − p_ref(0), so p(0) = p̂(0) = 0. The same origin shift is applied to every landmark. It changes neither the bearings nor the optical flow.');
    paragraph(container, 'The true velocity is v = ṗ. Gravity is g = +9.81 e₃ m/s². Angular rate and specific acceleration are obtained from the prescribed motion: ω = (RᵀṘ)∨ and a = Rᵀ(p̈ − g). Here ∨ maps a skew-symmetric matrix to its axial vector. The camera and IMU origins and axes coincide.');
    paragraph(container, 'The scene is fixed and feature sets are nested. Selected coordinates are listed below in the frame used by the playback data. Bearings are omnidirectional; no image rendering, finite field of view, occlusion, or feature turnover is simulated.');
    const details = document.createElement('details'); details.className = 'landmark-details';
    const summary = document.createElement('summary'); summary.textContent = 'Landmark coordinates for this selection (' + data.landmarks.length + ' points)'; details.append(summary);
    const table = document.createElement('table');
    const head = document.createElement('thead'), headRow = document.createElement('tr');
    ['Point', 'x (m)', 'y (m)', 'z (m)'].forEach(function (label) { const th = document.createElement('th'); th.textContent = label; headRow.append(th); });
    head.append(headRow); table.append(head);
    const body = document.createElement('tbody');
    data.landmarks.forEach(function (point, i) { const row = document.createElement('tr'); [i + 1].concat(point).forEach(function (value) { const td = document.createElement('td'); td.textContent = String(value); row.append(td); }); body.append(row); });
    table.append(body); details.append(table); container.append(details);
  }
  function computeBounds() {
    $("landmark-legend").hidden = !$("landmarks-toggle").checked && !$("rays-toggle").checked;
    const points = state.run.truth.position.slice();
    if ($("landmarks-toggle").checked || $("rays-toggle").checked) points.push.apply(points, state.run.landmarks);
    if ($("estimate-toggle").checked) points.push.apply(points, state.run.estimate.position);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    points.forEach(function (p) { if (p && p.every(finite)) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); } });
    const center = min.map(function (v, k) { return (v + max[k]) / 2; });
    const radius = Math.max(1, Math.hypot.apply(null, sub(max, min)) / 2);
    state.bounds = { min: min, max: max, center: center, radius: radius };
  }
  function makeProjector(width, height) {
    const b = state.bounds, ce = Math.cos(state.elevation);
    const direction = [ce * Math.cos(state.azimuth), ce * Math.sin(state.azimuth), Math.sin(state.elevation)];
    const forward = scale(direction, -1);
    const right = unit(cross(forward, [0, 0, 1]));
    const up = cross(right, forward);
    const distance = b.radius * 3.6 / state.zoom;
    const focal = Math.min(width, height) * 1.65;
    return function (point) {
      const relative = sub(point, b.center);
      const depth = dot(relative, forward) + distance;
      if (depth < b.radius * 0.03) return null;
      return [width * 0.5 + focal * dot(relative, right) / depth, height * 0.49 - focal * dot(relative, up) / depth, depth];
    };
  }
  function strokeWorld(points, project, color, width, dash, close) {
    const ctx = sceneContext;
    ctx.beginPath();
    let started = false;
    points.forEach(function (point) {
      const p = project(point);
      if (!p) { started = false; return; }
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
    });
    if (close) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
  }
  function niceStep(span) {
    const desired = Math.max(span / 7, 0.1);
    const base = Math.pow(10, Math.floor(Math.log10(desired)));
    const fraction = desired / base;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * base;
  }
  function drawGrid(project) {
    const b = state.bounds, step = niceStep(Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]));
    const x0 = Math.floor(b.min[0] / step) * step, x1 = Math.ceil(b.max[0] / step) * step;
    const y0 = Math.floor(b.min[1] / step) * step, y1 = Math.ceil(b.max[1] / step) * step;
    const z = Math.min(0, b.min[2]);
    const ctx = sceneContext;
    for (let x = x0; x <= x1 + step * 0.1; x += step) strokeWorld([[x, y0, z], [x, y1, z]], project, "#dce6df", 0.7);
    for (let y = y0; y <= y1 + step * 0.1; y += step) strokeWorld([[x0, y, z], [x1, y, z]], project, "#dce6df", 0.7);
    ctx.fillStyle = "#9daea9"; ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "center";
    for (let x = x0; x <= x1 + step * 0.1; x += step) {
      const p = project([x, y0, z]); if (p) ctx.fillText(Number(x.toFixed(2)), p[0], p[1] + 12);
    }
    const origin = [x0, y0, z], length = Math.max(step, b.radius * 0.18);
    [[length, 0, 0, "#bd7664", "x"], [0, length, 0, "#278f7e", "y"], [0, 0, length, "#5f82ae", "z"]].forEach(function (a) {
      const endpoint = add(origin, a.slice(0, 3));
      strokeWorld([origin, endpoint], project, a[3], 1.5);
      const p = project(endpoint); if (p) { ctx.fillStyle = a[3]; ctx.fillText(a[4], p[0] + 7, p[1] - 5); }
    });
  }
  function drawVehicle(position, quaternion, color, project, label) {
    if (!position || !quaternion) return;
    const ctx = sceneContext, arm = state.bounds.radius * 0.042;
    function world(local) { return add(position, rotateQuaternion(local, quaternion)); }
    strokeWorld([world([-arm, 0, 0]), world([arm, 0, 0])], project, color, 2.7);
    strokeWorld([world([0, -arm, 0]), world([0, arm, 0])], project, color, 2.7);
    [[arm, 0, 0], [-arm, 0, 0], [0, arm, 0], [0, -arm, 0]].forEach(function (center) {
      const ring = [];
      for (let j = 0; j <= 24; j++) { const angle = j * Math.PI / 12; ring.push(world(add(center, [arm * 0.36 * Math.cos(angle), arm * 0.36 * Math.sin(angle), 0]))); }
      strokeWorld(ring, project, color, 1.5);
    });
    const center = project(position);
    if (center) {
      ctx.fillStyle = "#fff"; ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(center[0], center[1], 3.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(label, center[0] + 11, center[1] + (label === 'estimate' ? 16 : -12));
    }
    const nose = project(world([arm * 1.4, 0, 0]));
    if (nose) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(nose[0], nose[1], 2.2, 0, 2 * Math.PI); ctx.fill(); }
  }
  function drawScene() {
    const size = fitCanvas(scene), ctx = size.context;
    ctx.clearRect(0, 0, size.width, size.height);
    if (!state.run || !state.bounds) return;
    const project = makeProjector(size.width, size.height), run = state.run, i = state.index;
    drawGrid(project);
    strokeWorld(run.truth.position, project, "#158b8040", 1.2);
    strokeWorld(run.truth.position.slice(0, i + 1), project, COLORS.teal, 2);
    if ($("estimate-toggle").checked) {
      strokeWorld(run.estimate.position, project, "#cc715e40", 1.1, [4, 4]);
      strokeWorld(run.estimate.position.slice(0, i + 1), project, COLORS.coral, 1.6, [4, 4]);
    }
    const start = project(run.truth.position[0]);
    if (start) {
      ctx.beginPath(); ctx.arc(start[0], start[1], 4.5, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = COLORS.ink; ctx.stroke();
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.fillStyle = COLORS.ink; ctx.textAlign = 'right';
      ctx.fillText(state.study === 'ideal' ? 'true start' : 'shared start', start[0] - 9, start[1] + 15);
    }
    if ($("rays-toggle").checked) run.landmarks.forEach(function (p) { strokeWorld([run.truth.position[i], p], project, "#bd994b55", 0.8, [3, 4]); });
    const landmarks = run.landmarks.map(function (p, k) { return { point: project(p), index: k }; }).filter(function (p) { return p.point; }).sort(function (a, b) { return b.point[2] - a.point[2]; });
    if ($("landmarks-toggle").checked || $("rays-toggle").checked) landmarks.forEach(function (item) {
      const p = item.point;
      ctx.fillStyle = COLORS.gold; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p[0], p[1], 4.2, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (run.landmarks.length <= 8) { ctx.fillStyle = "#9f874d"; ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "left"; ctx.fillText("P" + (item.index + 1), p[0] + 7, p[1] - 5); }
    });
    if ($("estimate-toggle").checked) drawVehicle(run.estimate.position[i], run.estimate.quaternion_xyzw[i], COLORS.coral, project, "estimate");
    drawVehicle(run.truth.position[i], run.truth.quaternion_xyzw[i], COLORS.teal, project, "true");
  }
  function prepareCharts() {
    state.charts = plotDefinitions.filter(function (definition) { return state.study === 'ideal' ? definition.key !== 'position_norm' : definition.key !== 'pe_lambda_min'; }).map(function (definition) {
      const values = state.run[definition.group][definition.key];
      const ensemble = state.dataset.ensemble;
      const band = ensemble && ensemble.trial_count > 1 && ensemble.metrics ? ensemble.metrics[definition.key] : null;
      const logarithmic = definition.key !== 'pe_lambda_min' && $("scale-select").value === 'log';
      const positive = values.concat(band ? band.p95 : []).filter(function (v) { return finite(v) && v > 0; });
      let low, high;
      if (logarithmic) {
        high = positive.length ? Math.ceil(Math.log10(Math.max.apply(null, positive))) : 0;
        const lower = values.concat(band ? band.p05 : []).filter(function (v) { return finite(v) && v > 0; });
        low = lower.length ? Math.max(-8, Math.floor(Math.log10(Math.min.apply(null, lower)))) : -8;
        if (high <= low) high = low + 1;
      } else {
        low = 0;
        const maximum = positive.length ? Math.max.apply(null, positive) : 0;
        high = Math.max(maximum * 1.12, definition.key === 'pe_lambda_min' ? 1e-6 : 1e-5);
      }
      $(definition.id).setAttribute('aria-label', definition.key.replaceAll('_', ' ') + ' versus time, ' + (logarithmic ? 'logarithmic' : 'linear') + ' scale' + (band ? ', median, empirical 5th to 95th percentiles, and displayed trial' : ''));
      return Object.assign({}, definition, { logarithmic: logarithmic, canvas: $(definition.id), values: values, band: band, low: low, high: high });
    });
  }
  const superscripts = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  function logLabel(value) { return "10" + String(value).split("").map(function (c) { return superscripts[c] || c; }).join(""); }
  function drawChart(chart) {
    const size = fitCanvas(chart.canvas), ctx = size.context, width = size.width, height = size.height;
    ctx.clearRect(0, 0, width, height);
    const pad = { left: 43, right: 9, top: 9, bottom: 23 }, plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const duration = state.run.time[state.run.time.length - 1], start = state.run.time[0];
    const mapX = function (time) { return pad.left + (time - start) / (duration - start) * plotW; };
    const mapY = function (value) {
      let v = chart.logarithmic ? Math.log10(Math.max(value, Math.pow(10, chart.low))) : value;
      return pad.top + (chart.high - clamp(v, chart.low, chart.high)) / (chart.high - chart.low) * plotH;
    };
    ctx.lineWidth = 0.7; ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    let ticks = [];
    if (chart.logarithmic) {
      const step = Math.max(1, Math.ceil((chart.high - chart.low) / 3));
      for (let y = chart.high; y >= chart.low; y -= step) ticks.push(y);
      if (ticks[ticks.length - 1] !== chart.low) ticks.push(chart.low);
    } else ticks = [chart.high, chart.high / 2, 0];
    ticks.forEach(function (tick) {
      const y = pad.top + (chart.high - tick) / (chart.high - chart.low) * plotH;
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = COLORS.muted; ctx.fillText(chart.logarithmic ? logLabel(tick) : format(tick), pad.left - 7, y);
    });
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let j = 0; j <= 4; j++) {
      const time = start + (duration - start) * j / 4, x = mapX(time);
      ctx.strokeStyle = "#eef2ef"; ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, height - pad.bottom); ctx.stroke();
      ctx.fillStyle = COLORS.muted; ctx.fillText(time.toFixed(0) + (j === 4 ? " s" : ""), x, height - 7);
    }
    if (chart.key === 'pe_lambda_min') {
      const first = chart.values.findIndex(finite);
      if (first > 0) {
        const end = mapX(state.run.time[first]);
        ctx.fillStyle = "#e9eee940"; ctx.fillRect(pad.left, pad.top, end - pad.left, plotH);
        if (end - pad.left > 65) { ctx.fillStyle = "#a5afa9"; ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.fillText("window forming", (pad.left + end) / 2, pad.top + plotH * 0.57); }
      }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.left - 1, pad.top - 1, plotW + 2, plotH + 2); ctx.clip();
    if (chart.band) {
      ctx.beginPath();
      chart.band.p95.forEach(function (v, i) { const x = mapX(state.run.time[i]), y = mapY(v); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      for (let i = chart.band.p05.length - 1; i >= 0; i--) ctx.lineTo(mapX(state.run.time[i]), mapY(chart.band.p05[i]));
      ctx.closePath(); ctx.fillStyle = '#d5eae4'; ctx.fill();
    }
    function trace(values, color, dash, lineWidth) {
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.setLineDash(dash); ctx.beginPath(); let started = false;
      values.forEach(function (value, i) { if (!finite(value)) { started = false; return; } const x = mapX(state.run.time[i]), y = mapY(value); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (chart.band) trace(chart.band.median, chart.color, [], 1.7);
    trace(chart.values, chart.band ? COLORS.coral : chart.color, chart.band ? [4, 3] : [], chart.band ? 1.15 : 1.6);
    const cursorX = mapX(state.run.time[state.index]);
    ctx.strokeStyle = "#304b5a65"; ctx.lineWidth = 0.8; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(cursorX, pad.top); ctx.lineTo(cursorX, height - pad.bottom); ctx.stroke(); ctx.setLineDash([]);
    const current = chart.values[state.index];
    if (finite(current)) { ctx.beginPath(); ctx.arc(cursorX, mapY(current), 3, 0, 2 * Math.PI); ctx.fillStyle = chart.band ? COLORS.coral : chart.color; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.restore();
  }
  function exportBlob(content, mime, name) {
    const blob = new Blob([content], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exportCSV() {
    const run = state.run, columns = [{ title: "time_s", get: function (i) { return run.time[i]; } }];
    ["truth", "estimate"].forEach(function (group) {
      [["position", ["x_m", "y_m", "z_m"]], ["quaternion_xyzw", ["qx", "qy", "qz", "qw"]], ["velocity_body", ["x_mps", "y_mps", "z_mps"]], ["gravity_body", ["x_mps2", "y_mps2", "z_mps2"]]].forEach(function (entry) {
        entry[1].forEach(function (axis, j) { columns.push({ title: group + "_" + entry[0] + "_" + axis, get: function (i) { return run[group][entry[0]][i][j]; } }); });
      });
    });
    ["velocity_body", "gravity_body"].forEach(function (key) { ["x", "y", "z"].forEach(function (axis, j) { columns.push({ title: "error_" + key + "_" + axis, get: function (i) { return run.errors[key][i][j]; } }); }); });
    ["position_norm", "velocity_norm", "gravity_norm", "tilt_deg"].forEach(function (key) { columns.push({ title: "displayed_trial_" + key, get: function (i) { return run.errors[key][i]; } }); });
    ["pe_lambda_min", "observability_lambda_min", "riccati_lambda_min", "riccati_lambda_max", "position_group_error_norm"].forEach(function (key) { if (run.diagnostics && run.diagnostics[key]) columns.push({ title: key, get: function (i) { return run.diagnostics[key][i]; } }); });
    if (state.dataset.ensemble && state.dataset.ensemble.metrics) Object.entries(state.dataset.ensemble.metrics).forEach(function (entry) { ['p05', 'median', 'p95'].forEach(function (q) { columns.push({ title: 'ensemble_' + entry[0] + '_' + q, get: function (i) { return entry[1][q][i]; } }); }); });
    const lines = [columns.map(function (c) { return c.title; }).join(",")];
    run.time.forEach(function (_, i) { lines.push(columns.map(function (c) { const v = c.get(i); return finite(v) ? v : ""; }).join(",")); });
    exportBlob(lines.join("\n"), "text/csv;charset=utf-8", exportName() + ".csv");
  }
  function exportName() { return state.study + '-' + state.run.meta.case_id + '-n' + state.run.landmarks.length + (state.study === 'ideal' ? '' : '-' + $("noise-select").value + '-trial' + (Number($("trial-select").value) + 1)); }
  function animate(timestamp) {
    if (state.playing && state.run) {
      const elapsed = state.lastFrame ? Math.min((timestamp - state.lastFrame) / 1000, 0.1) : 0;
      state.time += elapsed * Number($("speed-select").value);
      const last = state.run.time[state.run.time.length - 1];
      if (state.time >= last) { state.time = last; setPlaying(false); }
      setIndex(findTimeIndex(state.time), false);
    }
    state.lastFrame = timestamp;
    if (state.requestDraw && timestamp - state.lastDraw > 28) {
      drawScene();
      if (state.run) state.charts.forEach(drawChart);
      state.lastDraw = timestamp; state.requestDraw = false;
    }
    requestAnimationFrame(animate);
  }
  const pointers = new Map();
  let pinchDistance = 0;
  scene.addEventListener("pointerdown", function (event) { pointers.set(event.pointerId, [event.clientX, event.clientY]); scene.setPointerCapture(event.pointerId); if (pointers.size === 2) { const p = Array.from(pointers.values()); pinchDistance = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]); } });
  scene.addEventListener("pointermove", function (event) {
    const old = pointers.get(event.pointerId); if (!old) return;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1) { state.azimuth -= (event.clientX - old[0]) * 0.007; state.elevation = clamp(state.elevation + (event.clientY - old[1]) * 0.006, 0.06, 1.48); }
    else if (pointers.size === 2) { const p = Array.from(pointers.values()); const distance = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]); if (pinchDistance > 0) state.zoom = clamp(state.zoom * distance / pinchDistance, 0.4, 3); pinchDistance = distance; }
    state.requestDraw = true;
  });
  function releasePointer(event) { pointers.delete(event.pointerId); pinchDistance = 0; }
  scene.addEventListener("pointerup", releasePointer); scene.addEventListener("pointercancel", releasePointer);
  scene.addEventListener("wheel", function (event) { event.preventDefault(); state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.001), 0.4, 3); state.requestDraw = true; }, { passive: false });
  $("reset-view").addEventListener("click", function () { state.azimuth = -0.94; state.elevation = 0.67; state.zoom = 1; state.requestDraw = true; });
  $("estimate-toggle").addEventListener("change", function () { $("estimate-legend").hidden = !$("estimate-toggle").checked; if (state.run) computeBounds(); state.requestDraw = true; });
  $("rays-toggle").addEventListener("change", function () { if (state.run) computeBounds(); state.requestDraw = true; });
  $("landmarks-toggle").addEventListener("change", function () { if (state.run) computeBounds(); state.requestDraw = true; });
  $("play-button").addEventListener("click", function () { if (!state.run) return; if (state.index >= state.run.time.length - 1) setIndex(0); setPlaying(!state.playing); });
  $("timeline").addEventListener("input", function () { setPlaying(false); setIndex(Number($("timeline").value)); });
  $("case-select").addEventListener("change", function () { updateCounts(); loadRun(); });
  $("count-select").addEventListener("change", loadRun);
  $("noise-select").addEventListener("change", function () { updateCounts(); loadRun(); });
  $("trial-select").addEventListener("change", function () { setPlaying(false); selectTrial(true); });
  $("scale-select").addEventListener("change", function () { if (state.run) { updateSettings(); prepareCharts(); state.requestDraw = true; } });
  document.querySelectorAll('[data-study]').forEach(function (button) { button.addEventListener('click', function () { if (state.manifest && state.experiments) setStudy(button.dataset.study); }); });
  $("json-download").addEventListener("click", function () { if (state.run) exportBlob(JSON.stringify(Object.assign({}, state.dataset, { exported_displayed_trial: Number($("trial-select").value) + 1 })), "application/json", exportName() + ".json"); });
  $("csv-download").addEventListener("click", function () { if (state.run) exportCSV(); });
  plotDefinitions.forEach(function (definition) {
    const canvas = $(definition.id);
    function scrub(event) { if (!state.run) return; const box = canvas.getBoundingClientRect(); const fraction = clamp((event.clientX - box.left - 43) / (box.width - 52), 0, 1); setPlaying(false); setIndex(findTimeIndex(state.run.time[0] + fraction * (state.run.time[state.run.time.length - 1] - state.run.time[0]))); }
    canvas.addEventListener("pointerdown", function (event) { canvas.setPointerCapture(event.pointerId); scrub(event); });
    canvas.addEventListener("pointermove", function (event) { if (canvas.hasPointerCapture(event.pointerId)) scrub(event); });
  });
  new ResizeObserver(function () { state.requestDraw = true; }).observe(document.querySelector(".explorer-grid"));
  window.addEventListener("resize", function () { state.requestDraw = true; });
  requestAnimationFrame(animate);
  async function initialize() {
    try {
      const manifests = await Promise.all([readJSON("data/index.json"), readJSON("data/experiments/index.json")]);
      state.manifest = manifests[0]; state.experiments = manifests[1];
      $("noise-select").replaceChildren();
      [['none', 'None'], ['nominal', 'Nominal'], ['high', 'Elevated · 4×']].forEach(function (pair) { const option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; $("noise-select").append(option); });
      $("noise-select").value = 'nominal';
      setStudy('odometry');
    } catch (error) { showError(error); }
  }
  initialize();
}());
