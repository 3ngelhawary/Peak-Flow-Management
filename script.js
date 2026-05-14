'use strict';

// ── State ───────────────────────────────────────────────
let chart      = null;
let hydrograph = [];   // [{t: seconds, Q: m³/s, cumPct?: number}]
let rafId      = null;
let lastTs     = null;
let simTime    = 0;    // simulation seconds elapsed
let tankVolume = 0;    // m³
let maxTankVolume = 0; // maximum factored volume reached during simulation
let simRunning = false;
let simSpeed   = 300;  // simulation-seconds per real-second
let lastChartPush = 0;
let activeMethod = 'rational';

// ── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  bindSimControls();
  bindSliders();
  switchMethod();
});

// ── Slider output ───────────────────────────────────────
function bindSliders() {
  bindRangeNumberPair('intensity', 'intensity-manual', 'intensity-val', ' mm/hr');
  bindRangeNumberPair('storm-depth', 'storm-depth-manual', 'depth-val', ' mm');

  const coeffEl  = document.getElementById('runoff-c');
  const coeffOut = document.getElementById('c-val');
  coeffEl.addEventListener('input', () => { coeffOut.value = Number(coeffEl.value).toFixed(2); });

  const cnEl  = document.getElementById('curve-number');
  const cnOut = document.getElementById('cn-val');
  cnEl.addEventListener('input', () => { cnOut.value = String(Math.round(Number(cnEl.value))); });
}

function bindRangeNumberPair(rangeId, numberId, outputId, suffix) {
  const rangeEl = document.getElementById(rangeId);
  const numberEl = document.getElementById(numberId);
  const outputEl = document.getElementById(outputId);

  const update = source => {
    const min = Number(rangeEl.min);
    const max = Number(rangeEl.max);
    let value = Number(source.value);
    if (Number.isNaN(value)) value = min;
    value = Math.max(min, Math.min(max, value));
    rangeEl.value = value;
    numberEl.value = value;
    outputEl.value = suffix.trim();
  };

  rangeEl.addEventListener('input', () => update(rangeEl));
  numberEl.addEventListener('input', () => update(numberEl));
  update(rangeEl);
}

// ── Simulation controls ─────────────────────────────────
function bindSimControls() {
  document.getElementById('play-btn').addEventListener('click',  startSim);
  document.getElementById('pause-btn').addEventListener('click', pauseSim);
  document.getElementById('reset-btn').addEventListener('click', resetSim);
  document.getElementById('method-select').addEventListener('change', switchMethod);

  document.querySelectorAll('input[name="simspeed"]').forEach(r => {
    r.addEventListener('change', () => { simSpeed = Number(r.value); });
  });

}

// ── Simulation engine ────────────────────────────────────
function startSim() {
  hydrograph = buildSyntheticHydrograph();
  if (hydrograph.length === 0) {
    setStatus('No hydrograph data. Configure storm parameters.', 'warning');
    return;
  }

  simRunning = true;
  lastTs     = null;
  document.getElementById('play-btn').disabled  = true;
  document.getElementById('pause-btn').disabled = false;
  setStatus('Running', 'running');
  rafId = requestAnimationFrame(tick);
}

function pauseSim() {
  simRunning = false;
  cancelAnimationFrame(rafId);
  document.getElementById('play-btn').disabled  = false;
  document.getElementById('pause-btn').disabled = true;
  setStatus('Paused', 'paused');
}

function resetSim() {
  simRunning = false;
  cancelAnimationFrame(rafId);
  lastTs = null; simTime = 0; tankVolume = 0; maxTankVolume = 0;
  document.getElementById('play-btn').disabled  = false;
  document.getElementById('pause-btn').disabled = true;
  updateDashboard(0, 0);
  updateTankViz(0);
  resetChart();
  setStatus('Idle — press Start to begin', '');
  document.getElementById('sim-time').textContent = 'T = 0:00';
}

