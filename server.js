import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import crypto from "crypto";
import webpush from "web-push";
import * as store from "./store.js";
import * as geld from "./bezahlung.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

/* --------------------------------------------------------------------
   Schutzkopfzeilen

   Kein fremdes Skript soll sich einschleusen lassen, die Seite soll in
   keinem fremden Rahmen laufen (Clickjacking), und der Browser soll
   nicht raten, was eine Datei ist. Die App laedt nur von sich selbst
   und von Google Fonts - mehr erlaubt die Regel nicht.

   'unsafe-inline' bleibt noetig, weil Stil und Skript in der Seite
   stehen. Ein XSS-Weg entstuende dadurch nur, wenn irgendwo fremder
   Text als HTML landete - genau das tut die App nirgends, jede
   Nachricht geht durch textContent. Die Regel ist der Guertel zum
   Hosentraeger.
-------------------------------------------------------------------- */
app.disable("x-powered-by");   // verraet sonst "Express"
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
const http = createServer(app);
const io = new Server(http);

/* 64 KB reichen fuer alles Normale. Sprachnachrichten sind die einzige
   Ausnahme und bringen ihre eigene, groessere Grenze mit - deshalb laeuft
   dieser eine Pfad hier vorbei, statt das Limit fuer alles anzuheben. */
/* Der Stripe-Webhook kommt ebenfalls hier vorbei, aber aus einem anderen
   Grund: Seine Unterschrift gilt fuer den Rohtext. Sobald ein JSON-Leser
   ihn einmal zerlegt und wieder zusammensetzt, stimmt sie nicht mehr. */
const kleinesJson = express.json({ limit: "64kb" });
const rohesJson = express.raw({ type: "*/*", limit: "1mb" });
app.use((req, res, next) => {
  if (req.path === "/api/voice" || req.path === "/api/bild") return next();
  if (req.path === "/api/stripe") return rohesJson(req, res, next);
  return kleinesJson(req, res, next);
});

/* --------------------------------------------------------------------
   Zugangswort

   Ist ACCESS_CODE gesetzt, kommt niemand ohne das Wort in die App.
   Fehlt die Variable, ist die App offen wie vorher.

   Im Browser landet kein Klartext: Wer das Wort richtig eingibt,
   bekommt ein Cookie mit einem abgeleiteten Wert. Das Wort selbst
   bleibt auf dem Server.
-------------------------------------------------------------------- */
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const gateOn = Boolean(ACCESS_CODE);
const COOKIE = "lumo_gate";

const gateToken = () =>
  crypto.createHmac("sha256", ACCESS_CODE).update("lumo-gate-v1").digest("hex");

