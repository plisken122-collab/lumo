# lumo

Messenger, bei dem jeder in seiner Sprache schreibt und in seiner eigenen liest.
Spracherkennung und Übersetzung laufen auf dem Server — der API-Key liegt nie im Browser.

Kein Build-Schritt. Kein Framework. Eine HTML-Datei, ein Server.

---

## Lokal starten

Ein Befehl, im entpackten Ordner:

```bash
npm install && cp .env.example .env && echo "Jetzt .env öffnen und deinen API-Key eintragen"
```

Dann `.env` öffnen, bei `ANTHROPIC_API_KEY=` deinen Key eintragen (console.anthropic.com → API Keys), speichern. Danach:

```bash
npm start
```

Läuft auf http://localhost:3000

**Zum Testen mit zwei Personen:** zwei Browserfenster öffnen, in beiden denselben Chat-Code eingeben, aber verschiedene Sprachen wählen. Oder Handy im selben WLAN: `http://<deine-lokale-IP>:3000`

---

## Änderungen live bringen

Die App läuft bereits: **https://lumo-3d74.onrender.com**, aus dem Repo **github.com/plisken122-collab/lumo**, Branch `main`. Render deployt bei jedem Push von selbst (`Auto-Deploy: On Commit`) und liest dabei `render.yaml`. Also genügt:

```bash
git add -A && git commit -m "was geändert wurde" && git push
```

**Falle mit zwei GitHub-Konten.** Scheitert der Push mit `Permission to plisken122-collab/lumo.git denied to carrango-pt` und HTTP 403, hat sich Git mit dem Konto des Carrango-Projekts angemeldet. Zwei Dinge müssen stimmen: der Kontoname in der Adresse (steht schon drin, `https://plisken122-collab@github.com/...`) **und** im Browser eine Anmeldung als `plisken122-collab` — dort öffnet sich das Anmeldefenster.

Kommt die Änderung trotz erfolgreichem Push nicht live, im Dashboard *Manual Deploy → Deploy latest commit*. Dass alles durch ist, prüfst du an `/health` und daran, ob die geänderte Datei wirklich ausgeliefert wird.

Eigene Domain: Settings → Custom Domain, CNAME bei Cloudflare setzen — genau wie bei Carrango.

---

## Aufs Handy holen

Die App ist eine PWA. Im Browser öffnen → Teilen → „Zum Home-Bildschirm". Danach startet sie ohne Adressleiste wie eine normale App.

---

## Was drin ist

- Chaträume über einen frei wählbaren Code, kein Login nötig
- Echtzeit über WebSockets (Socket.io)
- Automatische Spracherkennung am Text, nicht an der Einstellung
- 33 Sprachen inklusive regionaler Varianten, RTL für Arabisch und Hebräisch
- Getrennt: Português (Brasil) und Português (Portugal), Español (Latinoamérica) und (España), English US und UK, Deutsch und Deutsch (Schweiz), Chinesisch vereinfacht und traditionell — der Server bekommt pro Variante eigene Vorgaben zu Wortschatz und Anrede (você/tu, ônibus/autocarro, celular/telemóvel)
- Die Erkennung gibt die Variante mit an, wenn sie am Text erkennbar ist
- Original jeder Nachricht auf Antippen sichtbar
- Sprache jederzeit umschaltbar, alte Nachrichten werden nachübersetzt
- Übersetzungen werden pro Nachricht und Sprache gecacht — jede Übersetzung kostet nur einmal

## Grenzen gegen zu hohe Kosten

Jede Übersetzung kostet, und eine Nachricht löst eine je Lesersprache aus. Drei Grenzen bremsen das, alle über `.env` einstellbar. Eine 0 schaltet die jeweilige Grenze ab.

| Variable | Standard | Wirkung |
|---|---|---|
| `TRANSLATIONS_PER_DAY` | 2000 | Obergrenze für alle zusammen. Danach kommen Nachrichten weiter an, werden aber im Original angezeigt. |
| `MSG_PER_MIN` | 20 | Nachrichten je Minute und Gerät. Der abgewiesene Text bleibt im Eingabefeld stehen. |
| `NEED_PER_MIN` | 120 | Nachfragen nach Übersetzungen je Minute und Gerät. |
| `GATE_TRIES_PER_15MIN` | 10 | Versuche beim Zugangswort je Adresse, sonst lässt es sich durchprobieren. |

Wie viel vom Tageskontingent noch übrig ist, steht unter `/health`. Was tatsächlich verbraucht wurde, zeigt `/stats.html`.

Die Zähler liegen im Arbeitsspeicher. Bei mehreren Instanzen zählt jede für sich — bei einem Dienst auf Render ist das genau eine.

## Sprachnachrichten