function tick(ts) {
  if (lastTs === null) lastTs = ts;
  const realDelta = Math.min((ts - lastTs) / 1000, 0.1); // cap at 100 ms
  lastTs = ts;

  const simDelta  = realDelta * simSpeed;
  simTime        += simDelta;

  const maxT = hydrograph[hydrograph.length - 1]?.t ?? 0;
  if (simTime >= maxT) {
    simTime = maxT;
    maxTankVolume = Math.max(maxTankVolume, tankVolume);
    updateDashboard(0, tankVolume);
    updateTankViz(tankVolume / getVmax());
    pushChartPoint(simTime / 60, 0, tankVolume);
    endSim();
    return;
  }

  const Qin    = interpolateFlow(simTime);
  const Qpump  = getQpump();
  const vMax   = getVmax();
  const net    = Qin - Qpump;
  const sf     = getSafetyFactor();
  const volumeDelta = net > 0 ? net * simDelta * sf : net * simDelta;

  tankVolume = Math.max(0, Math.min(vMax, tankVolume + volumeDelta));
  maxTankVolume = Math.max(maxTankVolume, tankVolume);

  const fill = tankVolume / vMax;
  updateDashboard(Qin, tankVolume);
  updateTankViz(fill);
  pushChartPoint(simTime / 60, Qin, tankVolume);

  const m = Math.floor(simTime / 60);
  const s = Math.floor(simTime % 60);
  document.getElementById('sim-time').textContent = `T = ${m}:${String(s).padStart(2,'0')}`;

  if (fill >= 0.9) {
    setStatus(`⚠ Overflow Risk — ${Math.round(fill * 100)}% full`, 'warning');
  } else if (document.getElementById('status-badge').className.includes('running')) {
    setStatus('Running', 'running');
  }

  rafId = requestAnimationFrame(tick);
}

function endSim() {
  simRunning = false;
  document.getElementById('play-btn').disabled  = false;
  document.getElementById('pause-btn').disabled = true;
  setStatus('Simulation complete', 'done');
}

// -- Hydrograph builders ---------------------------------
function buildSyntheticHydrograph() {
  activeMethod = document.getElementById('method-select').value;
  return activeMethod === 'scs' ? buildScsHydrograph() : buildRationalHydrograph();
}

function buildRationalHydrograph() {
  const iMmHr  = Number(document.getElementById('intensity-manual').value) || 50;
  const durMin = Number(document.getElementById('storm-duration').value) || 60;
  const areaHa = Number(document.getElementById('area').value)          || 50;
  const C      = Number(document.getElementById('runoff-c').value)      || 0.75;

  const Qpeak = (C * iMmHr * areaHa) / 360;
  const Tp = (durMin / 2) * 60;
  const Tb = 2.67 * Tp;

  const pts = [];
  const dt  = 30;
  for (let t = 0; t <= Tb + dt; t += dt) {
    let Q = 0;
    if (t <= Tp) Q = Qpeak * (t / Tp);
    else if (t <= Tb) Q = Qpeak * (Tb - t) / (Tb - Tp);
    pts.push({ t, Q: Math.max(0, Q), cumPct: null });
  }
  return pts;
}

function buildScsHydrograph() {
  const depthMm = Number(document.getElementById('storm-depth-manual').value) || 50;
  const areaHa  = Number(document.getElementById('area').value)        || 50;
  const cn      = Math.max(30, Math.min(98, Number(document.getElementById('curve-number').value) || 75));

  const sMm = (25400 / cn) - 254;
  const iaMm = 0.2 * sMm;
  const dt = 300;
  const totalT = 24 * 60 * 60;
  const areaM2 = areaHa * 10000;
  const totalRunoffMm = getScsRunoffDepth(depthMm, iaMm, sMm);
  const pts = [];
  let prevRunoffMm = 0;

  for (let t = 0; t <= totalT; t += dt) {
    const hour = t / 3600;
    const cumulativeRainMm = depthMm * scsType2CumulativeRatio(hour);
    const cumulativeRunoffMm = getScsRunoffDepth(cumulativeRainMm, iaMm, sMm);
    const incrementalRunoffMm = Math.max(0, cumulativeRunoffMm - prevRunoffMm);
    const incrementalVolume = (incrementalRunoffMm / 1000) * areaM2;
    const Q = incrementalVolume / dt;
    const cumPct = totalRunoffMm > 0 ? (cumulativeRunoffMm / totalRunoffMm) * 100 : 0;

    pts.push({ t, Q, cumPct: Math.max(0, Math.min(100, cumPct)) });
    prevRunoffMm = cumulativeRunoffMm;
  }

  pts.push({ t: totalT + dt, Q: 0, cumPct: 100 });
  return pts;
}

const SCS_TYPE_II_24HR = [
  [0, 0.000], [2, 0.022], [4, 0.048], [6, 0.080],
  [8, 0.120], [9, 0.147], [10, 0.181], [11, 0.235],
  [11.5, 0.283], [11.75, 0.357], [12, 0.663],
  [12.25, 0.735], [12.5, 0.772], [13, 0.820],
  [14, 0.886], [15, 0.928], [16, 0.953], [18, 0.981],
  [20, 0.993], [22, 0.998], [24, 1.000],
];

