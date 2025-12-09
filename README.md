# Projekt_WebApp
WebApp zur sicheren Zuordnung, Dokumentation und Transfusion von Blutprodukten (Integration mit openEMR ; Mirth Connect, und Blutbank DB )
# Blutprodukt-Management WebApp  
**Klinik Niederrhein – Zentrale Notaufnahme / Station 1**

# Systemarchitektur

### 1. **openEMR (KIS-System)**
- Arzt ordnet Blutprodukte an (z. B. 2 EKs)
- openEMR erzeugt automatisch eine **HL7 OMB^O27**-Nachricht
- Enthält: Patientendaten, Produktanforderung, Menge usw.
- Nachricht wird digital an die Blutbank übermittelt

### 2. **Mirth Connect**
- Empfängt HL7 (TCP Listener)
- Validiert, transformiert und routet Nachrichten
- Leitet die Anfrage an das Blutbank-Informationssystem weiter  
- Leitet später die Rückmeldung der Blutbank an openEMR zurück

### 3. **Blutbank-System**
- Prüft Anforderung
- Liefert passende EK-Daten als **HL7 ORU^R01**
  - Chargennummer  
  - Blutgruppe  
  - Haltbarkeit  
  - Lagerort  
- Daten werden dem Patienten in openEMR zugeordnet

---

##  Funktion der WebApp (Pflege-App / Stations-App)

###  1. Patientenauswahl
Pflegekraft wählt den Patienten auf Station 1 über die WebApp aus.

###  2. Anzeige der Blutprodukte
Die App zeigt für diesen Patienten:
- vorgesehene EK-Konservennummern  
- Ablaufdatum  
- Status (bereitgestellt / ausstehend)  

### 3. Barcode-Scan & Sicherheit
- Scan des Patientenarmbandes  
- Scan des EK-Barcodes  
- Automatische Systemprüfung:
  - AB0-Kompatibilität  
  - Richtige Chargennummer  
  - Richtige Zuordnung zum Patienten  
- Visuelle Rückmeldung:
  - ✔️ Grüner Pfeil = korrekt  
  - ❌ Rotes Kreuz = falsches Produkt / Fehlzuordnung  

###  4. Dokumentation
Nach Freigabe:
- Transfusion wird gestartet  
- Uhrzeit, Pflegekraft, Status → automatisch dokumentiert  
- Mirth Connect überträgt Daten zurück an openEMR  
- Lückenlose Rückverfolgbarkeit gewährleistet

---

##  Ergebnis im Beispiel
Nach Transfusion:
- Hb steigt auf **9,5 g/dl**
- Hämodynamische Stabilisierung
- Koloskopie zeigt blutende Divertikulose
- Patient nach 2 Tagen stabil → Entlassungsdiagnose **K57.33**

---

##  Technologien
- WebApp (Frontend): HTML/JS/Framework deiner Wahl  
- Backend: z. B. Node, PHP oder im Klinikum vorhandenes System  
- HL7 Kommunikation über **Mirth Connect**  
- KIS: **openEMR**  
- Barcode-Scanning (WebAPI oder Gerätescanner)

---

##  Ziel der App
- Erhöhung der Patientensicherheit  
- Automatisierte, fehlerfreie Zuordnung von Blutprodukten  
- Vollständige digitale Dokumentation  
- Integration in bestehende Kliniksysteme (openEMR + Mirth)