function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function passedGate(req) {
  if (!gateOn) return true;
  const got = cookieValue(req, COOKIE);
  if (!got) return false;
  const want = gateToken();
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* --------------------------------------------------------------------
   Admin-Wort

   Schuetzt die Uebersichtsseite und die Zahlen dahinter. Wie beim
   Zugangswort landet das Wort selbst nie im Browser: Wer es richtig
   eingibt, bekommt ein Cookie mit einem abgeleiteten Wert. Fehlt
   ADMIN_TOKEN, ist der ganze Admin-Bereich aus.
-------------------------------------------------------------------- */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const adminOn = Boolean(ADMIN_TOKEN);
const ADMIN_COOKIE = "diralo_admin";

const adminToken = () =>
  crypto.createHmac("sha256", ADMIN_TOKEN).update("diralo-admin-v1").digest("hex");

function adminOk(req) {
  if (!adminOn) return false;
  const got = cookieValue(req, ADMIN_COOKIE);
  if (!got) return false;
  const want = adminToken();
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* Diese Pfade muessen ohne Zugangswort erreichbar sein, sonst laesst sich
   die Eingabeseite nicht darstellen. */
/* /sw.js gehoert dazu: Der Service Worker enthaelt nichts Vertrauliches,
   muss sich aber erneuern koennen - und laesst sich so auch von aussen
   pruefen, um festzustellen, welche Fassung wirklich ausgeliefert wird. */
/* Das Impressum muss ohne Zugangswort erreichbar sein - eine
   Pflichtangabe hinter einer Sperre erfuellt ihren Zweck nicht. */
const OPEN_PATHS = new Set(["/gate.html", "/api/gate", "/health", "/favicon.svg", "/manifest.json", "/i18n.js", "/sw.js", "/impressum.html", "/impressum", "/datenschutz.html", "/datenschutz", "/agb.html", "/agb", "/widerruf.html", "/widerruf",
  /* Die Preise muss sehen koennen, wer noch gar nicht drin ist - sonst
     kauft niemand die Katze im Sack. Der Webhook von Stripe bringt kein
     Cookie mit und muss ebenfalls vorbei. */
  "/preise.html", "/preise", "/api/stripe", "/api/plan", "/api/kasse", "/api/kasse-zurueck", "/api/verwalten",
  "/api/raeume", "/api/raum-dazu", "/api/raum-weg"]);
const isOpen = (p) => OPEN_PATHS.has(p) || p.startsWith("/brand/") || p.startsWith("/icons/");

app.post("/api/gate", (req, res) => {
  if (!gateOn) return res.json({ ok: true });
  if (!take(`gate:${req.ip}`, GATE_TRIES, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Zu viele Versuche. Spaeter nochmal." });
  }
  const given = String(req.body?.code || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ACCESS_CODE).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Das Wort stimmt nicht." });
  }
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${gateToken()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!gateOn || isOpen(req.path) || passedGate(req)) return next();
  if ((req.headers.accept || "").includes("text/html")) {
    /* Bewusst 200 und nicht 401: Die Seite hier *ist* die Antwort, nicht
       ein Fehler. Mit 401 hielten Pruefdienste - Stripe etwa, beim
       Anlegen des Kontos - diralo.app fuer eine tote Adresse und wiesen
       sie zurueck.

       Die Sperre selbst aendert sich dadurch nicht: Ohne das richtige
       Cookie kommt weiterhin nur diese Seite. Und gate.html traegt
       noindex und meldet keinen Service Worker an - sie kann also weder
       in einer Suchmaschine noch im Zwischenspeicher landen. */
    return res.sendFile(join(__dirname, "public", "gate.html"));
  }
  /* Aufrufe der Schnittstelle bleiben bei 401 - dort ist es wirklich
     eine abgewiesene Anfrage, und der Browser soll das auch so lesen. */
  res.status(401).json({ error: "Zugang gesperrt" });
});

/* Kurze Adresse ohne Endung, damit sie sich vorlesen laesst. */
app.get("/impressum", (_req, res) =>
  res.sendFile(join(__dirname, "public", "impressum.html")));
app.get("/datenschutz", (_req, res) =>
  res.sendFile(join(__dirname, "public", "datenschutz.html")));
app.get("/agb", (_req, res) =>
  res.sendFile(join(__dirname, "public", "agb.html")));
app.get("/widerruf", (_req, res) =>
  res.sendFile(join(__dirname, "public", "widerruf.html")));
app.get("/preise", (_req, res) =>
  res.sendFile(join(__dirname, "public", "preise.html")));

/* --------------------------------------------------------------------
   Bezahlung

   Eine Mitgliedschaft gehoert zu einem Chat, nicht zu einem Geraet. Wer
   einlaedt, bezahlt; alle im Chat schreiben mit. Das passt zu einer App
   ohne Konten - und der Chat-Code ist ohnehin schon der Schluessel zu
   allem, was drin steht.
-------------------------------------------------------------------- */
const raumCode = (r) => String(r || "").trim().toLowerCase().slice(0, 60);

/* Woher der Kaeufer kam. Nicht aus dem Browser uebernehmen: Sonst legt
   ein Fremder einen Kassengang an, der nach dem Bezahlen auf seine
   eigene Seite zurueckfuehrt. */
function eigeneHerkunft(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const schema = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${schema}://${req.headers.host}`;
}

/* Was ein Chat im Monat darf und wie viel davon weg ist.

   Das Kontingent gehoert dem Abo, nicht dem einzelnen Chat: Ein Abo
   schaltet mehrere Chats frei, und die teilen sich die Uebersetzungen.
   Ein Chat ohne Abo steht fuer sich und bekommt das freie Kontingent. */
async function kontingent(room) {
  const abo = await store.getAboByRoom(room);
  /* "gekuendigt" gehoert dazu: bezahlt ist bezahlt, der Tarif gilt bis
     zum Ende des Zeitraums. Erst "canceled" nimmt ihn weg. */
  const laeuft = abo && ["active", "trialing", "past_due", "gekuendigt"].includes(abo.status);
  const plan = laeuft ? abo.plan : "frei";
  const raeume = laeuft ? await store.raeumeVonAbo(abo.id) : [room];
  return {
    plan,
    bezahlt: Boolean(laeuft),
    status: abo?.status || null,
    grenze: geld.KONTINGENT[plan] ?? geld.KONTINGENT.frei,
    plaetze: geld.PLAETZE[plan] ?? geld.PLAETZE.frei,
    raeume,
    bisEnde: abo?.period_end ? Number(abo.period_end) : null,
  };
}

app.get("/api/plan", async (req, res) => {
  const room = raumCode(req.query.room);
  if (!room) return res.status(400).json({ error: "Kein Chat angegeben" });
  try {
    const k = await kontingent(room);
    /* Ueber alle Chats des Abos zusammen - sie teilen sich das Kontingent. */
    const benutzt = await store.translationsThisMonthForRooms(k.raeume);
    res.json({
      ...k, benutzt, rest: Math.max(0, k.grenze - benutzt),
      bezahlungAn: geld.bezahlungAn,
      plaetzeFrei: Math.max(0, k.plaetze - k.raeume.length),
      /* Welche Tarife wirklich hinterlegt sind. Ohne diese Angabe zeigt
         die Preisseite einen Knopf, der beim Druecken absagt. */
      tarife: geld.verfuegbar(),
      kontingente: geld.KONTINGENT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

app.post("/api/kasse", async (req, res) => {
  if (!geld.bezahlungAn) return res.status(503).json({ error: "Bezahlung ist noch nicht eingerichtet." });
  if (!take(`kasse:${req.ip}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Zu viele Versuche. Spaeter nochmal." });
  }

  const room = raumCode(req.body?.room);
  const plan = String(req.body?.plan || "");
  const zeitraum = String(req.body?.zeitraum || "monat");
  if (!room) return res.status(400).json({ error: "Kein Chat angegeben" });

  const preisId = geld.PREISE[plan]?.[zeitraum];
  if (!preisId) return res.status(400).json({ error: "Diesen Tarif gibt es nicht." });

  try {
    const sitzung = await geld.kassengang({
      preisId, raum: room, plan,
      herkunft: eigeneHerkunft(req),
      sprache: String(req.body?.sprache || ""),
    });
    res.json({ url: sitzung.url });
  } catch (err) {
    console.error("  Kassengang fehlgeschlagen:", err.message);
    letzterGeldFehler = err.message.slice(0, 200);
    res.status(502).json({ error: "Die Kasse antwortet gerade nicht." });
  }
});

/* Nach der Rueckkehr von Stripe. Der Webhook ist die eigentliche
   Wahrheit - dieser Aufruf sorgt nur dafuer, dass der Kaeufer seinen
   Verwaltungsschluessel sofort sieht, statt auf die Meldung zu warten. */
app.get("/api/kasse-zurueck", async (req, res) => {
  if (!geld.bezahlungAn) return res.status(503).json({ error: "Bezahlung ist aus." });
  const id = String(req.query.id || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Unbrauchbare Kennung" });

  try {
    const sitzung = await geld.kassengangLesen(id);
    if (sitzung.payment_status !== "paid" && sitzung.status !== "complete") {
      return res.json({ fertig: false });
    }
    /* Auch hier: eine Kennung aus einem anderen Geschaeft desselben
       Stripe-Kontos darf hier nichts freischalten. */
    if (!geld.unsere(sitzung)) return res.status(400).json({ error: "Gehoert nicht zu Diralo" });
    const room = raumCode(sitzung.client_reference_id || sitzung.metadata?.raum);
    if (!room) return res.status(400).json({ error: "Kein Chat an der Zahlung" });

    const gespeichert = await eintragen(sitzung, room, { frischerSchluessel: true });
    res.json({ fertig: true, room, plan: gespeichert.plan, schluessel: gespeichert.schluessel || null });
  } catch (err) {
    console.error("  Rueckkehr von der Kasse:", err.message);
    letzterGeldFehler = err.message.slice(0, 200);
    res.status(502).json({ error: "Konnte die Zahlung nicht nachschlagen." });
  }
});

/* Wann endet der bezahlte Zeitraum?

   Stripe hat current_period_end in neueren API-Fassungen vom Abonnement
   zu dessen Posten verschoben. Unser Webhook laeuft auf 2026-08-26; an
   der alten Stelle steht dort nichts mehr. Beide Stellen abfragen, damit
   es auch bei einer aelteren Fassung stimmt. */
function laufzeitEnde(abo) {
  const sek = abo?.items?.data?.[0]?.current_period_end ?? abo?.current_period_end;
  return sek ? Number(sek) * 1000 : null;
}

/* Zu welchem Tarif gehoert diese Preis-Kennung? Umgekehrter Weg, damit
   der Webhook nicht raten muss. */
function planZuPreis(preisId) {
  for (const [plan, zeiten] of Object.entries(geld.PREISE)) {
    for (const id of Object.values(zeiten)) if (id && id === preisId) return plan;
  }
  return null;
}

/* Eine bezahlte Sitzung in die Datenbank schreiben. Legt beim ersten Mal
   den Verwaltungsschluessel an und gibt ihn genau dann einmal zurueck. */
async function eintragen(sitzung, room, { frischerSchluessel = false } = {}) {
  /* Gibt es fuer dieses Abonnement schon ein Abo, gehoert der Kauf dazu -
     sonst entsteht ein neues, und der gekaufte Chat ist sein erster. */
  const abosNr = typeof sitzung.subscription === "string"
    ? sitzung.subscription : sitzung.subscription?.id;
  const vorher = (await store.getAboBySubscription(abosNr)) || (await store.getAboByRoom(room));
  /* Reihenfolge mit Bedacht: Die Metadaten haben wir selbst gesetzt, die
     Posten kommen nur mit, wenn wir sie ausdruecklich anfordern - und in
     der Webhook-Meldung fehlen sie ganz. */
  const preisId = sitzung.line_items?.data?.[0]?.price?.id || null;
  const plan = (geld.KONTINGENT[sitzung.metadata?.plan] ? sitzung.metadata.plan : null)
    || planZuPreis(preisId) || vorher?.plan || "plus";

  /* Der Verwaltungsschluessel laesst sich nur in dem Moment herausgeben,
     in dem er entsteht - gespeichert wird bloss sein Abdruck.

     Der Webhook ist aber schneller als der zurueckkehrende Browser. Legte
     nur er den Schluessel an, waere er schon vergeben, bevor der Kaeufer
     wieder da ist - und niemand kaeme je an ihn heran.

     Deshalb: Kommt der Kaeufer mit der Kennung seines Kassengangs zurueck,
     wird ein frischer Schluessel erzeugt und einmal ausgegeben. Diese
     Kennung hat nur, wer gerade bezahlt hat. */
  let schluessel = null;
  let abdruck = vorher?.manage_key || null;
  if (!abdruck || frischerSchluessel) {
    schluessel = geld.neuerVerwaltungsSchluessel();
    abdruck = geld.schluesselAbdruck(schluessel);
  }

  const id = vorher?.id || store.neueAboId();
  await store.saveAbo({
    id, plan, status: "active",
    customer: typeof sitzung.customer === "string" ? sitzung.customer : sitzung.customer?.id,
    subscription: abosNr,
    manage_key: abdruck,
    period_end: null,
  });
  /* Der Chat, fuer den bezahlt wurde, gehoert ab jetzt zum Abo. Gehoert er
     schon einem anderen, bleibt es dabei - dann hat der Kaeufer ein Abo
     ohne Chat und kann in der Verwaltung einen zuordnen. */
  const dazu = await store.raumHinzufuegen(id, room);

  frischeZahlen(await store.raeumeVonAbo(id));
  return { plan, schluessel, aboId: id, raumUebernommen: dazu };
}

/* Nach jeder Aenderung an einem Abo muessen die gemerkten Zahlen weg -
   sonst gilt die alte Grenze noch eine Minute weiter. */
function frischeZahlen(raeume) {
  for (const r of raeume || []) planZwischen.delete(r);
  monatsZaehler.clear();
}

/* Abo heraussuchen und den Schluessel pruefen. Gibt entweder das Abo
   zurueck oder hat die Antwort schon selbst beendet. */
async function aboMitSchluessel(req, res) {
  if (!take(`verw:${req.ip}`, 20, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Zu viele Versuche. Spaeter nochmal." });
    return null;
  }
  const room = raumCode(req.body?.room);
  const abo = await store.getAboByRoom(room);
  if (!abo) {
    res.status(404).json({ error: "Fuer diesen Chat gibt es keine Mitgliedschaft." });
    return null;
  }
  if (!geld.schluesselStimmt(req.body?.schluessel, abo.manage_key)) {
    res.status(403).json({ error: "Der Verwaltungsschluessel stimmt nicht." });
    return null;
  }
  return abo;
}

app.post("/api/verwalten", async (req, res) => {
  if (!geld.bezahlungAn) return res.status(503).json({ error: "Bezahlung ist aus." });
  const abo = await aboMitSchluessel(req, res);
  if (!abo) return;
  if (!abo.customer) return res.status(404).json({ error: "Zu dieser Mitgliedschaft fehlt der Kunde bei Stripe." });
  try {
    const seite = await geld.verwaltungsSeite({ kunde: abo.customer, herkunft: eigeneHerkunft(req) });
    res.json({ url: seite.url });
  } catch (err) {
    letzterGeldFehler = err.message.slice(0, 200);
    res.status(502).json({ error: "Die Verwaltung antwortet gerade nicht." });
  }
});

/* ------------------- Chats eines Abos verwalten -------------------
   Nur mit dem Verwaltungsschluessel. Sonst koennte jeder, der einen
   Chat-Code kennt, sich an ein fremdes Abo haengen.
------------------------------------------------------------------ */
app.post("/api/raeume", async (req, res) => {
  const abo = await aboMitSchluessel(req, res);
  if (!abo) return;
  const raeume = await store.raeumeVonAbo(abo.id);
  const plaetze = geld.PLAETZE[abo.plan] ?? geld.PLAETZE.frei;
  res.json({ plan: abo.plan, status: abo.status, raeume, plaetze, frei: Math.max(0, plaetze - raeume.length) });
});

app.post("/api/raum-dazu", async (req, res) => {
  const abo = await aboMitSchluessel(req, res);
  if (!abo) return;

  const neu = raumCode(req.body?.neuerRaum);
  if (!neu) return res.status(400).json({ error: "Kein Chat angegeben." });

  const raeume = await store.raeumeVonAbo(abo.id);
  if (raeume.includes(neu)) return res.json({ raeume, schon: true });

  const plaetze = geld.PLAETZE[abo.plan] ?? geld.PLAETZE.frei;
  if (raeume.length >= plaetze) {
    return res.status(409).json({ error: `Dieser Tarif schaltet ${plaetze} Chats frei. Nimm erst einen heraus.` });
  }
  if (!(await store.raumHinzufuegen(abo.id, neu))) {
    return res.status(409).json({ error: "Dieser Chat gehoert schon zu einer anderen Mitgliedschaft." });
  }
  const jetzt = await store.raeumeVonAbo(abo.id);
  frischeZahlen(jetzt.concat(raeume));
  res.json({ raeume: jetzt, frei: Math.max(0, plaetze - jetzt.length) });
});

app.post("/api/raum-weg", async (req, res) => {
  const abo = await aboMitSchluessel(req, res);
  if (!abo) return;

  const weg = raumCode(req.body?.raumWeg);
  const vorher = await store.raeumeVonAbo(abo.id);
  if (vorher.length <= 1) {
    return res.status(409).json({ error: "Der letzte Chat kann nicht heraus - sonst gaebe es keinen Weg zurueck in die Verwaltung." });
  }
  await store.raumEntfernen(abo.id, weg);
  const jetzt = await store.raeumeVonAbo(abo.id);
  frischeZahlen(vorher);
  const plaetze = geld.PLAETZE[abo.plan] ?? geld.PLAETZE.frei;
  res.json({ raeume: jetzt, frei: Math.max(0, plaetze - jetzt.length) });
});

/* --------------------------- Meldungen von Stripe ---------------------
   Die einzige Stelle, an der eine Mitgliedschaft ablaufen oder wieder
   aufleben kann. Antwortet absichtlich immer schnell: Stripe wiederholt
   sonst, und ein langsamer Webhook wird irgendwann abgeschaltet.
--------------------------------------------------------------------- */
app.post("/api/stripe", async (req, res) => {
  if (!geld.webhookAn) return res.status(503).send("Webhook nicht eingerichtet");

  let meldung;
  try {
    const roh = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    meldung = geld.webhookPruefen(roh, req.headers["stripe-signature"]);
  } catch (err) {
    /* Nicht ins Protokoll mit dem Inhalt - nur, dass und warum. */
    console.error("  Stripe-Meldung abgewiesen:", err.message);
    letzterGeldFehler = "Webhook: " + err.message.slice(0, 150);
    return res.status(400).send("Unterschrift");
  }

  res.json({ received: true }); // erst quittieren, dann arbeiten

  try {
    const d = meldung.data?.object || {};
    if (meldung.type === "checkout.session.completed") {
      /* Nur, was unsere Marke traegt. Laeuft im selben Stripe-Konto noch
         ein anderes Geschaeft, landen dessen Zahlungen ebenfalls hier -
         und eine fremde client_reference_id wuerde sonst hier einen Chat
         freischalten. */
      if (!geld.unsere(d)) return;
      const room = raumCode(d.client_reference_id || d.metadata?.raum);
      if (room) await eintragen(d, room);
    } else if (meldung.type?.startsWith("customer.subscription.")) {
      /* Kennen wir das Abonnement schon, ist es unseres - dann braucht
         es die Marke nicht. Kennen wir es nicht, muss sie da sein. */
      const abo = await store.getAboBySubscription(d.id);
      if (!abo && !geld.unsere(d)) return;
      if (abo) {
        await store.saveAbo({
          id: abo.id,
          plan: (geld.KONTINGENT[d.metadata?.plan] ? d.metadata.plan : null)
            || planZuPreis(d.items?.data?.[0]?.price?.id) || abo.plan || "plus",
          /* Wer im Kundenportal kuendigt, behaelt den Tarif bis zum Ende
             des bezahlten Zeitraums - Stripe laesst den Status dabei auf
             "active" und setzt nur cancel_at_period_end. Ohne diese
             Unterscheidung stuende der Chat bis zuletzt auf "aktiv" und
             waere dann von einem Tag auf den anderen wieder frei. */
          status: meldung.type.endsWith("deleted")
            ? "canceled"
            : (d.cancel_at_period_end ? "gekuendigt" : String(d.status || "active")),
          customer: typeof d.customer === "string" ? d.customer : d.customer?.id,
          subscription: d.id,
          period_end: laufzeitEnde(d),
        });
        frischeZahlen(await store.raeumeVonAbo(abo.id));
      }
    }
  } catch (err) {
    console.error("  Stripe-Meldung nicht verarbeitet:", err.message);
    letzterGeldFehler = "Verarbeitung: " + err.message.slice(0, 150);
  }
});

/* --------------------------------------------------------------------
   Trichter

   Fuenf Zahlen, mehr nicht. Sie beantworten die Frage, an der jede
   Werbung haengt: Wo hoeren die Leute auf?

   Bewusst ohne Zaehlpixel, ohne Cookie, ohne Kennung - gespeichert wird
   nur "an diesem Tag ist das n-mal passiert". Daraus laesst sich nicht
   zurueckrechnen, wer es war.
-------------------------------------------------------------------- */
const ZAEHLBAR = new Set(["besuch", "eingetreten", "nachricht", "einladung", "ueber_link"]);

/* Zaehlen darf nie etwas kaputtmachen: Faellt die Datenbank aus, laeuft
   der Chat weiter und die Zahl ist eben verloren. */
function zaehle(ereignis) {
  if (!ZAEHLBAR.has(ereignis)) return;
  store.zaehle(ereignis).catch(() => {});
}

/* Eigene Aufrufe nicht mitzaehlen. Wer die App selbst zum Ausprobieren
   oeffnet, wuerde den Trichter aufblaehen. Ein Aufruf von /?intern=1 setzt
   auf dem Geraet ein Cookie; von da an zaehlt dieses Geraet nicht mehr mit.
   /?intern=aus nimmt es zurueck. Das Cookie sagt nur "nicht zaehlen" - es
   steht kein Name drin, und normale Besucher bekommen es nie. */
const INTERN_COOKIE = "diralo_intern";
const istIntern = (req) => cookieValue(req, INTERN_COOKIE) === "1";

function internSetzen(res, an, secure) {
  const rest = an ? "Max-Age=31536000" : "Max-Age=0";
  res.setHeader(
    "Set-Cookie",
    `${INTERN_COOKIE}=${an ? "1" : ""}; Path=/; ${rest}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

/* Die Startseite selbst zaehlen. Muss vor express.static stehen, sonst
   liefert der die Datei aus, bevor wir sie bemerken. */
app.get("/", (req, res) => {
  if (req.query.intern !== undefined) {
    const an = req.query.intern !== "aus" && req.query.intern !== "0";
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    internSetzen(res, an, secure);
    return res.redirect("/");
  }
  if (!istIntern(req)) zaehle("besuch");
  res.sendFile(join(__dirname, "public", "index.html"));
});

/* Zwei Dinge weiss nur der Browser: ob jemand ueber einen Einladungslink
   kam und ob er auf Einladen gedrueckt hat. */
app.post("/api/zaehl", (req, res) => {
  if (!take(`zaehl:${req.ip}`, 60, 60 * 1000)) return res.status(429).end();
  const e = String(req.body?.ereignis || "");
  if (!istIntern(req) && (e === "einladung" || e === "ueber_link")) zaehle(e);
  res.status(204).end();
});

/* Was ist neu? Der Browser schickt seine Chats mit dem Zeitpunkt, an
   dem er sie zuletzt gelesen hat, und bekommt Zahlen zurueck - nie
   Inhalte. So verraet die Abfrage nichts, auch wenn jemand fremde
   Chat-Codes durchprobiert. */
app.post("/api/neues", async (req, res) => {
  if (!take(`neues:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({});
  const paare = (Array.isArray(req.body?.chats) ? req.body.chats : [])
    .map((c) => ({ room: raumCode(c?.room), seit: Number(c?.seit) || 0 }))
    .filter((c) => c.room);
  try {
    res.json(await store.neueNachrichten(paare, String(req.body?.device || "").slice(0, 60)));
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 150) });
  }
});

/* Die Admin-Seite selbst. Ohne Cookie zeigt sie nur ein Eingabefeld -
   die Zahlen holt sie ueber die geschuetzten Endpunkte unten. */
app.get("/admin", (_req, res) =>
  res.sendFile(join(__dirname, "public", "admin.html")));

app.post("/api/admin/login", (req, res) => {
  if (!adminOn) return res.status(503).json({ error: "Admin ist nicht eingerichtet." });
  if (!take(`admin:${req.ip}`, 8, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Zu viele Versuche. Spaeter nochmal." });
  }
  const given = String(req.body?.wort || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Das Wort stimmt nicht." });
  }
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${adminToken()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
  res.json({ ok: true });
});

app.get("/api/trichter", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  const tage = Math.min(90, Math.max(1, Number(req.query.tage) || 14));
  try {
    res.json(await store.trichter(tage));
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

/* Alle Zahlen fuer die Uebersicht in einem Rutsch. Nur Aggregate -
   keine Chat-Codes, keine Nachrichteninhalte. */
app.get("/api/admin/daten", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  try {
    const [trichter, aktiv7, aktiv30, abos, push, monat, gesamt, demo] = await Promise.all([
      store.trichter(14),
      store.aktiveChats(7),
      store.aktiveChats(30),
      store.aboZaehlung(),
      store.pushZaehlung(),
      store.getUsage(30),
      store.getUsage(365),
      store.getDemoUsage(30),
    ]);
    const kostenMonat = costOf(monat.total);
    const kostenDemo = costOf(demo);
    res.json({
      trichter,
      chats: { aktiv7, aktiv30 },
      abos,
      push,
      uebersetzungen: { monat: monat.total.count, jahr: gesamt.total.count },
      kostenMonatUsd: Number(kostenMonat.toFixed(2)),
      demo: { monat: demo.count, kostenUsd: Number(kostenDemo.toFixed(2)) },
      umsatzMonatEur: abos.plus * 4.99 + abos.familie * 9.99,
    });
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/* Preise in US-Dollar je eine Million Tokens. Stand September 2026 fuer
   Sonnet 5. Aendern sich die Preise, hier anpassen - oder per
   Umgebungsvariable, ohne den Code anzufassen. */
const PRICE_IN = Number(process.env.PRICE_IN_PER_MTOK || 2);
const PRICE_OUT = Number(process.env.PRICE_OUT_PER_MTOK || 10);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

/* ------------------------------ Bremse ------------------------------
   Jede Uebersetzung kostet Geld, und eine Nachricht loest eine je
   Lesersprache aus. Drei Grenzen, von aussen nach innen:

   1. Zugangswort - begrenzte Versuche je Adresse, sonst laesst es sich
      in Ruhe durchprobieren.
   2. Nachrichten - begrenzt je Geraet. Bremst den Dauerlaeufer, nicht
      das normale Gespraech.
   3. Uebersetzungen - eine Obergrenze fuer alle zusammen, pro Tag. Das
      ist die eigentliche Sicherung der Rechnung: Was danach kommt, wird
      zugestellt, aber im Original angezeigt.

   Alles nur im Arbeitsspeicher. Bei mehreren Instanzen zaehlt jede fuer
   sich - bei einem Dienst auf Render ist das genau eine.
-------------------------------------------------------------------- */
const GATE_TRIES = Number(process.env.GATE_TRIES_PER_15MIN || 10);
const MSG_PER_MIN = Number(process.env.MSG_PER_MIN || 20);
const NEED_PER_MIN = Number(process.env.NEED_PER_MIN || 120);
const TRANSLATIONS_PER_DAY = Number(process.env.TRANSLATIONS_PER_DAY || 2000);
/* Der Probe-Chat kostet je Runde eine KI-Antwort. Grosszuegig genug fuer
   echtes Ausprobieren, gedeckelt gegen Missbrauch. */
const DEMO_PER_DAY = Number(process.env.DEMO_PER_DAY || 800);

const counters = new Map(); // Schluessel -> { n, until }

/* Zaehlt einen Versuch. Gibt false zurueck, wenn die Grenze erreicht
   ist. Eine Grenze von 0 oder weniger heisst: keine Grenze. */
function take(key, max, windowMs) {
  if (!(max > 0)) return true;
  const now = Date.now();
  const c = counters.get(key);
  if (!c || c.until <= now) {
    counters.set(key, { n: 1, until: now + windowMs });
    return true;
  }
  if (c.n >= max) return false;
  c.n++;
  return true;
}

/* Wie viele Uebersetzungen heute noch drin sind. Nur zur Anzeige. */
function leftToday() {
  if (!(TRANSLATIONS_PER_DAY > 0)) return null;
  const c = counters.get("tr:day");
  if (!c || c.until <= Date.now()) return TRANSLATIONS_PER_DAY;
  return Math.max(0, TRANSLATIONS_PER_DAY - c.n);
}

/* Abgelaufene Zaehler wegraeumen, sonst waechst die Map unbegrenzt. */
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of counters) if (c.until <= now) counters.delete(k);
}, 5 * 60 * 1000).unref();

/* Hinter dem Proxy von Render steht die echte Adresse des Besuchers in
   X-Forwarded-For. Ohne diese Zeile sieht Express nur den Proxy - und
   alle Besucher teilten sich einen Zaehler. */
app.set("trust proxy", 1);

/* ------------------------- Web Push einrichten ------------------------- */
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_MAIL = process.env.VAPID_CONTACT || "mailto:admin@example.com";
const pushReady = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);

if (pushReady) {
  webpush.setVapidDetails(VAPID_MAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

/* ----------------------------- Sprachen ----------------------------- */
const LANG_NAMES = {
  de: "Deutsch",
  "de-CH": "Schweizer Hochdeutsch",
  "pt-PT": "europaeisches Portugiesisch (Portugal)",
  "pt-BR": "brasilianisches Portugiesisch (Brasilien)",
  en: "britisches Englisch",
  "en-US": "amerikanisches Englisch",
  es: "kastilisches Spanisch (Spanien)",
  "es-419": "lateinamerikanisches Spanisch",
  fr: "Franzoesisch", it: "Italienisch", nl: "Niederlaendisch", pl: "Polnisch",
  ru: "Russisch", uk: "Ukrainisch", tr: "Tuerkisch", ar: "Arabisch",
  zh: "Chinesisch (vereinfacht)", "zh-TW": "Chinesisch (traditionell)",
  ja: "Japanisch", ko: "Koreanisch", hi: "Hindi",
  sv: "Schwedisch", ro: "Rumaenisch", da: "Daenisch", no: "Norwegisch",
  fi: "Finnisch", cs: "Tschechisch", hu: "Ungarisch", el: "Griechisch",
  he: "Hebraeisch", th: "Thai", vi: "Vietnamesisch", id: "Indonesisch",
};
const CODES = Object.keys(LANG_NAMES);
const clean = (l) => (CODES.includes(l) ? l : "de");

const HINTS = {
  "pt-BR": "Brasilianisch: 'voce' statt 'tu', Gerundium ('estou fazendo', nicht 'estou a fazer'), brasilianischer Wortschatz (onibus, trem, celular, legal, cara, a gente, bacana). Keine Mesoklise.",
  "pt-PT": "Europaeisch: informelles 'tu', Infinitivkonstruktion ('estou a fazer'), portugiesischer Wortschatz (autocarro, comboio, telemovel, fixe, pa, se calhar).",
  "es-419": "Lateinamerikanisch: kein 'vosotros', neutraler Wortschatz ohne Regionalismen aus Spanien.",
  es: "Spanien: 'vosotros' erlaubt, Wortschatz aus Spanien (coche, movil, vale, guay).",
  "en-US": "US-Schreibweise und US-Wortschatz.",
  en: "Britische Schreibweise und britischer Wortschatz.",
  "de-CH": "Schweizer Hochdeutsch: kein Eszett, Schweizer Wortschatz (Velo, Natel, parkieren, Znueni).",
  "zh-TW": "Traditionelle Schriftzeichen, taiwanischer Sprachgebrauch.",
};

/* ---------------------------- Uebersetzung ---------------------------- */
const inFlight = new Map(); // key -> Promise, verhindert doppelte Anfragen
let quotaWarnedUntil = 0; // damit die Tagesgrenze nur einmal gemeldet wird
let lastClient = null;   // letzte Meldung eines Geraets, siehe /health
let lastSpeech = null;   // wie die letzte Mitschrift ausging, siehe /health
let letzterLoeschFehler = null; // damit ein gescheitertes Loeschen sichtbar wird
let letzterLoeschVersuch = null; // erreicht der Versuch den Server ueberhaupt?
let letzterGeldFehler = null;   // damit ein Fehler bei Stripe sichtbar wird

/* Zwei kleine Zwischenspeicher, damit nicht jede einzelne Uebersetzung
   zwei Datenbankabfragen ausloest. Bei einer Instanz auf Render reicht
   das; kaeme je eine zweite dazu, muesste beides in die Datenbank. */
const monatsZaehler = new Map(); // room -> { monat, n }
const planZwischen = new Map();  // room -> { bis, wert }

const monatsKennung = () => {
  const d = new Date();
  return d.getUTCFullYear() * 100 + d.getUTCMonth();
};

async function claude(prompt) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return {
    result: JSON.parse(text.replace(/```json|```/g, "").trim()),
    usage: {
      inTokens: data.usage?.input_tokens || 0,
      outTokens: data.usage?.output_tokens || 0,
    },
  };
}

/* Wie claude(), aber mit einem Bild davor: dasselbe Modell kann sehen,
   liest also Text aus einem Foto und uebersetzt ihn in einem Zug. */
async function claudeBild(daten, mime, prompt) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: daten } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return {
    result: JSON.parse(text.replace(/```json|```/g, "").trim()),
    usage: {
      inTokens: data.usage?.input_tokens || 0,
      outTokens: data.usage?.output_tokens || 0,
    },
  };
}

async function translate(text, target) {
  const name = LANG_NAMES[target] || target;
  const hint = HINTS[target] ? `\nZielvariante beachten: ${HINTS[target]}` : "";
  const prompt = `Du bist die Uebersetzungs-Engine eines Messengers. Erkenne die Sprache des Textes und uebersetze ihn natuerlich und umgangssprachlich nach ${name} (${target}) - so, wie ein Muttersprachler es in einen Chat tippen wuerde. Behalte Emojis, Namen, Zahlen und den Tonfall. Erklaere nichts, kommentiere nichts.${hint}
Bei der Erkennung die regionale Variante angeben, wenn sie am Text erkennbar ist: pt-BR oder pt-PT, es-419 oder es, en-US oder en, de-CH oder de, zh-TW oder zh. Sonst nur den Sprachcode.
Text: """${text}"""
Antworte NUR mit JSON, ohne Markdown: {"detected":"<Sprachcode>","translation":"<Uebersetzung>"}`;
  return claude(prompt);
}

const costOf = (u) => (u.inTokens / 1e6) * PRICE_IN + (u.outTokens / 1e6) * PRICE_OUT;

/* Darf dieser Chat noch uebersetzen lassen?

   Zaehlt im Arbeitsspeicher weiter, holt sich den Stand aber einmal je
   Monat und Chat aus dem Verbrauchsprotokoll. Ein Neustart verliert
   damit nichts: Die Zahl steht in der Datenbank, nicht hier.

   Schlaegt die Abfrage fehl, wird durchgelassen. Lieber eine Handvoll
   Uebersetzungen zu viel als ein Chat, der wegen einer klemmenden
   Datenbank verstummt. */
async function imKontingent(room) {
  const monat = monatsKennung();

  /* Gezaehlt wird je Abo, nicht je Chat: Alle Chats eines Abos teilen
     sich dieselben Uebersetzungen. Ein Chat ohne Abo bildet seinen
     eigenen "Topf" - der Schluessel ist dann einfach der Chat selbst. */
  let topf, grenze, raeume;
  const gemerkt = planZwischen.get(room);
  if (gemerkt && gemerkt.bis > Date.now()) {
    ({ topf, grenze, raeume } = gemerkt.wert);
  } else {
    try {
      const k = await kontingent(room);
      grenze = k.grenze;
      raeume = k.raeume;
      topf = k.bezahlt ? "abo:" + k.raeume.slice().sort().join(",") : "raum:" + room;
    } catch (err) {
      letzterGeldFehler = "Kontingent: " + err.message.slice(0, 150);
      return true;
    }
    planZwischen.set(room, { bis: Date.now() + 60 * 1000, wert: { topf, grenze, raeume } });
  }
  if (!(grenze > 0)) return true; // 0 heisst: keine Grenze

  let stand = monatsZaehler.get(topf);
  if (!stand || stand.monat !== monat) {
    try {
      stand = { monat, n: await store.translationsThisMonthForRooms(raeume) };
    } catch (err) {
      letzterGeldFehler = "Monatszaehler: " + err.message.slice(0, 150);
      return true;
    }
    monatsZaehler.set(topf, stand);
  }

  if (stand.n >= grenze) return false;
  stand.n++;
  return true;
}

/* Sorgt dafuer, dass eine Uebersetzung existiert. Gibt den Text zurueck. */
async function ensure(room, msgId, target) {
  const msg = await store.getMessage(msgId);
  if (!msg) return null;
  if (msg.lang === target) return msg.text;
  if (msg.tr[target]) return msg.tr[target];

  /* Steht kein einziger Buchstabe drin, ist nichts zu uebersetzen -
     reine Smileys, Zahlen oder Satzzeichen. Spart einen bezahlten
     Aufruf und schuetzt die Zeichen davor, unterwegs zu verunglaecken.

     Die Runde muss trotzdem raus: Ohne sie wartet der Browser ewig auf
     eine Uebersetzung, die nie kommt, und zeigt weiter "uebersetzt ...". */
  if (!/\p{L}/u.test(msg.text)) {
    io.to(room).emit("translated", { id: msgId, lang: target, text: msg.text });
    return msg.text;
  }

  const key = `${msgId}:${target}`;
  if (inFlight.has(key)) return inFlight.get(key);

  /* Monatsgrenze des Chats. Sie steht vor der Tagesgrenze: Ist der Chat
     am Ende seines Kontingents, soll er nicht auch noch vom gemeinsamen
     Tagesvorrat abbeissen.

     Die Nachricht kommt trotzdem an - sie wird nur im Original gezeigt.
     Zustellung darf nie am Geld haengen. */
  if (!(await imKontingent(room))) {
    io.to(room).emit("quotaReached", { id: msgId, grund: "monat" });
    return null;
  }

  /* Erst hier zaehlen: Alles darueber kam aus dem Zwischenspeicher und
     hat nichts gekostet. */
  if (!take("tr:day", TRANSLATIONS_PER_DAY, 24 * 60 * 60 * 1000)) {
    /* Einmal je Tagesfenster ins Protokoll, nicht bei jeder Nachricht. */
    const until = counters.get("tr:day")?.until || 0;
    if (quotaWarnedUntil !== until) {
      quotaWarnedUntil = until;
      console.error(`  Tagesgrenze von ${TRANSLATIONS_PER_DAY} Uebersetzungen erreicht.`);
    }
    io.to(room).emit("quotaReached", { id: msgId });
    return null;
  }

  const job = (async () => {
    try {
      const { result: out, usage } = await translate(msg.text, target);
      store.logUsage({
        room, target, chars: msg.text.length,
        inTokens: usage.inTokens, outTokens: usage.outTokens,
      }).catch((e) => console.error("Verbrauch nicht speicherbar:", e.message));
      if (out.detected && !msg.detected && CODES.includes(out.detected)) {
        await store.setDetectedLang(msgId, out.detected);
        msg.lang = out.detected;
        io.to(room).emit("lang", { id: msgId, lang: out.detected });
      }
      if (msg.lang === target) return msg.text;
      await store.setTranslation(msgId, target, out.translation);
      io.to(room).emit("translated", { id: msgId, lang: target, text: out.translation });
      return out.translation;
    } catch (err) {
      console.error("Uebersetzung fehlgeschlagen:", err.message);
      io.to(room).emit("translationError", { id: msgId, lang: target });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, job);
  return job;
}

/* Text aus einem Bild lesen und uebersetzen - auf Anfrage, nicht von
   selbst (Sehen kostet mehr als Textuebersetzen). Ergebnis je Bild und
   Sprache zwischengespeichert, damit das Ansehen nur einmal kostet. */
const bildTextInFlight = new Map();
async function uebersetzeBildText(room, msgId, target) {
  const zwischen = await store.getBildText(msgId, target);
  if (zwischen != null) {
    io.to(room).emit("bildTextFertig", { id: msgId, lang: target, text: zwischen });
    return zwischen;
  }
  const msg = await store.getMessage(msgId);
  if (!msg || !msg.bild) return null;
  const medien = await store.getMedia(msgId);
  if (!medien) return null;

  const key = `bt:${msgId}:${target}`;
  if (bildTextInFlight.has(key)) return bildTextInFlight.get(key);

  if (!(await imKontingent(room))) {
    io.to(room).emit("quotaReached", { id: msgId, grund: "monat" });
    return null;
  }
  if (!take("tr:day", TRANSLATIONS_PER_DAY, 24 * 60 * 60 * 1000)) {
    io.to(room).emit("quotaReached", { id: msgId });
    return null;
  }

  const name = LANG_NAMES[target] || target;
  const prompt = `In diesem Bild steht moeglicherweise Text (Schild, Screenshot, Brief o. ae.). Lies allen gut lesbaren Text und uebersetze ihn natuerlich nach ${name} (${target}). Behalte Zeilenumbrueche grob bei. Ist gar kein lesbarer Text im Bild, gib einen leeren String zurueck. Erklaere und kommentiere nichts. Antworte NUR mit JSON, ohne Markdown: {"text":"<Uebersetzung oder leer>"}`;

  const job = (async () => {
    try {
      const b64 = Buffer.from(medien.bytes).toString("base64");
      const { result: out, usage } = await claudeBild(b64, medien.mime, prompt);
      const text = String(out.text || "").slice(0, 4000);
      store.logUsage({
        room, target, chars: Math.max(1, text.length),
        inTokens: usage.inTokens, outTokens: usage.outTokens,
      }).catch((e) => console.error("Verbrauch nicht speicherbar:", e.message));
      await store.saveBildText(msgId, target, text);
      io.to(room).emit("bildTextFertig", { id: msgId, lang: target, text });
      return text;
    } catch (err) {
      console.error("Bildtext-Uebersetzung fehlgeschlagen:", err.message);
      io.to(room).emit("bildTextFehler", { id: msgId, lang: target });
      return null;
    } finally {
      bildTextInFlight.delete(key);
    }
  })();

  bildTextInFlight.set(key, job);
  return job;
}

/* ------------------------------- Push ------------------------------- */
/* Schickt jedem angemeldeten Geraet im Raum die Nachricht in seiner Sprache. */
async function pushToRoom(room, msg) {
  if (!pushReady) return;
  let subs = [];
  try {
    subs = await store.getSubscriptions(room);
  } catch (err) {
    console.error("Push-Anmeldungen nicht lesbar:", err.message);
    return;
  }

  for (const sub of subs) {
    if (sub.device === msg.device) continue; // nicht an den Absender
    try {
      const body = await ensure(room, msg.id, clean(sub.lang));
      const payload = JSON.stringify({
        title: msg.name,
        body: body || msg.text || (msg.ort ? "📍" : (msg.bild ? "📷" : "")),
        room,
        id: msg.id,
      });
      await webpush.sendNotification(sub.data, payload);
    } catch (err) {
      /* 404 und 410 heissen: Anmeldung ist tot, Geraet abgemeldet. */
      if (err.statusCode === 404 || err.statusCode === 410) {
        await store.deleteSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error("Push fehlgeschlagen:", err.statusCode || err.message);
      }
    }
  }
}

/* ------------------------------ HTTP API ------------------------------ */
app.get("/api/push-key", (_req, res) => {
  res.json({ enabled: pushReady, key: VAPID_PUBLIC || null });
});

app.post("/api/subscribe", async (req, res) => {
  const { subscription, room, rooms, device, name, lang } = req.body || {};
  if (!pushReady) return res.status(503).json({ error: "Push ist nicht eingerichtet" });
  if (!subscription?.endpoint || !device) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }

  /* Die Glocke gilt fuer alle Chats, die der Browser mitschickt - nicht
     nur fuer den gerade offenen. Wer sie einmal einschaltet, will von
     allen seinen Gespraechen hoeren, nicht von einem. */
  const liste = [...new Set(
    (Array.isArray(rooms) ? rooms : [])
      .concat(room ? [room] : [])
      .map((r) => String(r || "").toLowerCase().trim().slice(0, 60))
      .filter(Boolean)
  )].slice(0, 20);

  if (!liste.length) return res.status(400).json({ error: "Kein Chat angegeben" });

  try {
    for (const r of liste) {
      await store.saveSubscription({
        endpoint: subscription.endpoint,
        room: r,
        device: String(device).slice(0, 60),
        name: String(name || "Gast").slice(0, 40),
        lang: clean(lang),
        data: subscription,
      });
    }
    res.json({ ok: true, chats: liste.length });
  } catch (err) {
    console.error("Anmeldung fehlgeschlagen:", err.message);
    res.status(500).json({ error: "Anmeldung fehlgeschlagen" });
  }
});

app.post("/api/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint fehlt" });
  try {
    await store.deleteSubscription(endpoint);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Abmeldung fehlgeschlagen" });
  }
});

/* ------------------------ Sprachnachrichten ------------------------
   Die Aufnahme kommt als base64 in JSON. Das blaeht sie um ein Drittel
   auf, spart dafuer eine Zusatzbibliothek fuer mehrteilige Formulare -
   bei zwei Minuten Opus geht es um wenige hundert Kilobyte.

   Die Mitschrift macht der Browser des Absenders. Sie landet als
   gewoehnlicher Nachrichtentext in der Datenbank und laeuft danach durch
   dieselbe Uebersetzung wie alles andere. Deshalb braucht es hier keinen
   eigenen Weg fuer "Sprachnachricht uebersetzen".
------------------------------------------------------------------- */
const VOICE_MAX_SECONDS = Number(process.env.VOICE_MAX_SECONDS || 120);
const VOICE_MAX_BYTES = Number(process.env.VOICE_MAX_BYTES || 1_500_000);

/* Nur diese Formate, und der Typ wird nie aus dem Dateinamen
   uebernommen - sonst laesst sich Beliebiges als Audio ausliefern. */
const VOICE_MIME = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "audio/mpeg": "audio/mpeg",
};

app.post("/api/voice", express.json({ limit: "3mb" }), async (req, res) => {
  const { room, device, name, lang, seconds, transcript, mime, audio } = req.body || {};
  if (!room || !device || !audio) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  const type = VOICE_MIME[String(mime || "").split(";")[0].trim()];
  if (!type) return res.status(415).json({ error: "Format nicht unterstuetzt" });

  const dauer = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round(Number(seconds) || 1)));
  let bytes;
  try {
    bytes = Buffer.from(String(audio), "base64");
  } catch {
    return res.status(400).json({ error: "Aufnahme unlesbar" });
  }
  if (!bytes.length || bytes.length > VOICE_MAX_BYTES) {
    return res.status(413).json({ error: "Aufnahme zu gross" });
  }

  const raum = String(room).trim().toLowerCase().slice(0, 60);
  const geraet = String(device).slice(0, 60);
  if (!take(`msg:${geraet}`, MSG_PER_MIN, 60 * 1000)) {
    return res.status(429).json({ error: "Zu schnell" });
  }

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    room: raum,
    device: geraet,
    name: String(name || "Gast").slice(0, 40),
    text: String(transcript || "").trim().slice(0, 4000),
    lang: clean(lang),
    detected: false,
    tr: {},
    at: Date.now(),
    audioSeconds: dauer,
  };

  try {
    await store.addMessage(msg);
    await store.addMedia(msg.id, { mime: type, bytes });
  } catch (err) {
    console.error("Sprachnachricht nicht speicherbar:", err.message);
    return res.status(500).json({ error: "Nicht speicherbar" });
  }

  io.to(raum).emit("message", msg);
  pushToRoom(raum, msg).catch((e) => console.error("Push-Lauf:", e.message));
  res.json({ ok: true, id: msg.id });
});

/* ------------------------------ Bilder ------------------------------
   Wie die Sprachnachricht kommt das Bild als base64 in JSON. Verkleinert
   und von EXIF befreit hat es schon der Browser des Absenders - der
   Server prueft nur Format und Groesse und legt es in dieselbe
   media-Tabelle. Die Loeschfrist raeumt es ueber ON DELETE CASCADE mit
   der Nachricht wieder weg.

   Eine etwaige Bildunterschrift ist gewoehnlicher Nachrichtentext und
   laeuft danach durch dieselbe Uebersetzung wie alles andere.
------------------------------------------------------------------- */
const BILD_MAX_BYTES = Number(process.env.BILD_MAX_BYTES || 2_500_000);
const BILD_MIME = {
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/png": "image/png",
};

app.post("/api/bild", express.json({ limit: "5mb" }), async (req, res) => {
  const { room, device, name, lang, caption, mime, bild } = req.body || {};
  if (!room || !device || !bild) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  const type = BILD_MIME[String(mime || "").split(";")[0].trim()];
  if (!type) return res.status(415).json({ error: "Format nicht unterstuetzt" });

  let bytes;
  try {
    bytes = Buffer.from(String(bild), "base64");
  } catch {
    return res.status(400).json({ error: "Bild unlesbar" });
  }
  if (!bytes.length || bytes.length > BILD_MAX_BYTES) {
    return res.status(413).json({ error: "Bild zu gross" });
  }

  const raum = String(room).trim().toLowerCase().slice(0, 60);
  const geraet = String(device).slice(0, 60);
  if (!take(`msg:${geraet}`, MSG_PER_MIN, 60 * 1000)) {
    return res.status(429).json({ error: "Zu schnell" });
  }

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    room: raum,
    device: geraet,
    name: String(name || "Gast").slice(0, 40),
    text: String(caption || "").trim().slice(0, 4000),
    lang: clean(lang),
    detected: false,
    tr: {},
    at: Date.now(),
    bild: true,
  };

  try {
    await store.addMessage(msg);
    await store.addMedia(msg.id, { mime: type, bytes });
  } catch (err) {
    console.error("Bild nicht speicherbar:", err.message);
    return res.status(500).json({ error: "Nicht speicherbar" });
  }

  io.to(raum).emit("message", msg);
  pushToRoom(raum, msg).catch((e) => console.error("Push-Lauf:", e.message));
  res.json({ ok: true, id: msg.id });
});

/* Ausliefern. Liegt hinter dem Zugangswort wie alles andere - die
   Aufnahmen sind damit nicht oeffentlich abrufbar. */
app.get("/medien/:id", async (req, res) => {
  let m = null;
  try {
    m = await store.getMedia(String(req.params.id));
  } catch (err) {
    console.error("Aufnahme nicht lesbar:", err.message);
    return res.sendStatus(500);
  }
  if (!m) return res.sendStatus(404);
  res.setHeader("Content-Type", m.mime);
  res.setHeader("Content-Length", m.bytes.length);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(m.bytes);
});

app.get("/api/stats", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  try {
    const u = await store.getUsage(days);
    const cost = costOf(u.total);
    res.json({
      days,
      model: MODEL,
      prices: { inputPerMTok: PRICE_IN, outputPerMTok: PRICE_OUT },
      total: {
        ...u.total,
        costUsd: Number(cost.toFixed(4)),
        costPerTranslationUsd: u.total.count ? Number((cost / u.total.count).toFixed(6)) : 0,
      },
      byDay: u.byDay.map((d) => ({
        ...d,
        costUsd: Number(costOf(d).toFixed(4)),
      })),
    });
  } catch (err) {
    console.error("Auswertung fehlgeschlagen:", err.message);
    res.status(500).json({ error: "Auswertung fehlgeschlagen" });
  }
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    key: Boolean(API_KEY),
    push: pushReady,
    database: store.usingDatabase,
    gate: gateOn,
    retentionDays: RETENTION_DAYS > 0 ? RETENTION_DAYS : null,
    langs: CODES.length,
    lastClient,
    lastSpeech,
    dbFehler: store.schemaFehler || null,
    loeschFehler: letzterLoeschFehler,
    loeschVersuch: letzterLoeschVersuch,
    limits: {
      msgPerMin: MSG_PER_MIN,
      translationsPerDay: TRANSLATIONS_PER_DAY > 0 ? TRANSLATIONS_PER_DAY : null,
      translationsLeftToday: leftToday(),
    },
    geld: {
      stripe: geld.bezahlungAn,
      webhook: geld.webhookAn,
      preise: geld.verfuegbar(),
      kontingente: geld.KONTINGENT,
      letzterFehler: letzterGeldFehler,
    },
  })
);

/* ------------------------------ Sockets ------------------------------ */
io.use((socket, next) => {
  if (!gateOn) return next();
  const fake = { headers: { cookie: socket.handshake.headers.cookie || "" } };
  if (passedGate(fake)) return next();
  next(new Error("Zugang gesperrt"));
});

/* Die echte Adresse hinter dem Proxy von Render. socket.handshake.address
   waere nur der Proxy - alle Besucher haetten dieselbe. */
function sockAdresse(socket) {
  const vor = socket.handshake.headers["x-forwarded-for"];
  if (vor) return String(vor).split(",")[0].trim();
  return socket.handshake.address || "?";
}

io.on("connection", (socket) => {
  let room = null;
  let me = { name: "Gast", lang: "de", device: null };
  const ip = sockAdresse(socket);
  /* Dasselbe "nicht zaehlen"-Cookie wie oben - der Handschlag traegt es
     mit, also bleiben auch Eintritt und Nachricht dieses Geraets draussen. */
  const internSock = istIntern({ headers: { cookie: socket.handshake.headers.cookie || "" } });

  socket.on("join", async ({ roomCode, name, lang, device, build, speech }) => {
    /* Zur Fehlersuche: Welche Fassung hat das Geraet geladen, und kann
       sein Browser mitschreiben? Nur diese zwei Angaben, nichts, woran
       sich jemand erkennen liesse. */
    lastClient = {
      build: String(build || "unbekannt").slice(0, 20),
      speech: Boolean(speech),
      at: new Date().toISOString(),
    };
    /* Wer schon in einem Raum sitzt und neu beitritt - etwa ueber einen
       Einladungslink - muss den alten verlassen. Sonst bekaeme er die
       Nachrichten beider Raeume. */
    const vorher = room;
    const gewuenscht = String(roomCode || "lobby").trim().toLowerCase().slice(0, 60);

    /* Chat-Codes durchprobieren unterbinden. Der Code ist das einzige
       Geheimnis; wer einen Treffer landet, bekaeme sofort den ganzen
       Verlauf. Ein neuer Chat je Beitritt ist normal - hundert in einer
       Minute ist ein Woerterbuchangriff. Nur echte Wechsel zaehlen,
       damit ein Reconnect in denselben Chat nichts verbraucht. */
    if (gewuenscht !== vorher && !take(`join:${ip}`, 40, 5 * 60 * 1000)) {
      socket.emit("system", { type: "tooManyJoins" });
      return;
    }

    room = gewuenscht;
    if (vorher !== room && !internSock) zaehle("eingetreten");
    if (vorher && vorher !== room) {
      socket.leave(vorher);
      socket.to(vorher).emit("system", { type: "left", name: me.name });
    }
    me = {
      name: String(name || "Gast").slice(0, 40),
      lang: clean(lang),
      device: String(device || socket.id).slice(0, 60),
    };
    socket.join(room);
    try {
      socket.emit("history", await store.getHistory(room));
    } catch (err) {
      console.error("Verlauf nicht ladbar:", err.message);
      socket.emit("history", []);
    }
    socket.to(room).emit("system", { type: "joined", name: me.name });
  });

  /* Nur das Ergebnis der Mitschrift, nie ihr Inhalt: Fehlerkuerzel,
     Zeichenzahl, Zahl der Neustarts. */
  socket.on("speechInfo", (info) => {
    /* Die Meldungen kommen einzeln herein - Start, Ton, Fehler, Ende.
       Zurueckgesetzt wird beim Beginn einer Aufnahme ("neu"), danach
       wird ergaenzt. Wuerde das Ende zuruecksetzen, gingen Start und
       Fehler genau dann verloren, wenn sie gebraucht werden. */
    const vorher = info?.neu ? {} : (lastSpeech || {});
    lastSpeech = {
      diktat: Boolean(info?.diktat || vorher.diktat),
      gestartet: Boolean(info?.gestartet || vorher.gestartet),
      tonAn: Boolean(info?.tonAn || vorher.tonAn),
      error: info?.error ? String(info.error).slice(0, 40) : (vorher.error || null),
      ende: Boolean(info?.ende),
      zeichen: Number(info?.zeichen) || vorher.zeichen || 0,
      laeufe: Number(info?.laeufe) || vorher.laeufe || 0,
      ergebnisse: Number(info?.ergebnisse) || vorher.ergebnisse || 0,
      form: info?.form ? String(info.form).slice(0, 100) : (vorher.form || null),
      feld: Number(info?.feld) || vorher.feld || 0,
      at: new Date().toISOString(),
    };
  });

  socket.on("setLang", ({ lang }) => {
    me.lang = clean(lang);
  });

  socket.on("send", async ({ text, replyTo }) => {
    if (!room || !text?.trim()) return;
    if (!take(`msg:${me.device}`, MSG_PER_MIN, 60 * 1000)) {
      socket.emit("tooFast");
      return;
    }
    if (!internSock) zaehle("nachricht");
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      room,
      device: me.device,
      name: me.name,
      text: text.trim().slice(0, 4000),
      lang: me.lang,
      detected: false,
      tr: {},
      replyTo: replyTo ? String(replyTo).slice(0, 60) : null,
      at: Date.now(),
    };
    try {
      await store.addMessage(msg);
    } catch (err) {
      console.error("Nachricht nicht speicherbar:", err.message);
      socket.emit("translationError", { id: msg.id, lang: me.lang });
      return;
    }
    io.to(room).emit("message", msg);
    pushToRoom(room, msg).catch((e) => console.error("Push-Lauf:", e.message));
  });

  /* Standort teilen: kein Text, nur Koordinaten. Wird als antippbare
     Karte gezeigt und in der Karten-App des Empfaengers geoeffnet. Auf
     sechs Nachkommastellen gerundet - das reicht metergenau und speichert
     nicht mehr als noetig. */
  socket.on("sendOrt", async ({ lat, lng }) => {
    if (!room) return;
    const la = Number(lat), lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) ||
        la < -90 || la > 90 || lo < -180 || lo > 180) return;
    if (!take(`msg:${me.device}`, MSG_PER_MIN, 60 * 1000)) { socket.emit("tooFast"); return; }
    if (!internSock) zaehle("nachricht");
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      room, device: me.device, name: me.name,
      text: "", lang: me.lang, detected: false, tr: {},
      ort: { lat: Math.round(la * 1e6) / 1e6, lng: Math.round(lo * 1e6) / 1e6 },
      at: Date.now(),
    };
    try {
      await store.addMessage(msg);
    } catch (err) {
      console.error("Standort nicht speicherbar:", err.message);
      socket.emit("translationError", { id: msg.id, lang: me.lang });
      return;
    }
    io.to(room).emit("message", msg);
    pushToRoom(room, msg).catch((e) => console.error("Push-Lauf:", e.message));
  });

  /* Lesebestaetigung: jemand hat den Chat offen und alles bis "bis"
     gesehen. Nur an die anderen im Raum weiterreichen (nicht zurueck an
     den Melder), damit deren eigene Nachrichten die Lese-Haken bekommen.
     Bewusst fluechtig - nichts wird gespeichert. */
  socket.on("gelesen", ({ bis }) => {
    if (!room) return;
    const t = Number(bis);
    if (!Number.isFinite(t)) return;
    socket.to(room).emit("gelesen", { device: me.device, bis: t });
  });

  /* Loeschen fuer alle. Nur die eigene Nachricht - geprueft wird am
     Geraet, das sie geschrieben hat, nicht an dem, was der Browser
     behauptet zu duerfen. */
  socket.on("deleteForAll", async ({ id }) => {
    /* Haelt fest, dass ueberhaupt jemand geklopft hat - sonst laesst
       sich "kam nie an" nicht von "war nicht erlaubt" unterscheiden. */
    letzterLoeschVersuch = { id: String(id || "?").slice(0, 40), raum: Boolean(room),
                             geraet: String(me.device || "?").slice(0, 12),
                             at: new Date().toISOString() };
    if (!room || !id) return;
    try {
      const ok = await store.deleteForAll(String(id), me.device);
      if (ok) { letzterLoeschVersuch.ergebnis = "geloescht";
                io.to(room).emit("deleted", { id: String(id) }); }
      /* Nicht geloescht heisst: fremde Nachricht oder schon weg. Auch
         das gehoert zurueckgemeldet, sonst tippt jemand ins Leere. */
      else { letzterLoeschVersuch.ergebnis = "nicht erlaubt";
             socket.emit("deleteFailed", { id: String(id), grund: "nicht erlaubt" }); }
    } catch (err) {
      console.error("Loeschen fehlgeschlagen:", err.message);
      letzterLoeschFehler = err.message.slice(0, 200);
      socket.emit("deleteFailed", { id: String(id), grund: "Fehler" });
    }
  });

  socket.on("need", ({ id, lang }) => {
    if (!room) return;
    /* Nachfragen sind meist billig - beim Sprachwechsel holt der Browser
       den ganzen Verlauf auf einmal nach. Die Grenze faengt nur den Fall
       ab, dass jemand das Ereignis von Hand in Schleife schickt. */
    if (!take(`need:${me.device}`, NEED_PER_MIN, 60 * 1000)) return;
    ensure(room, id, clean(lang)).catch(() => {});
  });

  /* Text im Bild uebersetzen - auf Anfrage. Strenger begrenzt als need,
     weil ein Bildaufruf das Modell mehr kostet. */
  socket.on("bildText", ({ id, lang }) => {
    if (!room || !id) return;
    if (!take(`bildtext:${me.device}`, 12, 60 * 1000)) return;
    uebersetzeBildText(room, String(id), clean(lang)).catch(() => {});
  });

  /* Probe-Chat: ein KI-Partner, damit ein Besucher die Uebersetzung allein
     erleben kann, ohne dass schon jemand da ist. Bewusst schlank - eine
     Antwort in der Partnersprache samt ihrer Uebersetzung in die Sprache
     des Besuchers, in einem Zug. Nur zum Ausprobieren; echte Chats laufen
     ueber "send". */
  socket.on("demo", async ({ text, meLang, partnerLang, first }) => {
    const my = clean(meLang);
    const partner = clean(partnerLang);
    /* Strenger als normale Nachrichten - jede Runde kostet eine KI-Antwort. */
    if (!take(`demo:${me.device || ip}`, 12, 60 * 1000)) { socket.emit("demoFehler"); return; }
    if (!take("demo:day", DEMO_PER_DAY, 24 * 60 * 60 * 1000)) { socket.emit("demoFehler"); return; }
    /* Nur der Start zaehlt (die Begruessung), nicht jede einzelne Runde -
       so steht im Admin "wie viele haben die Demo ausprobiert". Eigene
       Tests bleiben wie ueberall draussen. */
    if (first && !internSock) await store.zaehle("demo").catch(() => {});
    const partnerName = LANG_NAMES[partner] || partner;
    const myName = LANG_NAMES[my] || my;
    const nutzer = first
      ? "(Der Besucher hat den Probe-Chat gerade geoeffnet und noch nichts geschrieben. Begruesse ihn kurz und warm.)"
      : String(text || "").slice(0, 800);
    const prompt = `Du spielst einen warmherzigen, neugierigen Chat-Partner in einer Uebersetzungs-App - fuer einen Probe-Chat, damit ein neuer Nutzer die App ausprobieren kann. Antworte natuerlich und locker, wie eine echte Person in einem Chat, in EINEM kurzen Satz (hoechstens ~15 Woerter). Sei freundlich und stelle gern eine leichte Rueckfrage. Erwaehne nie, dass du eine KI bist. Schreibe deine Antwort auf ${partnerName} (${partner}).
Der Nutzer schreibt auf ${myName} (${my}). Seine Nachricht: """${nutzer}"""
Antworte NUR mit JSON, ohne Markdown: {"reply":"<deine Antwort auf ${partner}>","translation":"<dieselbe Antwort auf ${my}>"}`;
    try {
      const { result: out, usage } = await claude(prompt);
      /* Unter eigenem Kuerzel, damit sich die Demo-Kosten im Admin von den
         echten Uebersetzungen trennen lassen. */
      store.logUsage({
        room: "__demo__", target: my, chars: String(out.reply || "").length,
        inTokens: usage.inTokens, outTokens: usage.outTokens,
      }).catch((e) => console.error("Verbrauch (Demo) nicht speicherbar:", e.message));
      socket.emit("demoAntwort", {
        text: String(out.reply || "").slice(0, 500),
        tr: { [my]: String(out.translation || out.reply || "").slice(0, 500) },
        lang: partner,
      });
    } catch (err) {
      console.error("Demo fehlgeschlagen:", err.message);
      socket.emit("demoFehler");
    }
  });

  socket.on("disconnect", () => {
    if (room) socket.to(room).emit("system", { type: "left", name: me.name });
  });
});

/* ------------------------------- Start ------------------------------- */
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === "IPv4" && !iface.internal) return iface.address;
  }
  return null;
}

await store.init().catch((err) => {
  console.error("  Datenbank nicht erreichbar:", err.message);
});

/* Aufbewahrungsfrist durchsetzen: beim Start und danach stuendlich. */
async function purge() {
  if (!(RETENTION_DAYS > 0)) return;
  try {
    const n = await store.purgeOlderThan(RETENTION_DAYS);
    if (n) console.log(`  ${n} Nachricht(en) aelter als ${RETENTION_DAYS} Tage geloescht.`);
  } catch (err) {
    console.error("  Aufraeumen fehlgeschlagen:", err.message);
  }
}
purge();
setInterval(purge, 60 * 60 * 1000).unref();

http.listen(PORT, "0.0.0.0", async () => {
  const lan = lanAddress();
  console.log(`\n  Diralo laeuft.\n`);
  console.log(`  Auf diesem Rechner:  http://localhost:${PORT}`);
  if (lan) {
    const url = `http://${lan}:${PORT}`;
    console.log(`  Auf Handys im WLAN:  ${url}\n`);
    try {
      const qr = (await import("qrcode-terminal")).default;
      qr.generate(url, { small: true });
      console.log(`  QR-Code mit der Handykamera scannen.\n`);
    } catch {
      console.log(`  Diese Adresse auf beiden Handys im Browser oeffnen.\n`);
    }
  }
  if (!API_KEY) console.log("  WARNUNG: ANTHROPIC_API_KEY fehlt - es wird nicht uebersetzt.");
  if (!pushReady) console.log("  Hinweis: VAPID-Schluessel fehlen - Push bei geschlossener App ist aus.");
  if (!store.usingDatabase) console.log("  Hinweis: keine Datenbank - Nachrichten sind nach Neustart weg.");
  console.log(gateOn ? "  Zugangswort ist aktiv." : "  Hinweis: kein ACCESS_CODE - die App ist oeffentlich erreichbar.");
  console.log(RETENTION_DAYS > 0
    ? `  Nachrichten werden nach ${RETENTION_DAYS} Tagen geloescht.`
    : "  Hinweis: RETENTION_DAYS=0 - Nachrichten bleiben unbegrenzt liegen.");
  console.log(TRANSLATIONS_PER_DAY > 0
    ? `  Bremse: ${MSG_PER_MIN} Nachrichten je Minute und Geraet, ${TRANSLATIONS_PER_DAY} Uebersetzungen am Tag.`
    : `  Bremse: ${MSG_PER_MIN} Nachrichten je Minute und Geraet. WARNUNG: keine Tagesgrenze fuer Uebersetzungen.`);
  console.log("");
});
