// File: script.js
'use strict';

let chart = null;
let hydrograph = [];
let rafId = null;
let lastTs = null;

let simTime = 0;
let tankVolume = 0;
let maxTankVolume = 0;

let simRunning = false;
let simSpeed = 300;

let lastChartPush = 0;
let hasRun = false;

const SCS_TYPE_II = [
  [0, 0],
  [1, 0.5],
  [2, 1.1],
  [3, 1.7],
  [4, 2.4],
  [5, 3.2],
  [6, 4.0],
  [7, 4.9],
  [8, 6.0],
  [9, 7.3],
  [10, 9.0],
  [10.5, 10.2],
  [11, 11.7],
  [11.3, 13.0],
  [11.5, 14.1],
  [11.6, 15.3],
  [11.7, 17.7],
  [11.8, 21.5],
  [11.9, 28.4],
  [12, 33.1],
  [12.1, 34.1],
  [12.5, 36.8],
  [13, 38.6],
  [14, 41.0],
  [15, 42.7],
  [16, 44.0],
  [17, 45.1],
  [18, 46.1],
  [19, 46.9],
  [20, 47.6],
  [21, 48.2],
  [22, 48.8],
  [23, 49.4],
  [24, 50]
];

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  bindControls();
  bindLinkedInputs();
  setMethodMode('rational');
});

function bindControls() {
  document
    .getElementById('method-select')
    .addEventListener('change', e => {
      setMethodMode(e.target.value);
    });

  document
    .getElementById('play-btn')
    .addEventListener('click', startSim);

  document
    .getElementById('pause-btn')
    .addEventListener('click', pauseSim);

  document
    .getElementById('reset-btn')
    .addEventListener('click', resetSim);

  document
    .querySelectorAll('input[name="simspeed"]')
    .forEach(r => {
      r.addEventListener('change', () => {
        simSpeed = Number(r.value);
      });
    });
}

function bindLinkedInputs() {
  linkRangeAndPill(
    'intensity',
    'intensity-val',
    5,
    150,
    0
  );

  linkRangeAndPill(
    'runoff-c',
    'c-val',
    0.05,
    1,
    2
  );

  linkRangeAndPill(
    'storm-depth',
    'storm-depth-val',
    5,
    200,
    0
  );

  linkRangeAndPill(
    'curve-number',
    'cn-val',
    30,
    98,
    0
  );

  // Tc max updated to 1000
  linkRangeAndPill(
    'tc',
    'tc-val',
    10,
    1000,
    0
  );
}

function linkRangeAndPill(
  rangeId,
  inputId,
  min,
  max,
  decimals
) {
  const range = document.getElementById(rangeId);
  const input = document.getElementById(inputId);

  const format = value =>
    Number(value).toFixed(decimals);

  const clamp = value =>
    Math.min(max, Math.max(min, Number(value)));

  range.addEventListener('input', () => {
    input.value = format(range.value);
  });

  input.addEventListener('change', () => {
    const value = clamp(input.value || min);

    range.value = value;
    input.value = format(value);
  });
}

function setMethodMode(mode) {
  const isScs = mode === 'scs';

  document.getElementById('method-label').textContent =
    isScs
      ? 'SCS Curve Number'
      : 'Rational Method';

  document.getElementById('method-note').textContent =
    isScs
      ? 'SCS uses storm depth and Curve Number CN.'
      : 'Rational uses rainfall intensity and runoff coefficient C.';

  setControlGroupEnabled(
    'rational-controls',
    !isScs
  );

  setControlGroupEnabled(
    'scs-controls',
    isScs
  );

  const duration =
    document.getElementById('storm-duration');

  if (isScs) {
    duration.value = '1440';
    duration.disabled = true;
  }
  else {
    duration.disabled = false;

    if (duration.value === '1440') {
      duration.value = '60';
    }
  }

  resetSim();
}

function setControlGroupEnabled(
  groupId,
  enabled
) {
  const group =
    document.getElementById(groupId);

  group.classList.toggle(
    'inactive',
    !enabled
  );

  group
    .querySelectorAll(
      'input, select, button'
    )
    .forEach(el => {
      el.disabled = !enabled;
    });
}

function buildHydrograph() {
  return document
    .getElementById('method-select')
    .value === 'scs'
      ? buildScsHydrograph()
      : buildRationalHydrograph();
}

function buildRationalHydrograph() {
  const intensity =
    getNum('intensity-val', 50);

  const durationMin =
    getNum('storm-duration', 60);

  const areaHa =
    getNum('area', 50);

  const c =
    getNum('c-val', 0.75);

  const qPeak =
    (c * intensity * areaHa) / 360;

  const tp =
    (durationMin / 2) * 60;

  const tb =
    2.67 * tp;

  const pts = [];

  for (
    let t = 0;
    t <= tb + 30;
    t += 30
  ) {
    let q = 0;

    if (t <= tp) {
      q = qPeak * (t / tp);
    }
    else if (t <= tb) {
      q =
        qPeak *
        (tb - t) /
        (tb - tp);
    }

    pts.push({
      t,
      Q: Math.max(0, q)
    });
  }

  return pts;
}

