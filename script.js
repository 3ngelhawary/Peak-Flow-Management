'use strict';

let chart = null;
let hydrograph = [];
let rafId = null;
let lastTs = null;
let simTime = 0;
let tankVolume = 0;
let maxTankVolume = 0;
let spillVolume = 0;       // tracks cumulative overflow volume
let peakInflow = 0;        // FIX4/5: peak total inflow seen during sim (m³/s)
let peakInflowTime = 0;    // FIX5: sim time (s) when peak inflow occurred
let simRunning = false;
let isPaused = false;      // distinguishes fresh start from resume
let simSpeed = 300;
let lastChartPush = 0;
let lastResultUpdate = 0;  // FIX3: throttle updateResultStrip
let hasRun = false;

const SCS_TYPE_II = [
  [0,0],[1,0.5],[2,1.1],[3,1.7],[4,2.4],[5,3.2],[6,4.0],
  [7,4.9],[8,6.0],[9,7.3],[10,9.0],[10.5,10.2],[11,11.7],
  [11.3,13.0],[11.5,14.1],[11.6,15.3],[11.7,17.7],[11.8,21.5],
  [11.9,28.4],[12,33.1],[12.1,34.1],[12.5,36.8],[13,38.6],
  [14,41.0],[15,42.7],[16,44.0],[17,45.1],[18,46.1],[19,46.9],
  [20,47.6],[21,48.2],[22,48.8],[23,49.4],[24,50]
];

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  bindControls();
  bindLinkedInputs();
  setMethodMode('rational');
});

function bindControls() {
  document.getElementById('method-select').addEventListener('change', e => setMethodMode(e.target.value));
  document.getElementById('play-btn').addEventListener('click', startSim);
  document.getElementById('pause-btn').addEventListener('click', pauseSim);
  document.getElementById('reset-btn').addEventListener('click', resetSim);
  document.querySelectorAll('input[name="simspeed"]').forEach(r => {
    r.addEventListener('change', () => { simSpeed = Number(r.value); });
  });
}

function bindLinkedInputs() {
  linkRangeAndPill('intensity', 'intensity-val', 5, 150, 0);
  linkRangeAndPill('runoff-c', 'c-val', 0.05, 1, 2);
  linkRangeAndPill('storm-depth', 'storm-depth-val', 5, 200, 0);
  linkRangeAndPill('curve-number', 'cn-val', 30, 98, 0);
  linkRangeAndPill('tc', 'tc-val', 10, 360, 0);  // Tc capped at 360 min for 24h storm
  linkRangeAndPill('direct-inflow-r', 'direct-inflow-r-val', 0, 500, 0);
  linkRangeAndPill('direct-inflow-s', 'direct-inflow-s-val', 0, 500, 0);
}

function linkRangeAndPill(rangeId, inputId, min, max, decimals) {
  const range = document.getElementById(rangeId);
  const input = document.getElementById(inputId);
  const format = value => Number(value).toFixed(decimals);
  const clamp = value => Math.min(max, Math.max(min, Number(value)));

  range.addEventListener('input', () => { input.value = format(range.value); });
  input.addEventListener('change', () => {
    const value = clamp(input.value || min);
    range.value = value;
    input.value = format(value);
  });
}

function setMethodMode(mode) {
  const isScs = mode === 'scs';
  document.getElementById('method-label').textContent = isScs ? 'SCS Curve Number' : 'Rational Method';
  document.getElementById('method-note').textContent = isScs
    ? 'SCS uses storm depth and Curve Number CN.'
    : 'Rational uses rainfall intensity and runoff coefficient C.';

  setControlGroupEnabled('rational-controls', !isScs);
  setControlGroupEnabled('scs-controls', isScs);

  const duration = document.getElementById('storm-duration');
  if (isScs) {
    duration.value = '1440';
    duration.disabled = true;
  } else {
    duration.disabled = false;
    if (duration.value === '1440') duration.value = '60';
  }

  resetSim();
}

