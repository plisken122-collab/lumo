/* --------------------------------------------------------------------
   anruf.js

   Sprach- und Videoanrufe mit Live-Untertiteln.

   Bild und Ton laufen ueber LiveKit (WebRTC-Server, LIVEKIT_URL,
   LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Fuer jeden Anruf setzt sich ein
   unsichtbarer Helfer ("Untertitel-Bot") mit in den Raum: Er hoert jede
   Person einzeln, laesst Google mitschreiben (Speech-to-Text, in der
   Sprache der Person) und schickt den Text an alle - fertige Saetze
   zusaetzlich uebersetzt in die Sprache der anderen.

   Ohne LiveKit-Zugang ist der Bereich aus; ohne Google-Dienstkonto gibt
   es Anrufe ohne Untertitel.
-------------------------------------------------------------------- */
import { stimmSprache, dienstkonto } from "./sprache.js";

const URL = (process.env.LIVEKIT_URL || "").trim();
const KEY = (process.env.LIVEKIT_API_KEY || "").trim();
const SECRET = (process.env.LIVEKIT_API_SECRET || "").trim();
export const anrufAn = Boolean(URL && KEY && SECRET);

const BOT = "diralo-untertitel";

/* Verbrauch melden (Kostenschaetzung in der Uebersicht). Setzt der Server. */
let zaehler = () => {};
export const setZaehler = (fn) => { zaehler = fn; };

/* Schnelle Uebersetzung fuer Untertitel: Google Translate antwortet in
   rund 0,2 s - die KI-Uebersetzung braucht 1-2 s, zu lang fuer Live-
   Untertitel. Faellt Google aus (API aus, Fehler), gibt es null. */
let gAuth = null;
let googleAus = false;
async function googleUebersetzen(text, ziel, quelle) {
  if (googleAus) return null;
  const konto = dienstkonto();
  if (!konto) return null;
  try {
    if (!gAuth) {
      const { GoogleAuth } = await import("google-auth-library");
      gAuth = new GoogleAuth({
        credentials: { client_email: konto.client_email, private_key: konto.private_key },
        projectId: konto.project_id, scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
    }
    const token = (await (await gAuth.getClient()).getAccessToken()).token;
    const r = await fetch("https://translation.googleapis.com/language/translate/v2", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "x-goog-user-project": konto.project_id },
      body: JSON.stringify({ q: text, target: zielCode(ziel), source: zielCode(quelle), format: "text" }),
    });
    if (r.status === 403) { googleAus = true; console.error("Google Translate ist aus - Untertitel nutzen die KI-Uebersetzung."); return null; }
    if (!r.ok) return null;
    const j = await r.json();
    zaehler("uebersetzung_zeichen", text.length);
    return j.data?.translations?.[0]?.translatedText || null;
  } catch {
    return null;
  }
}
/* Diralo-Sprachcode -> Google-Translate-Code. */
const zielCode = (c) => {
  const x = String(c || "en");
  if (x === "zh-TW") return "zh-TW";
  if (x === "zh") return "zh-CN";
  if (x === "pt-PT") return "pt-PT";
  if (x.startsWith("pt")) return "pt";
  if (x === "no") return "no";
  return x.split("-")[0];
};
const raumName = (room) => "diralo-" + String(room).toLowerCase();

/* Zugangsschein fuer einen Teilnehmer. Name und Sprache stehen in den
   Metadaten - daran erkennt der Bot, in welcher Sprache er mitschreibt. */
export async function tokenFuer({ room, device, name, lang }) {
  const { AccessToken } = await import("livekit-server-sdk");
  const at = new AccessToken(KEY, SECRET, {
    identity: String(device).slice(0, 60),
    name: String(name || "Gast").slice(0, 40),
    metadata: JSON.stringify({ lang: String(lang || "en") }),
    ttl: "3h",
  });
  at.addGrant({ roomJoin: true, room: raumName(room), canPublish: true, canSubscribe: true, canPublishData: true });
  return { url: URL, token: await at.toJwt() };
}

/* ------------------------- Untertitel-Bot ------------------------- */
const bots = new Map();   // room -> { raum, hoerer: Map(identity -> stop) }

/* Startet den Bot fuer einen Raum, falls er nicht schon drin ist.
   uebersetze(text, ziel) liefert die Uebersetzung (oder null).
   budget (optional): { darf(), verbrauche(sek), ende() } - das Minuten-
   Kontingent der Untertitel. Ist es leer, laeuft der Anruf ohne
   Untertitel weiter, und alle bekommen einmal den Hinweis. */
const MAX_BOTS = Number(process.env.UNTERTITEL_MAX_BOTS || 15);

