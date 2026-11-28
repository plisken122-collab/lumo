import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import os from "os";
import crypto from "crypto";
import webpush from "web-push";
import * as stimme from "./sprache.js";
import * as store from "./store.js";
import * as geld from "./bezahlung.js";
import * as play from "./playkasse.js";
import * as anruf from "./anruf.js";
import * as gruppe from "./gruppe.js";
import * as lernpush from "./lernpush.js";
import * as mitschrift from "./mitschrift.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* Letztes Auffangnetz: Ein Fehler, den niemand abfaengt, darf nie den
   ganzen Server beenden - sonst reicht ein kaputtes Paket von aussen,
   und Diralo ist fuer alle weg. Protokollieren und weiterlaufen. */
process.on("unhandledRejection", (err) => console.error("Unbehandelt (Promise):", err?.message || err));
process.on("uncaughtException", (err) => console.error("Unbehandelt:", err?.message || err));

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
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.klipy.com https://media.tenor.com https://*.giphy.com",
    "media-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  /* HTTPS erzwingen: Hat der Browser die Seite einmal ueber HTTPS gesehen,
     geht er ein Jahr lang nie wieder ueber HTTP hin - das verhindert ein
     Herunterstufen der Verbindung. Nur ueber HTTPS senden (hinter dem
     Render-Proxy steht das in x-forwarded-proto); ueber HTTP ignorieren
     Browser den Header ohnehin, aber so bleibt lokales http sauber. */
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
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
  if (req.path === "/api/voice" || req.path === "/api/bild" || req.path === "/api/foto-text" || req.path === "/api/datei") return next();
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
  "/api/raeume", "/api/raum-dazu", "/api/raum-weg",
  /* Kaeufe aus der Android-App, und die Datei, an der Android erkennt,
     dass App und Seite zusammengehoeren. Beide fragt kein Browser mit
     Cookie ab. */
  "/api/play-kauf", "/.well-known/assetlinks.json"]);
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
const raumCode = (r) => String(r || "").trim().toLowerCase().replace(/[<>"'`&\\]/g, "").slice(0, 60);

/* Wer aus einer Gruppe entfernt wurde, darf auch ueber diese Wege nichts
   mehr hineinschicken, keine Anrufe starten und keine Push-Nachrichten
   fuer den Chat abonnieren. Raum und Geraet stehen im Inhalt oder - bei
   Dateien - in der Adresse. */
const RAUM_WEGE = ["/api/voice", "/api/bild", "/api/gif", "/api/datei", "/api/anruf", "/api/subscribe", "/api/expo-push"];
async function entfernteSperren(req, res, next) {
  if (req.method !== "POST") return next();
  try {
    const q = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : (req.query || {});
    const geraet = String(q.device || "").slice(0, 60);
    if (!geraet) return next();
    if (q.room && !(await gruppe.darfRein(raumCode(q.room), geraet))) {
      return res.status(403).json({ error: "Aus diesem Chat entfernt" });
    }
    if (Array.isArray(q.rooms)) {
      const erlaubt = [];
      for (const r of q.rooms.slice(0, 60)) if (await gruppe.darfRein(raumCode(r), geraet)) erlaubt.push(r);
      q.rooms = erlaubt;
    }
  } catch {}
  next();
}
/* Sprachnachricht und Bild lesen ihren Inhalt erst in der Route - dort
   steht die Pruefung direkt. Fuer die anderen reicht es hier. */
app.use(RAUM_WEGE.filter((w) => w !== "/api/voice" && w !== "/api/bild"), entfernteSperren);

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
/* "gekuendigt" gehoert dazu: bezahlt ist bezahlt, der Tarif gilt bis
   zum Ende des Zeitraums. Erst "canceled" nimmt ihn weg. */
const LAEUFT = ["active", "trialing", "past_due", "gekuendigt"];
const laeuftNoch = (abo) => Boolean(abo && (LAEUFT.includes(abo.status)
  || (abo.status === "bonus" && Number(abo.period_end) > Date.now())));

/* --------------------------- Einlade-Bonus ---------------------------
   Wer jemanden einlaedt und die Person schreibt wirklich mit, bekommt
   fuer diesen Chat einen Monat Diralo Plus - beide profitieren, denn
   das Kontingent haengt am Chat. Bedingungen gegen Missbrauch:
   - zwei verschiedene Geraete mit je mindestens 2 Nachrichten,
   - der Chat hat noch nie ein Abo oder einen Bonus gehabt,
   - je einladendem Geraet hoechstens ein Bonus in 30 Tagen,
   - hoechstens BONUS_PRO_TAG Boni am Tag insgesamt. */
const BONUS_TAGE = Number(process.env.BONUS_TAGE || 30);
const bonusGeprueft = new Map();   // room -> zuletzt geprueft (ms) | "fertig"
const bonusSpaeter = new Map();    // room -> Timer fuer die verschobene Pruefung
async function einladeBonus(room) {
  if (process.env.BONUS_AUS === "1") return;
  const r = String(room || "").toLowerCase();
  if (!r || r.startsWith("demo-") || OHNE_GRENZE.has(r)) return;
  const stand = bonusGeprueft.get(r);
  if (stand === "fertig") return;
  /* Hoechstens alle 5 s pruefen - aber nichts verschlucken: Kam die
     Nachricht zu frueh, wird spaeter noch einmal nachgesehen. */
  if (stand && Date.now() - stand < 5000) {
    if (!bonusSpaeter.has(r)) {
      bonusSpaeter.set(r, setTimeout(() => { bonusSpaeter.delete(r); bonusGeprueft.delete(r); einladeBonus(r).catch(() => {}); }, 5000));
    }
    return;
  }
  bonusGeprueft.set(r, Date.now());
  try {
    if (await store.getAboByRoom(r)) { bonusGeprueft.set(r, "fertig"); return; }
    const verlauf = await store.getHistory(r, 80);
    const je = new Map();
    for (const m of verlauf) {
      if (!m.device || String(m.device).startsWith("test_") || m.deleted) continue;
      je.set(m.device, (je.get(m.device) || 0) + 1);
    }
    const aktiv = [...je.entries()].filter(([, n]) => n >= 2).map(([d]) => d);
    if (aktiv.length < 2) return;
    /* Einladender = wer im Chat zuerst geschrieben hat. */
    const einlader = verlauf.find((m) => aktiv.includes(m.device))?.device;
    if (!einlader) return;
    if (await store.bonusAnzahl(einlader, Date.now() - 30 * 24 * 60 * 60 * 1000) > 0) { bonusGeprueft.set(r, "fertig"); return; }
    if (!take("bonus:tag", Number(process.env.BONUS_PRO_TAG || 30), 24 * 60 * 60 * 1000)) return;
    const id = "bonus_" + r;
    await store.saveAbo({ id, plan: "plus", status: "bonus", customer: einlader, period_end: Date.now() + BONUS_TAGE * 24 * 60 * 60 * 1000 });
    if (!(await store.raumHinzufuegen(id, r))) { bonusGeprueft.set(r, "fertig"); return; }
    bonusGeprueft.set(r, "fertig");
    planZwischen.delete(r);
    io.to(r).emit("bonus", { tage: BONUS_TAGE, plan: "plus" });
    console.log("  Einlade-Bonus vergeben.");
  } catch (err) {
    console.error("Einlade-Bonus:", err.message);
  }
}

/* Personen-Grenze der Team-Tarife: null, wenn der Chat keine hat. */
async function teamGrenze(room) {
  const abo = await store.getAboByRoom(room);
  if (!laeuftNoch(abo)) return null;
  const grenze = geld.PERSONEN?.[abo.plan];
  return grenze ? { grenze, raeume: await store.raeumeVonAbo(abo.id) } : null;
}

async function kontingent(room) {
  let abo = await store.getAboByRoom(room);
  if (play.istPlay(abo)) abo = await playAuffrischen(abo);
  const laeuft = laeuftNoch(abo);
  const plan = laeuft ? abo.plan : "frei";
  const raeume = laeuft ? await store.raeumeVonAbo(abo.id) : [room];
  return {
    plan,
    bezahlt: Boolean(laeuft),
    ausPlay: play.istPlay(abo),
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
  if (!take(`plan:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({ error: "Zu viele Anfragen" });
  try {
    const k = await kontingent(room);
    /* Ueber alle Chats des Abos zusammen - sie teilen sich das Kontingent. */
    const benutzt = await store.translationsThisMonthForRooms(k.raeume);
    res.json({
      /* Nie die Chat-Codes des Abos herausgeben - wer einen Chat kennt,
         kaeme sonst in alle. Nur die Anzahl. */
      ...k, raeume: undefined, chats: k.raeume.length,
      benutzt, rest: Math.max(0, k.grenze - benutzt),
      bezahlungAn: geld.bezahlungAn,
      plaetzeFrei: Math.max(0, k.plaetze - k.raeume.length),
      /* Welche Tarife wirklich hinterlegt sind. Ohne diese Angabe zeigt
         die Preisseite einen Knopf, der beim Druecken absagt. */
      tarife: geld.verfuegbar(),
      kontingente: geld.KONTINGENT,
      /* In der Android-App wird ueber Google Play gekauft. Die Seite
         braucht die Produktnamen, um Preise und Kauf bei Google anzufragen. */
      play: { an: play.playAn, produkte: play.PRODUKTE },
      herkunft: k.bezahlt ? (k.ausPlay ? "play" : "stripe") : null,
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
  let vorher = await store.getAboBySubscription(abosNr);
  if (!vorher) {
    /* Das Abo am Chat nur uebernehmen, wenn es kein fremdes, laufendes
       Abo ist - sonst schriebe ein Fremder, der den Chat-Code kennt, mit
       seinem Kauf einen neuen Verwaltungsschluessel in das Abo des Opfers. */
    const amRaum = await store.getAboByRoom(room);
    if (amRaum && (!amRaum.subscription || amRaum.subscription === abosNr || !laeuftNoch(amRaum))) vorher = amRaum;
  }
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
  const abo = await aboMitSchluessel(req, res);
  if (!abo) return;
  /* Ein Abo aus Google Play kuendigt man nur bei Google. */
  if (play.istPlay(abo)) return res.json({ url: play.verwaltungsAdresse() });
  if (!geld.bezahlungAn) return res.status(503).json({ error: "Bezahlung ist aus." });
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

/* ------------------------- Kaeufe aus Google Play -------------------------
   Die Android-App kauft ueber Google und schickt uns danach den Beleg
   (purchaseToken). Freigeschaltet wird erst, wenn Google ihn bestaetigt.

   Kennt nur, wer gekauft hat: Der Beleg ist fuer Play, was die Kennung
   des Kassengangs fuer Stripe ist. Deshalb gibt es hier - und nur hier -
   einen frischen Verwaltungsschluessel.

   still: Die Preisseite gleicht beim Oeffnen die Kaeufe des Geraets ab,
   falls nach einem Kauf die Verbindung abriss. Dabei soll ein bekanntes
   Abo nicht bei jedem Oeffnen einen neuen Schluessel bekommen.
------------------------------------------------------------------------- */
app.post("/api/play-kauf", async (req, res) => {
  if (!play.playAn) return res.status(503).json({ error: "Google Play ist noch nicht eingerichtet." });
  if (!take(`play:${req.ip}`, 20, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Zu viele Versuche. Spaeter nochmal." });
  }

  const room = raumCode(req.body?.room);
  const token = String(req.body?.token || "").trim();
  const still = req.body?.still === true;
  if (!token || token.length > 1000 || !/^[A-Za-z0-9._-]+$/.test(token)) {
    return res.status(400).json({ error: "Unbrauchbarer Beleg" });
  }

  let kauf;
  try {
    kauf = await play.kaufLesen(token);
  } catch (err) {
    letzterGeldFehler = "Play: " + err.message.slice(0, 150);
    if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) {
      return res.status(400).json({ error: "Google kennt diesen Kauf nicht." });
    }
    return res.status(502).json({ error: "Google antwortet gerade nicht." });
  }
  if (kauf.wartet) return res.json({ fertig: false, wartet: true });
  if (!kauf.plan) return res.status(400).json({ error: "Gehoert nicht zu Diralo" });

  /* Quittieren, sonst erstattet Google nach drei Tagen. Klappt es jetzt
     nicht, holt es der naechste Abgleich beim Oeffnen der Preisseite nach -
     deshalb hier kein Abbruch. */
  if (!kauf.quittiert) {
    try { await play.quittieren(kauf.produkt, token); }
    catch (err) { letzterGeldFehler = "Play quittieren: " + err.message.slice(0, 150); }
  }

  try {
    const nr = play.VORSILBE + token;
    const vorher = (await store.getAboBySubscription(nr))
      || (kauf.vorgaenger ? await store.getAboBySubscription(play.VORSILBE + kauf.vorgaenger) : null);

    let schluessel = null;
    if (!vorher || !still) schluessel = geld.neuerVerwaltungsSchluessel();

    const id = vorher?.id || store.neueAboId();
    await store.saveAbo({
      id, plan: kauf.plan, status: kauf.status,
      subscription: nr,
      manage_key: schluessel ? geld.schluesselAbdruck(schluessel) : null,
      period_end: kauf.ende,
    });

    /* Den Chat dazunehmen, fuer den gekauft wurde - wenn noch Platz ist.
       Haengt er an einem abgelaufenen Abo, darf er umziehen; an einem
       laufenden bleibt er, dann ordnet der Kaeufer in der Verwaltung zu. */
    let dazu = false;
    if (room) {
      const belegt = await store.getAboByRoom(room);
      if (belegt && belegt.id !== id && !laeuftNoch(belegt)) await store.raumEntfernen(belegt.id, room);
      const raeume = await store.raeumeVonAbo(id);
      if (raeume.includes(room)) dazu = true;
      else if (raeume.length < (geld.PLAETZE[kauf.plan] ?? 1)) dazu = await store.raumHinzufuegen(id, room);
    }

    frischeZahlen(await store.raeumeVonAbo(id));
    res.json({ fertig: true, room: dazu ? room : null, plan: kauf.plan, schluessel });
  } catch (err) {
    console.error("  Play-Kauf nicht eingetragen:", err.message);
    letzterGeldFehler = "Play eintragen: " + err.message.slice(0, 150);
    res.status(500).json({ error: "Konnte den Kauf nicht eintragen." });
  }
});

/* Laeuft ein Play-Abo noch? Google meldet Verlaengerungen und
   Kuendigungen nicht von selbst (dafuer braeuchte es Pub/Sub). Stattdessen
   wird nachgefragt, sobald der bezahlte Zeitraum vorbei ist - hoechstens
   alle zehn Minuten je Abo, damit eine klemmende Google-Schnittstelle
   nicht jede Uebersetzung ausbremst. */
const playNachgefragt = new Map(); // abo_id -> Zeitpunkt

async function playAuffrischen(abo) {
  if (!play.playAn || abo.status === "canceled") return abo;
  const ende = Number(abo.period_end) || 0;
  if (ende && Date.now() < ende) return abo;
  if (Date.now() - (playNachgefragt.get(abo.id) || 0) < 10 * 60 * 1000) return abo;
  playNachgefragt.set(abo.id, Date.now());

  try {
    const kauf = await play.kaufLesen(abo.subscription.slice(play.VORSILBE.length));
    const neu = await store.saveAbo({
      id: abo.id, plan: kauf.plan || abo.plan, status: kauf.status,
      subscription: abo.subscription, period_end: kauf.ende,
    });
    frischeZahlen(await store.raeumeVonAbo(abo.id));
    return neu || abo;
  } catch (err) {
    letzterGeldFehler = "Play nachfragen: " + err.message.slice(0, 150);
    return abo;
  }
}

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
/* Schritte in der Android-App (ab Version 19): Wo hoeren neue Nutzer
   auf? Je Geraet und Tag hoechstens einmal - nur "ist passiert", keine
   Inhalte, keine Kennung in der Datenbank. */
const SCHRITTE = ["a_start", "a_ohne_name", "a_name", "a_chat", "a_dolmetsch", "a_foto", "a_text",
  "a_kurz", "a_mittel", "a_lang"];
const ZAEHLBAR = new Set(["besuch", "eingetreten", "nachricht", "einladung", "ueber_link", "uebersetzt",
  "app_start", "dolmetsch", "foto", "text", "hilfe_person", ...SCHRITTE]);

/* Einmal pro Tag und Geraet (bzw. Adresse) zaehlen - fuer "App geoeffnet"
   und "hat eine Hilfe benutzt". Gemerkt wird nur ein gekuerzter Hash bis
   Mitternacht, danach ist die Liste leer. */
const tagesMerker = { tag: "", gesehen: new Set() };
function einmalHeute(art, wer) {
  const heute = new Date().toISOString().slice(0, 10);
  if (tagesMerker.tag !== heute) { tagesMerker.tag = heute; tagesMerker.gesehen.clear(); }
  const k = art + ":" + crypto.createHash("sha256").update(String(wer)).digest("hex").slice(0, 16);
  if (tagesMerker.gesehen.has(k) || tagesMerker.gesehen.size > 50000) return false;
  tagesMerker.gesehen.add(k);
  return true;
}

/* Dolmetscher, Foto und Text: jede gelungene Nutzung zaehlen, dazu
   einmal pro Tag die Person. Eigene Geraete zaehlen nicht. */
function zaehleHilfe(art, req) {
  const device = String(req.body?.device || "");
  if (EIGEN.geraete.has(device)) eigenAktiv(device, art);
  if (EIGEN.geraete.has(device) || istIntern(req)) return;
  zaehle(art);
  if (einmalHeute("hilfe", device || req.ip)) zaehle("hilfe_person");
}

/* Nachrichten, die mindestens einmal uebersetzt wurden - je Nachricht nur
   einmal, egal in wie viele Sprachen. "Nachricht" minus "uebersetzt" sind
   die Nachrichten ohne Uebersetzung (gleiche Sprache, nur Smileys, oder
   noch von niemandem in einer anderen Sprache gelesen). Eigene Geraete
   und Demo zaehlen nicht mit. */
const schonUebersetztGezaehlt = new Set();
function zaehleUebersetzt(msg) {
  if (!msg?.id || schonUebersetztGezaehlt.has(msg.id)) return;
  if (EIGEN.geraete.has(msg.device) || String(msg.room).startsWith("demo-")) return;
  if (schonUebersetztGezaehlt.size > 5000) schonUebersetztGezaehlt.clear();
  schonUebersetztGezaehlt.add(msg.id);
  if (Object.keys(msg.tr || {}).length) return;
  zaehle("uebersetzt");
}

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

/* --------------------------------------------------------------------
   Herkunft (getaggte Links)

   Kommt jemand ueber diralo.app/?von=reddit, merken wir uns "reddit" in
   einem Cookie und zaehlen die Stufen dieser Quelle getrennt (Besuch,
   Demo, Eintritt, Nachricht). So laesst sich sehen, welcher Kanal wirklich
   Nutzer bringt - nicht bloss Besuche, die man von Werbung nicht trennen
   kann. Der Name wird auf harmlose Zeichen begrenzt; nichts Persoenliches.
-------------------------------------------------------------------- */
const VON_COOKIE = "diralo_von";
const quelleTag = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
const istQuelle = (req) => quelleTag(cookieValue(req, VON_COOKIE));
function vonSetzen(res, tag, secure) {
  res.setHeader(
    "Set-Cookie",
    `${VON_COOKIE}=${tag}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}
/* Zaehlt eine Quellen-Stufe als Ereignis "q:<quelle>:<stufe>". Faellt die
   Datenbank aus, ist es gleichgueltig - darf nie den Betrieb stoeren. */
function zaehleQuelle(tag, stufe) {
  if (!tag) return;
  store.zaehle(`q:${tag}:${stufe}`).catch(() => {});
}

/* Kurze Adressen zum Abtippen (TikTok/Instagram-Bio ist nicht klickbar):
   diralo.app/tt -> /?von=tiktok usw. So erscheint die Quelle im Admin. */
const KURZ = { tt: "tiktok", tiktok: "tiktok", ig: "instagram", insta: "instagram", fb: "facebook", yt: "youtube" };
/* Android-Handys gehen direkt in den Play Store - dort ist "Installieren"
   ein Tipp. Gezaehlt wird trotzdem: Besuch + Stufe "store" fuer die Quelle.
   Vorschau-Bots (Facebook, WhatsApp ...) zaehlen nicht. */
const PLAY_LINK = "https://play.google.com/store/apps/details?id=app.diralo.twa";
const VORSCHAU_BOT = /bot|crawler|spider|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|preview/i;
/* Mit Sprache: diralo.app/fb/ne -> Seite und Play Store auf Nepali. */
app.get(/^\/(tt|tiktok|ig|insta|fb|yt)(?:\/([a-z]{2,3}(?:-[a-z0-9]{2,3})?))?\/?$/i, (req, res) => {
  const tag = KURZ[req.params[0].toLowerCase()];
  const sprache = req.params[1] ? req.params[1].toLowerCase().replace(/-([a-z0-9]+)$/, (_, r) => "-" + r.toUpperCase()) : "";
  const ua = String(req.headers["user-agent"] || "");
  if (/android/i.test(ua) && !VORSCHAU_BOT.test(ua) && req.query.web === undefined) {
    if (!istIntern(req)) {
      zaehle("besuch");
      zaehleQuelle(tag, "besuch");
      zaehleQuelle(tag, "store");
    }
    const ref = encodeURIComponent(`utm_source=${tag}&utm_medium=kurzlink`);
    const hl = sprache ? `&hl=${encodeURIComponent(sprache)}` : "";
    return res.redirect(302, `${PLAY_LINK}${hl}&referrer=${ref}`);
  }
  res.redirect(302, "/?von=" + tag + (sprache ? "&lang=" + encodeURIComponent(sprache) : ""));
});

/* Ohne Tag, aber von einer Social-App verlinkt? Dann die Quelle aus dem
   Referer ableiten, damit auch abgetippte/geteilte Links zaehlen. */
function quelleAusReferer(req) {
  const r = String(req.headers.referer || "").toLowerCase();
  if (r.includes("tiktok.com")) return "tiktok";
  if (r.includes("instagram.com")) return "instagram";
  if (r.includes("facebook.com") || r.includes("fb.com")) return "facebook";
  if (r.includes("youtube.com")) return "youtube";
  return "";
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
  /* Ueber einen getaggten Link gekommen (?von=reddit)? Quelle merken und
     ihren Besuch getrennt zaehlen. */
  const vonRef = req.query.von === undefined && !istQuelle(req) ? quelleAusReferer(req) : "";
  if ((req.query.von !== undefined || vonRef) && !istIntern(req)) {
    const tag = quelleTag(req.query.von !== undefined ? req.query.von : vonRef);
    if (tag) {
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
      vonSetzen(res, tag, secure);
      zaehleQuelle(tag, "besuch");
    }
  }
  if (!istIntern(req)) zaehle("besuch");
  res.type("html").send(startseite(""));
});

/* --------------------------------------------------------------------
   Sprachseiten fuer Google

   diralo.app/pt/, /es/, /de/ sind dieselbe Startseite, aber mit Titel,
   Beschreibung und Sprache im Kopf - so findet Google Diralo auch auf
   Portugiesisch, Spanisch und Deutsch. Die Fassungen verweisen
   gegenseitig aufeinander (hreflang); Englisch ist die Hauptadresse.
-------------------------------------------------------------------- */
const SEITEN = {
  "": { html: "en", app: "", pfad: "/",
    titel: "Diralo – Free Interpreter, Photo and Chat Translator",
    text: "Talk to anyone in your own language: a live interpreter for conversations, translate photos and texts, and chat with automatic translation. Free Android app and web app." },
  pt: { html: "pt-PT", app: "pt-PT", pfad: "/pt/",
    titel: "Diralo – Intérprete, Tradutor de Fotos e Chat Grátis",
    text: "Fale com qualquer pessoa na sua língua: intérprete ao vivo para conversas, tradução de fotos e textos e chat com tradução automática. App Android grátis e na web." },
  es: { html: "es", app: "es", pfad: "/es/",
    titel: "Diralo – Intérprete, Traductor de Fotos y Chat Gratis",
    text: "Habla con cualquiera en tu idioma: intérprete en vivo para conversaciones, traduce fotos y textos y chatea con traducción automática. App Android gratis y en la web." },
  de: { html: "de", app: "de", pfad: "/de/",
    titel: "Diralo – Kostenloser Dolmetscher, Foto- und Chat-Übersetzer",
    text: "Sprich mit jedem in deiner Sprache: Live-Dolmetscher für Gespräche, Fotos und Texte übersetzen und Chat mit automatischer Übersetzung. Kostenlose Android-App und im Browser." },
};
const SEITE_BASIS = "https://diralo.app";
let indexVorlage = null;
const seitenCache = new Map();
function startseite(k) {
  if (seitenCache.has(k)) return seitenCache.get(k);
  if (!indexVorlage) indexVorlage = readFileSync(join(__dirname, "public", "index.html"), "utf8");
  const s = SEITEN[k], en = SEITEN[""];
  const url = SEITE_BASIS + s.pfad;
  const attr = (x) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const alternativen = Object.values(SEITEN).map((x) =>
    `<link rel="alternate" hreflang="${x.html === "en" ? "en" : x.html.slice(0, 2)}" href="${SEITE_BASIS}${x.pfad}">`).join("\n") +
    `\n<link rel="alternate" hreflang="x-default" href="${SEITE_BASIS}/">`;
  const app = {
    "@context": "https://schema.org", "@type": "SoftwareApplication",
    name: "Diralo", description: s.text, url, inLanguage: s.html,
    operatingSystem: "Android, Web", applicationCategory: "CommunicationApplication",
    installUrl: "https://play.google.com/store/apps/details?id=app.diralo.twa",
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  };
  let h = indexVorlage
    .replace('<html lang="en">', `<html lang="${s.html}">`)
    .split(en.titel).join(attr(s.titel))
    .split(en.text).join(attr(s.text))
    .replace('<link rel="canonical" href="https://diralo.app/">', `<link rel="canonical" href="${url}">`)
    .replace('<meta property="og:url" content="https://diralo.app/">', `<meta property="og:url" content="${url}">`)
    .replace("</head>", alternativen + "\n" +
      `<script type="application/ld+json">${JSON.stringify(app).replace(/</g, "\\u003c")}</script>\n` +
      (s.app ? `<script>window.SEITEN_SPRACHE = ${JSON.stringify(s.app)};</script>\n` : "") + "</head>");
  seitenCache.set(k, h);
  return h;
}
app.get(/^\/(pt|es|de)\/?$/, (req, res) => {
  if (!req.path.endsWith("/")) return res.redirect(301, req.path + "/");
  if (!istIntern(req)) zaehle("besuch");
  res.type("html").send(startseite(req.params[0]));
});
app.get(/^\/en\/?$/, (_req, res) => res.redirect(301, "/"));

/* Zwei Dinge weiss nur der Browser: ob jemand ueber einen Einladungslink
   kam und ob er auf Einladen gedrueckt hat. */
app.post("/api/zaehl", (req, res) => {
  if (!take(`zaehl:${req.ip}`, 60, 60 * 1000)) return res.status(429).end();
  const e = String(req.body?.ereignis || "");
  if (!istIntern(req) && (e === "einladung" || e === "ueber_link")) zaehle(e);
  res.status(204).end();
});

/* Schritte aus der Android-App (siehe SCHRITTE). Eigene Geraete und
   interne Aufrufe zaehlen nicht. */
app.post("/api/schritt", (req, res) => {
  if (!take(`schritt:${req.ip}`, 60, 60 * 1000)) return res.status(429).end();
  const art = String(req.body?.schritt || "");
  const device = String(req.body?.device || "").slice(0, 60);
  if (SCHRITTE.includes(art) && !istIntern(req) && !EIGEN.geraete.has(device)
      && einmalHeute(art, device || req.ip)) zaehle(art);
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
  /* Jeder Code zaehlt einzeln - sonst liessen sich 20 Codes je Anfrage
     durchprobieren. 300 je Stunde reichen fuer jede echte Chatliste. */
  for (let i = 0; i < paare.length; i++) {
    if (!take(`neuescode:${req.ip}`, 300, 60 * 60 * 1000)) return res.status(429).json({});
  }
  try {
    const geraet = String(req.body?.device || "").slice(0, 60);
    /* Aus einer Gruppe Entfernte sehen auch hier nichts Neues mehr. */
    const erlaubt = [];
    for (const p of paare) if (await gruppe.darfRein(p.room, geraet)) erlaubt.push(p);
    res.json(await store.neueNachrichten(erlaubt, geraet));
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
/* Zahlen aus der Play Console (Installationen, Store-Besucher, Quellen).
   Google aktualisiert die Berichte einmal am Tag, mit 1-2 Tagen Verzug. */
app.get("/api/admin/play-statistik", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  try {
    res.json(await play.statistik());
  } catch (err) {
    res.status(502).json({ error: err.message.slice(0, 200) });
  }
});

/* Trichter: Was wird aus neuen Besuchern und Chats? (28 Tage)
   Eigene Chats (RAEUME_OHNE_GRENZE) und Testchats zaehlen nicht mit. */
app.get("/api/admin/chat-trichter", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  try {
    const [chats, zaehler] = await Promise.all([
      store.chatTrichter(28, req.query.alle === "1" ? [...OHNE_GRENZE] : [...OHNE_GRENZE, ...EIGEN.raeume]),
      store.trichter(28),
    ]);
    res.json({ ...chats, besuch: zaehler.summe.besuch || 0, eingetreten: zaehler.summe.eingetreten || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

app.get("/api/admin/daten", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  try {
    /* ?alle=1 zeigt die Zahlen MIT den eigenen Chats. */
    const mitEigenen = req.query.alle === "1";
    const ohne = mitEigenen ? [] : [...EIGEN.raeume];
    const [trichter, aktiv7, aktiv30, abos, push, monat, gesamt, demo, gespraeche7, google] = await Promise.all([
      store.trichter(14),
      store.aktiveChats(7, ohne),
      store.aktiveChats(30, ohne),
      store.aboZaehlung(),
      store.pushZaehlung(),
      store.getUsage(30),
      store.getUsage(365),
      store.getDemoUsage(30),
      store.personenGruppen(7, ohne).catch(() => null),
      googleKosten().catch(() => null),
    ]);
    const kostenMonat = costOf(monat.total);
    const kostenDemo = costOf(demo);
    res.json({
      trichter,
      chats: { aktiv7, aktiv30, gruppen7: gespraeche7 },
      eigen: { ausgeblendet: !mitEigenen, chats: EIGEN.raeume.size, geraete: EIGEN.geraete.size },
      eigeneGeraete: await eigeneGeraeteListe().catch(() => []),
      google,
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

/* Die Bestaetigung, dass die Android-App zu dieser Seite gehoert. Ohne
   sie zeigt die App oben eine Adressleiste wie ein Browser. express.static
   liefert Punkt-Ordner wie .well-known nicht aus - daher von Hand. */
app.get("/.well-known/assetlinks.json", (_req, res) =>
  res.sendFile(join(__dirname, "public", ".well-known", "assetlinks.json"),
    (err) => { if (err && !res.headersSent) res.status(404).end(); }));

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
/* Zusaetzliche Schranke je IP und Tag. Die Minutengrenze oben haengt am
   Geraetenamen, den der Browser selbst schickt - wer ihn rotiert, umgeht
   sie. Diese Grenze haengt an der Adresse und sorgt dafuer, dass ein
   einzelner Absender nicht den gemeinsamen Tagesvorrat an Uebersetzungen
   (TRANSLATIONS_PER_DAY) leerlaufen lassen kann. Bewusst grosszuegig, damit
   echte Vielschreiber - auch mehrere hinter demselben Mobilfunk-Zugang -
   nicht anstossen; zum Feintunen per Umgebungsvariable. 0 heisst: keine. */
const MSG_PER_DAY_IP = Number(process.env.MSG_PER_DAY_IP || 600);
const NEED_PER_MIN = Number(process.env.NEED_PER_MIN || 120);
const TRANSLATIONS_PER_DAY = Number(process.env.TRANSLATIONS_PER_DAY || 2000);
/* Der Probe-Chat kostet je Runde eine KI-Antwort. Grosszuegig genug fuer
   echtes Ausprobieren, gedeckelt gegen Missbrauch. */
const DEMO_PER_DAY = Number(process.env.DEMO_PER_DAY || 800);

/* Erlaubte Reaktionen. Nur diese werden angenommen - so kann niemand
   beliebige Zeichen ueber die Reaktion einschleusen. */
const REAKTIONEN = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

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
  ja: "Japanisch", ko: "Koreanisch", hi: "Hindi", ur: "Urdu", bn: "Bengalisch", pa: "Punjabi (Gurmukhi)", ne: "Nepali",
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

/* Das Modell soll reines JSON liefern, setzt aber gelegentlich einen Satz
   davor oder Markdown drumherum. Dann den ersten {...}-Block nehmen, statt
   die ganze Antwort als Fehler zu werten. */
function jsonAusAntwort(text) {
  const roh = String(text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(roh); } catch {}
  const a = roh.indexOf("{"), b = roh.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(roh.slice(a, b + 1));
  throw new Error("Antwort ist kein JSON: " + roh.slice(0, 120));
}

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
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return {
    result: jsonAusAntwort(text),
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
    result: jsonAusAntwort(text),
    usage: {
      inTokens: data.usage?.input_tokens || 0,
      outTokens: data.usage?.output_tokens || 0,
    },
  };
}

async function translate(text, target, kontext = "") {
  const name = LANG_NAMES[target] || target;
  const hint = HINTS[target] ? `\nZielvariante beachten: ${HINTS[target]}` : "";
  /* Die letzten Nachrichten davor, nur zum Verstehen: Kurze Woerter wie
     "Chamo" sind oft die Korrektur eines Tippfehlers ("te chsmo" ->
     "te chamo") oder eine Antwort - ohne Zusammenhang raet die KI falsch. */
  const umfeld = kontext
    ? `\nZum Verstaendnis die Nachrichten direkt davor (NICHT uebersetzen, nur als Zusammenhang). Ist der Text die Korrektur eines Tippfehlers aus diesen Nachrichten oder eine Fortsetzung davon, uebersetze ihn passend dazu:\n${kontext}\n`
    : "";
  const prompt = `Du bist die Uebersetzungs-Engine eines Messengers. Erkenne die Sprache des Textes und uebersetze ihn natuerlich und umgangssprachlich nach ${name} (${target}) - so, wie ein Muttersprachler es in einen Chat tippen wuerde. Behalte Emojis, Namen, Zahlen und den Tonfall. Erklaere nichts, kommentiere nichts.${hint}
Bei der Erkennung die regionale Variante angeben, wenn sie am Text erkennbar ist: pt-BR oder pt-PT, es-419 oder es, en-US oder en, de-CH oder de, zh-TW oder zh. Sonst nur den Sprachcode.${umfeld}
Text: """${text}"""
Antworte NUR mit JSON, ohne Markdown: {"detected":"<Sprachcode>","translation":"<Uebersetzung>"}`;
  /* Ein zweiter Versuch faengt kurze Aussetzer der Schnittstelle ab -
     sonst sieht jeder im Chat "Uebersetzung gerade nicht moeglich". */
  try { return await claude(prompt); }
  catch (err) {
    await new Promise((r) => setTimeout(r, 800));
    return claude(prompt);
  }
}

const costOf = (u) => (u.inTokens / 1e6) * PRICE_IN + (u.outTokens / 1e6) * PRICE_OUT;

/* Darf dieser Chat noch uebersetzen lassen?

   Zaehlt im Arbeitsspeicher weiter, holt sich den Stand aber einmal je
   Monat und Chat aus dem Verbrauchsprotokoll. Ein Neustart verliert
   damit nichts: Die Zahl steht in der Datenbank, nicht hier.

   Schlaegt die Abfrage fehl, wird durchgelassen. Lieber eine Handvoll
   Uebersetzungen zu viel als ein Chat, der wegen einer klemmenden
   Datenbank verstummt. */
/* Chats ohne Monatsgrenze, z. B. der eigene des Betreibers. Kommagetrennt
   in RAEUME_OHNE_GRENZE; ohne Angabe gilt "algarve". */
const OHNE_GRENZE = new Set(
  String(process.env.RAEUME_OHNE_GRENZE ?? "algarve")
    .split(",").map((r) => r.trim().toLowerCase()).filter(Boolean)
);

/* Eigene Chats und Geraete (Betreiber + Familie) aus den Admin-Zahlen
   herausrechnen. Grundlage: die Raeume in RAEUME_OHNE_GRENZE. Wer dort
   schreibt, zaehlt ab sofort weder bei "Chat betreten" noch bei
   "Nachricht" mit; eigene Chats fehlen in Gespraechen und Trichter.
   Alle 15 Minuten neu ermittelt. */
const EIGEN = { geraete: new Set(), raeume: new Set() };
async function eigeneLaden() {
  try {
    const e = await store.eigeneRaeumeUndGeraete([...OHNE_GRENZE]);
    EIGEN.geraete = new Set(e.geraete);
    EIGEN.raeume = new Set(e.raeume);
  } catch (err) {
    console.error("Eigene Geraete nicht ladbar:", err.message);
  }
}
setTimeout(eigeneLaden, 5000);
setInterval(eigeneLaden, 15 * 60 * 1000);

/* Beta-Test: Wann war welches eigene Geraet (Betreiber + Familie, mit
   deren Einverstaendnis) zuletzt aktiv? Nur Zeitpunkt und Art - keine
   Inhalte. Chat-Oeffnen und Hilfen merkt sich der Server bis zum
   naechsten Neustart, Nachrichten kommen aus der Datenbank. */
const EIGEN_AKTIV = new Map();
function eigenAktiv(device, was) {
  if (!device) return;
  EIGEN_AKTIV.set(device, { zuletzt: Date.now(), was });
}
async function eigeneGeraeteListe() {
  const geraete = [...EIGEN.geraete];
  if (!geraete.length) return [];
  const db = await store.eigeneGeraeteAktiv(geraete).catch(() => []);
  const je = new Map(db.map((x) => [x.device, x]));
  return geraete.map((d) => {
    const m = je.get(d) || {}, a = EIGEN_AKTIV.get(d);
    const nachricht = Number(m.zuletzt || 0);
    const neuer = a && a.zuletzt > nachricht;
    return {
      kennung: String(d).slice(0, 6),
      name: m.name || "",
      zuletzt: neuer ? a.zuletzt : nachricht || null,
      was: neuer ? a.was : nachricht ? "nachricht" : "",
      nachrichten7: Number(m.woche || 0),
    };
  }).sort((x, y) => (y.zuletzt || 0) - (x.zuletzt || 0));
}

/* Welcher Tarif und welche Grenze zuletzt fuer einen Chat galten - damit
   die Meldung "aufgebraucht" dem Nutzer das Richtige sagt. */
const planVonRaum = new Map();

async function imKontingent(room) {
  if (OHNE_GRENZE.has(String(room || "").toLowerCase())) return true;
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
      planVonRaum.set(room, { plan: k.plan, grenze: k.grenze });
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

/* Bis zu vier Nachrichten aus den 15 Minuten vor dieser - als
   Zusammenhang fuer kurze, mehrdeutige Nachrichten. Lange Texte
   verstehen sich selbst, da sparen wir uns das. */
async function kontextVor(room, msg) {
  if (String(msg.text || "").length > 60) return "";
  try {
    const davor = (await store.getHistory(room, 8))
      .filter((m) => m.id !== msg.id && !m.deleted && m.text && m.at <= msg.at && msg.at - m.at < 15 * 60 * 1000)
      .slice(-4);
    return davor.map((m) => `${m.name || "?"}: ${String(m.text).slice(0, 200)}`).join("\n");
  } catch {
    return "";
  }
}

/* Sorgt dafuer, dass eine Uebersetzung existiert. Gibt den Text zurueck. */
/* Vorschau in der Mitteilung fuer Datei-Nachrichten (ohne Uebersetzung). */
function dateiSymbol(d) {
  return (String(d.mime || "").startsWith("video/") ? "🎬 " : "📎 ") + (d.name || "");
}

async function ensure(room, msgId, target) {
  const msg = await store.getMessage(msgId);
  /* Nur Nachrichten aus diesem Chat - eine fremde ID darf hier nichts verraten. */
  if (!msg || msg.room !== room) return null;
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
    io.to(room).emit("quotaReached", { id: msgId, grund: "monat", ...(planVonRaum.get(room) || {}) });
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
      const { result: out, usage } = await translate(msg.text, target, await kontextVor(room, msg));
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
      zaehleUebersetzt(msg);
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
  /* Nur Bilder aus diesem Chat. */
  if ((await store.getMessage(msgId))?.room !== room) return null;
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
    io.to(room).emit("quotaReached", { id: msgId, grund: "monat", ...(planVonRaum.get(room) || {}) });
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

/* Aussprache-Hilfe: Lautschrift, wie man den Originaltext einer Nachricht
   in seiner Sprache ausspricht - fuer Paare, die die Sprache des anderen
   lernen. Auf Anfrage (kostet das Modell); das Ergebnis merkt sich der
   Browser fuer die Sitzung, deshalb keine eigene Zwischenspeicher-Tabelle. */
const ausspracheInFlight = new Map();
async function ausspracheHelfen(room, msgId, target) {
  const msg = await store.getMessage(msgId);
  if (!msg || msg.room !== room || !String(msg.text || "").trim()) { io.to(room).emit("ausspracheFehler", { id: msgId, lang: target }); return null; }

  const key = `au:${msgId}:${target}`;
  if (ausspracheInFlight.has(key)) return ausspracheInFlight.get(key);

  if (!(await imKontingent(room))) {
    io.to(room).emit("quotaReached", { id: msgId, grund: "monat", ...(planVonRaum.get(room) || {}) });
    io.to(room).emit("ausspracheFehler", { id: msgId, lang: target });
    return null;
  }
  if (!take("tr:day", TRANSLATIONS_PER_DAY, 24 * 60 * 60 * 1000)) {
    io.to(room).emit("quotaReached", { id: msgId });
    io.to(room).emit("ausspracheFehler", { id: msgId, lang: target });
    return null;
  }

  const quelle = LANG_NAMES[msg.lang] || msg.lang;
  const ziel = LANG_NAMES[target] || target;
  const prompt = `Der folgende Text ist auf ${quelle}. Schreibe eine einfache, praktische Aussprache-Hilfe fuer jemanden, der ${ziel} spricht, damit er den Text laut vorlesen kann - mit der gewohnten Schreibweise und den Lautregeln von ${ziel}, KEINE IPA-Zeichen, keine Erklaerung. Kurz halten.
Text: """${msg.text.slice(0, 1000)}"""
Antworte NUR mit JSON, ohne Markdown: {"lautschrift":"<Aussprache in ${ziel}-Schreibweise>"}`;

  const job = (async () => {
    try {
      const { result: out, usage } = await claude(prompt);
      const text = String(out.lautschrift || "").slice(0, 600);
      store.logUsage({
        room, target, chars: Math.max(1, msg.text.length),
        inTokens: usage.inTokens, outTokens: usage.outTokens,
      }).catch((e) => console.error("Verbrauch nicht speicherbar:", e.message));
      io.to(room).emit("ausspracheFertig", { id: msgId, lang: target, text });
      return text;
    } catch (err) {
      console.error("Aussprache fehlgeschlagen:", err.message);
      io.to(room).emit("ausspracheFehler", { id: msgId, lang: target });
      return null;
    } finally {
      ausspracheInFlight.delete(key);
    }
  })();

  ausspracheInFlight.set(key, job);
  return job;
}

/* ------------------------------- Push ------------------------------- */
/* Schickt jedem angemeldeten Geraet im Raum die Nachricht in seiner Sprache. */
async function pushToRoom(room, msg) {
  let subs = [];
  try {
    subs = await store.getSubscriptions(room);
  } catch (err) {
    console.error("Push-Anmeldungen nicht lesbar:", err.message);
    return;
  }

  for (const sub of subs) {
    if (sub.device === msg.device) continue; // nicht an den Absender
    const istExpo = !!sub.data?.expo;
    if (!istExpo && !pushReady) continue;    // Web-Push braucht VAPID
    try {
      const body = await ensure(room, msg.id, clean(sub.lang));
      if (istExpo) {
        await expoPush(sub, {
          title: msg.name,
          body: body || msg.text || (msg.ort ? "📍" : (msg.bild ? "📷" : (msg.gif ? "GIF" : msg.datei ? dateiSymbol(msg.datei) : "🎤"))),
          room, id: msg.id,
        });
        continue;
      }
      const payload = JSON.stringify({
        title: msg.name,
        body: body || msg.text || (msg.ort ? "📍" : (msg.bild ? "📷" : (msg.gif ? "GIF" : msg.datei ? dateiSymbol(msg.datei) : ""))),
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

/* Native App: Benachrichtigungen laufen ueber den Expo-Push-Dienst, der
   sie an Firebase (Android) weiterreicht. Ein abgemeldetes Geraet meldet
   Expo als DeviceNotRegistered - dann fliegt die Anmeldung raus. */
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/;
/* Diagnose fuer den Admin: die letzten Anmeldungen und Sendeversuche,
   nur im Speicher und ohne Tokens oder Inhalte. */
const expoLog = [];
function expoMerken(e) { expoLog.unshift({ at: Date.now(), ...e }); expoLog.length = Math.min(expoLog.length, 30); }

async function expoPush(sub, { title, body, room, id, typ }) {
  const r = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      to: sub.data.expo, title, body: String(body || "").slice(0, 300),
      data: { room, id, typ: typ || "nachricht" }, sound: "default", channelId: "nachrichten", priority: "high",
    }),
  });
  const j = await r.json().catch(() => ({}));
  const t = j?.data;
  expoMerken({ art: "senden", room, http: r.status, status: t?.status || "?", fehler: t?.details?.error || t?.message || null });
  if (t?.status === "error") {
    if (t.details?.error === "DeviceNotRegistered") {
      await store.deleteSubscription(sub.endpoint).catch(() => {});
    } else {
      console.error("Expo-Push fehlgeschlagen:", t.message || t.details?.error);
    }
  }
}

/* Diralo Lernen: Startpakete und taeglicher Satz (lernpush.js). */
lernpush.einrichten({
  app, store, claude, clean, take, expoPush, webpush, pushReady,
  langName: (l) => LANG_NAMES[l] || l,
});

/* ------------------------------ HTTP API ------------------------------ */
/* Anmeldung der nativen App. Wie die Glocke im Browser gilt sie fuer
   alle Chats, die die App mitschickt. */
app.post("/api/expo-push", async (req, res) => {
  const { token, rooms, device, name, lang } = req.body || {};
  if (!EXPO_TOKEN_RE.test(String(token || "")) || !device) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  const liste = [...new Set(
    (Array.isArray(rooms) ? rooms : [])
      .map((r) => String(r || "").toLowerCase().trim().slice(0, 60))
      .filter(Boolean)
  )].slice(0, 20);
  if (!liste.length) return res.status(400).json({ error: "Kein Chat angegeben" });
  try {
    for (const r of liste) {
      await store.saveSubscription({
        endpoint: "expo:" + token,
        room: r,
        device: String(device).slice(0, 60),
        name: String(name || "Gast").slice(0, 40),
        lang: clean(lang),
        data: { expo: token },
      });
    }
    expoMerken({ art: "anmeldung", chats: liste.length });
    res.json({ ok: true, chats: liste.length });
  } catch (err) {
    console.error("Expo-Anmeldung fehlgeschlagen:", err.message);
    res.status(500).json({ error: "Anmeldung fehlgeschlagen" });
  }
});

/* Admin: Nachrichten eines Chats nach Text suchen und eine davon fuer
   alle loeschen - fuer Nachrichten, deren Geraet nicht mehr existiert
   (z. B. nach einer Neuinstallation der App). */
app.get("/api/admin/suche", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  const room = raumCode(req.query.room);
  const q = String(req.query.q || "").toLowerCase().trim();
  if (!room || !q) return res.status(400).json({ error: "room und q angeben" });
  const liste = await store.getHistory(room, 500);
  res.json(liste.filter((m) => !m.deleted && String(m.text || "").toLowerCase().includes(q))
    .map((m) => ({ id: m.id, name: m.name, text: String(m.text || "").slice(0, 200), at: m.at })));
});

/* Einen Chat unter einen neuen Code legen (z. B. weil der alte zu leicht
   zu erraten war). Ziel muss leer sein. Wer im alten Chat sitzt, sieht ihn
   danach leer - den neuen Code bekommt nur, wem man ihn gibt. */
app.post("/api/admin/umziehen", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  const von = raumCode(req.body?.von);
  const nach = raumCode(req.body?.nach);
  if (!von || !nach || von === nach || nach.length < 10) return res.status(400).json({ error: "von und nach (mind. 10 Zeichen) angeben" });
  try {
    const r = await store.raumUmziehen(von, nach);
    planZwischen.delete(von);
    io.to(von).emit("system", { type: "umgezogen" });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message.slice(0, 150) });
  }
});

app.post("/api/admin/loeschen", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  const id = String(req.body?.id || "");
  const room = raumCode(req.body?.room);
  if (!id || !room) return res.status(400).json({ error: "id und room angeben" });
  const msg = await store.getMessage(id);
  if (!msg) return res.status(404).json({ error: "Nachricht nicht gefunden" });
  const ok = await store.deleteForAll(id, msg.device);
  if (ok) io.to(room).emit("deleted", { id });
  res.json({ ok });
});

/* --------------------------- Anrufe ---------------------------
   Laufende Anrufe je Chat - damit jemand, der den Chat erst nach dem
   Klingeln oeffnet (z. B. ueber die Benachrichtigung), noch annehmen
   kann. Nur im Arbeitsspeicher; ein Anruf ueberlebt keinen Neustart. */
const anrufe = new Map();   // room -> { name, device, video, at }

/* Zwischenspeicher, die je beruehrtem Chat wachsen, nie unbegrenzt
   werden lassen: stuendlich Altes weg, notfalls alles (es sind nur
   Merker - fehlt einer, wird er beim naechsten Mal neu ermittelt). */
setInterval(() => {
  const jetzt = Date.now();
  for (const [r, a] of anrufe) if (jetzt - (a?.at || 0) > 60 * 60 * 1000) anrufe.delete(r);
  for (const [r, z] of planZwischen) if (!z || z.bis < jetzt) planZwischen.delete(r);
  for (const map of [planVonRaum, bonusGeprueft, playNachgefragt]) if (map.size > 5000) map.clear();
}, 60 * 60 * 1000).unref?.();
const ANRUF_KLINGELT_MS = 60 * 1000;

const RUFT_AN = {
  de: "ruft dich an", pt: "está a ligar-te", en: "is calling you", es: "te está llamando",
  fr: "t'appelle", it: "ti sta chiamando", nl: "belt je", pl: "dzwoni do ciebie",
};
const ruftAn = (lang) => RUFT_AN[String(lang || "").split("-")[0]] || RUFT_AN.en;

async function anrufKlingeln(room, wer) {
  let subs = [];
  try { subs = await store.getSubscriptions(room); } catch { return; }
  for (const sub of subs) {
    if (sub.device === wer.device || !sub.data?.expo) continue;
    expoPush(sub, {
      title: (wer.video ? "🎥 " : "📞 ") + wer.name,
      body: wer.name + " " + ruftAn(sub.lang),
      room, id: "anruf", typ: "anruf",
    }).catch(() => {});
  }
}

/* Verbrauch der Google-Dienste zaehlen - gesammelt im Speicher und alle
   30 s in die Datenbank, damit nicht jede Sekunde ein Schreibzugriff ist. */
const zaehlerOffen = new Map();
function zaehlen(art, menge) {
  zaehlerOffen.set(art, (zaehlerOffen.get(art) || 0) + Number(menge || 0));
}
setInterval(() => {
  const monat = monatsKennung();
  for (const [art, menge] of zaehlerOffen) {
    if (menge < 1) continue;
    zaehlerOffen.set(art, menge - Math.floor(menge));
    store.zaehlerDazu(monat, art, Math.floor(menge)).catch(() => {});
  }
}, 30 * 1000).unref?.();
anruf.setZaehler(zaehlen);

/* Listenpreise in US-Dollar (anpassbar ueber die Umgebung). */
const GOOGLE_PREIS = {
  tts: Number(process.env.PREIS_TTS_PRO_MIO || 30),          // Chirp3-HD, je 1 Mio. Zeichen
  stt: Number(process.env.PREIS_STT_PRO_MIN || 0.024),       // Speech-to-Text, je Minute
  tr: Number(process.env.PREIS_UEBERSETZUNG_PRO_MIO || 20),  // Translation, je 1 Mio. Zeichen
};

async function googleKosten() {
  const monat = monatsKennung();
  const z = await store.zaehlerMonat(monat);
  const d = new Date();
  const monatsAnfang = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const tts = (z.tts_zeichen || 0) + (zaehlerOffen.get("tts_zeichen") || 0) + await store.ttsZeichenSeit(monatsAnfang);
  const sttSek = (z.stt_sekunden || 0) + (zaehlerOffen.get("stt_sekunden") || 0);
  const tr = (z.uebersetzung_zeichen || 0) + (zaehlerOffen.get("uebersetzung_zeichen") || 0);
  const usd = tts / 1e6 * GOOGLE_PREIS.tts + sttSek / 60 * GOOGLE_PREIS.stt + tr / 1e6 * GOOGLE_PREIS.tr;
  return { ttsZeichen: Math.round(tts), sttMinuten: Math.round(sttSek / 6) / 10, uebersetzungZeichen: Math.round(tr), usd: Number(usd.toFixed(2)) };
}

/* Untertitel-Minuten je Monat. Anrufe selbst sind frei - Geld kosten
   nur Spracherkennung und Uebersetzung der Untertitel. Gezaehlt wird je
   Abo (alle Chats eines Abos teilen sich die Minuten) oder je Chat. */
const UNTERTITEL_MIN = {
  frei: Number(process.env.UNTERTITEL_MIN_FREI || 10),
  plus: Number(process.env.UNTERTITEL_MIN_PLUS || 60),
  familie: Number(process.env.UNTERTITEL_MIN_FAMILIE || 200),
  team: Number(process.env.UNTERTITEL_MIN_TEAM || 60),
  teamplus: Number(process.env.UNTERTITEL_MIN_TEAMPLUS || 200),
};

async function untertitelStand(room) {
  if (OHNE_GRENZE.has(String(room).toLowerCase())) return null;   // ohne Grenze
  const k = await kontingent(room);
  const topf = k.bezahlt ? "abo:" + k.raeume.slice().sort().join(",") : "raum:" + room;
  const monat = monatsKennung();
  const minuten = UNTERTITEL_MIN[k.plan] ?? UNTERTITEL_MIN.frei;
  return { topf, monat, plan: k.plan, grenzeSek: minuten * 60, benutzt: await store.anrufSekunden(topf, monat) };
}

async function untertitelBudget(room) {
  const st = await untertitelStand(room);
  if (!st) return null;
  let offen = 0;
  const sichern = () => {
    if (offen <= 0) return;
    const n = offen;
    offen = 0;
    st.benutzt += n;
    store.anrufSekundenDazu(st.topf, st.monat, n).catch((e) => console.error("Untertitel-Minuten:", e.message));
  };
  const uhr = setInterval(sichern, 15 * 1000);
  return {
    darf: () => st.benutzt + offen < st.grenzeSek,
    verbrauche: (sek) => { offen += sek; },
    ende: () => { clearInterval(uhr); sichern(); },
  };
}

/* Wie viele Untertitel-Minuten sind noch da? Fuer die Anzeige in der App. */
app.get("/api/anruf/minuten", async (req, res) => {
  const room = raumCode(req.query.room);
  if (!room) return res.status(400).json({ error: "room angeben" });
  if (!take(`minuten:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({ error: "Zu viele Anfragen" });
  try {
    const st = await untertitelStand(room);
    if (!st) return res.json({ unbegrenzt: true });
    res.json({ plan: st.plan, minuten: st.grenzeSek / 60, rest: Math.max(0, Math.floor((st.grenzeSek - st.benutzt) / 60)) });
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) });
  }
});

/* Zugang zum Anruf. Startet nebenbei den Untertitel-Helfer. */
app.post("/api/anruf", async (req, res) => {
  if (!anruf.anrufAn) return res.status(503).json({ error: "Anrufe sind noch nicht eingerichtet" });
  const room = raumCode(req.body?.room);
  const device = String(req.body?.device || "").slice(0, 60);
  if (!room || !device) return res.status(400).json({ error: "room und device angeben" });
  if (!take(`anruf:${device}`, 30, 60 * 60 * 1000)) return res.status(429).json({ error: "Zu viele Anrufe" });
  /* Die Geraete-Kennung waehlt der Client selbst - deshalb auch je Adresse. */
  if (!take(`anrufip:${req.ip}`, 40, 60 * 60 * 1000)) return res.status(429).json({ error: "Zu viele Anrufe" });
  try {
    const zugang = await anruf.tokenFuer({
      room, device, name: req.body?.name, lang: clean(req.body?.lang),
    });
    anruf.untertitelStarten(room, async (text, ziel) => {
      /* Dieselbe Tagesgrenze wie fuer Chat-Uebersetzungen. */
      if (!take("tr:day", TRANSLATIONS_PER_DAY, 24 * 60 * 60 * 1000)) return null;
      const { result, usage } = await translate(text, ziel);
      store.logUsage({ room, target: ziel, chars: text.length, inTokens: usage.inTokens, outTokens: usage.outTokens }).catch(() => {});
      return result.translation || null;
    }, await untertitelBudget(room).catch(() => null)).catch(() => {});
    res.json(zugang);
  } catch (err) {
    console.error("Anruf-Zugang:", err.message);
    res.status(500).json({ error: "Anruf gerade nicht moeglich" });
  }
});

app.get("/api/admin/expo", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
  res.json({ log: expoLog });
});

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

/* ---------------------- Dolmetscher und Foto ----------------------
   Zwei Helfer der nativen App, die ohne Chat auskommen:
   - Dolmetscher: zwei Menschen am selben Handy, jeder spricht seine
     Sprache, die App uebersetzt Satz fuer Satz.
   - Foto: Speisekarte, Brief, Schild fotografieren - Text lesen,
     uebersetzen und auf Wunsch einfach erklaeren.
   Beides kostet Modellaufrufe und haengt an keinem Chat-Kontingent,
   deshalb je Geraet und je Tag eng begrenzt. Nichts wird gespeichert. */
const HILFE_PRO_TAG = Number(process.env.HILFE_PRO_TAG || 800);

/* Gratis-Kontingent fuer Dolmetscher und Foto-Uebersetzer: je Geraet und
   Tag. Mit Plus (irgendein bezahlter Chat des Geraets) unbegrenzt. Die App
   schickt dazu ihre Chat-Codes mit; geprueft wird nur, ob einer davon ein
   laufendes Abo hat - die Codes werden nicht gespeichert. */
const GRATIS_PRO_TAG = {
  dolmetsch: Number(process.env.GRATIS_DOLMETSCH || 20),
  foto: Number(process.env.GRATIS_FOTO || 5),
  text: Number(process.env.GRATIS_TEXT || 10),
};
const plusMerker = new Map(); // device -> { plus, bis }
async function hatPlus(device, raeume) {
  const m = plusMerker.get(device);
  if (m && m.bis > Date.now()) return m.plus;
  let plus = false;
  const codes = (Array.isArray(raeume) ? raeume : []).slice(0, 30).map(raumCode).filter(Boolean);
  if (codes.some((r) => OHNE_GRENZE.has(r))) plus = true;
  for (const r of codes) {
    if (plus) break;
    try { if ((await kontingent(r)).bezahlt) plus = true; } catch {}
  }
  if (plusMerker.size > 5000) plusMerker.clear();
  /* Plus 10 Minuten merken, "kein Plus" nur 1 Minute - wer gerade
     gekauft hat, soll nicht lange warten. */
  plusMerker.set(device, { plus, bis: Date.now() + (plus ? 10 : 1) * 60 * 1000 });
  return plus;
}
async function gratisErlaubt(req, art) {
  const device = String(req.body?.device || "").slice(0, 60);
  if (device && EIGEN.geraete.has(device)) return true;
  if (device && await hatPlus(device, req.body?.raeume)) return true;
  const wer = device || req.ip;
  return take(`gratis:${art}:${wer}`, GRATIS_PRO_TAG[art], 24 * 60 * 60 * 1000);
}

/* Natuerliche Stimme (Google Cloud TTS). POST liefert eine Kennung, GET
   die MP3 dazu - so steht der Text nie in einer Adresse. */
/* Neueste App-Version (versionCode). Die App vergleicht beim Start und
   bietet das Update an; unter "minimum" ist es Pflicht. Ueber die
   Umgebung einstellbar, ohne neuen Server-Code. */
app.get("/api/app-version", (req, res) => {
  /* Die Android-App fragt das bei jedem Start - so sehen wir, wie viele
     Installierte die App wirklich oeffnen (einmal pro Tag und Adresse). */
  if (!istIntern(req) && einmalHeute("start", req.ip)) zaehle("app_start");
  res.json({
    aktuell: Number(process.env.APP_VERSION_AKTUELL || 6),
    minimum: Number(process.env.APP_VERSION_MINIMUM || 0),
  });
});

app.post("/api/sprechen", async (req, res) => {
  if (!stimme.spracheAn) return res.status(503).json({ error: "Stimmen aus" });
  const text = String(req.body?.text || "").trim().slice(0, 600);
  const lang = clean(req.body?.lang);
  const wer = String(req.body?.device || req.ip).slice(0, 60);
  if (!text || !lang) return res.status(400).json({ error: "Angaben unvollstaendig" });
  if (!take(`sprechen:${wer}`, 60, 10 * 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
  if (!take("sprechen:day", Number(process.env.SPRECHEN_PRO_TAG || 3000), 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Tagesgrenze" });
  }
  try {
    const { id, neu } = await stimme.sprechen(text, lang, req.body?.langsam === true);
    if (neu) zaehlen("tts_zeichen", text.length);
    res.json({ id });
  } catch (err) {
    console.error("Sprechen fehlgeschlagen:", err.message);
    res.status(502).json({ error: "Stimme nicht verfuegbar" });
  }
});

app.get("/api/sprechen/:id", (req, res) => {
  const mp3 = stimme.aufnahme(req.params.id);
  if (!mp3) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.set("Cache-Control", "private, max-age=3600");
  res.send(mp3);
});

app.post("/api/dolmetsch", express.json({ limit: "20kb" }), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 800);
  const von = clean(req.body?.von), nach = clean(req.body?.nach);
  const wer = String(req.body?.device || req.ip).slice(0, 60);
  if (!text || !von || !nach) return res.status(400).json({ error: "Angaben unvollstaendig" });
  if (!take(`dolm:${wer}`, 40, 10 * 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
  if (!(await gratisErlaubt(req, "dolmetsch"))) return res.status(402).json({ error: "gratis_aus", grenze: GRATIS_PRO_TAG.dolmetsch });
  if (!take("hilfe:day", HILFE_PRO_TAG, 24 * 60 * 60 * 1000)) return res.status(429).json({ error: "Tagesgrenze" });
  const vonName = LANG_NAMES[von] || von, nachName = LANG_NAMES[nach] || nach;
  const prompt = `Du bist ein Dolmetscher in einem Gespraech von Angesicht zu Angesicht. Der Text ist gesprochene Sprache auf ${vonName} (${von}), von einer Spracherkennung mitgeschrieben - kleine Erkennungsfehler sinnvoll ausgleichen. Uebersetze natuerlich und muendlich nach ${nachName} (${nach}). Erklaere nichts.
Text: """${text}"""
Antworte NUR mit JSON, ohne Markdown: {"uebersetzt":"<Text auf ${nach}>"}`;
  try {
    const { result: out, usage } = await claude(prompt);
    store.logUsage({ room: "__dolmetsch__", target: nach, chars: text.length,
      inTokens: usage.inTokens, outTokens: usage.outTokens }).catch(() => {});
    zaehleHilfe("dolmetsch", req);
    res.json({ uebersetzt: String(out.uebersetzt || "").slice(0, 1500) });
  } catch (err) {
    console.error("Dolmetscher fehlgeschlagen:", err.message);
    res.status(502).json({ error: "Uebersetzung fehlgeschlagen" });
  }
});

/* Text aus einer anderen App (Teilen-Menue von Android): uebersetzen
   und auf Wunsch kurz erklaeren - Redewendungen, Tonfall, was gemeint ist. */
app.post("/api/text-erklaeren", express.json({ limit: "40kb" }), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  const lang = clean(req.body?.lang);
  const erklaeren = req.body?.erklaeren !== false;
  const wer = String(req.body?.device || req.ip).slice(0, 60);
  if (!text || !lang) return res.status(400).json({ error: "Angaben unvollstaendig" });
  if (!take(`teilen:${wer}`, 20, 10 * 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
  if (!(await gratisErlaubt(req, "text"))) return res.status(402).json({ error: "gratis_aus", grenze: GRATIS_PRO_TAG.text });
  if (!take("hilfe:day", HILFE_PRO_TAG, 24 * 60 * 60 * 1000)) return res.status(429).json({ error: "Tagesgrenze" });
  const ziel = LANG_NAMES[lang] || lang;
  const prompt = `Der folgende Text wurde aus einer anderen App geteilt (z. B. eine Chatnachricht, ein Post oder eine E-Mail). Erkenne die Sprache und uebersetze ihn natuerlich nach ${ziel} (${lang}).${erklaeren ? ` Schreibe ausserdem eine kurze Erklaerung auf ${ziel}: Was ist gemeint, welcher Tonfall (freundlich, ironisch, foermlich, veraergert ...), gibt es Redewendungen oder kulturelle Anspielungen? Hoechstens 3 kurze Saetze. Ist alles eindeutig, reicht ein Satz.` : ""}
Text: """${text}"""
Antworte NUR mit JSON, ohne Markdown: {"sprache":"<Sprachcode des Originals>","uebersetzt":"<Text auf ${lang}>"${erklaeren ? `,"erklaerung":"<Erklaerung auf ${lang}>"` : ""}}`;
  try {
    const { result: out, usage } = await claude(prompt);
    store.logUsage({ room: "__teilen__", target: lang, chars: text.length,
      inTokens: usage.inTokens, outTokens: usage.outTokens }).catch(() => {});
    zaehleHilfe("text", req);
    res.json({
      sprache: clean(out.sprache) || "",
      uebersetzt: String(out.uebersetzt || "").slice(0, 6000),
      erklaerung: erklaeren ? String(out.erklaerung || "").slice(0, 1500) : "",
    });
  } catch (err) {
    console.error("Text erklaeren fehlgeschlagen:", err.message);
    res.status(502).json({ error: "Uebersetzung fehlgeschlagen" });
  }
});

app.post("/api/foto-text", express.json({ limit: "8mb" }), async (req, res) => {
  const bild = String(req.body?.bild || "");
  const lang = clean(req.body?.lang);
  const erklaeren = req.body?.erklaeren === true;
  const wer = String(req.body?.device || req.ip).slice(0, 60);
  if (!bild || !lang || bild.length > 7_500_000 || !/^[A-Za-z0-9+/=]+$/.test(bild)) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  if (!take(`foto:${wer}`, 10, 10 * 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
  if (!(await gratisErlaubt(req, "foto"))) return res.status(402).json({ error: "gratis_aus", grenze: GRATIS_PRO_TAG.foto });
  if (!take("hilfe:day", HILFE_PRO_TAG, 24 * 60 * 60 * 1000)) return res.status(429).json({ error: "Tagesgrenze" });
  const ziel = LANG_NAMES[lang] || lang;
  const prompt = `Lies allen Text auf diesem Foto (z. B. Speisekarte, Brief, Schild, Beipackzettel). Uebersetze ihn vollstaendig und gut lesbar nach ${ziel} (${lang}) - Absaetze und Aufzaehlungen beibehalten.${erklaeren ? ` Schreibe ausserdem eine kurze, einfache Erklaerung auf ${ziel}: Worum geht es, was muss der Leser tun oder beachten, gibt es Fristen oder Betraege?` : ""} Ist kein Text zu sehen, gib leere Felder zurueck.
Antworte NUR mit JSON, ohne Markdown: {"original":"<gelesener Text>","uebersetzt":"<Text auf ${lang}>"${erklaeren ? `,"erklaerung":"<kurze Erklaerung auf ${lang}>"` : ""}}`;
  try {
    const { result: out, usage } = await claudeBild(bild, "image/jpeg", prompt);
    store.logUsage({ room: "__foto__", target: lang, chars: Math.max(1, String(out.original || "").length),
      inTokens: usage.inTokens, outTokens: usage.outTokens }).catch(() => {});
    zaehleHilfe("foto", req);
    res.json({
      original: String(out.original || "").slice(0, 6000),
      uebersetzt: String(out.uebersetzt || "").slice(0, 6000),
      erklaerung: erklaeren ? String(out.erklaerung || "").slice(0, 2000) : "",
    });
  } catch (err) {
    console.error("Foto-Text fehlgeschlagen:", err.message);
    res.status(502).json({ error: "Foto konnte nicht gelesen werden" });
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
  /* Die native App: ihre Spracherkennung speichert die Aufnahme nur als
     unkomprimiertes WAV (16 kHz, 16 Bit, mono = 32 KB je Sekunde). */
  "audio/wav": "audio/wav",
};
/* WAV ist ungepackt - zwei Minuten sind rund 3,8 MB. Eigene Grenze, damit
   die fuer gepackte Formate nicht mit aufgeweicht wird. */
const VOICE_MAX_BYTES_WAV = Number(process.env.VOICE_MAX_BYTES_WAV || 4_000_000);

app.post("/api/voice", express.json({ limit: "6mb" }), entfernteSperren, async (req, res) => {
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
  const grenze = type === "audio/wav" ? VOICE_MAX_BYTES_WAV : VOICE_MAX_BYTES;
  if (!bytes.length || bytes.length > grenze) {
    return res.status(413).json({ error: "Aufnahme zu gross" });
  }
  /* Zu leise Aufnahmen (WAV aus der App) lauter machen - sonst hoert der
     andere "nichts" und die Spracherkennung versteht nichts. */
  try { bytes = mitschrift.lauterMachen(bytes, type); } catch {}

  const raum = String(room).trim().toLowerCase().slice(0, 60);
  const geraet = String(device).slice(0, 60);
  if (!take(`msg:${geraet}`, MSG_PER_MIN, 60 * 1000)) {
    return res.status(429).json({ error: "Zu schnell" });
  }
  if (!take(`msgtag:${req.ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) {
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
  /* Ohne Mitschrift vom Handy: auf dem Server nachholen und uebersetzen. */
  if (!msg.text) mitschriftNachholen(raum, msg, bytes, type).catch((e) => console.error("Mitschrift:", e.message?.slice(0, 160)));
});

/* Sprachnachricht ohne Text: mit Google mitschreiben, Text speichern und
   in alle Sprachen des Chats uebersetzen. Die Empfaenger haben vorher
   eine leere Uebersetzung bekommen - "translated" ersetzt sie jetzt. */
async function mitschriftNachholen(raum, msg, bytes, type) {
  const text = await mitschrift.transkribieren(bytes, type, msg.lang, stimme.dienstkonto(), msg.audioSeconds);
  if (!text) return;
  await store.setMessageText(msg.id, text.slice(0, 4000));
  io.to(raum).emit("translated", { id: msg.id, lang: msg.lang, text });
  const sprachen = new Set();
  for (const m of await store.getHistory(raum, 80).catch(() => [])) {
    if (m.lang) sprachen.add(m.lang);
    for (const l of Object.keys(m.tr || {})) sprachen.add(l);
  }
  sprachen.delete(msg.lang);
  for (const l of sprachen) await ensure(raum, msg.id, clean(l)).catch(() => {});
}

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

app.post("/api/bild", express.json({ limit: "5mb" }), entfernteSperren, async (req, res) => {
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
  if (!take(`msgtag:${req.ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) {
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

/* ------------------------------- GIFs -------------------------------
   Suche ueber KLIPY (Tenor wurde von Google im Juni 2026 abgeschaltet).
   Der Schluessel bleibt auf dem Server (KLIPY_KEY); die App fragt nur
   hier. Ein GIF ist eine gewoehnliche Nachricht mit leerem Text und
   msg.gif = {url, b, h} - nichts zu uebersetzen.
------------------------------------------------------------------------ */
const KLIPY_KEY = process.env.KLIPY_KEY || "";
const GIF_HOSTS = /(^|\.)(klipy\.com|klipy\.co|tenor\.com|giphy\.com)$/i;
const gifCache = new Map(); // "q|lang" -> {at, liste}

function gifGroesse(f) {
  if (!f || typeof f !== "object") return null;
  const g = f.gif || f.webp || f;
  if (g && typeof g.url === "string") return { url: g.url, b: Number(g.width) || 0, h: Number(g.height) || 0 };
  return null;
}

/* KLIPY-Antwort tolerant lesen: data.data[] oder data[] oder results[]. */
function gifListe(json) {
  const roh = json?.data?.data || json?.data || json?.results || [];
  const aus = [];
  for (const it of Array.isArray(roh) ? roh : []) {
    const f = it.file || it.files || it.media_formats || it.images || {};
    const klein = gifGroesse(f.sm) || gifGroesse(f.xs) || gifGroesse(f.tinygif) || gifGroesse(f.fixed_width_small) || gifGroesse(f.md);
    const gross = gifGroesse(f.md) || gifGroesse(f.hd) || gifGroesse(f.gif) || gifGroesse(f.downsized) || klein;
    if (!klein || !gross) continue;
    aus.push({ id: String(it.id ?? it.slug ?? aus.length), klein, gross });
  }
  return aus;
}

app.get("/api/gif/suche", async (req, res) => {
  if (!KLIPY_KEY) return res.status(503).json({ error: "GIFs nicht eingerichtet" });
  const q = String(req.query.q || "").trim().slice(0, 60);
  const lang = clean(req.query.lang) || "en";
  const schluessel = q.toLowerCase() + "|" + lang;
  const alt = gifCache.get(schluessel);
  if (alt && Date.now() - alt.at < 30 * 60 * 1000) return res.json({ gifs: alt.liste });
  if (!take(`gif:${req.ip}`, 60, 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });

  const art = q ? "search" : "trending";
  const params = new URLSearchParams({ per_page: "30", page: "1", customer_id: "diralo", locale: lang.split("-")[0] });
  if (q) params.set("q", q);
  try {
    const r = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(KLIPY_KEY)}/gifs/${art}?${params}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      console.error("KLIPY:", r.status, (await r.text()).slice(0, 200));
      return res.status(502).json({ error: "GIF-Dienst antwortet nicht" });
    }
    const liste = gifListe(await r.json());
    gifCache.set(schluessel, { at: Date.now(), liste });
    if (gifCache.size > 500) gifCache.delete(gifCache.keys().next().value);
    res.json({ gifs: liste });
  } catch (err) {
    console.error("KLIPY:", err.message);
    res.status(502).json({ error: "GIF-Dienst antwortet nicht" });
  }
});

app.post("/api/gif", async (req, res) => {
  const { room, device, name, lang, gif, replyTo } = req.body || {};
  if (!room || !device || !gif || typeof gif.url !== "string") {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  let url;
  try { url = new URL(gif.url); } catch { return res.status(400).json({ error: "Adresse unlesbar" }); }
  if (url.protocol !== "https:" || !GIF_HOSTS.test(url.hostname)) {
    return res.status(400).json({ error: "Nur GIFs aus der Suche" });
  }
  const raum = String(room).trim().toLowerCase().slice(0, 60);
  const geraet = String(device).slice(0, 60);
  if (!take(`msg:${geraet}`, MSG_PER_MIN, 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
  if (!take(`msgtag:${req.ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    room: raum,
    device: geraet,
    name: String(name || "Gast").slice(0, 40),
    text: "",
    lang: clean(lang),
    detected: false,
    tr: {},
    at: Date.now(),
    replyTo: replyTo ? String(replyTo).slice(0, 40) : null,
    gif: { url: url.href.slice(0, 500), b: Math.min(2000, Number(gif.b) || 0), h: Math.min(2000, Number(gif.h) || 0) },
  };
  try {
    await store.addMessage(msg);
  } catch (err) {
    console.error("GIF nicht speicherbar:", err.message);
    return res.status(500).json({ error: "Nicht speicherbar" });
  }
  io.to(raum).emit("message", msg);
  pushToRoom(raum, msg).catch((e) => console.error("Push-Lauf:", e.message));
  res.json({ ok: true, id: msg.id });
});

/* --------------------------- Dateien und Videos ---------------------------
   PDF, Word, Videos usw. - werden NICHT uebersetzt, nur weitergereicht.
   Der Koerper ist die Datei selbst (keine Base64-Huelle), Name und Art
   stehen in der Adresse. Gespeichert wird wie ein Bild in "media"; die
   Loeschfrist raeumt es mit der Nachricht weg.
------------------------------------------------------------------------ */
const DATEI_MAX_BYTES = Number(process.env.DATEI_MAX_BYTES || 25_000_000);
const dateiRoh = express.raw({ type: () => true, limit: DATEI_MAX_BYTES + 1000 });

/* Grosse Dateien kommen ganz in den Speicher. Damit ein paar gleichzeitige
   25-MB-Uploads den Server nicht an die Speichergrenze bringen, laufen
   hoechstens DATEI_GLEICHZEITIG auf einmal; je Adresse gibt es am Tag
   hoechstens DATEI_MB_TAG Megabyte (sonst liefe die Datenbank voll). */
const DATEI_GLEICHZEITIG = Number(process.env.DATEI_GLEICHZEITIG || 4);
const DATEI_MB_TAG = Number(process.env.DATEI_MB_TAG || 300);
let dateiLaufend = 0;
const dateiBytes = new Map();   // "tag|ip" -> Bytes
function dateiBytesDazu(ip, n) {
  const tag = new Date().toISOString().slice(0, 10);
  if (dateiBytes.size > 20000) dateiBytes.clear();
  const k = `${tag}|${ip}`;
  const neu = (dateiBytes.get(k) || 0) + n;
  dateiBytes.set(k, neu);
  return neu <= DATEI_MB_TAG * 1_000_000;
}

app.post("/api/datei", (req, res, next) => {
  if (dateiLaufend >= DATEI_GLEICHZEITIG) return res.status(503).json({ error: "Gerade viel los - gleich nochmal" });
  dateiLaufend++;
  let fertig = false;
  const frei = () => { if (!fertig) { fertig = true; dateiLaufend--; } };
  res.on("finish", frei);
  res.on("close", frei);
  dateiRoh(req, res, (err) => {
    if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Datei zu gross" : "Datei unlesbar" });
    next();
  });
}, async (req, res) => {
  const q = req.query || {};
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  if (!q.room || !q.device || !bytes || !bytes.length) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  if (bytes.length > DATEI_MAX_BYTES) return res.status(413).json({ error: "Datei zu gross" });
  if (!dateiBytesDazu(req.ip, bytes.length)) return res.status(429).json({ error: "Fuer heute genug hochgeladen" });

  /* Der Typ entscheidet nur ueber die Anzeige (Video oder Datei). Was
     ausgeliefert wird, ist nie als Seite ausfuehrbar - siehe /medien. */
  let mime = String(q.mime || "").split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) mime = "application/octet-stream";
  const dateiName = String(q.dateiname || "Datei").replace(/[\\/\r\n\t"]/g, "_").trim().slice(0, 120) || "Datei";

  const raum = String(q.room).trim().toLowerCase().slice(0, 60);
  const geraet = String(q.device).slice(0, 60);
  if (!take(`msg:${geraet}`, MSG_PER_MIN, 60 * 1000)) {
    return res.status(429).json({ error: "Zu schnell" });
  }
  if (!take(`msgtag:${req.ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Zu schnell" });
  }

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    room: raum,
    device: geraet,
    name: String(q.name || "Gast").slice(0, 40),
    text: "",                 // nichts zu uebersetzen
    lang: clean(q.lang),
    detected: false,
    tr: {},
    at: Date.now(),
    datei: { name: dateiName, mime, groesse: bytes.length },
  };

  try {
    await store.addMessage(msg);
    await store.addMedia(msg.id, { mime, bytes });
  } catch (err) {
    console.error("Datei nicht speicherbar:", err.message);
    return res.status(500).json({ error: "Nicht speicherbar" });
  }

  io.to(raum).emit("message", msg);
  pushToRoom(raum, msg).catch((e) => console.error("Push-Lauf:", e.message));
  res.json({ ok: true, id: msg.id });
});

/* Ausliefern. Liegt hinter dem Zugangswort wie alles andere - die
   Aufnahmen sind damit nicht oeffentlich abrufbar.
   Videos brauchen "Range", sonst laesst sich im Player nicht spulen.
   Alles ausser Bild, Ton und Video kommt als Download - eine hochgeladene
   HTML-Datei darf nie als Seite von diralo.app laufen. */
const MEDIEN_ANZEIGEN = /^(image\/(jpeg|png|webp|gif)|audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a|3gpp|amr)|video\/(mp4|webm|3gpp|quicktime))$/;
app.get("/medien/:id", async (req, res) => {
  const id = String(req.params.id);
  let m = null;
  try {
    m = await store.getMedia(id);
  } catch (err) {
    console.error("Aufnahme nicht lesbar:", err.message);
    return res.sendStatus(500);
  }
  if (!m) return res.sendStatus(404);
  const bytes = Buffer.from(m.bytes);
  /* Nur der reine Typ zaehlt (ohne ";codecs=..."), und nur aus einer
     festen Liste - "audio/x+xml" wuerde der Browser sonst als Seite mit
     Skript darstellen. Dazu eine Sandbox: Selbst wenn doch etwas als
     Dokument geoeffnet wird, laeuft darin kein Skript. */
  const grundTyp = String(m.mime || "").split(";")[0].trim().toLowerCase();
  const zeigen = MEDIEN_ANZEIGEN.test(grundTyp);
  res.setHeader("Content-Type", zeigen ? grundTyp : "application/octet-stream");
  /* Bei Ton und Video "allow-same-origin": Ohne das hat die Sandbox einen
     fremden Ursprung, 'self' passt nicht mehr und der Browser laedt das
     Video im eigenen Abspieler gar nicht (schwarzes Bild, 0:00). Skripte
     bleiben trotzdem aus - dafuer muesste "allow-scripts" dabeistehen. */
  const abspielen = zeigen && /^(audio|video)\//.test(grundTyp);
  res.setHeader("Content-Security-Policy",
    `sandbox${abspielen ? " allow-same-origin" : ""}; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  if (!zeigen || req.query.laden !== undefined) {
    let dateiName = "datei";
    try { dateiName = (await store.getMessage(id))?.datei?.name || dateiName; } catch {}
    res.setHeader("Content-Disposition",
      `attachment; filename="${dateiName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(dateiName)}`);
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
    let ende = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length || start > ende) {
      res.setHeader("Content-Range", `bytes */${bytes.length}`);
      return res.sendStatus(416);
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${ende}/${bytes.length}`);
    res.setHeader("Content-Length", ende - start + 1);
    return res.end(bytes.subarray(start, ende + 1));
  }
  res.setHeader("Content-Length", bytes.length);
  res.end(bytes);
});

app.get("/api/stats", async (req, res) => {
  /* Betriebszahlen (Token, Kosten, Uebersetzungen je Tag) gehen niemanden
     ausser den Betreiber etwas an - dieselbe Sperre wie /api/admin/daten. */
  if (!adminOk(req)) return res.status(401).json({ error: "Nur fuer Admin" });
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

/* Nach aussen nur "ich lebe" - genau das, was der Render-Healthcheck
   braucht. Alle Betriebsdetails (Restbudget, Kontingente, App-Fassung,
   Fehlertexte, Geraete-/Nachrichten-Fragmente) verrieten sonst jedem
   Besucher zu viel und gaeben einem Angreifer eine Landkarte. Die vollen
   Angaben gibt es nur mit Admin-Cookie. */
app.get("/health", (req, res) => {
  if (!adminOk(req)) return res.json({ ok: true });
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
      msgPerDayIp: MSG_PER_DAY_IP > 0 ? MSG_PER_DAY_IP : null,
      translationsPerDay: TRANSLATIONS_PER_DAY > 0 ? TRANSLATIONS_PER_DAY : null,
      translationsLeftToday: leftToday(),
    },
    geld: {
      stripe: geld.bezahlungAn,
      webhook: geld.webhookAn,
      play: play.playAn,
      preise: geld.verfuegbar(),
      kontingente: geld.KONTINGENT,
      letzterFehler: letzterGeldFehler,
    },
  });
});

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
  /* Wie Express mit "trust proxy 1": der LETZTE Eintrag ist der, den
     Render selbst angehaengt hat. Den ersten setzt der Besucher - wer
     dort Zufall eintraegt, umginge sonst jede Bremse. */
  const vor = socket.handshake.headers["x-forwarded-for"];
  if (vor) {
    const teile = String(vor).split(",").map((s) => s.trim()).filter(Boolean);
    if (teile.length) return teile[teile.length - 1];
  }
  return socket.handshake.address || "?";
}

io.on("connection", (socket) => {
  let room = null;
  let me = { name: "Gast", lang: "de", device: null };
  /* Schutz fuer alle Ereignisse dieser Verbindung: Fehlende oder kaputte
     Daten (emit("setLang") ohne Inhalt, text als Zahl ...) duerfen nur
     dieses eine Ereignis scheitern lassen, nie den Server. */
  const anmelden = socket.on.bind(socket);
  socket.on = (ereignis, fn) => anmelden(ereignis, (erstes, ...rest) => {
    const daten = erstes === undefined || erstes === null ? {} : erstes;
    try {
      const r = fn(daten, ...rest);
      if (r && typeof r.catch === "function") r.catch((e) => console.error(`Socket ${ereignis}:`, e?.message || e));
    } catch (e) {
      console.error(`Socket ${ereignis}:`, e?.message || e);
    }
  });
  const ip = sockAdresse(socket);
  /* Dasselbe "nicht zaehlen"-Cookie wie oben - der Handschlag traegt es
     mit, also bleiben auch Eintritt und Nachricht dieses Geraets draussen. */
  const internSock = istIntern({ headers: { cookie: socket.handshake.headers.cookie || "" } });
  /* Herkunft dieses Geraets (aus dem ?von-Cookie), um Eintritt/Demo/Nachricht
     der Quelle zuzuordnen. */
  const vonSock = istQuelle({ headers: { cookie: socket.handshake.headers.cookie || "" } });

  socket.on("join", async ({ roomCode, name, lang, device, build, speech, geheim }) => {
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

    /* Gehoert die Geraete-Kennung wirklich diesem Geraet? (gruppe.js) */
    socket.data.geraet = await gruppe.geraetPruefen(String(device || socket.id).slice(0, 60), geheim);
    /* Aus einer Gruppe entfernt? Dann bleibt die Tuer zu. */
    if (!(await gruppe.darfRein(gewuenscht, String(device || socket.id).slice(0, 60)))) {
      socket.emit("system", { type: "entfernt" });
      return;
    }
    /* Team-Abo voll? Wer schon dabei ist, kommt immer hinein. */
    if (!(await gruppe.platzFrei(gewuenscht, String(device || socket.id).slice(0, 60), teamGrenze))) {
      socket.emit("system", { type: "teamVoll" });
      return;
    }
    room = gewuenscht;
    /* Der Probe-Chat von der Startseite (Raum "demo-...") ist kein echter
       Eintritt - sonst blaeht er die Trichterzahl "Chat betreten" auf.
       Die Demo selbst wird ueber "first" im demo-Ereignis eigens gezaehlt. */
    if (vorher !== room && !internSock && !EIGEN.geraete.has(String(device || "")) && !room.startsWith("demo-")) {
      zaehle("eingetreten");
      zaehleQuelle(vonSock, "eingetreten");
    }
    if (vorher && vorher !== room) {
      socket.leave(vorher);
      socket.to(vorher).emit("system", { type: "left", name: me.name });
      anwesendMelden(vorher);
    }
    me = {
      name: String(name || "Gast").slice(0, 40),
      lang: clean(lang),
      device: String(device || socket.id).slice(0, 60),
    };
    socket.join(room);
    if (EIGEN.geraete.has(me.device)) { socket.emit("eigen"); eigenAktiv(me.device, "chat"); }
    try {
      socket.emit("history", await store.getHistory(room));
      /* Dauerhafte Lese-Haken: dem Beitretenden sagen, wie weit die anderen
         schon gelesen haben - dann sieht er das ✓✓ auch nach einem Neustart
         und wenn der andere gerade offline ist. */
      const gelesenBis = await store.getReadBisExcept(room, me.device);
      if (gelesenBis) socket.emit("gelesen", { device: null, bis: gelesenBis });
    } catch (err) {
      console.error("Verlauf nicht ladbar:", err.message);
      socket.emit("history", []);
    }
    socket.to(room).emit("system", { type: "joined", name: me.name });
    socket.data.wer = { name: me.name, device: me.device };
    anwesendMelden(room);
    gruppe.beigetreten(io, room, me);
    /* Klingelt es in diesem Chat gerade? Dann auch dem Neuen zeigen. */
    const laeuft = anrufe.get(room);
    if (laeuft && laeuft.device !== me.device && Date.now() - laeuft.at < ANRUF_KLINGELT_MS) {
      socket.emit("anrufKommt", { name: laeuft.name, video: laeuft.video });
    }
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
    if (room) gruppe.spracheNeu(io, room, me);
  });

  socket.on("send", async ({ text, replyTo }) => {
    if (!room || !text?.trim()) return;
    if (!take(`msg:${me.device}`, MSG_PER_MIN, 60 * 1000)) {
      socket.emit("tooFast");
      return;
    }
    /* Zusaetzliche Tagesgrenze je Adresse - faengt den ab, der den
       Geraetenamen rotiert, um die Minutengrenze zu umgehen. */
    if (!take(`msgtag:${ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) {
      socket.emit("tooFast");
      return;
    }
    if (!internSock && !EIGEN.geraete.has(me.device)) { zaehle("nachricht"); zaehleQuelle(vonSock, "nachricht"); }
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
    einladeBonus(room).catch(() => {});
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
    if (!take(`msgtag:${ip}`, MSG_PER_DAY_IP, 24 * 60 * 60 * 1000)) { socket.emit("tooFast"); return; }
    if (!internSock && !EIGEN.geraete.has(me.device)) { zaehle("nachricht"); zaehleQuelle(vonSock, "nachricht"); }
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
    einladeBonus(room).catch(() => {});
    pushToRoom(room, msg).catch((e) => console.error("Push-Lauf:", e.message));
  });

  /* Gruppen: Name, Mitglieder, Entfernen (gruppe.js). */
  gruppe.handler(io, socket, () => room, () => me, () => { room = null; }, async (r) => {
    if (OHNE_GRENZE.has(String(r).toLowerCase())) return "teamplus";   // Betreiber-Chat zum Testen
    const abo = await store.getAboByRoom(r);
    return laeuftNoch(abo) ? abo.plan : "frei";
  });

  /* Lesebestaetigung: jemand hat den Chat offen und alles bis "bis"
     gesehen. Nur an die anderen im Raum weiterreichen (nicht zurueck an
     den Melder), damit deren eigene Nachrichten die Lese-Haken bekommen.
     Bewusst fluechtig - nichts wird gespeichert. */
  socket.on("gelesen", ({ bis }) => {
    if (!room) return;
    const t = Number(bis);
    if (!Number.isFinite(t)) return;
    /* Dauerhaft merken, damit der Absender die Haken auch spaeter/nach
       Neustart sieht - nicht nur waehrend beide gerade online sind. */
    store.setRead(room, me.device, t).catch(() => {});
    socket.to(room).emit("gelesen", { device: me.device, bis: t });
  });

  /* "... schreibt gerade": winziges Live-Signal an die anderen im Raum.
     Der Client drosselt schon auf alle zwei Sekunden; die Bremse hier
     faengt nur einen Missbrauch ab. Nichts wird gespeichert. */
  /* Anruf beginnen: den anderen im Chat klingeln lassen - live und
     per Benachrichtigung, falls die App zu ist. */
  socket.on("anrufStart", ({ video } = {}) => {
    if (!room || !me.device) return;
    if (!take(`anrufStart:${me.device}`, 20, 60 * 60 * 1000)) return;
    const wer = { name: me.name, device: me.device, video: Boolean(video), at: Date.now() };
    anrufe.set(room, wer);
    socket.to(room).emit("anrufKommt", { name: wer.name, video: wer.video });
    anrufKlingeln(room, wer);
  });
  socket.on("anrufAngenommen", () => {
    if (!room) return;
    anrufe.delete(room);
    socket.to(room).emit("anrufAngenommen", { name: me.name });
  });
  socket.on("anrufEnde", () => {
    if (!room) return;
    anrufe.delete(room);
    socket.to(room).emit("anrufEnde", { name: me.name });
  });

  socket.on("tippt", () => {
    if (!room) return;
    if (!take(`tippt:${me.device}`, 40, 60 * 1000)) return;
    socket.to(room).emit("tippt", { name: me.name });
  });

  /* Reaktion setzen/entfernen (Herz, Daumen ...). Leeres Emoji hebt die
     eigene Reaktion auf. Wird gespeichert und an alle im Raum verteilt. */
  socket.on("reagieren", async ({ id, emoji }) => {
    if (!room || !id) return;
    if (!take(`reagieren:${me.device}`, 30, 60 * 1000)) return;
    const e = REAKTIONEN.includes(emoji) ? emoji : "";
    try {
      if ((await store.getMessage(String(id)))?.room !== room) return;
      await store.setReaction(String(id), me.device, e);
    } catch (err) {
      console.error("Reaktion nicht speicherbar:", err.message);
      return;
    }
    io.to(room).emit("reaktion", { id: String(id), device: me.device, emoji: e });
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
    /* Nur wer den geheimen Schluessel dieses Geraets hat, loescht "als" es. */
    if (!gruppe.darfAlsGeraet(socket)) { socket.emit("deleteFailed", { grund: "nicht erlaubt" }); return; }
    try {
      if ((await store.getMessage(String(id)))?.room !== room) { socket.emit("deleteFailed", { grund: "nicht erlaubt" }); return; }
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

  /* Aussprache-Hilfe anfordern - auf Anfrage, aehnlich begrenzt wie
     Bildtext, weil jeder Aufruf das Modell kostet. */
  socket.on("aussprache", ({ id, lang }) => {
    if (!room || !id) return;
    if (!take(`aussprache:${me.device}`, 12, 60 * 1000)) return;
    ausspracheHelfen(room, String(id), clean(lang)).catch(() => {});
  });

  /* Vorschau beim Tippen: wie kommt meine Nachricht beim anderen an -
     und zur Kontrolle zurueckuebersetzt. Nichts wird gespeichert. Kostet
     einen Modellaufruf, deshalb eng begrenzt und aufs Kontingent des
     Chats angerechnet. nr ordnet die Antwort dem richtigen Tippstand zu. */
  socket.on("vorschau", async ({ text, ziel, nr }) => {
    const t = String(text || "").trim().slice(0, 600);
    const zl = clean(ziel);
    if (!room || !t || !zl || zl === me.lang) return;
    if (!/\p{L}/u.test(t)) return;
    if (!take(`vorschau:${me.device}`, 20, 60 * 1000)) return;
    if (!(await imKontingent(room))) return;
    if (!take("tr:day", TRANSLATIONS_PER_DAY, 24 * 60 * 60 * 1000)) return;
    const zielName = LANG_NAMES[zl] || zl;
    const meinName = LANG_NAMES[me.lang] || me.lang;
    const prompt = `Du bist die Uebersetzungs-Engine eines Messengers. Uebersetze den Text natuerlich und umgangssprachlich nach ${zielName} (${zl}), so wie ein Muttersprachler ihn tippen wuerde. Uebersetze deine Uebersetzung danach woertlich zurueck nach ${meinName} (${me.lang}), damit der Schreiber pruefen kann, ob der Sinn stimmt. Behalte Emojis und Namen.
Text: """${t}"""
Antworte NUR mit JSON, ohne Markdown: {"uebersetzt":"<Text auf ${zl}>","zurueck":"<Rueckuebersetzung auf ${me.lang}>"}`;
    try {
      const { result: out, usage } = await claude(prompt);
      store.logUsage({
        room, target: zl, chars: t.length,
        inTokens: usage.inTokens, outTokens: usage.outTokens,
      }).catch(() => {});
      socket.emit("vorschauFertig", {
        nr,
        uebersetzt: String(out.uebersetzt || "").slice(0, 800),
        zurueck: String(out.zurueck || "").slice(0, 800),
      });
    } catch (err) {
      console.error("Vorschau fehlgeschlagen:", err.message);
    }
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
    if (first && !internSock) { await store.zaehle("demo").catch(() => {}); zaehleQuelle(vonSock, "demo"); }
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
    if (room) {
      socket.to(room).emit("system", { type: "left", name: me.name });
      anwesendMelden(room);
    }
  });
});

/* Wer ist gerade im Chat? Allen im Raum die Liste schicken (je Geraet
   einmal), damit die App "Iracema · im Chat" anzeigen kann. Nur Namen
   und Geraetekennung - nichts, was nicht ohnehin im Chat sichtbar ist. */
async function anwesendMelden(raum) {
  try {
    const socks = await io.in(raum).fetchSockets();
    const da = new Map();
    for (const so of socks) {
      const w = so.data?.wer;
      if (w?.device && !da.has(w.device)) da.set(w.device, { name: w.name, device: w.device });
    }
    io.to(raum).emit("anwesend", [...da.values()]);
  } catch {}
}

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