function setControlGroupEnabled(groupId, enabled) {
  const group = document.getElementById(groupId);
  group.classList.toggle('inactive', !enabled);
  group.querySelectorAll('input, select, button').forEach(el => { el.disabled = !enabled; });
}

// startSim handles both fresh start and resume via isPaused flag
function startSim() {
  if (isPaused) {
    // Resume: restart the animation loop only — do not reset state or rebuild hydrograph
    isPaused = false;
    simRunning = true;
    lastTs = null;
    document.getElementById('play-btn').disabled = true;
    document.getElementById('pause-btn').disabled = false;
    setStatus('Running', 'running');
    rafId = requestAnimationFrame(tick);
    return;
  }

  // Fresh start — validate inputs first
  const areaHa = getNum('area', 50);
  const vmax = getVmax();
  if (areaHa <= 0) { setStatus('⚠ Catchment area must be greater than 0.', 'warning'); return; }
  if (vmax <= 0)   { setStatus('⚠ Tank capacity must be greater than 0.', 'warning'); return; }

  hydrograph = buildHydrograph();
  if (!hydrograph.length) {
    setStatus('No hydrograph data. Check input values.', 'warning');
    return;
  }

  // Reset all simulation state for a clean run
  simTime = 0;
  tankVolume = 0;
  maxTankVolume = 0;
  spillVolume = 0;
  peakInflow = 0;
  peakInflowTime = 0;
  lastTs = null;
  lastResultUpdate = 0;
  hasRun = true;
  simRunning = true;
  isPaused = false;

  resetChart();
  document.getElementById('play-btn').disabled = true;
  document.getElementById('pause-btn').disabled = false;
  setStatus('Running', 'running');
  rafId = requestAnimationFrame(tick);
}

function pauseSim() {
  simRunning = false;
  isPaused = true;
  cancelAnimationFrame(rafId);
  document.getElementById('play-btn').disabled = false;
  document.getElementById('pause-btn').disabled = true;
  setStatus('Paused', 'paused');
}

function resetSim() {
  simRunning = false;
  isPaused = false;
  cancelAnimationFrame(rafId);
  lastTs = null;
  simTime = 0;
  tankVolume = 0;
  maxTankVolume = 0;
  spillVolume = 0;
  peakInflow = 0;
  peakInflowTime = 0;
  lastResultUpdate = 0;
  hasRun = false;
  document.getElementById('play-btn').disabled = false;
  document.getElementById('pause-btn').disabled = true;
  updateDashboard(0, 0);
  updateTankViz(0);
  updateResultStrip(true);
  resetChart();
  setStatus('Idle — press Start to begin', '');
  document.getElementById('sim-time').textContent = 'T = 0:00';
}

