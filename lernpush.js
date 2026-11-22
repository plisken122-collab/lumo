/* --------------------------------------------------------------------
   Diralo Lernen - Server-Teil

   1. Startpakete: je Situation rund 30 wichtige Saetze (Grundlage
      Englisch). Die App holt ein Paket in zwei Sprachen - meiner und der
      des anderen - und macht daraus Lernkarten. Uebersetzt wird einmal
      je Paket und Sprache, danach kommt es aus dem Zwischenspeicher.

   2. Taeglicher Satz: jeden Morgen um 9 Uhr (Lissabon) eine
      Benachrichtigung mit einem Satz aus dem eigenen Chat - in der
      Sprache des anderen, darunter die eigene. Nur in Chats mit zwei
      verschiedenen Sprachen (bei gleicher Sprache gibt es nichts zu
      lernen), hoechstens einmal je Geraet und Tag, abschaltbar.
-------------------------------------------------------------------- */

export const PAKETE = {
  paar: [
    "Good morning, my love.", "Did you sleep well?", "I miss you.", "I love you.", "What are you doing?",
    "When are you coming home?", "I'm on my way.", "I'll be there in ten minutes.", "Have you eaten yet?",
    "What shall we cook today?", "I'm hungry.", "I'm tired.", "Good night, sleep well.", "See you later.",
    "Thank you for everything.", "I'm sorry.", "Don't worry.", "Everything is fine.", "How was your day?",
    "I'm proud of you.", "Call me when you can.", "Can you pick me up?", "Let's go for a walk.",
    "The weather is beautiful today.", "Please buy bread.", "Where are the keys?", "Happy birthday!",
    "You look beautiful.", "I'm happy with you.", "Sleep well, my dear.",
  ],
  arbeit: [
    "Good morning, boss.", "What time do we start tomorrow?", "We start at seven.", "Wearing a helmet is mandatory.",
    "Where should I put this?", "I've finished.", "I need help.", "Can you show me how to do it?",
    "I didn't understand, please repeat.", "Please speak slowly.", "Lunch break is at twelve.", "I'm sick today.",
    "I'll be late, sorry.", "The machine is broken.", "We need more material.", "Be careful!", "Where is the toilet?",
    "How much do I earn per hour?", "When do we get paid?", "Tomorrow is a day off.", "Do we work on Saturday?",
    "I'm going home now.", "Pick the ripe tomatoes.", "Water the plants.", "Clean the tools.",
    "Close the door, please.", "It's very hot today.", "Drink enough water.", "Thank you, see you tomorrow.", "Good work!",
  ],
  alltag: [
    "Hello, good morning.", "Thank you very much.", "Excuse me.", "I don't understand.", "Do you speak English?",
    "How much does it cost?", "Where is the pharmacy?", "I need a doctor.", "It hurts here.", "I have an appointment.",
    "I have an allergy.", "Call an ambulance!", "Where is the bus stop?", "One ticket, please.",
    "Can I pay by card?", "Can I have the receipt?", "I'm looking for work.", "Where do I get a tax number?",
    "Here is my passport.", "Which documents do I need?", "Can you help me fill in this form?",
    "I'm looking for a room to rent.", "Is water included?", "The bill, please.", "Is it far?", "Turn left.",
    "Turn right.", "Go straight ahead.", "Is it open today?", "What time does it close?",
  ],
};

const TITEL = {
  de: "🎓 Dein Satz für heute", en: "🎓 Your sentence for today", pt: "🎓 A sua frase de hoje",
  es: "🎓 Tu frase de hoy", fr: "🎓 Ta phrase du jour", it: "🎓 La tua frase di oggi", nl: "🎓 Jouw zin van vandaag",
  pl: "🎓 Twoje zdanie na dziś", ru: "🎓 Фраза дня", uk: "🎓 Фраза дня", tr: "🎓 Bugünün cümlesi",
  ar: "🎓 جملة اليوم", ja: "🎓 今日のひとこと", hi: "🎓 आज का वाक्य", ur: "🎓 آج کا جملہ", bn: "🎓 আজকের বাক্য",
  pa: "🎓 ਅੱਜ ਦਾ ਵਾਕ", ne: "🎓 आजको वाक्य", sv: "🎓 Dagens mening",
};

const basis = (l) => String(l || "").slice(0, 2).toLowerCase();

/* Lissabon-Zeit, damit "9 Uhr" auch im Sommer stimmt. */
function lissabon() {
  const teile = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { tag: `${teile.year}-${teile.month}-${teile.day}`, stunde: Number(teile.hour) };
}