Der Knopf mit dem Mikrofon sitzt rechts neben dem Eingabefeld. Antippen startet die Aufnahme, ein zweiter Tipp schickt sie ab, *Abbrechen* verwirft sie. Nach zwei Minuten endet die Aufnahme von selbst (`VOICE_MAX_SECONDS`).

**Sprachnachrichten werden nicht übersetzt.** Der Versuch, während der Aufnahme mitzuschreiben, ist gescheitert — und zwar aus einem Grund, der sich nicht umgehen ließ: Aufnahme und Spracherkennung wollen beide das Mikrofon, und Chrome auf Android gibt die Erkennung dann still auf. Gemessen am 14.09.2026: Die Erkennung startete, bekam Ton, meldete keinen Fehler und lieferte trotzdem kein einziges Wort. Weder das Umdrehen der Reihenfolge noch ein Warten auf das letzte Ergebnis half.

Wer sich verständlich machen will, nimmt stattdessen den **Sprechen-Knopf** (siehe unten). Wer die Stimme übertragen will, nimmt die Sprachnachricht — dann ohne Text.

Soll beides zusammengehen, müsste die Mitschrift auf dem Server entstehen, über einen Dienst wie Whisper oder Deepgram. Das kostet rund einen halben Cent je Aufnahme und ist bewusst nicht gebaut.

## Sprechen statt tippen

Der Knopf 🗣️ neben dem Mikrofon hört nur zu und schreibt in das Eingabefeld — er nimmt nichts auf. Genau deshalb funktioniert er: Es streitet sich niemand ums Mikrofon.

Antippen, sprechen, der Text erscheint währenddessen im Feld. Nochmal antippen beendet es. Danach ist es eine ganz gewöhnliche Nachricht, wird also übersetzt wie jede andere — du sprichst in deiner Sprache, der andere liest in seiner. Schon Getipptes bleibt stehen, das Gesprochene hängt sich dahinter.

Kostet keinen Cent zusätzlich, weil die Erkennung im Browser läuft. Auf dem iPhone fehlt sie allerdings — dort blendet sich der Knopf selbst aus.

Wie bei WhatsApp zeigt die Eingabezeile entweder die Sprechen-Knöpfe oder den Senden-Knopf, je nachdem ob schon Text da ist.

Die Aufnahmen liegen in der Datenbank, nicht in einem Dateispeicher — eine halbe Minute Opus sind rund 40 KB. Sie hängen per Fremdschlüssel an der Nachricht: Löscht die Aufbewahrungsfrist die Nachricht, verschwindet die Aufnahme mit. Ausgeliefert werden sie unter `/medien/<kennung>` und liegen damit hinter dem Zugangswort wie alles andere.

Für Bilder gilt das nicht — die sind hundertmal größer und gehören in einen Objektspeicher wie Cloudflare R2. Das ist noch nicht gebaut.

## Was noch fehlt für den Produktivbetrieb

- **Login.** Aktuell reicht der Chat-Code. Wer ihn kennt, liest mit.
- **Bilder.** Brauchen einen Objektspeicher, siehe oben.

**Ende-zu-Ende-Verschlüsselung wird es nicht geben.** Sie schließt sich mit der Übersetzung auf dem Server aus: Entweder der Server kann den Text lesen, oder er kann ihn nicht übersetzen. Das ist keine offene Aufgabe, sondern eine Entscheidung — und der Hinweis auf der Startseite sagt es den Leuten auch offen.

Erledigt sind inzwischen: Datenbank (Postgres, siehe `store.js`), Push über VAPID, Zugangswort, Aufbewahrungsfrist, die Grenzen oben, Smileys und Sprachnachrichten.