function tick(ts) {
  if (lastTs === null) lastTs = ts;
  const realDelta = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  const totalSimDelta = realDelta * simSpeed;

  const directQ = getDirectInflow();
  const hydrographEnd = hydrograph[hydrograph.length - 1]?.t ?? 0;
  const isScs = document.getElementById('method-select').value === 'scs';
  const pump = getQpump();
  const noPump = pump === 0;
  const hardStop = noPump
    ? (isScs ? 86400 : hydrographEnd)
    : Infinity;

  // Sub-step: max 10 s of sim-time per step so the triangular peak is never
  // skipped at high speeds (200× can otherwise jump 20 s in one frame).
  const MAX_SUBSTEP = 10; // seconds of sim-time
  const nSteps = Math.ceil(totalSimDelta / MAX_SUBSTEP);
  const subDelta = totalSimDelta / nSteps;

  let qIn = 0; // will hold the last sub-step value for display

  for (let s = 0; s < nSteps; s++) {
    simTime += subDelta;

    const stormOver = simTime >= hydrographEnd;
    const storageEmpty = tankVolume <= 0;
    const reachedHardStop = simTime >= hardStop;

    if ((stormOver && storageEmpty && directQ === 0) || reachedHardStop) {
      simTime = Math.min(simTime, hardStop < Infinity ? hardStop : hydrographEnd);
      updateDashboard(0, 0);
      updateTankViz(tankVolume / getVmax());
      updateResultStrip(true);
      pushChartPoint(simTime / 60, 0, tankVolume);
      endSim();
      return;
    }

    const stormQ = stormOver ? 0 : interpolateFlow(simTime);
    qIn = stormQ + directQ;

    const effectivePump = tankVolume > 0 ? pump : 0;
    const net = qIn - effectivePump;

    const rawNext = tankVolume + net * subDelta;
    if (rawNext > getVmax()) spillVolume += rawNext - getVmax();
    tankVolume = Math.max(0, Math.min(getVmax(), rawNext));
    maxTankVolume = Math.max(maxTankVolume, tankVolume);

    if (qIn > peakInflow) {
      peakInflow = qIn;
      peakInflowTime = simTime;
    }
  }

  // UI updates once per frame (after all sub-steps)
  updateDashboard(qIn, tankVolume);
  updateTankViz(tankVolume / getVmax());

  const now = performance.now();
  if (now - lastResultUpdate >= 250) {
    updateResultStrip(false);
    lastResultUpdate = now;
  }

  pushChartPoint(simTime / 60, qIn, tankVolume);
  updateTimeText();

  const fill = tankVolume / getVmax();
  const stormOverFinal = simTime >= hydrographEnd;
  if (fill >= 0.9) setStatus(`⚠ Overflow Risk — ${Math.round(fill * 100)}% full`, 'warning');
  else if (stormOverFinal && noPump && tankVolume > 0) setStatus('Storm ended — tank holding (no pump)', 'paused');
  else if (stormOverFinal) setStatus('Storm ended — draining tank…', 'running');
  else setStatus('Running', 'running');

  rafId = requestAnimationFrame(tick);
}

function endSim() {
  simRunning = false;
  isPaused = false;
  updateResultStrip(true); // force final update
  document.getElementById('play-btn').disabled = false;
  document.getElementById('pause-btn').disabled = false; // allow stepping through paused state
  document.getElementById('pause-btn').disabled = true;
  setStatus('Simulation complete', 'done');
  updateTimeText();
}

function buildHydrograph() {
  return document.getElementById('method-select').value === 'scs'
    ? buildScsHydrograph()
    : buildRationalHydrograph();
}

// Rational Method uses a simplified symmetric triangular hydrograph.
// Tp = storm duration / 2 is a standard simplification.
// Select intensity i from your local IDF curve at the duration equal to the
// system's Time of Concentration and the target return period (e.g. 10-year).
function buildRationalHydrograph() {
  const intensity = getNum('intensity-val', 50);
  const durationMin = getNum('storm-duration', 60);
  const areaHa = getNum('area', 50);
  const c = getNum('c-val', 0.75);
  const qPeak = (c * intensity * areaHa) / 360;
  const tp = (durationMin / 2) * 60;
  const tb = 2.67 * tp;
  const pts = [];
  for (let t = 0; t <= tb + 30; t += 30) {
    let q = 0;
    if (t <= tp) q = qPeak * (t / tp);
    else if (t <= tb) q = qPeak * (tb - t) / (tb - tp);
    pts.push({ t, Q: Math.max(0, q) });
  }
  return pts;
}

