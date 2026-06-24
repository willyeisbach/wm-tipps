# Funktionale Anforderungen – WM Tipp-Börse

Knappe Beschreibung dessen, was die Anwendung leisten muss. Technische Umsetzung siehe
[Architektur](ARCHITEKTUR.md).

## 1. Rahmenbedingungen
* **R1 – Kostenlos:** Keine laufenden Kosten, keine kostenpflichtige Infrastruktur.
* **R2 – Serverlos:** Kein zentraler Backend-/Datenbankserver. Datenaustausch ausschließlich
  über einen geteilten SharePoint-/OneDrive-Ordner.
* **R3 – Einfache Nutzung:** Bedienbar auch ohne IT-Kenntnisse; nur Browser + Ordnerauswahl.
* **R4 – Browserbasiert:** Läuft als reine Webseite (Chromium-Browser: Chrome/Edge).

## 2. Identität & Mitgliedschaft
* **R5 – Schlüssel-Identität:** Jede:r Teilnehmer:in erhält im Browser ein eigenes
  kryptografisches Schlüsselpaar; der öffentliche Schlüssel ist die Konto-Adresse.
* **R6 – Namensregistrierung:** Ein Klarname wird dauerhaft mit dem öffentlichen Schlüssel
  verknüpft. Namen sind eindeutig (kein Doppelvergeben).
* **R7 – Zulassungsverfahren:** Neue Teilnehmer:innen müssen **manuell** zugelassen werden;
  Zustimmung von **≥ 75 % der bereits zugelassenen** Teilnehmer:innen ist erforderlich
  (Sybil-/Fake-Profil-Schutz). Nur Stimmen zugelassener Teilnehmer:innen zählen.
* **R8 – Gründer/Genesis:** Die erste, vorab festgelegte Person (Admin) ist ohne Zustimmung
  sofort zugelassen und startet das Netzwerk.
* **R9 – Wallet-Sicherung:** Schlüssel können exportiert (Backup) und wiederhergestellt werden.

## 3. Ökonomie
* **R10 – Startkapital:** Jede:r zugelassene Teilnehmer:in erhält **genau einmal**
  10 € Spielgeld und 100 Aktien der eigenen „Ich-AG".
* **R11 – Assets:** Handelbar sind `EUR` (Spielwährung) und `SHARE_<Name>` (Anteile an
  Personen).
* **R12 – Handel:** Teilnehmer:innen stellen Verkaufsangebote **und Kaufgesuche** (Asset,
  Menge, Preis/Stück) ein und können fremde Angebote/Gesuche per Klick annehmen (kaufen bzw.
  hineinverkaufen). Ein Handel ist ein atomarer Tausch Aktien ↔ EUR.
* **R13 – Bestätigung von Handelsaktionen:** Trades werden automatisch im Hintergrund von
  unabhängigen Teilnehmer:innen verifiziert und gelten erst nach **N Zeugen** als gültig
  (Standard N = 3, konfigurierbar; bei kleiner Gruppe entsprechend weniger).
* **R13a – Kurs-Chart:** Die App zeigt je Aktie (`SHARE_<Name>`) den Kursverlauf aus der
  bestätigten Historie an. Jede Aktie startet bei einem konfigurierbaren Initialwert
  (Standard **0,05 €/Stück**); jeder bestätigte Trade setzt einen neuen Kurspunkt. Über eine
  **Mehrfachauswahl** lassen sich mehrere Aktien gleichzeitig im Diagramm vergleichen.
* **R14 – Schlussabrechnung:** Nach der WM werden im Auszahlungs-Tab die Tippspiel-Sieger
  für **Platz 1, 2 und 3** (Auswahl aus den registrierten „Ich-AGs") eingetragen. Der reale
  Pool und die Verteilung sind fest konfiguriert (`config.payoutPool`,
  `config.payoutRankShares`): standardmäßig **75 €** (5 € Einsatz × 15 Tippspiel-Teilnehmer)
  aufgeteilt in **50 % / 30 % / 20 %**. Das Preisgeld einer platzierten AG wird **anhand der
  Aktienanteile** auf ihre Aktionäre verteilt; je Aktie = Preisgeld / 100. Pro Person werden
  **Aktienwert (reale Auszahlung)** und **Restguthaben (Spielgeld, ohne Auszahlung)** getrennt
  ausgewiesen. Das EUR-Spielgeld dient nur dem Aktienkauf und wird nicht real ausgezahlt.

  Exakte Formel (`Bestand_P(X)` = Stück `SHARE_X` im Besitz von P, `Preis(X)` = Preisgeld der
  AG X laut Platzierung, sonst 0; Gesamtbestand 100 Stück je AG):
  ```
  Preis(Platz1) = 75 € × 0,50   Preis(Platz2) = 75 € × 0,30   Preis(Platz3) = 75 € × 0,20
  Auszahlung(P) = Σ_X [ Bestand_P(X) × Preis(X) / 100 ]
  ```
  (Die Summe aller Auszahlungen ergibt genau den Pool von 75 €.)

## 4. Sicherheit (gegen manipulierende Kolleg:innen)
* **R15 – Lokale Eingriffe wirkungslos:** Manipuliert jemand seinen lokalen Code/Speicher,
  betrifft das nur die eigene Sicht; andere Apps akzeptieren nur regelkonforme Aktionen.
* **R16 – Keine Geldschöpfung:** Beträge/Mengen müssen positiv sein; Salden dürfen nie
  negativ werden; der Zahlbetrag eines Trades ist an die signierten Order-Daten gebunden
  (kein „Gratis-Kauf").
* **R17 – Kein Double-Spend / Replay:** Jede Verkaufsorder ist **höchstens einmal**
  einlösbar; bereits ausgegebene Aktien/Beträge können nicht erneut ausgegeben werden.
* **R18 – Kein Reset:** Das Startkapital kann nicht erneut angefordert werden.
* **R19 – Sybil-Resistenz:** Selbst erzeugte Wegwerf-Schlüssel können weder Zulassungen
  noch Trades bestätigen (es zählen nur zugelassene Teilnehmer:innen).
* **R20 – Manipulationserkennung & Selbstheilung:** Bestätigte Dateien, die **gelöscht
  oder inhaltlich verändert** wurden, werden erkannt (Warnbanner) und aus einer lokalen
  Sicherung automatisch wiederhergestellt.
* **R21 – Vergleichbarkeit der Historie:** Die App zeigt eine kurze Prüfsumme
  („Ledger-Fingerprint") über die gesamte bestätigte Historie an, damit Teilnehmer:innen
  schnell vergleichen können, ob alle dieselbe Historie sehen.

## 5. Bewusst akzeptierte Grenzen (Spaß-App)
* Reihenfolge basiert auf Zeitstempeln der Clients (nicht perfekt fälschungssicher);
  Saldo-Prüfungen fangen Doppelausgaben jedoch ab.
* Private Schlüssel liegen unverschlüsselt im Browser-Speicher (Self-Custody + Backup).
* Die finalen Tipp-Punkte werden vertrauensbasiert manuell eingetragen (kein Konsens-Oracle).
