# 🏆 WM Tipp-Börse – Anleitung für alle

Eine kleine, kostenlose Spaß-App, mit der wir Anteile an unseren WM-Tippspiel-Konten
untereinander handeln können. Kein Konto, keine Installation, keine Kosten.

> **Du musst nichts über „Blockchain" wissen.** Stell es dir wie ein gemeinsames,
> fälschungssicheres Kontobuch vor, das in unserem geteilten SharePoint-/OneDrive-Ordner
> liegt. Jede:r hat eine Kopie, und alle Apps prüfen sich gegenseitig automatisch.

Weitere Dokumente: [Funktionale Anforderungen](ANFORDERUNGEN.md) · [Architektur](ARCHITEKTUR.md)

---

## Was brauche ich?

1. **Browser:** Google **Chrome** oder Microsoft **Edge** (Firefox/Safari funktionieren
   leider nicht – sie können den Ordner nicht öffnen).
2. **Zugriff** auf unseren geteilten SharePoint-/OneDrive-Ordner, der lokal auf deinem
   PC synchronisiert ist.
3. Die **App-Adresse** (eine `https://…`-Internetadresse, siehe nächster Abschnitt).

---

## Wie wird die App bereitgestellt? (einmalig)

> **Wichtig:** Nur **eine** Person muss die App bereitstellen. **Alle anderen brauchen
> keinen Account und installieren nichts** – sie öffnen nur eine Adresse.

**Empfohlen – GitHub Pages (kostenlos):**
Eine technische Person lädt die 4 Dateien (`index.html`, `app.js`, `style.css`,
`crypto-helper.js`) in ein GitHub-Repository und aktiviert unter *Settings → Pages*
die Veröffentlichung aus dem `main`-Branch. GitHub liefert eine feste
`https://…github.io/…`-Adresse. **Nur diese Person braucht einen (kostenlosen)
GitHub-Account** – die übrigen ~20 Kolleg:innen öffnen einfach nur die Adresse.
*(GitLab Pages, Netlify oder Cloudflare Pages funktionieren genauso – immer braucht nur
die bereitstellende Person einen Account.)*

**Ganz ohne GitHub-Account:** Dann startet **jede:r die App lokal über `localhost`** aus
der eigenen synchronisierten Ordnerkopie – z. B. mit dem **„Live Server"-Knopf in
VS Code** oder mit `python -m http.server 8080` und `http://localhost:8080`. Etwas mehr
Aufwand pro Person, dafür null Accounts.

**Evtl. internes Intranet/SharePoint:** Falls eure IT erlaubt, eigenes HTML über eine
interne `https://…`-Adresse auszuliefern, geht es ohne externen Dienst (manche
Firmen-Einstellungen blockieren das – vorher kurz testen).

> ⚠️ **Sicherer Kontext nötig:** Der Ordnerzugriff funktioniert nur über **HTTPS** oder
> **`localhost`**. Ein gemeinsamer lokaler Server unter `http://192.168.x.x` geht
> **nicht** (vom Browser blockiert). Und **Doppelklick** auf `index.html` (`file://`)
> funktioniert ebenfalls nicht.

---

## Erste Schritte