export async function untertitelStarten(room, uebersetze, budget = null) {
  if (!anrufAn || bots.has(room)) return;
  /* Jeder Untertitel-Bot ist eine eigene Verbindung im Server und kostet
     Spracherkennung - nie unbegrenzt viele gleichzeitig. */
  if (bots.size >= MAX_BOTS) { console.error("Untertitel: Hoechstzahl gleichzeitiger Anrufe erreicht"); return; }
  const konto = dienstkonto();
  if (!konto) return;
  const eintrag = { raum: null, hoerer: new Map(), budget };
  bots.set(room, eintrag);
  try {
    const { Room, RoomEvent, TrackKind, AudioStream } = await import("@livekit/rtc-node");
    const { AccessToken } = await import("livekit-server-sdk");
    const at = new AccessToken(KEY, SECRET, { identity: BOT, name: "Untertitel", ttl: "3h" });
    at.addGrant({ roomJoin: true, room: raumName(room), canPublish: false, canSubscribe: true, canPublishData: true });
    const raum = new Room();
    eintrag.raum = raum;

    const senden = (inhalt) => raum.localParticipant
      ?.publishData(new TextEncoder().encode(JSON.stringify(inhalt)), { reliable: true, topic: "untertitel" })
      .catch(() => {});

    /* Wer Untertitel ausgeschaltet hat (Schalter "CC" in der App). Ein
       Sprecher wird nur mitgeschrieben, wenn mindestens ein anderer
       Teilnehmer Untertitel sehen will - sonst kostet es nichts. */
    const ohneUntertitel = new Set();
    raum.on(RoomEvent.DataReceived, (payload, person, _art, thema) => {
      if (thema !== "untertitel-wunsch" || !person) return;
      try {
        const d = JSON.parse(Buffer.from(payload).toString());
        if (d.aus) ohneUntertitel.add(person.identity); else ohneUntertitel.delete(person.identity);
      } catch {}
    });
    const gebraucht = (sprecher) => [...raum.remoteParticipants.values()]
      .some((p) => p.identity !== sprecher && p.identity !== BOT && !ohneUntertitel.has(p.identity));

    const spracheVon = (p) => { try { return JSON.parse(p.metadata || "{}").lang || "en"; } catch { return "en"; } };
    const andereSprachen = (ausser) => [...new Set([...raum.remoteParticipants.values()]
      .filter((p) => p.identity !== ausser && p.identity !== BOT)
      .map(spracheVon))];

    raum.on(RoomEvent.TrackSubscribed, (track, _pub, person) => {
      if (track.kind !== TrackKind.KIND_AUDIO || person.identity === BOT) return;
      eintrag.hoerer.get(person.identity)?.();
      const lang = spracheVon(person);
      /* Waehrend des Sprechens: hoechstens alle 2,5 s und erst ab fuenf
         neuen Woertern vorlaeufig uebersetzen (nur die schnelle Google-
         Uebersetzung) - spart Zeichen. Fertige Saetze: schnell, sonst KI. */
      let zuletztZwischen = 0;
      let woerterZwischen = 0;
      const uebersetzeAlle = async (text, schnellNur) => {
        const tr = {};
        await Promise.all(andereSprachen(person.identity).map(async (ziel) => {
          if (ziel.split("-")[0] === lang.split("-")[0]) return;
          let t = await googleUebersetzen(text, ziel, lang);
          if (!t && !schnellNur) { try { t = await uebersetze(text, ziel); } catch {} }
          if (t) tr[ziel] = t;
        }));
        return tr;
      };
      const leer = () => {
        if (eintrag.leerGemeldet) return;
        eintrag.leerGemeldet = true;
        senden({ typ: "kontingent" });
      };
      const stop = mitschreiben(new AudioStream(track, 16000, 1), lang, konto, budget, leer, () => gebraucht(person.identity), async (text, fertig) => {
        if (!fertig) {
          senden({ von: person.identity, lang, text, fertig: false });
          const woerter = text.split(/\s+/).length;
          if (Date.now() - zuletztZwischen > 2500 && woerter - woerterZwischen >= 5) {
            zuletztZwischen = Date.now();
            woerterZwischen = woerter;
            const tr = await uebersetzeAlle(text, true);
            if (Object.keys(tr).length) senden({ von: person.identity, lang, text, tr, fertig: false });
          }
          return;
        }
        zuletztZwischen = 0;
        woerterZwischen = 0;
        const tr = await uebersetzeAlle(text, false);
        senden({ von: person.identity, lang, text, tr, fertig: true });
      });
      eintrag.hoerer.set(person.identity, stop);
    });
    raum.on(RoomEvent.ParticipantDisconnected, (person) => {
      eintrag.hoerer.get(person.identity)?.();
      eintrag.hoerer.delete(person.identity);
      if (![...raum.remoteParticipants.values()].some((p) => p.identity !== BOT)) beenden(room);
    });
    raum.on(RoomEvent.Disconnected, () => beenden(room));

    await raum.connect(URL, await at.toJwt(), { autoSubscribe: true, dynacast: false });
    /* Niemand kam dazu? Nach zwei Minuten wieder gehen. */
    setTimeout(() => {
      if (![...raum.remoteParticipants.values()].some((p) => p.identity !== BOT)) beenden(room);
    }, 2 * 60 * 1000);
  } catch (err) {
    console.error("Untertitel-Bot:", err.message);
    beenden(room);
  }
}

