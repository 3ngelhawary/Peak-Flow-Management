'use strict';

// ── State ───────────────────────────────────────────────
let chart      = null;
let hydrograph = [];   // [{t: seconds, Q: m³/s}]
let rafId      = null;
let lastTs     = null;
let simTime    = 0;    // simulation seconds elapsed
let tankVolume = 0;    // m³
let maxTankVolume = 0; // maximum factored volume reached during simulation
let simRunning = false;
let simSpeed   = 300;  // simulation-seconds per real-second
let lastChartPush = 0;

// ── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  bindSimControls();
  bindSliders();
});

// ── Slider output ───────────────────────────────────────
function bindSliders() {
  const intensity = document.getElementById('intensity');
  const intOut    = document.getElementById('intensity-val');
  intensity.addEventListener('input', () => { intOut.value = `${intensity.value} mm/hr`; });

  const coeffEl  = document.getElementById('runoff-c');
  const coeffOut = document.getElementById('c-val');
  coeffEl.addEventListener('input', () => { coeffOut.value = Number(coeffEl.value).toFixed(2); });
}

// ── Simulation controls ─────────────────────────────────
function bindSimControls() {
  document.getElementById('play-btn').addEventListener('click',  startSim);
  document.getElementById('pause-btn').addEventListener('click', pauseSim);
  document.getElementById('reset-btn').addEventListener('click', resetSim);

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

// ── Triangular Hydrograph (Rational Method peak) ────
function buildSyntheticHydrograph() {
  const iMmHr  = Number(document.getElementById('intensity').value)     || 50;
  const durMin = Number(document.getElementById('storm-duration').value) || 60;
  const areaHa = Number(document.getElementById('area').value)          || 50;
  const C      = Number(document.getElementById('runoff-c').value)      || 0.75;

  // Peak flow via Rational Method: Q = C·i·A / 360  (A in ha, i in mm/hr → m³/s)
  const Qpeak = (C * iMmHr * areaHa) / 360;

  // Triangular hydrograph distribution for dynamic routing
  const Tp = (durMin / 2) * 60; // time to peak (seconds)
  const Tb = 2.67 * Tp;         // base time (seconds)

  const pts = [];
  const dt  = 30; // 30-second steps
  for (let t = 0; t <= Tb + dt; t += dt) {
    let Q = 0;
    if (t <= Tp)      Q = Qpeak * (t / Tp);
    else if (t <= Tb) Q = Qpeak * (Tb - t) / (Tb - Tp);
    pts.push({ t, Q: Math.max(0, Q) });
  }
  return pts;
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
          label: 'Pump Capacity (m³/s)',
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
            label: ctx => ctx.datasetIndex === 2
              ? ` Fill: ${ctx.parsed.y.toFixed(1)}%`
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
  chart.update('none');
}

function resetChart() {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets.forEach(ds => (ds.data = []));
  chart.update('none');
  lastChartPush = 0;
}

// ── Helpers ──────────────────────────────────────────────
function getQpump() { return Number(document.getElementById('qpump-sim').value) || 1.9; }
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
