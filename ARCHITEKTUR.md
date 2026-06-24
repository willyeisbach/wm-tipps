# Architektur – WM Tipp-Börse

Technische Umsetzung der [funktionalen Anforderungen](ANFORDERUNGEN.md). Konzept:
„SharePoint-Consensus" – ein gemeinsames Append-only-Kontobuch aus vielen kleinen
JSON-Dateien, das jede App lokal aus den Krypto-Regeln neu berechnet.

## 1. Technologie-Stack
* **Frontend:** Single-Page-App, Vanilla JavaScript (ES-Module) + Vanilla CSS. **Kein
  Build-Schritt.**
* **Kryptografie:** Web Crypto API (`window.crypto.subtle`) – ECDSA P‑256 für Signaturen,
  SHA‑256 für Hashes.
* **Datenaustausch:** File System Access API (`showDirectoryPicker`) auf den lokal
  synchronisierten SharePoint-/OneDrive-Ordner. Nur Chromium-Browser (Chrome/Edge).

## 2. Dateien
| Datei | Aufgabe |
|------|---------|
| `index.html` | UI + Verdrahtung (Module, DOM, Auszahlungs-Rechner) |
| `app.js` | Kernlogik: State-Engine, Konsens, Handel, Integritätsschutz |
| `crypto-helper.js` | Krypto-Wrapper (Keygen, Export/Import, Signieren, Verifizieren, Hash) |
| `style.css` | Styling |

## 3. Ordnerstruktur (im geteilten Sync-Ordner)
```
<Sync-Ordner>/
├── mempool/         # Aktionen
│   ├── tx_<hash>.json      # REGISTER_NAME | INITIALIZE_PLAYER | TRADE
│   └── order_<hash>.json   # offene Verkaufsangebote / Kaufgesuche (SELL_ORDER | BUY_ORDER)
└── signatures/      # Zeugen-/Zulassungs-Signaturen
    └── sig_<txHash>_<witnessId>.json
```
Jede Aktion erzeugt eine **neue, eindeutige** Datei → OneDrive muss nie mergen, keine
Konflikte. `witnessId` ist ein Hash des Zeugen-Schlüssels (die rohen P‑256-Keys teilen
denselben Präfix und kollidierten sonst im Dateinamen).

## 4. Transaktionstypen
* **REGISTER_NAME** – verknüpft Name ↔ Public Key. Benötigt Zulassung (75 %).
* **INITIALIZE_PLAYER** – schreibt das einmalige Startkapital gut. Trägt die Startwerte
  (`startEUR`, `startShares`) signiert in der Transaktion, damit das Ledger selbsttragend
  ist. Zeugen/Commit lehnen Werte ab, die vom Konsens-Config abweichen (keine Selbstbedienung).
* **SELL_ORDER** – signiertes, offenes Verkaufsangebot (kein Ledger-Eintrag, nur Markt).
* **BUY_ORDER** – signiertes, offenes Kaufgesuch (kein Ledger-Eintrag, nur Markt). Spiegelbild
  der SELL_ORDER: der Käufer bietet EUR für eine Aktie, ein Halter kann hineinverkaufen.
* **TRADE** – atomarer Tausch `SHARE_x ↔ EUR`. Signiert von **Verkäufer** und **Käufer** sowie
  als Envelope vom Absender. Das Feld `orderType` (`SELL_ORDER`|`BUY_ORDER`, Default `SELL_ORDER`)
  gibt an, welche Seite die ursprüngliche Order signiert hat:
  * `SELL_ORDER`: Verkäufer signiert die Order, Käufer signiert die Ausführung (`BUY_EXECUTION`).
  * `BUY_ORDER`: Käufer signiert die Order, Verkäufer signiert die Ausführung (`SELL_EXECUTION`).

### 4.1 Datenformate (JSON)
Alle Felder sind base64 (Schlüssel/Signaturen) bzw. SHA-256-Hex (`hash`). Die
**Envelope-Signatur** (`signature`) deckt jeweils das Objekt **ohne** `signature` und `hash` ab.