function beenden(room) {
  const e = bots.get(room);
  if (!e) return;
  bots.delete(room);
  for (const stop of e.hoerer.values()) { try { stop(); } catch {} }
  try { e.budget?.ende?.(); } catch {}
  e.raum?.disconnect().catch(() => {});
}

/* Liest Tonbloecke (16 kHz, mono) und gibt sie an Google - aber nur,
   solange jemand spricht. Stille kostet bei Google genauso wie Sprache;
   in einem Gespraech redet jeder nur etwa die Haelfte der Zeit.

   Sprache erkennen wir an der Lautstaerke ueber dem Grundrauschen. Ein
   kurzer Vorlauf (0,3 s) wird mitgeschickt, damit der Wortanfang nicht
   fehlt; nach 1,2 s Stille endet der Strom - Google liefert dann sofort
   den fertigen Satz, und die Pause kostet nichts. Gibt eine Stopp-
   Funktion zurueck. */
function mitschreiben(ton, lang, konto, budget, leer, gebraucht, melden) {
  let aus = false;
  let strom = null;
  let seit = 0;
  let klient = null;
  let rauschen = 300;        // geschaetztes Grundrauschen (RMS)
  let zuletztSprache = 0;
  let gesendetSek = 0;       // seit der letzten Meldung ans Budget
  const vorlauf = [];        // die letzten ~0,3 s

  const neuerStrom = async () => {
    if (!klient) {
      const speech = (await import("@google-cloud/speech")).default;
      const { GoogleAuth } = await import("google-auth-library");
      klient = new speech.SpeechClient({
        auth: new GoogleAuth({
          credentials: { client_email: konto.client_email, private_key: konto.private_key },
          projectId: konto.project_id,
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        }),
        projectId: konto.project_id,
      });
    }
    try { strom?.end(); } catch {}
    seit = Date.now();
    strom = klient.streamingRecognize({
      config: {
        encoding: "LINEAR16", sampleRateHertz: 16000,
        languageCode: stimmSprache(lang), enableAutomaticPunctuation: true,
      },
      interimResults: true,
    })
      .on("data", (d) => {
        const r = d.results?.[0];
        const text = r?.alternatives?.[0]?.transcript?.trim();
        if (text) melden(text, Boolean(r.isFinal));
      })
      .on("error", (err) => {
        if (!aus && !/Audio Timeout|OUT_OF_RANGE/i.test(err.message || "")) {
          console.error("Spracherkennung:", err.message?.slice(0, 160));
        }
        strom = null;
      });
  };
  const schliessen = () => { try { strom?.end(); } catch {} strom = null; };

  (async () => {
    try {
      for await (const block of ton) {
        if (aus) break;
        const d = block.data;
        let summe = 0;
        for (let i = 0; i < d.length; i++) summe += d[i] * d[i];
        const rms = Math.sqrt(summe / Math.max(1, d.length));
        const laut = rms > Math.max(450, rauschen * 3);
        if (!laut) rauschen = rauschen * 0.995 + rms * 0.005;
        const jetzt = Date.now();
        if (laut) zuletztSprache = jetzt;
        const spricht = jetzt - zuletztSprache < 1200;
        const puffer = Buffer.from(d.buffer, d.byteOffset, d.byteLength);

        if (!spricht || !gebraucht()) {
          if (strom) schliessen();
          vorlauf.push(puffer);
          if (vorlauf.length > 30) vorlauf.shift();
          continue;
        }
        if (budget && !budget.darf()) { if (strom) schliessen(); leer(); continue; }
        if (!strom || jetzt - seit > 4 * 60 * 1000) {
          await neuerStrom();
          for (const v of vorlauf.splice(0)) { strom?.write(v); gesendetSek += v.length / 32000; }
        }
        strom?.write(puffer);
        gesendetSek += puffer.length / 32000;   // 16 kHz * 2 Byte
        if (gesendetSek >= 1) { budget?.verbrauche(gesendetSek); zaehler("stt_sekunden", gesendetSek); gesendetSek = 0; }
      }
    } catch (err) {
      if (!aus) console.error("Mitschrift:", err.message?.slice(0, 160));
    } finally {
      if (gesendetSek > 0) { budget?.verbrauche(gesendetSek); zaehler("stt_sekunden", gesendetSek); }
      schliessen();
    }
  })();

  return () => {
    aus = true;
    schliessen();
    try { ton.cancel?.(); } catch {}
  };
}
