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

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const http = createServer(app);
const io = new Server(http);

/* 64 KB reichen fuer alles Normale. Sprachnachrichten sind die einzige
   Ausnahme und bringen ihre eigene, groessere Grenze mit - deshalb laeuft
   dieser eine Pfad hier vorbei, statt das Limit fuer alles anzuheben. */
const kleinesJson = express.json({ limit: "64kb" });
app.use((req, res, next) => {
  if (req.path === "/api/voice") return next();
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

/* Diese Pfade muessen ohne Zugangswort erreichbar sein, sonst laesst sich
   die Eingabeseite nicht darstellen. */
/* /sw.js gehoert dazu: Der Service Worker enthaelt nichts Vertrauliches,
   muss sich aber erneuern koennen - und laesst sich so auch von aussen
   pruefen, um festzustellen, welche Fassung wirklich ausgeliefert wird. */
const OPEN_PATHS = new Set(["/gate.html", "/api/gate", "/health", "/favicon.svg", "/manifest.json", "/i18n.js", "/sw.js"]);
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
    return res.status(401).sendFile(join(__dirname, "public", "gate.html"));
  }
  res.status(401).json({ error: "Zugang gesperrt" });
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
        body: body || msg.text,
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
  const { subscription, room, device, name, lang } = req.body || {};
  if (!pushReady) return res.status(503).json({ error: "Push ist nicht eingerichtet" });
  if (!subscription?.endpoint || !room || !device) {
    return res.status(400).json({ error: "Angaben unvollstaendig" });
  }
  try {
    await store.saveSubscription({
      endpoint: subscription.endpoint,
      room: String(room).toLowerCase().slice(0, 60),
      device: String(device).slice(0, 60),
      name: String(name || "Gast").slice(0, 40),
      lang: clean(lang),
      data: subscription,
    });
    res.json({ ok: true });
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
    limits: {
      msgPerMin: MSG_PER_MIN,
      translationsPerDay: TRANSLATIONS_PER_DAY > 0 ? TRANSLATIONS_PER_DAY : null,
      translationsLeftToday: leftToday(),
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

io.on("connection", (socket) => {
  let room = null;
  let me = { name: "Gast", lang: "de", device: null };

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
    room = String(roomCode || "lobby").trim().toLowerCase().slice(0, 60);
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

  socket.on("send", async ({ text }) => {
    if (!room || !text?.trim()) return;
    if (!take(`msg:${me.device}`, MSG_PER_MIN, 60 * 1000)) {
      socket.emit("tooFast");
      return;
    }
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      room,
      device: me.device,
      name: me.name,
      text: text.trim().slice(0, 4000),
      lang: me.lang,
      detected: false,
      tr: {},
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

  /* Loeschen fuer alle. Nur die eigene Nachricht - geprueft wird am
     Geraet, das sie geschrieben hat, nicht an dem, was der Browser
     behauptet zu duerfen. */
  socket.on("deleteForAll", async ({ id }) => {
    if (!room || !id) return;
    try {
      const ok = await store.deleteForAll(String(id), me.device);
      if (ok) io.to(room).emit("deleted", { id: String(id) });
    } catch (err) {
      console.error("Loeschen fehlgeschlagen:", err.message);
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
  console.log(`\n  lumo laeuft.\n`);
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