function buildScsHydrograph() {
  const depthMm = getNum('storm-depth-val', 50);
  const cn = getNum('cn-val', 75);
  const areaHa = getNum('area', 50);
  const tcMin = getNum('tc-val', 60);

  // dtSeconds is the computation time-step in seconds.
  // The kernel is normalised by dividing by responseArea (units: s),
  // making it a density in 1/s. Convolution yields flow in m³/s.
  // IMPORTANT: if dtSeconds is ever changed, it must match the step used in
  // both the stormEnd loop and the kernel convolution loop below.
  const dtSeconds = 360;
  const stormEnd = 24 * 3600;

  const tLag = 0.6 * tcMin * 60; // NRCS: tLag = 0.6 × Tc, converted to seconds

  // tp uses no floor — removed Math.max(dtSeconds,…) that caused Tc to be ignored
  // for small values. tp = (dt/2) + tLag with no floor.
  const tp = (dtSeconds / 2) + tLag;

  const nrcsUh = [
    [0, 0], [0.1, 0.03], [0.2, 0.10], [0.3, 0.19], [0.4, 0.31],
    [0.5, 0.47], [0.6, 0.66], [0.7, 0.82], [0.8, 0.93], [0.9, 0.99],
    [1.0, 1.00], [1.1, 0.99], [1.2, 0.93], [1.3, 0.86], [1.4, 0.78],
    [1.5, 0.68], [1.7, 0.56], [2.0, 0.39], [2.2, 0.30], [2.5, 0.207],
    [3.0, 0.107], [3.5, 0.055], [4.0, 0.029], [4.5, 0.015], [5.0, 0]
  ];

  const response = [];
  const responseEnd = 5 * tp;
  for (let t = 0; t <= responseEnd; t += dtSeconds) {
    const ratio = t / tp;
    let qRatio = 0;
    for (let i = 1; i < nrcsUh.length; i++) {
      const p0 = nrcsUh[i - 1];
      const p1 = nrcsUh[i];
      if (p1[0] >= ratio) {
        const a = (ratio - p0[0]) / (p1[0] - p0[0]);
        qRatio = p0[1] + a * (p1[1] - p0[1]);
        break;
      }
    }
    response.push(qRatio);
  }

  const responseArea = response.reduce((sum, value) => sum + value * dtSeconds, 0);
  const kernel = responseArea > 0 ? response.map(value => value / responseArea) : [1 / dtSeconds];
  const flow = new Array(Math.ceil(stormEnd / dtSeconds) + kernel.length + 2).fill(0);

  let lastRunoffDepth = 0;
  for (let t = 0, step = 0; t <= stormEnd; t += dtSeconds, step++) {
    const hr = t / 3600;
    const cumulativeRain = interpolateScsRain(hr, depthMm);
    const cumulativeRunoff = calcCnRunoffDepth(cumulativeRain, cn);
    const incrementalRunoff = Math.max(0, cumulativeRunoff - lastRunoffDepth);
    lastRunoffDepth = cumulativeRunoff;
    const volume = incrementalRunoff / 1000 * areaHa * 10000;

    for (let k = 0; k < kernel.length; k++) {
      flow[step + k] += volume * kernel[k];
    }
  }

  const pts = [];
  for (let i = 0; i < flow.length; i++) {
    pts.push({ t: i * dtSeconds, Q: Math.max(0, flow[i]) });
  }
  pts.push({ t: (flow.length + 1) * dtSeconds, Q: 0 });
  return pts;
}

function interpolateScsRain(hour, depthMm) {
  if (hour <= 0) return 0;
  if (hour >= 24) return depthMm;
  for (let i = 1; i < SCS_TYPE_II.length; i++) {
    const p0 = SCS_TYPE_II[i - 1];
    const p1 = SCS_TYPE_II[i];
    if (p1[0] >= hour) {
      const a = (hour - p0[0]) / (p1[0] - p0[0]);
      const rawDepthFor50mm = p0[1] + a * (p1[1] - p0[1]);
      return (rawDepthFor50mm / 50) * depthMm;
    }
  }
  return depthMm;
}

function calcCnRunoffDepth(rainMm, cn) {
  const s = (25400 / cn) - 254;
  const ia = 0.2 * s;
  if (rainMm <= ia) return 0;
  return Math.pow(rainMm - ia, 2) / (rainMm + 0.8 * s);
}

