const API_BASE = 'http://localhost:3002';

// Scanner-Fix: ß -> -  und Großbuchstaben
function normalizeEk(raw) {
  if (!raw) return '';
  return raw
  .trim()
  .replace(/ß/g, '-')
  .replace(/[`´]/g, '+')
  .toUpperCase();
}

// in-memory Zustand im Browser
let currentEks = [];   // alle vorgesehenen EKs aus der DB
let scannedEks = [];   // für diese Transfusion gescannte EKs

// -------------------------------------------------------
// Login / Seitenumschaltung
// -------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const loginPage = document.getElementById('loginPage');
  const patientPage = document.getElementById('patientPage');
  patientPage.style.display = 'none';

  document.getElementById('btnLogin').addEventListener('click', async () => {
    const user = document.getElementById('user').value.trim();
    const pass = document.getElementById('pass').value.trim();

    if (!user || !pass) return alert('Bitte Benutzername und Passwort eingeben');

    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Login fehlgeschlagen');
        return;
      }

      const { token } = await res.json();
      localStorage.setItem('token', token);

      // Login erfolgreich → Patientenseite anzeigen
      loginPage.style.display = 'none';
      patientPage.style.display = 'block';
      document.getElementById('pid').focus();

    } catch (err) {
      console.error(err);
      alert('Benutzername oder Passwort falsch');
    }
  });

  // Transfusions-Button
  const btnTransfuse = document.getElementById('btnTransfuse');
  if (btnTransfuse) {
    btnTransfuse.addEventListener('click', doTransfusion);
  }
});

// -------------------------------------------------------
// 1) ENTER vom Barcode-Scanner abfangen
// -------------------------------------------------------
document.getElementById("pid").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    loadPatient();
  }
});

document.getElementById("ek").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    validateEK();
  }
});

// -------------------------------------------------------
// 2) Buttons (falls kein Scanner-ENTER geschickt wird)
// -------------------------------------------------------
document.getElementById("btnLoadPatient").onclick = loadPatient;
document.getElementById("btnValidate").onclick = validateEK;

// -------------------------------------------------------
// 3) Patient aus Backend laden
// -------------------------------------------------------
async function loadPatient() {
  const pid = document.getElementById("pid").value.trim();
  if (!pid) return;

  const token = localStorage.getItem('token');

  try {
    const res = await fetch(`${API_BASE}/api/patient/${pid}`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });

    if (res.status === 404) {
      showResult("Patient nicht gefunden", "danger");
      document.getElementById("ptName").textContent = "";
      document.getElementById("ptDob").textContent = "";
      document.getElementById("ptBlood").textContent = "";
      return;
    }

    if (!res.ok) {
      console.error('Fehlerstatus:', res.status);
      showResult("Fehler beim Laden des Patienten", "danger");
      return;
    }

    const data = await res.json();
    if (!data.patient) {
      showResult("Patient nicht gefunden", "danger");
      return;
    }

    const p = data.patient;

    document.getElementById("ptName").textContent =
      `${p.vorname} ${p.nachname}`;
    document.getElementById("ptDob").textContent = p.geburtsdatum || "";
    document.getElementById("ptBlood").textContent = p.blutgruppe || "";

    document.getElementById("patientBox").style.display = "block";
    document.getElementById("ekScanBox").style.display = "block";

    // EKs aus der DB merken + anzeigen
    currentEks = data.eks || [];
    scannedEks = []; // bei neuem Patienten leeren
    renderEkTable();
    renderScannedEkList();

    document.getElementById("ek").value = "";
    document.getElementById("ek").focus();

  } catch (err) {
    console.error(err);
    showResult("Fehler beim Laden des Patienten", "danger");
  }
}

// -------------------------------------------------------
// 4) EK-Validierung + in "eingescannte EKs" aufnehmen
// -------------------------------------------------------
async function validateEK() {
  const pid = document.getElementById("pid").value.trim();
  const ekInput = document.getElementById("ek");
  const ekNorm  = normalizeEk(ekInput.value);

  ekInput.value = ekNorm; // Anzeige korrigieren

  if (!pid || !ekNorm) return;

  const res = await fetch(`${API_BASE}/api/validate-ek`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid, ek: ekNorm })
  });

  const data = await res.json();

  if (data.valid) {
    showResult("EK ist gültig ✔", "success");

    const code = data.ek.ek_barcode || ekNorm;

    // in Liste der gescannten EKs aufnehmen (oder reaktivieren)
    let item = scannedEks.find(e => e.ek_barcode === code);
    if (!item) {
      item = {
        ek_barcode: code,
        ek: data.ek,
        selected: true,
        menge_ml: ""   // optional vom User eintragbar
      };
      scannedEks.push(item);
    } else {
      item.selected = true;
    }

    renderEkTable();
    renderScannedEkList();

    ekInput.value = "";
    ekInput.focus();
  } else {
    showResult("EK NICHT gültig ❌<br>" + (data.reason || ""), "danger");
  }
}

// -------------------------------------------------------
// 5) Tabellen-Rendering
// -------------------------------------------------------
function renderEkTable() {
  const ekListDiv = document.getElementById("ekList");
  if (!ekListDiv) return;

  if (!currentEks || currentEks.length === 0) {
    ekListDiv.innerHTML = "<p>Keine EKs für diesen Patienten gefunden.</p>";
    return;
  }

  let html = `
    <table class="table table-sm">
      <thead>
        <tr>
          <th></th>
          <th>Barcode</th>
          <th>Blutgruppe</th>
          <th>Typ</th>
          <th>Status</th>
          <th>Ablaufdatum</th>
        </tr>
      </thead>
      <tbody>
  `;

  currentEks.forEach(ek => {
    const ablauf = ek.ablaufdatum
      ? new Date(ek.ablaufdatum).toLocaleDateString('de-DE')
      : '';
    const scanned = scannedEks.some(s => s.ek_barcode === ek.ek_barcode && s.selected);

    html += `
      <tr class="${scanned ? 'table-success' : ''}">
        <td>${scanned ? '✔' : ''}</td>
        <td>${ek.ek_barcode}</td>
        <td>${ek.blutgruppe || ''}</td>
        <td>${ek.typ || ''}</td>
        <td>${ek.ek_status}</td>
        <td>${ablauf}</td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  ekListDiv.innerHTML = html;
}

function renderScannedEkList() {
  const div = document.getElementById("scannedEkList");
  if (!div) return;

  if (!scannedEks || scannedEks.length === 0) {
    div.innerHTML = "<p>Noch keine EKs gescannt.</p>";
    updateTransfuseButtonState();
    return;
  }

  let html = `
    <table class="table table-sm">
      <thead>
        <tr>
          <th>auswählen</th>
          <th>Barcode</th>
          <th>Blutgruppe</th>
          <th>Status</th>
          <th>Menge (ml)</th>
        </tr>
      </thead>
      <tbody>
  `;

  scannedEks.forEach(item => {
    const ek = item.ek;
    html += `
      <tr class="${item.selected ? '' : 'table-light'}">
        <td>
          <input type="checkbox" class="form-check-input" data-ek="${item.ek_barcode}"
                 ${item.selected ? 'checked' : ''}>
        </td>
        <td>${item.ek_barcode}</td>
        <td>${ek.blutgruppe || ''}</td>
        <td>${ek.ek_status}</td>
        <td style="max-width:120px;">
          <input type="number"
                 class="form-control form-control-sm"
                 min="0"
                 data-ek-ml="${item.ek_barcode}"
                 value="${item.menge_ml !== "" ? item.menge_ml : ''}">
        </td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  div.innerHTML = html;

  // Checkbox-Events
  div.querySelectorAll('input[type="checkbox"][data-ek]').forEach(cb => {
    cb.addEventListener('change', () => {
      const code = cb.getAttribute('data-ek');
      const item = scannedEks.find(s => s.ek_barcode === code);
      if (item) {
        item.selected = cb.checked;
        renderEkTable();
        updateTransfuseButtonState();
      }
    });
  });

  // ml-Inputs
  div.querySelectorAll('input[type="number"][data-ek-ml]').forEach(inp => {
    inp.addEventListener('change', () => {
      const code = inp.getAttribute('data-ek-ml');
      const item = scannedEks.find(s => s.ek_barcode === code);
      if (item) {
        const val = inp.value.trim();
        item.menge_ml = val ? parseInt(val, 10) : "";
      }
    });
  });

  updateTransfuseButtonState();
}

function updateTransfuseButtonState() {
  const btn = document.getElementById("btnTransfuse");
  if (!btn) return;
  const anySelected = scannedEks.some(s => s.selected);
  btn.disabled = !anySelected;
}

// -------------------------------------------------------
// 6) Transfusion durchführen (mehrere EKs)
// -------------------------------------------------------
async function doTransfusion() {
  const pid = document.getElementById("pid").value.trim();
  if (!pid) return;

  const selected = scannedEks.filter(s => s.selected);
  if (selected.length === 0) {
    showResult("Keine EKs für Transfusion ausgewählt.", "danger");
    return;
  }

  // vorerst feste Mitarbeiter-ID (Backend verlangt sie, nutzt sie aber nicht wirklich)
  const mitarbeiterId = 1;

  let ok = 0;
  let fail = 0;
  const details = [];

  for (const item of selected) {
    const body = {
      pid,
      ek: item.ek_barcode,
      mitarbeiterId,
      menge_ml: item.menge_ml || undefined   // wenn leer → Backend nimmt Standardmenge
    };

    try {
      const res = await fetch(`${API_BASE}/api/record-transfusion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        ok++;
        details.push(`EK ${item.ek_barcode}: gespeichert`);
      } else {
        fail++;
        details.push(`EK ${item.ek_barcode}: FEHLER – ${(data && data.error) || res.statusText}`);
      }
    } catch (err) {
      fail++;
      details.push(`EK ${item.ek_barcode}: FEHLER – ${err.message}`);
    }
  }

  const msg =
    `Transfusion fertig. Erfolgreich: ${ok}, Fehler: ${fail}<br>` +
    details.join("<br>");

  showResult(msg, fail ? "warning" : "success");
}

// -------------------------------------------------------
// 7) Ergebnisbox anzeigen
// -------------------------------------------------------
function showResult(msg, type) {
  document.getElementById("result").innerHTML =
    `<div class="alert alert-${type}">${msg}</div>`;
}