```jsonc
// tx_<hash>.json  – REGISTER_NAME
{ "type":"REGISTER_NAME", "name":"Max",
  "senderPubKey":"<pubKey>", "timestamp":1700000000000, "prevHash":"<hash|0…0>",
  "signature":"<Absender>", "hash":"<sha256>" }

// tx_<hash>.json  – INITIALIZE_PLAYER
{ "type":"INITIALIZE_PLAYER", "startEUR":10.0, "startShares":100,
  "senderPubKey":"<pubKey>", "timestamp":1700000000001, "prevHash":"<hash>",
  "signature":"<Absender>", "hash":"<sha256>" }

// order_<hash>.json  – SELL_ORDER
{ "type":"SELL_ORDER", "seller":"<pubKey>", "asset":"SHARE_<ownerPubKey>",
  "amount":10, "pricePerUnit":2.0, "timestamp":1700000000002,
  "signature":"<Verkäufer über {type,seller,asset,amount,pricePerUnit,timestamp}>",
  "hash":"<sha256 über das Objekt inkl. signature>" }

// order_<hash>.json  – BUY_ORDER
{ "type":"BUY_ORDER", "buyer":"<pubKey>", "asset":"SHARE_<ownerPubKey>",
  "amount":10, "pricePerUnit":2.0, "timestamp":1700000000002,
  "signature":"<Käufer über {type,buyer,asset,amount,pricePerUnit,timestamp}>",
  "hash":"<sha256 über das Objekt inkl. signature>" }

// tx_<hash>.json  – TRADE
{ "type":"TRADE", "orderType":"SELL_ORDER", "partyA":"<Verkäufer>", "partyB":"<Käufer>",
  "giveAsset":"SHARE_<owner>", "giveAmount":10, "receiveAsset":"EUR", "receiveAmount":20.0,
  "orderHash":"<hash der Order>", "orderTimestamp":1700000000002, "pricePerUnit":2.0,
  "timestamp":1700000000003, "prevHash":"<hash>", "senderPubKey":"<Absender>",
  "signatures":{
    "partyA":"<SELL_ORDER- bzw. SELL_EXECUTION-Signatur des Verkäufers>",
    "partyB":"<BUY_EXECUTION- bzw. BUY_ORDER-Signatur des Käufers>" },
  "signature":"<Envelope: Absender über das Trade-Objekt ohne signature/hash>",
  "hash":"<sha256>" }

// sig_<txHash>_<witnessId>.json  – Zeugen-/Zulassungssignatur
{ "txHash":"<hash der bezeugten Transaktion>",
  "witnessPubKey":"<pubKey des Zeugen>",
  "signature":"<Zeuge über den String txHash>" }
```
`witnessId` im Dateinamen = erste 16 Hex eines SHA-256 über `witnessPubKey` (eindeutig,
da rohe P-256-Schlüssel denselben base64-Präfix teilen). `prevHash` wird mitgeführt,
aber bewusst **nicht** als harte Kette erzwungen (siehe §9).

### 4.2 Transaktions-Lebenszyklus
```
erstellt ──> /mempool (tx_ | order_)
   │
   ▼  bei jedem Sync, in jeder App:
Absender-Signatur prüfen ──(ungültig)──> verworfen (ignoriert, kein Effekt)
   │ gültig
   ▼
Auto-Witnessing: andere committete Peers signieren GÜLTIGE TRADE/INITIALIZE
   (REGISTER_NAME nur manuell per Klick) ──> sig_-Dateien
   │
   ▼
genug gültige Zeugen (committete Nicht-Parteien, Schwelle aus §6)?
   ├─ nein ──> bleibt "pending" im Mempool (wird bei jedem Sync neu geprüft)
   └─ ja  ──> State-Transition prüfen (Salden/Regeln/Deckung, §7)
                 ├─ gültig   ──> in den Ledger übernommen, Salden aktualisiert
                 └─ ungültig ──> verworfen (kein Saldo-Effekt; z. B. fehlende Deckung)
```
* Eine **SELL_ORDER** bzw. **BUY_ORDER** bleibt offen, bis ein TRADE sie über `orderHash`
  einlöst (`spentOrders`); danach verschwindet sie aus dem Marktplatz.
* Ungültige Aktionen „verhungern" – sie können geschrieben, aber von ehrlichen Apps
  weder bezeugt noch angewendet werden.

## 5. State-Rekonstruktion (`syncLedger`)
Bei jedem Sync:
1. **Selbstheilung:** Fehlende, früher bestätigte Dateien aus dem LocalStorage-Spiegel
   zurückschreiben (+ Warnung).
2. Alle `tx_`/`order_`/`sig_`-Dateien einlesen.
3. Transaktionen **chronologisch** (Zeitstempel) sortieren.
4. Pro Transaktion: Absender-Signatur prüfen → gültige Zeugen zählen → Konsens-Regel
   anwenden → bei Bestätigung **State-Transition** ausführen (Salden/Namen aktualisieren),
   sonst im Mempool als „ausstehend" belassen.
5. Offene, noch nicht eingelöste Orders als Marktplatz bereitstellen.
6. **Auto-Witnessing:** Eigene App signiert im Hintergrund fremde, gültige Trades/Inits.
7. Integritäts-Spiegel der bestätigten Dateien in LocalStorage aktualisieren.

State wird vollständig aus den Dateien neu berechnet (kein vertrauenswürdiger
Zwischenstand). Salden: `pubKey → { EUR, SHARES: { ownerPubKey → Stück } }`.

## 6. Konsens-Regeln
* **Zeugen-Eignung:** Es zählen nur Signaturen **bereits zugelassener** Peers, die **nicht
  Partei** der Transaktion sind (Sybil-Schutz, R19).
* **REGISTER_NAME:** Admin (`bootstrapAdmins`) → sofort. Sonst
  `Aufrundung(zugelassene × 0,75)` Zustimmungen nötig. Namensduplikate werden verworfen.