/* Kurz, mit Buchstaben, ohne Medien - und eine Uebersetzung in meine Sprache. */
function satzKandidaten(verlauf, meineSprache) {
  const raus = [];
  for (const m of verlauf) {
    if (!m || m.deleted || m.ort || m.bild || m.datei || m.gif || m.audioSeconds) continue;
    if (basis(m.lang) === basis(meineSprache)) continue;
    const ziel = String(m.text || "").trim();
    const mein = String((m.tr || {})[meineSprache] || "").trim();
    if (!ziel || !mein || ziel === mein) continue;
    if (ziel.length < 4 || ziel.length > 70 || ziel.split(/\s+/).length > 9 || !/\p{L}/u.test(ziel)) continue;
    raus.push({ id: m.id, ziel, mein });
  }
  return raus;
}

function zahlAus(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function einrichten({ app, store, claude, clean, take, langName, expoPush, webpush, pushReady }) {
  /* ------------------------- Startpakete ------------------------- */
  const zwischen = new Map();   // "paket|lang" -> [saetze]
  const laufend = new Map();

  async function paketIn(paket, lang) {
    const key = `${paket}|${lang}`;
    if (zwischen.has(key)) return zwischen.get(key);
    if (laufend.has(key)) return laufend.get(key);
    const job = (async () => {
      const quelle = PAKETE[paket];
      if (basis(lang) === "en") { zwischen.set(key, quelle); return quelle; }
      const prompt = `Translate each English sentence into natural, everyday ${langName(lang)} (${lang}) - the way a native speaker would say it in a chat. Keep the order and the number of sentences exactly. Keep punctuation.
Sentences (JSON): ${JSON.stringify(quelle)}
Reply ONLY with JSON, no markdown: {"s":["...", ...]}`;
      const { result } = await claude(prompt);
      const s = Array.isArray(result?.s) ? result.s.map((x) => String(x || "").trim().slice(0, 200)) : [];
      if (s.length !== quelle.length || s.some((x) => !x)) throw new Error("Paket unvollstaendig");
      zwischen.set(key, s);
      return s;
    })().finally(() => laufend.delete(key));
    laufend.set(key, job);
    return job;
  }

  app.get("/api/lernpaket", async (req, res) => {
    const paket = String(req.query.paket || "");
    const lang = clean(req.query.lang);
    if (!PAKETE[paket] || !lang) return res.status(400).json({ error: "paket und lang angeben" });
    if (!zwischen.has(`${paket}|${lang}`) && !take(`lernpaket:${req.ip}`, 12, 60 * 60 * 1000)) {
      return res.status(429).json({ error: "Zu viele Anfragen" });
    }
    try {
      res.json({ paket, lang, saetze: await paketIn(paket, lang) });
    } catch (err) {
      console.error("Lernpaket:", err.message);
      res.status(502).json({ error: "Gerade nicht verfuegbar" });
    }
  });

  /* ---------------------- Taeglicher Satz an/aus ---------------------- */
  app.post("/api/lernen-push", async (req, res) => {
    const device = String(req.body?.device || "").slice(0, 60);
    if (!device) return res.status(400).json({ error: "device fehlt" });
    if (!take(`lernenpush:${req.ip}`, 30, 60 * 1000)) return res.status(429).json({ error: "Zu schnell" });
    try {
      await store.lernAusSetzen(device, req.body?.an === false);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Nicht speicherbar" });
    }
  });

  /* ------------------------ Taeglicher Satz ------------------------ */
  async function taeglich(tag) {
    const subs = await store.alleSubscriptions();
    const aus = await store.lernAusListe();
    const erledigt = new Set();
    const verlaeufe = new Map();
    let gesendet = 0;
    for (const sub of subs) {
      if (erledigt.has(sub.device) || aus.has(sub.device)) continue;
      const istExpo = !!sub.data?.expo;
      if (!istExpo && !pushReady) continue;
      if (!verlaeufe.has(sub.room)) {
        verlaeufe.set(sub.room, await store.getHistory(sub.room, 300).catch(() => []));
      }
      const kandidaten = satzKandidaten(verlaeufe.get(sub.room), clean(sub.lang));
      if (!kandidaten.length) continue;   // gleiche Sprache oder noch nichts Passendes
      const satz = kandidaten[zahlAus(sub.device + tag) % kandidaten.length];
      const title = TITEL[basis(sub.lang)] || TITEL.en;
      const body = `${satz.ziel}\n= ${satz.mein}`;
      try {
        if (istExpo) await expoPush(sub, { title, body, room: sub.room, id: satz.id, typ: "lernen" });
        else await webpush.sendNotification(sub.data, JSON.stringify({ title, body, room: sub.room, id: satz.id }));
        erledigt.add(sub.device);
        gesendet++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await store.deleteSubscription(sub.endpoint).catch(() => {});
      }
    }
    console.log(`Taeglicher Satz ${tag}: ${gesendet} gesendet`);
  }

  setInterval(async () => {
    const { tag, stunde } = lissabon();
    if (stunde !== 9) return;
    try {
      if (!(await store.lernTagMerken(tag))) return;   // heute schon (auch nach Neustart)
      await taeglich(tag);
    } catch (err) {
      console.error("Taeglicher Satz:", err.message);
    }
  }, 5 * 60 * 1000).unref();

  return { taeglich };
}
