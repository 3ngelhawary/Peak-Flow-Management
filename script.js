'use strict';

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calc-btn').addEventListener('click', calculateStorage);

  ['qin', 'qpump', 'duration', 'factor'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') calculateStorage();
    });
  });
});

function getNumber(id) {
  const raw = document.getElementById(id).value.trim();
  const num = Number(raw);
  return raw === '' || isNaN(num) ? NaN : num;
}

function calculateStorage() {
  const qin      = getNumber('qin');
  const qpump    = getNumber('qpump');
  const duration = getNumber('duration');
  const factor   = getNumber('factor');

  const volumeEl  = document.getElementById('volume');
  const messageEl = document.getElementById('message');

  const invalid =
    [qin, qpump, duration, factor].some(isNaN) ||
    qin <= 0 || qpump < 0 || duration <= 0 || factor <= 0;

  if (invalid) {
    volumeEl.textContent  = '—';
    messageEl.textContent = 'Please enter valid positive values for all fields.';
    return;
  }

  const excessFlow = qin - qpump;

  if (excessFlow <= 0) {
    volumeEl.textContent  = '0 m³';
    messageEl.textContent =
      'Pump capacity meets or exceeds the peak inflow — no retention storage required.';
    return;
  }

  const volume = excessFlow * (duration * 60) * factor;

  volumeEl.textContent  = `${Math.round(volume).toLocaleString()} m³`;
  messageEl.textContent =
    `Excess flow: ${excessFlow.toFixed(2)} m³/s — ` +
    `Duration: ${duration} min — ` +
    `Safety factor: ×${factor.toFixed(2)}`;
}