* **INITIALIZE_PLAYER:** nur zugelassene Person, **nur einmal**; benötigt
  `min(initWitnesses, andere zugelassene)` Zeugen. Die signierten `startEUR`/`startShares`
  müssen dem Konsens-Config entsprechen, sonst keine Bestätigung.
* **TRADE:** benötigt `min(tradeWitnesses, zugelassene Nicht-Parteien)` Zeugen.

Schwellen sind in `app.config` konfigurierbar (`registrationApprovalRatio`,
`tradeWitnesses`, `initWitnesses`, `startEUR`, `startShares`, `bootstrapAdmins`,
`initialSharePrice`, `payoutPool`, `payoutRankShares`).

## 6a. Kurs-Chart
`app.getPriceHistory()` rekonstruiert aus dem **bestätigten** Ledger je Aktie
(`SHARE_<ownerPubKey>`) eine chronologische Kursreihe `[{ timestamp, price }]`:
* Startpunkt = `config.initialSharePrice` (Default `0.05` €/Stück) zum Zeitpunkt des
  `REGISTER_NAME` des Eigentümers.
* Jeder committete `TRADE` fügt mit seinem `pricePerUnit` und `timestamp` einen neuen
  Kurspunkt hinzu (offene Orders zählen **nicht** – nur die echte Historie).

Die UI (`index.html`, Tab „Kurs-Chart") rendert daraus ein **inline-SVG-Stufendiagramm**
(kein externes Charting-Lib → kein Build, offline-fähig). Eine **Mehrfachauswahl**
(`<select multiple>`) erlaubt den gleichzeitigen Vergleich mehrerer Aktien; die Auswahl
bleibt über Auto-Syncs erhalten.

## 7. Sicherheitsmechanismen (Mapping zu Anforderungen)
* **Signatur-Bindung (R16):** Bei einer SELL_ORDER signiert der Verkäufer
  `{asset, amount, pricePerUnit, timestamp}`, der Käufer `{orderHash, timestamp}`; bei einer
  BUY_ORDER ist es umgekehrt (Käufer signiert die Order, Verkäufer die Ausführung). Beim
  Anwenden wird zusätzlich erzwungen:
  `receiveAmount === giveAmount × pricePerUnit`, `receiveAsset === "EUR"`, Asset = `SHARE_*`.
* **Order-Bindung / Anti-Replay (R17):** `orderHash` wird aus (Order-Inhalt + Order-
  Signatur) – passend zu `orderType` – deterministisch neu berechnet und muss übereinstimmen
  → eine Order-Signatur ist genau **einmal** einlösbar (`spentOrders`).
* **Mengen-/Saldo-Prüfung (R16):** nur positive Ganzzahl-Mengen, endliche Preise ≥ 0,
  ausreichende Deckung; keine negativen Salden.
* **Anti-Reset (R18):** `initializedPlayers`-Sperre; ein zweites INITIALIZE wird verworfen.
* **Selbstheilung (R20):** `_persistMirror` / `_restoreMissingFiles` + `onIntegrityWarning`.
  Committete Dateien sind hash-benannt und damit unveränderlich – jede App vergleicht den
  Ordner gegen ihren lokalen Spiegel und schreibt **gelöschte wie auch überschriebene**
  Dateien zurück (eine einzige ehrliche Kopie genügt; kein Voting nötig, da sich keine
  abweichende *gültige* Version erzeugen lässt).
* **Ledger-Fingerprint (R21):** Kurz-Hash über die geordneten committeten Tx-Hashes
  (`ledgerFingerprint`), im Header angezeigt – zum schnellen Abgleich der Historie.

## 8. Betrieb & Konfiguration
* **Hosting:** GitHub Pages (empfohlen) oder lokaler Server nur zum Testen – siehe
  [README](README.md).
* **Admin festlegen:** In `index.html` `app.config.bootstrapAdmins = [ "<Public Key des
  Gründers>" ]` setzen, **bevor** weitere Personen beitreten. Solange leer, gilt der erste
  Registrierer als Genesis – die App zeigt dann ein Warnbanner.

## 9. Bekannte Grenzen / Trade-offs
* Reihenfolge über Client-Zeitstempel (nicht streng deterministisch); Saldo-Checks fangen
  Doppelausgaben ab.
* Private Schlüssel unverschlüsselt im Browser (Self-Custody + Backup-Button).
* Finale Tippspiel-Platzierung (Platz 1/2/3) wird manuell im Auszahlungs-Rechner eingetragen
  (kein Konsens-Oracle – bewusst, siehe R-Grenzen).

## 10. Test
Sicherheits-Eigenschaften werden über ein Node-Harness (Mock-FileSystem + WebCrypto, das
die echte `app.js` treibt) gegen Exploits geprüft: Sybil-Zulassung, Sybil-Zeugen,
Gratis-Aktien, Order-Replay, Re-Init-Reset, negative Beträge, Datei-Löschung.
