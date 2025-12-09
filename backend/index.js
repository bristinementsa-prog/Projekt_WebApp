// --- Module ---
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

// --- App erstellen ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' })); // für Mirth POSTs als Text

// --- Geheimschlüssel JWT ---
const SECRET = 'supersecret';

// --- Lokale Personal-Daten ---
const USERS = [
  { username: 'Meier', password: 'Test-1234', role: 'pflege' },
  { username: 'Müller', password: 'Test1234', role: 'arzt' }
];

// --- LOGIN Route ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  const user = USERS.find(
    u => u.username.toLowerCase() === username.toLowerCase() && u.password === password
  );

  if (!user) return res.status(401).json({ error: 'Ungültige Login-Daten' });

  const token = jwt.sign({ username: user.username, role: user.role }, SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// --- Statische Dateien laden (Frontend) ---
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- GET / liefert index.html ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// --- HL7 Nachrichtenverwaltung ---
const messages = []; // Array für alle empfangenen Nachrichten

// --- POST /mirth-in: Nachricht von Mirth empfangen ---
app.post('/mirth-in', (req, res) => {
  const hl7Text = req.body;
  console.log('Nachricht aus Mirth empfangen:\n', hl7Text);

  // Nachricht speichern
  messages.push(hl7Text);

  res.send('OK');
});

// --- GET /api/get-patient-by-pid?pid=XXX ---
app.get('/api/get-patient-by-pid', (req, res) => {
  const { pid } = req.query;
  if (!pid) return res.status(400).json({ error: 'PID fehlt' });

  const msg = messages.find(msg => msg.includes(`|${pid}^`));
  if (!msg) return res.status(404).json({ error: 'Patient nicht gefunden' });

  const lines = msg.split(/\r?\n/);
  const patient = { ekProduct: null, patientBloodGroup: null };

  lines.forEach(line => {
    const parts = line.split('|');
    if (parts[0] === 'PID') {
      patient.patientId = parts[3] || null;
      patient.patientName = parts[5] || null;
      patient.dob = parts[7] || null;
      patient.gender = parts[8] || null;
    }
    if (parts[0] === 'BPO') {
      patient.ekProduct = parts[4] || null; // bestelltes Produkt
    }
    if (parts[0] === 'NTE') {
      if (parts[2] && parts[2].includes('Patientenblutgruppe')) {
        patient.patientBloodGroup = parts[3] || null;
      }
    }
  });

  res.json(patient);
});

// --- POST /api/check-ek ---
// Body: { pid: '12345678', scannedEK: 'A+-EK-006' }
app.post('/api/check-ek', (req, res) => {
  const { pid, scannedEK } = req.body;
  if (!pid || !scannedEK) return res.status(400).json({ error: 'PID oder EK fehlt' });

  const msg = messages.find(msg => msg.includes(`|${pid}^`));
  if (!msg) return res.status(404).json({ error: 'Patient nicht gefunden' });

  const lines = msg.split(/\r?\n/);
  let expectedEK = null;
  lines.forEach(line => {
    const parts = line.split('|');
    if (parts[0] === 'BPO') {
      expectedEK = parts[4]; // bestelltes Produkt / Charge
    }
  });

  if (!expectedEK) return res.status(404).json({ error: 'Keine EK-Daten vorhanden' });

  if (scannedEK === expectedEK) {
    res.json({ match: true, message: 'EK passt zum Patienten ✅' });
  } else {
    res.json({ match: false, message: 'Falsches EK! Transfusion blockiert ❌' });
  }
});

// --- Server starten ---
const PORT = 3001;
app.listen(PORT, () => console.log(`Backend läuft auf http://localhost:${PORT}`));