function buildScsHydrograph() {
  const depthMm =
    getNum('storm-depth-val', 50);

  const cn =
    getNum('cn-val', 75);

  const areaHa =
    getNum('area', 50);

  const tcMin =
    getNum('tc-val', 60);

  const dtSeconds = 360;
  const stormEnd = 24 * 3600;

  const tLag =
    0.6 * tcMin * 60;

  const tp =
    Math.max(
      dtSeconds,
      (dtSeconds / 2) + tLag
    );

  const nrcsUh = [
    [0, 0],
    [0.1, 0.03],
    [0.2, 0.10],
    [0.3, 0.19],
    [0.4, 0.31],
    [0.5, 0.47],
    [0.6, 0.66],
    [0.7, 0.82],
    [0.8, 0.93],
    [0.9, 0.99],
    [1.0, 1.00],
    [1.1, 0.99],
    [1.2, 0.93],
    [1.3, 0.86],
    [1.4, 0.78],
    [1.5, 0.68],
    [1.7, 0.56],
    [2.0, 0.39],
    [2.2, 0.30],
    [2.5, 0.207],
    [3.0, 0.107],
    [3.5, 0.055],
    [4.0, 0.029],
    [4.5, 0.015],
    [5.0, 0]
  ];

  const response = [];
  const responseEnd = 5 * tp;

  for (
    let t = 0;
    t <= responseEnd;
    t += dtSeconds
  ) {
    const ratio = t / tp;

    let qRatio = 0;

    for (
      let i = 1;
      i < nrcsUh.length;
      i++
    ) {
      const p0 = nrcsUh[i - 1];
      const p1 = nrcsUh[i];

      if (p1[0] >= ratio) {
        const a =
          (ratio - p0[0]) /
          (p1[0] - p0[0]);

        qRatio =
          p0[1] +
          a * (p1[1] - p0[1]);

        break;
      }
    }

    response.push(qRatio);
  }

  const responseArea =
    response.reduce(
      (sum, value) =>
        sum + value * dtSeconds,
      0
    );

  const kernel =
    responseArea > 0
      ? response.map(
          value => value / responseArea
        )
      : [1 / dtSeconds];

  const flow =
    new Array(
      Math.ceil(
        stormEnd / dtSeconds
      ) + kernel.length + 2
    ).fill(0);

  let lastRunoffDepth = 0;

  for (
    let t = 0, step = 0;
    t <= stormEnd;
    t += dtSeconds, step++
  ) {
    const hr = t / 3600;

    const cumulativeRain =
      interpolateScsRain(
        hr,
        depthMm
      );

    const cumulativeRunoff =
      calcCnRunoffDepth(
        cumulativeRain,
        cn
      );

    const incrementalRunoff =
      Math.max(
        0,
        cumulativeRunoff -
        lastRunoffDepth
      );

    lastRunoffDepth =
      cumulativeRunoff;

    const volume =
      incrementalRunoff /
      1000 *
      areaHa *
      10000;

    for (
      let k = 0;
      k < kernel.length;
      k++
    ) {
      flow[step + k] +=
        volume * kernel[k];
    }
  }

  const pts = [];

  for (
    let i = 0;
    i < flow.length;
    i++
  ) {
    pts.push({
      t: i * dtSeconds,
      Q: Math.max(0, flow[i])
    });
  }

  pts.push({
    t: (flow.length + 1) * dtSeconds,
    Q: 0
  });

  return pts;
}

function interpolateScsRain(
  hour,
  depthMm
) {
  if (hour <= 0) {
    return 0;
  }

  if (hour >= 24) {
    return depthMm;
  }

  for (
    let i = 1;
    i < SCS_TYPE_II.length;
    i++
  ) {
    const p0 = SCS_TYPE_II[i - 1];
    const p1 = SCS_TYPE_II[i];

    if (p1[0] >= hour) {
      const a =
        (hour - p0[0]) /
        (p1[0] - p0[0]);

      const rawDepthFor50mm =
        p0[1] +
        a * (p1[1] - p0[1]);

      return (
        (rawDepthFor50mm / 50) *
        depthMm
      );
    }
  }

  return depthMm;
}

function calcCnRunoffDepth(
  rainMm,
  cn
) {
  const s =
    (25400 / cn) - 254;

  const ia = 0.2 * s;

  if (rainMm <= ia) {
    return 0;
  }

  return Math.pow(
    rainMm - ia,
    2
  ) / (
    rainMm + 0.8 * s
  );
}

function getNum(id, fallback) {
  const el =
    document.getElementById(id);

  if (!el) {
    console.warn(
      `getNum: element #${id} not found`
    );

    return fallback;
  }

  const n = Number(el.value);

  return Number.isFinite(n)
    ? n
    : fallback;
}
