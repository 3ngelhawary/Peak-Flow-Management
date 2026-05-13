// File: script.js
function getNumber(id) {
  return Number(document.getElementById(id).value);
}

function calculateStorage() {
  const qin = getNumber("qin");
  const qpump = getNumber("qpump");
  const duration = getNumber("duration");
  const factor = getNumber("factor");
  const volumeBox = document.getElementById("volume");
  const message = document.getElementById("message");

  if (qin <= 0 || qpump < 0 || duration <= 0 || factor <= 0) {
    volumeBox.textContent = "-";
    message.textContent = "Please enter valid positive values.";
    return;
  }

  const excessFlow = qin - qpump;

  if (excessFlow <= 0) {
    volumeBox.textContent = "0 m³";
    message.textContent = "Pump capacity is enough for the entered peak flow.";
    return;
  }

  const durationSeconds = duration * 60;
  const volume = excessFlow * durationSeconds * factor;

  volumeBox.textContent = `${volume.toFixed(0)} m³`;
  message.textContent =
    `Excess flow = ${excessFlow.toFixed(2)} m³/s. ` +
    `Storage includes safety factor ${factor.toFixed(2)}.`;
}
