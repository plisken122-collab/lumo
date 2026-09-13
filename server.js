import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* ---------------------------------------------------------------
   Speicher im Arbeitsspeicher. Reicht fuer den Test.
   Fuer die echte App spaeter durch Postgres ersetzen.
---------------------------------------------------------------- */
const rooms = new Map(); // code -> { messages: [] }
const inFlight = new Set(); // verhindert doppelte Uebersetzungsanfragen

function room(code) {
  if (!rooms.has(code)) rooms.set(code, { messages: [] });
  return rooms.get(code);
}

/* Sprachen inklusive regionaler Varianten. Muss zur Liste in public/index.html passen. */
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

/* Regionale Eigenheiten, die eine reine Uebersetzung sonst verfehlt. */
const HINTS = {
  "pt-BR": "Brasilianisch: 'voce' statt 'tu', Gerundium ('estou fazendo', nicht 'estou a fazer'), brasilianischer Wortschatz (onibus, trem, celular, legal, cara, a gente, bacana). Keine Mesoklise, kein europaeischer Satzbau.",
  "pt-PT": "Europaeisch: informelles 'tu', Infinitivkonstruktion ('estou a fazer'), portugiesischer Wortschatz (autocarro, comboio, telemovel, fixe, pa, se calhar).",
  "es-419": "Lateinamerikanisch: kein 'vosotros', neutraler Wortschatz ohne Regionalismen aus Spanien.",
  es: "Spanien: 'vosotros' erlaubt, Wortschatz aus Spanien (coche, movil, vale, guay).",
  "en-US": "US-Schreibweise und US-Wortschatz.",
  en: "Britische Schreibweise und britischer Wortschatz.",
  "de-CH": "Schweizer Hochdeutsch: kein Eszett, Schweizer Wortschatz (Velo, Natel, parkieren, Znueni).",
  "zh-TW": "Traditionelle Schriftzeichen, taiwanischer Sprachgebrauch.",
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
  return JSON.parse(text.replace(/```json|```/g, "").trim());
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

/* Uebersetzt eine Nachricht in eine Zielsprache und meldet das Ergebnis an den Raum. */
async function ensure(code, msgId, target) {
  const r = rooms.get(code);
  if (!r) return;
  const msg = r.messages.find((m) => m.id === msgId);
  if (!msg) return;
  if (msg.lang === target || msg.tr[target]) return;

  const key = `${code}:${msgId}:${target}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    const out = await translate(msg.text, target);
    if (out.detected && !msg.detected && CODES.includes(out.detected)) {
      msg.lang = out.detected;
      msg.detected = true;
      io.to(code).emit("lang", { id: msgId, lang: out.detected });
    }
    if (msg.lang !== target) {
      msg.tr[target] = out.translation;
      io.to(code).emit("translated", { id: msgId, lang: target, text: out.translation });
    }
  } catch (err) {
    console.error("Uebersetzung fehlgeschlagen:", err.message);
    io.to(code).emit("translationError", { id: msgId, lang: target });
  } finally {
    inFlight.delete(key);
  }
}

io.on("connection", (socket) => {
  let code = null;
  let me = { name: "Gast", lang: "de" };

  const clean = (l) => (CODES.includes(l) ? l : "de");

  socket.on("join", ({ roomCode, name, lang }) => {
    code = (roomCode || "lobby").trim().toLowerCase();
    me = { name: (name || "Gast").slice(0, 40), lang: clean(lang) };
    socket.join(code);
    socket.emit("history", room(code).messages);
    socket.to(code).emit("system", `${me.name} ist dazugekommen`);
  });

  socket.on("setLang", ({ lang }) => {
    me.lang = clean(lang);
  });

  socket.on("send", ({ text }) => {
    if (!code || !text?.trim()) return;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      from: socket.id,
      name: me.name,
      text: text.trim().slice(0, 4000),
      lang: me.lang,
      detected: false,
      tr: {},
      at: Date.now(),
    };
    room(code).messages.push(msg);
    io.to(code).emit("message", msg);
  });

  socket.on("need", ({ id, lang }) => {
    if (code) ensure(code, id, clean(lang));
  });

  socket.on("disconnect", () => {
    if (code) socket.to(code).emit("system", `${me.name} hat den Chat verlassen`);
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, key: Boolean(API_KEY), langs: CODES.length }));

/* Beim Start die Adresse im lokalen Netz ausgeben - damit findet das Handy den Server. */
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === "IPv4" && !iface.internal) return iface.address;
  }
  return null;
}

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
  } else {
    console.log(`  Keine Netzwerkadresse gefunden - bist du mit dem WLAN verbunden?\n`);
  }
  if (!API_KEY) console.log("  WARNUNG: ANTHROPIC_API_KEY fehlt in .env - es wird nicht uebersetzt.\n");
});
