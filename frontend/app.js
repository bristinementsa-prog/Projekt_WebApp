document.addEventListener('DOMContentLoaded', () => {
  const loginPage = document.getElementById('loginPage');
  const patientPage = document.getElementById('patientPage');
  patientPage.style.display = 'none';

  document.getElementById('btnLogin').addEventListener('click', async () => {
    const user = document.getElementById('user').value.trim();
    const pass = document.getElementById('pass').value.trim();

    if (!user || !pass) return alert('Bitte Benutzername und Passwort eingeben');

    try {
      const res = await fetch('http://localhost:3001/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });

      if (!res.ok) {
        const err = await res.json();
        return alert(err.error);
      }

      const { token } = await res.json();
      localStorage.setItem('token', token);

      // Login erfolgreich → Patientenseite anzeigen
      loginPage.style.display = 'none';
      patientPage.style.display = 'block';

    } catch (err) {
      console.error(err);
      alert('Benutzername oder Passwort falsch');
    }
  });
});
// --- Elemente ---
const patientInfo = document.getElementById('patientInfo');
const ekList = document.getElementById('ekList');
const validationResult = document.getElementById('validationResult');
const transfusionResult = document.getElementById('transfusionResult');

// PATIENT LADEN
document.getElementById('btnLoadPatient').addEventListener('click', async () => {
    const pid = document.getElementById('pid').value.trim();
    const token = localStorage.getItem('token');
    if (!pid) return alert("Bitte PID scannen");

    const res = await fetch("http://localhost:3001/api/patient/" + pid, {
        headers: { "Authorization": "Bearer " + token }
    });

    const data = await res.json();

    patientInfo.textContent = JSON.stringify(data, null, 2);

    // Beispiel: EKs anzeigen (später aus OpenEMR)
    ekList.innerHTML = `
      <div>
        <strong>EK1:</strong><br>
        Nummer: 123456<br>
        Ablauf: 2025-02-20<br>
        Blutgruppe: 0+
      </div>

      <div>
        <strong>EK2:</strong><br>
        Nummer: 123457<br>
        Ablauf: 2025-02-21<br>
        Blutgruppe: 0+
      </div>
    `;
});

// EK VALIDIEREN
document.getElementById('btnValidateEK').addEventListener('click', () => {
    const patientId = document.getElementById('pid').value.trim();
    const ekCode = document.getElementById('ekScan').value.trim();

    if (!patientId || !ekCode) return alert("PID und EK scannen");

    // Beispiel-Check (später: API an Mirth)
    if (ekCode === "123456" || ekCode === "123457") {
        validationResult.textContent = "OK: EK passt zum Patienten";
        validationResult.className = "status-ok";
    } else {
        validationResult.textContent = "FEHLER: EK gehört nicht zu diesem Patienten!";
        validationResult.className = "status-error";
    }
});

// TRANSFUSION
document.getElementById('btnTransfuse').addEventListener('click', async () => {
    transfusionResult.textContent = "Transfusion dokumentiert (Demo)...";
});