function interpolateFlow(t) {
  if (!hydrograph.length) return 0;
  if (t <= hydrograph[0].t) return hydrograph[0].Q;
  const last = hydrograph[hydrograph.length - 1];
  if (t >= last.t) return 0;
  for (let i = 1; i < hydrograph.length; i++) {
    if (hydrograph[i].t >= t) {
      const p0 = hydrograph[i - 1];
      const p1 = hydrograph[i];
      const a = (t - p0.t) / (p1.t - p0.t);
      return p0.Q + a * (p1.Q - p0.Q);
    }
  }
  return 0;
}

// FIX10: dashboard now shows running peak inflow in the 4th card
function updateDashboard(qIn, volume) {
  const vMax = getVmax();
  const excess = Math.max(0, qIn - getQpump());
  const fillPct = vMax > 0 ? volume / vMax * 100 : 0;
  document.getElementById('m-qin').textContent = qIn.toFixed(2);
  document.getElementById('m-excess').textContent = excess.toFixed(2);
  document.getElementById('m-volume').textContent = Math.round(volume).toLocaleString();
  document.getElementById('m-peak').textContent = peakInflow.toFixed(2);  // FIX10: running peak
  const bar = document.getElementById('fill-bar');
  bar.style.width = `${Math.min(100, fillPct)}%`;
  bar.style.background = fillPct >= 90 ? '#ef4444' : fillPct >= 75 ? '#f97316' : fillPct >= 50 ? '#eab308' : 'var(--blue)';
  bar.parentElement.setAttribute('aria-valuenow', Math.round(fillPct));
  // Update fill metric separately (still needed by its own card)
  document.getElementById('m-fill').textContent = Math.round(fillPct);
}

// FIX3: accepts a `force` flag — only writes DOM every 250ms during sim,
// always writes on reset and at end of simulation.
function updateResultStrip(force) {
  if (!force) return; // throttling handled in tick() — this function is now called only when needed

  // Clamp SF to minimum 1.0 — below 1 would make tank-check falsely pass
  const sf = Math.max(1.0, getNum('safety-factor', 1.15));
  const factored = maxTankVolume * sf;
  const pump = getQpump();

  // Emptying time uses actual peak volume — safety factor is a design size, not physical water
  const emptyHours = pump > 0 ? maxTankVolume / pump / 3600 : null;

  // FIX5: peak inflow time displayed as mm:ss or h:mm:ss
  const pth = Math.floor(peakInflowTime / 3600);
  const ptm = Math.floor((peakInflowTime % 3600) / 60);
  const pts = Math.floor(peakInflowTime % 60);
  const peakTimeStr = hasRun
    ? (pth > 0
        ? `${pth}:${String(ptm).padStart(2,'0')}:${String(pts).padStart(2,'0')}`
        : `${ptm}:${String(pts).padStart(2,'0')}`)
    : '—';

  document.getElementById('max-volume').textContent    = `${Math.round(maxTankVolume).toLocaleString()} m³`;
  document.getElementById('factored-volume').textContent = `${Math.round(factored).toLocaleString()} m³`;
  document.getElementById('empty-time').textContent    = emptyHours !== null ? `${emptyHours.toFixed(1)} hr` : 'No Pump';
  document.getElementById('spill-volume').textContent  = `${Math.round(spillVolume).toLocaleString()} m³`;
  document.getElementById('peak-inflow-res').textContent = hasRun ? `${peakInflow.toFixed(2)} m³/s` : '—';  // FIX4
  document.getElementById('peak-time-res').textContent   = peakTimeStr;                                       // FIX5
  document.getElementById('tank-check').textContent    = hasRun ? (factored > getVmax() ? 'Insufficient' : 'OK') : 'Ready';
}

