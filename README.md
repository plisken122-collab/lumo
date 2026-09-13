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

## Auf Render deployen

```bash
git init && git add -A && git commit -m "lumo" && git branch -M main
```

Dann auf github.com ein leeres Repo anlegen und:

```bash
git remote add origin https://github.com/DEINNAME/lumo.git && git push -u origin main
```

Auf render.com → New → Web Service → Repo verbinden. Render liest `render.yaml`. Einzige manuelle Eingabe: unter **Environment** den Key `ANTHROPIC_API_KEY` mit deinem Wert setzen.

Danach eigene Domain verbinden (Settings → Custom Domain), CNAME bei Cloudflare setzen — genau wie bei Carrango.

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

## Was noch fehlt für den Produktivbetrieb

- **Datenbank.** Nachrichten liegen im Arbeitsspeicher und sind beim Neustart weg. Postgres einbauen.
- **Login.** Aktuell reicht der Chat-Code. Wer ihn kennt, liest mit.
- **Ende-zu-Ende-Verschlüsselung.** Geht nicht zusammen mit Server-Übersetzung — entweder der Server liest mit, oder die Übersetzung läuft auf dem Gerät.
- **Push-Benachrichtigungen.** Web Push über VAPID.
- **Rate Limit.** Sonst kann jemand deine API-Rechnung hochtreiben.
- **Bilder und Sprachnachrichten.**

## Kosten

Render Free reicht zum Testen (schläft nach Inaktivität ein). Für den Dauerbetrieb Starter ~7 €/Monat. Dazu die Anthropic-API nach Verbrauch — bei normalem Chatvolumen ein paar Euro im Monat.

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

Einmal auf Render deployen (siehe oben). Danach bekommst du eine feste Adresse wie `https://lumo.onrender.com`, die auf jedem Handy funktioniert, auch über Mobilfunk und auch wenn dein Rechner aus ist.

Auf dem Free-Plan schläft der Server nach 15 Minuten Leerlauf ein. Der erste Aufruf danach dauert dann ~30 Sekunden — nicht erschrecken, das ist kein Fehler.

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