function scsType2CumulativeRatio(hour) {
  if (hour <= 0) return 0;
  if (hour >= 24) return 1;

  for (let i = 1; i < SCS_TYPE_II_24HR.length; i++) {
    const p0 = SCS_TYPE_II_24HR[i - 1];
    const p1 = SCS_TYPE_II_24HR[i];
    if (hour <= p1[0]) {
      const a = (hour - p0[0]) / (p1[0] - p0[0]);
      return p0[1] + a * (p1[1] - p0[1]);
    }
  }

  return 1;
}

function getScsRunoffDepth(pMm, iaMm, sMm) {
  if (pMm <= iaMm) return 0;
  const effectiveP = pMm - iaMm;
  return (effectiveP * effectiveP) / (effectiveP + sMm);
}

function switchMethod() {
  const method = document.getElementById('method-select').value;
  const isScs = method === 'scs';
  const durationField = document.getElementById('duration-field');
  const durationSelect = document.getElementById('storm-duration');

  document.getElementById('rational-fields').classList.toggle('hidden', isScs);
  document.getElementById('scs-fields').classList.toggle('hidden', !isScs);
  document.getElementById('method-pill').textContent = isScs ? 'SCS Type II 24-hr' : 'Rational Method';
  document.getElementById('method-note').textContent = isScs
    ? 'SCS uses storm depth and Curve Number to generate runoff from the Type II cumulative curve.'
    : 'Rational uses rainfall intensity, duration, and runoff coefficient C to calculate peak flow.';

  if (isScs) {
    durationField.firstChild.textContent = 'Storm Duration Fixed for SCS';
    durationSelect.innerHTML = '<option value="1440" selected>24 hours</option>';
    durationSelect.disabled = true;
  } else {
    durationField.firstChild.textContent = 'Storm Duration';
    durationSelect.disabled = false;
    durationSelect.innerHTML = [
      '<option value="30">30 min</option>',
      '<option value="60" selected>1 hour</option>',
      '<option value="120">2 hours</option>',
      '<option value="180">3 hours</option>',
      '<option value="360">6 hours</option>',
    ].join('');
  }

  resetSim();
}

// ── Interpolate Q from hydrograph at time t (seconds) ───
function interpolateFlow(t) {
  if (!hydrograph.length) return 0;
  if (t <= hydrograph[0].t) return hydrograph[0].Q;
  const last = hydrograph[hydrograph.length - 1];
  if (t >= last.t) return 0;
  for (let i = 1; i < hydrograph.length; i++) {
    if (hydrograph[i].t >= t) {
      const p0 = hydrograph[i - 1], p1 = hydrograph[i];
      const a  = (t - p0.t) / (p1.t - p0.t);
      return p0.Q + a * (p1.Q - p0.Q);
    }
  }
  return 0;
}

// ── Dashboard ────────────────────────────────────────────
function updateDashboard(Qin, volume) {
  const vMax    = getVmax();
  const excess  = Math.max(0, Qin - getQpump());
  const fillPct = vMax > 0 ? (volume / vMax) * 100 : 0;

  document.getElementById('m-qin').textContent    = Qin.toFixed(2);
  document.getElementById('m-excess').textContent  = excess.toFixed(2);
  document.getElementById('m-volume').textContent  = Math.round(maxTankVolume).toLocaleString();
  document.getElementById('m-empty-time').textContent = formatEmptyingTime(maxTankVolume, getQpump());
  document.getElementById('m-fill').textContent    = Math.round(fillPct);

  const bar = document.getElementById('fill-bar');
  bar.style.width      = `${Math.min(100, fillPct)}%`;
  bar.style.background =
    fillPct >= 90 ? '#ef4444' :
    fillPct >= 75 ? '#f97316' :
    fillPct >= 50 ? '#eab308' : 'var(--blue)';
  bar.parentElement.setAttribute('aria-valuenow', Math.round(fillPct));
}

// ── Tank SVG animation ───────────────────────────────────
function updateTankViz(f) {
  f = Math.max(0, Math.min(1, f));
  const totalH = 290, topY = 20;
  const waterH = f * totalH;
  const waterY = topY + totalH - waterH;

  const wb = document.getElementById('water-body');
  wb.setAttribute('y', waterY);
  wb.setAttribute('height', waterH);

  const top = document.getElementById('wg-top');
  const bot = document.getElementById('wg-bot');
  if      (f >= 0.9)  { top.setAttribute('stop-color','#fca5a5'); bot.setAttribute('stop-color','#dc2626'); }
  else if (f >= 0.75) { top.setAttribute('stop-color','#fdba74'); bot.setAttribute('stop-color','#ea580c'); }
  else if (f >= 0.5)  { top.setAttribute('stop-color','#fde68a'); bot.setAttribute('stop-color','#d97706'); }
  else                { top.setAttribute('stop-color','#38bdf8'); bot.setAttribute('stop-color','#0369a1'); }

  document.getElementById('warn-overlay').setAttribute('opacity', f >= 0.85 ? '1' : '0');
  document.getElementById('tank-pct').textContent    = `${Math.round(f * 100)}%`;
  document.getElementById('tank-status').textContent =
    f === 0   ? 'Empty'         :
    f < 0.5   ? 'Filling'       :
    f < 0.75  ? 'Half Full'     :
    f < 0.9   ? 'High Level'    : '⚠ Overflow Risk';
}