function updateTankViz(f) {
  f = Math.max(0, Math.min(1, f || 0));
  const totalH = 290;
  const topY = 20;
  const waterH = f * totalH;
  document.getElementById('water-body').setAttribute('y', topY + totalH - waterH);
  document.getElementById('water-body').setAttribute('height', waterH);
  const top = document.getElementById('wg-top');
  const bot = document.getElementById('wg-bot');
  if (f >= 0.9) { top.setAttribute('stop-color', '#fca5a5'); bot.setAttribute('stop-color', '#dc2626'); }
  else if (f >= 0.75) { top.setAttribute('stop-color', '#fdba74'); bot.setAttribute('stop-color', '#ea580c'); }
  else if (f >= 0.5) { top.setAttribute('stop-color', '#fde68a'); bot.setAttribute('stop-color', '#d97706'); }
  else { top.setAttribute('stop-color', '#38bdf8'); bot.setAttribute('stop-color', '#0369a1'); }
  document.getElementById('warn-overlay').setAttribute('opacity', f >= 0.85 ? '1' : '0');
  document.getElementById('tank-pct').textContent = `${Math.round(f * 100)}%`;
  document.getElementById('tank-status').textContent = f === 0 ? 'Empty' : f < 0.5 ? 'Filling' : f < 0.75 ? 'Half Full' : f < 0.9 ? 'High Level' : '⚠ Overflow Risk';
}

function initChart() {
  const ctx = document.getElementById('sim-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        // FIX9: label updated to clarify it includes direct inflow
        { label: 'Total Inflow (storm + direct) m³/s', data: [], borderColor: '#0ea5e9', borderWidth: 2.5, fill: false, tension: 0.35, pointRadius: 0, yAxisID: 'yFlow' },
        { label: 'Pump Capacity (m³/s)', data: [], borderColor: '#f97316', borderWidth: 2, borderDash: [6,4], fill: false, tension: 0, pointRadius: 0, yAxisID: 'yFlow' },
        { label: 'Tank Fill (%)', data: [], borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.12)', borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, yAxisID: 'yFill' }
      ]
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true } } },
      scales: {
        x: { title: { display: true, text: 'Time (min)' }, ticks: { maxTicksLimit: 10 } },
        yFlow: { type: 'linear', position: 'left', min: 0, title: { display: true, text: 'Flow Rate (m³/s)' } },
        yFill: { type: 'linear', position: 'right', min: 0, max: 100, title: { display: true, text: 'Tank Fill (%)' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

function pushChartPoint(tMin, qIn, volume) {
  const now = performance.now();
  if (now - lastChartPush < 250) return;
  lastChartPush = now;
  if (chart.data.labels.length > 400) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
  const fill = getVmax() > 0 ? Math.min(100, volume / getVmax() * 100) : 0;
  chart.data.labels.push(tMin.toFixed(1));
  chart.data.datasets[0].data.push(qIn);
  chart.data.datasets[1].data.push(getQpump());
  chart.data.datasets[2].data.push(fill);
  chart.update('none');
}

function resetChart() {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets.forEach(ds => { ds.data = []; });
  chart.update('none');
  lastChartPush = 0;
}

function updateTimeText() {
  const h = Math.floor(simTime / 3600);
  const m = Math.floor((simTime % 3600) / 60);
  const sec = Math.floor(simTime % 60);
  document.getElementById('sim-time').textContent = h > 0
    ? `T = ${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `T = ${m}:${String(sec).padStart(2, '0')}`;
}

function getNum(id, fallback) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`getNum: element #${id} not found`);
    return fallback;
  }
  const n = Number(el.value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getQpump() { return getNum('qpump-lps', 200) / 1000; }
function getVmax()  { return getNum('vmax', 15000); }

// Direct Inflow: constant forcemain/external discharge (m³/s) added throughout simulation.
function getDirectInflow() {
  const isScs = document.getElementById('method-select').value === 'scs';
  const lps = isScs
    ? getNum('direct-inflow-s-val', 0)
    : getNum('direct-inflow-r-val', 0);
  return lps / 1000;
}

function setStatus(text, cls) {
  const badge = document.getElementById('status-badge');
  badge.textContent = text;
  badge.className = 'status-badge' + (cls ? ` ${cls}` : '');
}
