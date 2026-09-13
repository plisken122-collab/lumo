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

Oben in der Leiste sitzt ein Knopf `Ton aus` / `Ton an`. Beim ersten Antippen fragt der Browser um Erlaubnis. Danach gibt es bei jeder eingehenden Nachricht:

- einen kurzen Ton
- eine Vibration auf dem Handy
- eine Systembenachrichtigung mit dem bereits übersetzten Text
- eine Zahl im Tab-Titel für ungelesene Nachrichten

Es klingelt nur, wenn lumo gerade **nicht** im Vordergrund ist, und nie bei eigenen Nachrichten. Die Einstellung merkt sich das Gerät.

**Grenze:** Das funktioniert, solange lumo im Hintergrund geöffnet ist. Wird die App komplett weggewischt, kommt nichts mehr an. Für Benachrichtigungen bei geschlossener App braucht es echtes Web Push mit VAPID-Schlüsseln und eine Datenbank für die Abos — das ist der nächste Ausbauschritt.

Auf dem iPhone gehen Benachrichtigungen nur, wenn lumo vorher über Teilen → „Zum Home-Bildschirm" installiert wurde. Im normalen Safari-Tab unterdrückt iOS sie.
