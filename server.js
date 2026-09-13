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

app.use(express.json({ limit: "64kb" }));

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
const OPEN_PATHS = new Set(["/gate.html", "/api/gate", "/health", "/favicon.svg", "/manifest.json"]);
const isOpen = (p) => OPEN_PATHS.has(p) || p.startsWith("/brand/") || p.startsWith("/icons/");

app.post("/api/gate", (req, res) => {
  if (!gateOn) return res.json({ ok: true });
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

  const key = `${msgId}:${target}`;
  if (inFlight.has(key)) return inFlight.get(key);

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

  socket.on("join", async ({ roomCode, name, lang, device }) => {
    room = String(roomCode || "lobby").trim().toLowerCase().slice(0, 60);
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
    socket.to(room).emit("system", `${me.name} ist dazugekommen`);
  });

  socket.on("setLang", ({ lang }) => {
    me.lang = clean(lang);
  });

  socket.on("send", async ({ text }) => {
    if (!room || !text?.trim()) return;
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

  socket.on("need", ({ id, lang }) => {
    if (room) ensure(room, id, clean(lang)).catch(() => {});
  });

  socket.on("disconnect", () => {
    if (room) socket.to(room).emit("system", `${me.name} hat den Chat verlassen`);
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
  console.log("");
});
