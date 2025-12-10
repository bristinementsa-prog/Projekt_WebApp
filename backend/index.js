require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' }));

const SECRET = process.env.SECRET || 'supersecret';
const MIRTH_URL = process.env.MIRTH_URL || null;
const MIRTH_AUTH = {
  username: process.env.MIRTH_USER || '',
  password: process.env.MIRTH_PASS || ''
};

// In-memory HL7 messages (dein aktuelles Verhalten)
const messages = [];

// MariaDB Pool
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'appuser',
  password: process.env.DB_PASS || 'appsecret',
  database: process.env.DB_NAME || 'transfusiondb',
  waitForConnections: true,
  connectionLimit: 10,
});

function normalizeEk(ek) {
  if (!ek || typeof ek !== 'string') return ek;
  return ek
  .trim()
  .replace(/ß/g, '-')
  .replace(/[`´]/g, '+')
  .toUpperCase();
}
// ======================


// ---------- HL7 Parser (robust) ----------
/**
 * parseHL7(text) -> { msh: {...}, pid: {...}, bpos: [...], nte: [...] }
 * returns object with important fields. tolerant to CR/LF and missing segments.
 */
function parseHL7(hl7text) {
  if (!hl7text || typeof hl7text !== 'string') return null;
  // Normalize line endings and split
  const lines = hl7text.replace(/\r/g, '\n').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = { msh: {}, pid: {}, bpos: [], nte: [] };

  for (const line of lines) {
    const parts = line.split('|');
    const seg = parts[0];

    if (seg === 'MSH') {
      out.msh = {
        sendingApp: parts[2] || null,
        sendingFac: parts[3] || null,
        receivingApp: parts[4] || null,
        datetime: parts[6] || null,
        msgType: (parts[8] || null)
      };
    } else if (seg === 'PID') {
      out.pid = {
        setId: parts[1] || null,
        patientId: (parts[3] || null),
        name: parts[5] || null,
        dob: parts[7] || null,
        gender: parts[8] || null
      };
    } else if (seg === 'BPO' || seg === 'BPO') {
      // BPO fields vary; we assume product id at index 4 per your example
      out.bpos.push({
        raw: line,
        product: parts[4] || null,
        quantity: parts[5] || null
      });
    } else if (seg === 'NTE') {
      // NTE: structure NTE|1||Text...
      out.nte.push({
        raw: line,
        text: parts.slice(3).join('|') // join rest as text
      });
    } else if (seg === 'OBX') {
      // capture OBX if it contains bloodgroup etc.
      out.obx = out.obx || [];
      out.obx.push(parts);
    }
  }

  // Try to derive blood group from NTEs (search common keywords)
  const nteText = out.nte.map(n => n.text).join('||').toLowerCase();
  const bgMatch = nteText.match(/(patientenblutgruppe|blutgruppe)\s*[:\-]?\s*([a0o]\+|\+|-|ab\+|ab\-|a\+|a\-|b\+|b\-|0\+|0\-|o\+|o\-|a\/b|ab)/i);
  if (bgMatch) out.bloodGroup = bgMatch[2].replace(/0/gi, 'O');
  else {
    // try another variant
    const simple = nteText.match(/blutgruppe[:\s]*([^\s|,]+)/i);
    if (simple) out.bloodGroup = simple[1].replace(/0/gi, 'O');
  }

  return out;
}

// ---------- Helper: ask Mirth for patient (if MIRTH_URL configured) ----------
async function queryMirthForPid(pid) {
  if (!MIRTH_URL) return null;
  try {
    // Beispiel: Mirth API endpoint muss in Mirth konfiguriert sein - hier ist ein generischer GET
    // Wenn du Mirth so konfiguriert hast, dass es einen eigenen REST Endpoint bereitstellt, rufe ihn hier auf.
    // Falls nicht vorhanden, lasse Mirth die HL7 Nachrichten an /mirth-in pushen.
    const url = `${MIRTH_URL}/api/get-hl7-by-pid?pid=${encodeURIComponent(pid)}`;
    const resp = await axios.get(url, {
      auth: MIRTH_AUTH,
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      timeout: 5000
    });
    return resp.data;
  } catch (err) {
    console.warn('Mirth query failed:', err.message);
    return null;
  }
}

function formatHl7Ts(date) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return (
    pad(date.getFullYear(), 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function buildBtsO31Message({ rec, menge, mitarbeiterId }) {
  const now   = new Date();
  const ts    = formatHl7Ts(now);       // DTM für MSH-7, BPO-7, BTX-13
  const msgId = `${Date.now()}`;        // einfache eindeutige Message Control ID

  const sendingApp      = 'TransfusionApp';
  const sendingFacility = 'Niederrhein-Klinik';
  const recvApp         = 'BloodBank';
  const recvFacility    = 'MainLab';

  // -------- Patientendaten --------
  let dob = '';
  if (rec.geburtsdatum) {
    const d = new Date(rec.geburtsdatum);
    dob = formatHl7Ts(d).slice(0, 8);   // YYYYMMDD
  }

  const geschl = rec.geschlecht || '';
  const name   = `${rec.nachname || ''}^${rec.vorname || ''}`;
  const pid    = rec.kh_pid || '';

  const chargen = rec.chargennummer || '';
  const bg      = rec.blutgruppe || '';   // z.B. "0-"
  const typ     = rec.typ || '';          // z.B. "Erythrozyten"
  const ml      = menge || rec.menge_pro_einheit || '';

  // Wenn du feste Codes verwenden willst, kannst du das hier anpassen:
  const compCode = 'ERY';                     // Code für EK
  const compText = typ || 'Erythrozytenkonzentrat';

  // ---------------- MSH ----------------
  const msh =
    `MSH|^~\\&|${sendingApp}|${sendingFacility}|${recvApp}|${recvFacility}|` +
    `${ts}||BTS^O31^BTS_O31|${msgId}|P|2.8`;

  // ---------------- PID ----------------
  const pidSeg =
    `PID|1||${pid}^^^${sendingFacility}^PI||${name}||${dob}|${geschl}`;

  // ---------------- ORC ----------------
  // ORC-1 = RE (Result event)
  // ORC-2 = Placer Order Number -> wir nehmen die Blutprodukt-ID / Bestellung
  // ORC-5 = CM (Completed)
  // ORC-9 = Datum/Zeit Transaktion
  // ORC-10 = Eingegeben von (hier nur die ID, XCN kannst du später sauber befüllen)
  const orderId = rec.blutprodukt_id || rec.bestellung_id || '';

  const orc =
    `ORC|RE|${orderId}|||CM||||||${ts}|${mitarbeiterId}`;

  // ---------------- BPO ----------------
  // BPO-1: Set ID
  // BPO-2: Bp Universal Service Id -> EK
  // BPO-4: Bp Menge
  // BPO-6: Bp Einheiten
  // BPO-7: Bp absichtliche Verwendung Datum/Zeit -> Transfusionszeit
  const bpo =
    `BPO|1|${compCode}^${compText}^99BB||${ml}||mL^milliliter^UCUM|${ts}`;

  // ---------------- NTE (optional) ----------------
  const nte1 = `NTE|1||Transfusion ${ml} ml von Produkt ${chargen}`;
  const nte2 = `NTE|2||Lokaler Status: transfundiert`;

  // ---------------- BTX ----------------
  // BTX-1: Set ID
  // BTX-2: Spenden-ID -> Chargennummer / DonationID
  // BTX-3: Komponente -> Code + Text
  // BTX-4: Blutgruppe -> z.B. "0-"
  // BTX-7: Lot Nummer -> auch Chargennummer
  // BTX-8: Menge (ml)
  // BTX-10: Einheiten -> mL
  // BTX-11: Transfusions-/Dispositionstatus -> TX^Transfused^HL70513 (prüfbar im HL7-Table, sonst anpassen)
  // BTX-12: Nachrichtenstatus -> P^Processed^HL70511
  // BTX-13: Datum/Statuszeit -> ts
  // BTX-14: Transfusionsadministrator -> Mitarbeiter-ID als einfacher XCN
  const btx =
    `BTX|1|${chargen}|${compCode}^${compText}^99BB|${bg}^${bg}^99BLUT|||` +
    `${chargen}|${ml}||mL^milliliter^UCUM|TX^Transfused^HL70513|` +
    `P^Processed^HL70511|${ts}|${mitarbeiterId}^^^Transfusionspflege`;

  // Reihenfolge: MSH, PID, ORC, BPO, NTE, BTX
  return [msh, pidSeg, orc, bpo, nte1, nte2, btx].join('\r') + '\r';
}



// ---------- Routes ----------

// LOGIN (bleibt wie gehabt)
const USERS = [
  { username: 'Meier', password: 'Test-1234', role: 'pflege' },
  { username: 'Müller', password: 'Test1234', role: 'arzt' }
];

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: 'Ungültige Login-Daten' });
  const token = jwt.sign({ username: user.username, role: user.role }, SECRET, { expiresIn: '2h' });
  res.json({ token });
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

// Mirth sendet HL7 hierhin
app.post('/mirth-in', (req, res) => {
  const hl7 = (req.body || '').toString();
  console.log('HL7 von Mirth empfangen — Länge:', hl7.length);
  messages.push(hl7);
  res.send('OK');
});

// API: Patient holen (versucht Mirth, sonst lokale messages)
app.get('/api/patient/:pid', async (req, res) => {
  const pid = req.params.pid;

  let conn;
  try {
    conn = await dbPool.getConnection();

    // 1) Patient über KH-PID holen
    const [patRows] = await conn.execute(
      `SELECT id, vorname, nachname, geburtsdatum, geschlecht,
              blutgruppe, station, anlass, diagnose, icd_code, kh_pid
       FROM patienten
       WHERE kh_pid = ?`,
      [pid]
    );

    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient nicht gefunden' });
    }

    const patient = patRows[0];

    // 2) Vorgesehene EKs für diesen Patienten holen
    const [ekRows] = await conn.execute(
      `SELECT
         bp.id             AS blutprodukt_id,
         bp.chargennummer  AS ek_barcode,
         bp.status         AS ek_status,
         bp.ablaufdatum,
         bb.blutgruppe,
         bb.typ,
         b.id              AS bestellung_id,
         b.hl7_order_no
       FROM blutprodukte bp
       JOIN blutbestand bb   ON bb.id = bp.bestand_id
       LEFT JOIN bestellungen b ON b.id = bp.bestellung_id
       WHERE bp.patient_id = ?
  AND bp.status IN ('reserviert', 'abgeholt_bestaetigt')`,
      [patient.id]
    );

    console.log('DEBUG /api/patient PID=', pid);
    console.log('DEBUG patient:', patient);
    console.log('DEBUG eks:', ekRows);

    return res.json({
      patient,
      eks: ekRows      // wird in der Webapp unter "Vorgesehene EKs" angezeigt
    });

  } catch (err) {
    console.error('DB-Fehler /api/patient:', err);
    return res.status(500).json({ error: 'DB-Fehler', details: err.message });
  } finally {
    if (conn) conn.release();
  }
});


// API: EK validieren
app.post('/api/validate-ek', async (req, res) => {
  const { pid, ek } = req.body;      // pid = KH-PID, ek = Barcode/Chargennummer

  const normPid = (pid || '').trim();
  const normEk  = normalizeEk(ek);

  if (!normPid || !normEk) {
    return res.status(400).json({ error: 'pid oder ek fehlt' });
  }

  let conn;
  try {
    conn = await dbPool.getConnection();

    const [rows] = await conn.execute(
      `SELECT
         p.id           AS patienten_id,
         p.kh_pid       AS kh_pid,
         p.vorname,
         p.nachname,
         p.geburtsdatum,
         p.geschlecht,
         bp.id          AS blutprodukt_id,
         bp.chargennummer,
         bp.status      AS ek_status,       -- WICHTIG: Alias
         bp.ablaufdatum,
         bb.menge_pro_einheit,
         bb.blutgruppe,
         bb.typ
       FROM patienten p
       JOIN blutprodukte bp ON bp.patient_id = p.id
       JOIN blutbestand bb  ON bb.id = bp.bestand_id
       WHERE p.kh_pid = ?
         AND bp.chargennummer = ?`,
      [normPid, normEk]
    );


    if (rows.length === 0) {
      // EK gehört nicht zu diesem Patienten
      return res.json({
        valid: false,
        reason: 'EK gehört nicht zu diesem Patienten oder ist nicht reserviert'
      });
    }

    const rec = rows[0];

    // Ablaufdatum prüfen
    const heute = new Date();
    const ablauf = rec.ablaufdatum ? new Date(rec.ablaufdatum) : null;
    if (ablauf && ablauf < heute) {
      return res.json({
        valid: false,
        reason: 'EK abgelaufen',
        details: rec
      });
    }

    // Status prüfen
    const allowed = ['reserviert', 'abgeholt_bestaetigt']; // evtl. noch 'verfügbar', falls du den wirklich benutzt
    if (!allowed.includes(rec.ek_status)) {
      return res.json({
        valid: false,
        reason: `EK hat ungültigen Status: ${rec.ek_status}`,
        details: rec
      });
    }

    // Alles okay → EK passt
    return res.json({
      valid: true,
      patient: {
        id: rec.patient_id,
        vorname: rec.vorname,
        nachname: rec.nachname,
        kh_pid: rec.kh_pid
      },
      ek: rec
    });

  } catch (err) {
    console.error('DB-Fehler /api/validate-ek:', err);
    return res.status(500).json({ error: 'DB-Fehler', details: err.message });
  } finally {
    if (conn) conn.release();
  }
});


// API: Transfusion aufzeichnen
app.post('/api/record-transfusion', async (req, res) => {
  const { pid, ek, mitarbeiterId, menge_ml } = req.body;

  const normPid = (pid || '').trim();
  const normEk  = normalizeEk(ek);

  if (!normPid || !normEk || !mitarbeiterId) {
    return res.status(400).json({ error: 'pid, ek, mitarbeiterId erforderlich' });
  }

  let conn;
  let rec;

  try {
    conn = await dbPool.getConnection();
   // await conn.beginTransaction();

    // Patient + EK holen (und gleich sperren)
    const [rows] = await conn.execute(
      `SELECT
         p.id           AS patienten_id,
         p.kh_pid       AS kh_pid,
         p.vorname,
         p.nachname,
         p.geburtsdatum,
         p.geschlecht,
         bp.id          AS blutprodukt_id,
         bp.chargennummer,
         bp.status,
         bb.menge_pro_einheit,
         bb.blutgruppe,
         bb.typ,
         b.id           AS bestellung_id,
         b.hl7_order_no
       FROM patienten p
       JOIN blutprodukte bp ON bp.patient_id = p.id
       JOIN blutbestand bb  ON bb.id = bp.bestand_id
       LEFT JOIN bestellungen b ON b.id = bp.bestellung_id
       WHERE p.kh_pid = ?
         AND bp.chargennummer = ?`,
      [normPid, normEk]
    );

    if (rows.length === 0) {
  return res.status(404).json({ error: 'Kombination aus Patient und EK nicht gefunden' });
}
rec = rows[0];


  } catch (err) {
    console.error('DB-Lesefehler /api/record-transfusion', err);
    return res.status(500).json({ error: 'DB-Lesefehler', details: err.message });
  } finally {
    if (conn) conn.release();
  }

  // 2) OPTIONAL: einfache Statusprüfung (wenn du z.B. bereits transfundierte nicht nochmal schicken willst)
  if (rec.status === 'transfundiert') {
    return res.status(400).json({ error: 'EK ist bereits als transfundiert markiert (laut DB)' });
  }

  const menge = menge_ml || rec.menge_pro_einheit || null;

  // 3) HL7-Nachricht bauen
  const hl7 = buildBtsO31Message({
    rec,
    menge,
    mitarbeiterId
  });

  // 4) HL7 an Mirth schicken – keine DB-Änderung hier!
  if (!MIRTH_URL) {
    // falls du zum Testen noch keine Mirth-URL gesetzt hast
    console.log('HL7 BTS_O31 (MIRTH_URL fehlt):\n' + hl7);
    return res.json({ ok: true, hint: 'MIRTH_URL nicht gesetzt, HL7 nur geloggt' });
  }

  try {
    const url = `${MIRTH_URL}/bts_transfusion/`; // Pfad muss zu deinem HTTP-Listener passen

    await axios.post(url, hl7, {
      auth: MIRTH_AUTH,
      headers: { 'Content-Type': 'text/plain' },
      // falls du HTTPS mit Self-Signed nutzt:
      // httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      timeout: 5000
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error('Fehler beim Senden an Mirth (BTS_O31):', err.message);
    return res.status(502).json({
      error: 'Fehler beim Senden an Mirth',
      details: err.message
    });
  }
});


// Start server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Backend läuft auf http://0.0.0.0:${PORT}`));