1. **App-Adresse öffnen** (Chrome/Edge).
2. **„📁 Ordner auswählen"** anklicken und unseren synchronisierten SharePoint-/OneDrive-Ordner wählen.
3. **Namen eintragen** (z. B. „Max") und beitreten.
4. **Warten auf Freigabe:** Damit niemand Fake-Profile anlegt, müssen **75 % der bereits
   aktiven Kolleg:innen** dich per Klick zulassen. Sag im Tippspiel-Chat Bescheid, dann
   klicken sie bei „Status aktualisieren" auf **„👍 Zulassen"**.
   *(Die allererste Person – der Gründer – ist sofort freigeschaltet.)*
 5. **Startkapital:** Nach der Freigabe bekommst du automatisch **10 € Spielgeld** und
   **100 Aktien deiner eigenen „Ich-AG"**.

---

## Die Oberfläche im Überblick

Beim Start führt dich die App durch drei Bildschirme: **Ordner verbinden** →
**Name registrieren** → **Ausstehende Verifikation** (warten auf Freigabe). Danach siehst
du das Dashboard mit deinem Guthaben oben und diesen Reitern:

* **Mein Depot** – dein Spielgeld, deine eigenen Aktien und fremde Aktien in deinem Besitz.
* **Mitgliederliste** – alle zugelassenen Kolleg:innen (Kollegen-AGs).
* **Marktplatz & Orderbuch** – Angebote/Gesuche annehmen und eigene Verkaufs- bzw. Kaufsorder einstellen.
* **Ledger & Krypto-Logs** – die bestätigte Historie und die Warteschlange (Mempool).
* **Jackpot-Auszahlung** – am Ende die Tippspiel-Plätze 1/2/3 wählen und die reale Verteilung berechnen.

Oben erscheint außerdem ein gelbes **Freigabe-Banner**, wenn jemand Neues beitreten möchte,
sowie rechts der kurze **„Ledger"-Code** (Prüfsumme) zum Abgleich der Historie.

---

## Handeln

* Tab **„Marktplatz & Orderbuch"**:
  * **Verkaufsorder** – Aktien zum Verkauf anbieten (Menge + Preis pro Stück). Andere nehmen
    sie mit **🛒 Kaufen** an.
  * **Kaufsorder** – ein Kaufgesuch für eine Aktie einstellen (Menge + Preis pro Stück). Wer
    die gesuchten Aktien besitzt, bedient es mit **💸 Verkaufen**.
* Käufe und Verkäufe werden im Hintergrund automatisch von mehreren Kolleg:innen geprüft und
  dann den Depots gutgeschrieben. Das dauert einen Moment – einfach „Synchronisieren".

---

## 💾 Wallet sichern (wichtig!)

Deine geheimen Schlüssel liegen nur in deinem Browser. **Löschst du Browserdaten, ist
dein Account weg.** Klicke deshalb einmal auf den grünen **„💾 Backup"**-Knopf und
speichere die kleine `.json`-Datei sicher ab. Über **„Wallet wiederherstellen"** auf dem
Startbildschirm spielst du sie bei Bedarf wieder ein.

---

## Wie endet das Spiel?

Wenn die WM vorbei ist, stehen die Tippspiel-Sieger fest. Im Auszahlungs-Rechner trägst du
die **Plätze 1, 2 und 3** ein (Auswahl aus den registrierten „Ich-AGs"). Der reale Pool von
**75 €** (5 € Einsatz × 15 Tippspiel-Teilnehmer) wird als Preisgeld ausgeschüttet:
**Platz 1 = 50 % (37,50 €), Platz 2 = 30 % (22,50 €), Platz 3 = 20 % (15 €).**

Das Preisgeld einer platzierten AG wird **anteilig nach Aktienbesitz** auf ihre Aktionäre
verteilt (je Aktie = Preisgeld / 100). Wer rechtzeitig Aktien der späteren Sieger besitzt,
gewinnt. Das übrige Spielgeld (**Restguthaben**) wird separat ausgewiesen, aber **nicht real
ausgezahlt** – es dient nur dem Aktienkauf.

---

## Häufige Fragen

* **„Kann jemand schummeln und sich Geld geben?"** Nein. Jede App prüft jede Aktion nach
  festen Krypto-Regeln. Manipulierte oder erfundene Buchungen werden von allen abgelehnt.
* **„Was, wenn jemand Dateien löscht oder verändert?"** Die App merkt das, **warnt mit
  einem Banner** und **stellt die Originaldateien automatisch wieder her**. Oben rechts
  siehst du außerdem einen kurzen **„Ledger"-Code** – wenn alle denselben sehen, habt ihr
  dieselbe Historie.
* **„Sehe ich ein gelbes Banner zum Admin?"** Dann hat der Gründer seinen Schlüssel noch
  nicht als Admin hinterlegt – kurz in der [Anleitung für den Gründer](ARCHITEKTUR.md#8-betrieb--konfiguration) nachsehen.