// ── Chart.js ─────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('sim-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Inflow Q_in (m³/s)',
          data: [], borderColor: '#0ea5e9',
          borderWidth: 2.5, fill: false, tension: 0.4,
          pointRadius: 0, yAxisID: 'yFlow',
        },
        {
          label: 'Pump Discharge (m³/s)',
          data: [], borderColor: '#f97316',
          borderWidth: 2, borderDash: [6,4],
          fill: false, tension: 0, pointRadius: 0, yAxisID: 'yFlow',
        },
        {
          label: 'Tank Fill (%)',
          data: [], borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.12)',
          borderWidth: 2, fill: true, tension: 0.4,
          pointRadius: 0, yAxisID: 'yFill',
        },
        {
          label: 'SCS Cumulative Runoff (%)',
          data: [], borderColor: '#a855f7',
          borderWidth: 2, borderDash: [4,4],
          fill: false, tension: 0.35, pointRadius: 0, yAxisID: 'yFill',
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.datasetIndex >= 2
              ? ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? 0}%`
              : ` ${ctx.dataset.label.split(' ')[0]}: ${ctx.parsed.y.toFixed(2)} m³/s`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Time (min)', font: { size: 12 } },
          ticks: { maxTicksLimit: 10 },
        },
        yFlow: {
          type: 'linear', position: 'left', min: 0,
          title: { display: true, text: 'Flow Rate (m³/s)', font: { size: 12 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        yFill: {
          type: 'linear', position: 'right', min: 0, max: 100,
          title: { display: true, text: 'Tank Fill (%)', font: { size: 12 } },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function pushChartPoint(tMin, Qin, volume) {
  const now = performance.now();
  if (now - lastChartPush < 250) return; // throttle to 4 fps
  lastChartPush = now;

  if (chart.data.labels.length > 400) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }

  const fill = getVmax() > 0 ? Math.min(100, (volume / getVmax()) * 100) : 0;
  chart.data.labels.push(tMin.toFixed(1));
  chart.data.datasets[0].data.push(Qin);
  chart.data.datasets[1].data.push(getQpump());
  chart.data.datasets[2].data.push(fill);
  chart.data.datasets[3].data.push(getCumulativePercent(tMin * 60));
  chart.update('none');
}

function getCumulativePercent(t) {
  if (activeMethod !== 'scs' || !hydrograph.length) return null;
  if (t <= hydrograph[0].t) return hydrograph[0].cumPct || 0;
  for (let i = 1; i < hydrograph.length; i++) {
    if (hydrograph[i].t >= t) {
      const p0 = hydrograph[i - 1], p1 = hydrograph[i];
      const span = p1.t - p0.t || 1;
      const a = (t - p0.t) / span;
      const c0 = p0.cumPct ?? 0, c1 = p1.cumPct ?? c0;
      return c0 + a * (c1 - c0);
    }
  }
  return 100;
}

function resetChart() {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets.forEach(ds => (ds.data = []));
  chart.update('none');
  lastChartPush = 0;
}

// ── Helpers ──────────────────────────────────────────────
function getQpump() { return (Number(document.getElementById('qpump-sim').value) || 1900) / 1000; }
function getVmax()  { return Number(document.getElementById('vmax').value)      || 15000; }
function getSafetyFactor() { return Number(document.getElementById('sf-sim').value) || 1.0; }

function formatEmptyingTime(volume, qpump) {
  if (volume <= 0) return '0 min';
  if (qpump <= 0) return 'N/A';

  const minutes = volume / qpump / 60;
  if (minutes < 60) return `${Math.ceil(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hr`;

  const days = hours / 24;
  return `${days.toFixed(1)} d`;
}

function setStatus(text, cls) {
  const b = document.getElementById('status-badge');
  b.textContent = text;
  b.className   = 'status-badge' + (cls ? ' ' + cls : '');
}