Was der Betrieb kostet, steht weiter unten unter [Kosten im Betrieb](#kosten-im-betrieb).

---

## Test mit zwei Handys

### Variante A — beide Handys im selben WLAN (schnellste)

```bash
npm start
```

Der Server druckt beim Start eine Adresse wie `http://192.168.1.42:3000` und einen QR-Code ins Terminal. Mit der Kamera beider Handys scannen, fertig.

Auf Handy 1: Name „Carsten", Sprache Deutsch, Code `test`
Auf Handy 2: Name „João", Sprache Português (Brasil), Code `test`

Beide müssen denselben Code eingeben. Schreibt jetzt einer, sieht der andere es in seiner Sprache.

Klappt der QR-Code nicht, liegt es fast immer an einem dieser drei Punkte:
- Handys hängen im Gast-WLAN oder am Mobilfunknetz statt im selben WLAN
- Die Firewall des Rechners blockiert Port 3000 — kurz freigeben oder Firewall testweise aus
- Der Router hat Client-Isolation an (bei manchen Routern „AP Isolation") — dann geht nur Variante B

### Variante B — online stellen (funktioniert überall)

Die App ist bereits online: **https://lumo-3d74.onrender.com**. Die Adresse funktioniert auf jedem Handy, auch über Mobilfunk und auch wenn dein Rechner aus ist. Ist ein `ACCESS_CODE` gesetzt, braucht jeder zuerst dieses Wort.

Der Dienst läuft auf dem Starter-Plan und schläft nicht ein — der erste Aufruf kommt also sofort.

### Als App auf den Home-Bildschirm

Adresse im Handy-Browser öffnen → Teilen → „Zum Home-Bildschirm hinzufügen". Danach startet lumo ohne Adressleiste wie eine normale App. Funktioniert bei Variante B sauber; bei Variante A nur solange dein Rechner läuft.

---

## Benachrichtigungen

Oben in der Chat-Leiste sitzt der Knopf `Ton aus` / `Ton an`. Beim ersten Antippen fragt der Browser um Erlaubnis. Danach gibt es bei jeder eingehenden Nachricht einen Ton, eine Vibration und eine Systembenachrichtigung mit dem bereits übersetzten Text. Eigene Nachrichten lösen nie etwas aus.

Es gibt zwei Stufen, und der Unterschied ist wichtig:

**Stufe 1 — App im Hintergrund.** Läuft ohne weitere Einrichtung. Solange lumo geöffnet ist, auch hinter anderen Apps, klingelt es.

**Stufe 2 — App komplett geschlossen.** Braucht VAPID-Schlüssel und eine Datenbank. Dann verschickt der Server die Benachrichtigung selbst, unabhängig davon, ob lumo läuft.

### Stufe 2 einrichten

Schlüssel einmalig erzeugen:

```bash
npm run vapid
```

Das druckt drei Zeilen. Die bei Render unter Environment eintragen: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT`. Der private Schlüssel gehört ausschließlich dorthin — nicht ins Repo, nicht in einen Chat.

Dazu braucht es eine Postgres-Datenbank. In Render: New → Postgres, Region Frankfurt, danach beim Web Service unter Environment die Variable `DATABASE_URL` mit der Internal Database URL setzen. Die `render.yaml` legt beides automatisch an, wenn du den Service über eine Blueprint-Bereitstellung erzeugst.

Und der Web Service muss auf **Starter** laufen (7 $/Monat). Auf dem kostenlosen Plan schläft er nach 15 Minuten ein und kann nichts verschicken.

Ob alles steht, zeigt `/health`:

```
{"ok":true,"key":true,"push":true,"database":true,"langs":33}
```

Stehen dort `push` und `database` auf `true`, ist Stufe 2 aktiv.

### Ungelesen-Zähler

Drei Stellen zeigen an, wie viele Nachrichten offen sind:

- ein roter Punkt am Blasen-Logo in der Chat-Leiste
- die Zahl im Tab-Titel, etwa `(3) lumo`
- die Zahl am App-Symbol auf dem Startbildschirm, wie bei WhatsApp

Der Zähler springt auf null, sobald du die App wieder in den Vordergrund holst. Die Zahl am App-Symbol setzt auch der Service Worker, wenn lumo geschlossen ist — gezählt wird, wie viele Benachrichtigungen offen sind.

Das App-Symbol trägt die Zahl nur, wenn lumo über „Zum Startbildschirm" installiert wurde. Im normalen Browser-Tab gibt es kein Symbol, das eine Zahl tragen könnte; dort bleiben Punkt und Titel. Auf dem iPhone unterstützt Safari das noch nicht zuverlässig.

### iPhone

Push funktioniert nur, wenn lumo vorher über Teilen → „Zum Home-Bildschirm" installiert wurde. Im normalen Safari-Tab unterdrückt iOS es. Auf Android reicht der Browser.

---

## Was die Datenbank sonst noch ändert

Nachrichten überleben jetzt jeden Neustart. Wer den Chat neu öffnet, sieht die letzten 200 Nachrichten des Raums. Vorher war nach jedem Server-Neustart alles weg.

Außerdem erkennt lumo Geräte jetzt an einer festen Kennung statt an der Verbindung. Deine eigenen Nachrichten bleiben dadurch auch nach einem Verbindungsabbruch korrekt als deine markiert.

---

## Kosten im Betrieb

| Posten | Preis |
|---|---|
| Render Web Service, Starter | 7 $/Monat |
| Render Postgres, Basic 256 MB | ca. 6 $/Monat |
| Anthropic API | nach Verbrauch, bei normalem Chatvolumen wenige Euro |

Web Push selbst kostet nichts — das läuft über die Dienste von Google und Apple.

---

## Logo

Liegt in `public/brand/` als SVG und in `brand/export/` als PNG. Der Leitfaden mit Farben und Regeln steht in `brand/LOGO.md`.

Die Wortmarke ist gezeichnet, keine Schriftart — sie sieht deshalb überall gleich aus, ohne dass eine Schriftdatei mitgeliefert werden muss. Fehlt dir eine PNG-Größe, erzeugt `python3 brand/render.py` alle neu.

---

## Zugangswort

Setz die Umgebungsvariable `ACCESS_CODE` auf ein Wort deiner Wahl, und niemand kommt ohne dieses Wort in die App — weder über die Seite noch über die Echtzeitverbindung.

Wer das Wort richtig eingibt, bekommt ein Cookie und wird ein Jahr lang nicht mehr gefragt. Das Wort selbst verlässt den Server nie; im Browser liegt nur ein daraus abgeleiteter Wert.

Bleibt `ACCESS_CODE` leer, ist die App öffentlich erreichbar. Ob es aktiv ist, zeigt `/health` im Feld `gate`.

Dazu kommt eine `robots.txt`, die Suchmaschinen aussperrt, und `noindex` auf beiden Seiten. Vor einer echten Veröffentlichung beides wieder entfernen.

Das ersetzt keine Anmeldung mit Benutzerkonten — alle teilen sich dasselbe Wort, und wer es weitergibt, gibt den Zugang weiter. Für eine Testphase im kleinen Kreis reicht es.

---

## Aufbewahrung

Nachrichten werden nach 30 Tagen automatisch gelöscht, samt ihrer Übersetzungen. Der Aufräumlauf startet beim Serverstart und wiederholt sich stündlich. Push-Anmeldungen, die ein halbes Jahr nichts mehr getan haben, fliegen ebenfalls raus.

Die Frist steht in `RETENTION_DAYS`, Standard 30. `0` schaltet das Löschen ab — davon würde ich abraten: Was gelöscht ist, kann niemand lesen und niemand herausverlangen. Das ist der wirksamste Datenschutz, den diese App haben kann.

Auf der Startseite steht ein sichtbarer Hinweis, dass Nachrichten zum Übersetzen an einen Server gehen und dort lesbar sind. Das gehört dorthin und nicht ins Kleingedruckte — Leute vergleichen mit WhatsApp und nehmen sonst Ende-zu-Ende-Verschlüsselung an, die hier technisch nicht möglich ist.

---

## Was eine Nachricht kostet

Jede Übersetzung schreibt eine Zeile mit Tokenverbrauch mit — ohne Nachrichtentext, nur Zahlen. Die Auswertung liegt auf:

```
https://deine-adresse/stats.html
```

Dort steht, was eine einzelne Übersetzung tatsächlich kostet, wie viel pro Tag zusammenkommt, und wie viele Nachrichten ein Abo von 1,99 € im Monat decken würde. Nach einer Woche echter Nutzung sind das belastbare Zahlen statt Schätzungen.

Die Seite liegt hinter dem Zugangswort. Vor einer Veröffentlichung solltest du sie zusätzlich absichern oder entfernen — sie verrät sonst deine Betriebskosten.

**Modell:** Standard ist jetzt `claude-sonnet-5` mit 2 $/10 $ je Million Tokens. Vorher lief die App auf Sonnet 4.6 mit 3 $/15 $ — das neuere Modell ist also ein Drittel günstiger. Die Preise für die Rechnung stehen in `PRICE_IN_PER_MTOK` und `PRICE_OUT_PER_MTOK`; ändern sich die Tarife, passt du sie dort an, ohne den Code anzufassen.

Die Verbrauchszahlen bleiben ein Jahr liegen, nicht nur 30 Tage — sie enthalten keinen Nachrichtentext.

---

## Sprache der Oberfläche

Die Oberfläche folgt der Sprache, die jemand für seine Nachrichten wählt — keine zweite Einstellung. Wer Português (Brasil) auswählt, sieht auch Knöpfe und Hinweise auf brasilianischem Portugiesisch.

Beim ersten Aufruf schlägt lumo die Browsersprache vor. Ein Brasilianer, der den Link bekommt, landet also sofort auf einer portugiesischen Startseite.

Fertig übersetzt sind 13 Oberflächensprachen: Deutsch, Englisch, Português (Portugal), Português (Brasil), Spanisch, Französisch, Italienisch, Niederländisch, Polnisch, Russisch, Ukrainisch, Türkisch, Arabisch. Bei Arabisch dreht sich das Layout auf rechts-nach-links.

Für die übrigen der 33 Nachrichtensprachen bleibt die Oberfläche auf Englisch — übersetzt wird trotzdem in alle. Eine Sprache ergänzen heißt: in `public/i18n.js` einen Block kopieren und die Texte übersetzen. Mehr ist es nicht.

Auch die Systemmeldungen im Chat („X ist dazugekommen") kommen jetzt als Code vom Server und werden erst im Browser in die jeweilige Sprache gesetzt — jeder liest sie in seiner eigenen.
