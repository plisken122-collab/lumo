/* --------------------------------------------------------------------
   Mitschrift auf dem Server

   Sprachnachrichten werden nur ueber ihren Text uebersetzt. Den schreibt
   normalerweise das Handy beim Aufnehmen mit. Klappt das nicht (Laerm,
   leise Stimme, Spracherkennung des Handys aus), kam die Nachricht beim
   anderen nur als Ton an - ohne Text, ohne Uebersetzung. Dann schreibt
   hier Google Speech-to-Text nachtraeglich mit (dasselbe Dienstkonto wie
   bei den Anruf-Untertiteln).

   Formate: WAV (App, LINEAR16), WebM/Ogg mit Opus (Browser). Andere
   (mp4/aac, mp3) laesst Google v1 nicht zu - dann bleibt es beim Ton.
-------------------------------------------------------------------- */
import { stimmSprache } from "./sprache.js";

let klient = null;
async function holeKlient(konto) {
  if (klient) return klient;
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
  return klient;
}

function einstellungen(bytes, mime) {
  if (mime === "audio/wav") {
    /* WAV-Kopf: Kanaele ab Byte 22, Abtastrate ab Byte 24. */
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") return null;
    return {
      encoding: "LINEAR16",
      sampleRateHertz: bytes.readUInt32LE(24) || 16000,
      audioChannelCount: bytes.readUInt16LE(22) || 1,
    };
  }
  if (mime === "audio/webm") return { encoding: "WEBM_OPUS", sampleRateHertz: 48000 };
  if (mime === "audio/ogg") return { encoding: "OGG_OPUS", sampleRateHertz: 48000 };
  return null;
}

/* Zu leise WAV-Aufnahmen lauter machen. Die Spracherkennung des Handys
   nimmt oft sehr leise auf (gemessen: Mittel -35 dB, Spitze -18 dB) -
   beim anderen kam dann "nichts" an. Angehoben wird so, dass die Spitze
   bei etwa -1 dB liegt, hoechstens aber 8-fach (+18 dB), damit reines
   Rauschen nicht zu einem lauten Zischen wird. Andere Formate bleiben. */
export function lauterMachen(bytes, mime) {
  if (mime !== "audio/wav" || bytes.length < 48 || bytes.toString("ascii", 0, 4) !== "RIFF") return bytes;
  if (bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(34) !== 16) return bytes;   // nur PCM 16 Bit
  /* "data"-Abschnitt suchen (meist ab Byte 36, manchmal spaeter). */
  let pos = 12, start = -1, laenge = 0;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString("ascii", pos, pos + 4);
    const groesse = bytes.readUInt32LE(pos + 4);
    if (id === "data") { start = pos + 8; laenge = Math.min(groesse, bytes.length - start); break; }
    pos += 8 + groesse + (groesse % 2);
  }
  if (start < 0 || laenge < 2) return bytes;
  let spitze = 0;
  for (let i = start; i + 1 < start + laenge; i += 2) {
    const v = Math.abs(bytes.readInt16LE(i));
    if (v > spitze) spitze = v;
  }
  if (!spitze) return bytes;
  const faktor = Math.min(8, (32767 * 0.89) / spitze);   // 0,89 = -1 dB
  if (faktor < 1.3) return bytes;                          // laut genug
  const neu = Buffer.from(bytes);
  for (let i = start; i + 1 < start + laenge; i += 2) {
    const v = Math.round(bytes.readInt16LE(i) * faktor);
    neu.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
  }
  return neu;
}

/* Gibt den erkannten Text zurueck oder null. */
export async function transkribieren(bytes, mime, lang, konto, sekunden = 0) {
  if (!konto) return null;
  const grund = einstellungen(bytes, mime);
  if (!grund) return null;
  const k = await holeKlient(konto);
  const anfrage = {
    config: { ...grund, languageCode: stimmSprache(lang), enableAutomaticPunctuation: true },
    audio: { content: bytes.toString("base64") },
  };
  let antwort;
  if (sekunden > 55) {
    const [vorgang] = await k.longRunningRecognize(anfrage);
    [antwort] = await vorgang.promise();
  } else {
    [antwort] = await k.recognize(anfrage);
  }
  const text = (antwort?.results || [])
    .map((r) => r.alternatives?.[0]?.transcript?.trim() || "")
    .filter(Boolean).join(" ").trim();
  return text || null;
}
