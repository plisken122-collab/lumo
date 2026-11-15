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
   uebersetze(text, ziel) liefert die Uebersetzung (oder null). */
export async function untertitelStarten(room, uebersetze) {
  if (!anrufAn || bots.has(room)) return;
  const konto = dienstkonto();
  if (!konto) return;
  const eintrag = { raum: null, hoerer: new Map() };
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

    const spracheVon = (p) => { try { return JSON.parse(p.metadata || "{}").lang || "en"; } catch { return "en"; } };
    const andereSprachen = (ausser) => [...new Set([...raum.remoteParticipants.values()]
      .filter((p) => p.identity !== ausser && p.identity !== BOT)
      .map(spracheVon))];

    raum.on(RoomEvent.TrackSubscribed, (track, _pub, person) => {
      if (track.kind !== TrackKind.KIND_AUDIO || person.identity === BOT) return;
      eintrag.hoerer.get(person.identity)?.();
      const lang = spracheVon(person);
      const stop = mitschreiben(new AudioStream(track, 16000, 1), lang, konto, async (text, fertig) => {
        if (!fertig) { senden({ von: person.identity, lang, text, fertig: false }); return; }
        const tr = {};
        for (const ziel of andereSprachen(person.identity)) {
          if (ziel.split("-")[0] === lang.split("-")[0]) continue;
          try { tr[ziel] = await uebersetze(text, ziel); } catch {}
        }
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
  e.raum?.disconnect().catch(() => {});
}

/* Liest Tonbloecke (16 kHz, mono) und gibt sie an Google. Ein Strom
   darf hoechstens etwa fuenf Minuten laufen - darum alle 4 Minuten
   einen neuen anfangen. Gibt eine Stopp-Funktion zurueck. */
function mitschreiben(ton, lang, konto, melden) {
  let aus = false;
  let strom = null;
  let seit = 0;
  let klient = null;

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
        if (!aus) console.error("Spracherkennung:", err.message?.slice(0, 160));
        strom = null;
      });
  };

  (async () => {
    try {
      await neuerStrom();
      for await (const block of ton) {
        if (aus) break;
        if (!strom || Date.now() - seit > 4 * 60 * 1000) await neuerStrom();
        const d = block.data;
        strom.write(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
      }
    } catch (err) {
      if (!aus) console.error("Mitschrift:", err.message?.slice(0, 160));
    } finally {
      try { strom?.end(); } catch {}
    }
  })();

  return () => {
    aus = true;
    try { strom?.end(); } catch {}
    try { ton.cancel?.(); } catch {}
  };
}
