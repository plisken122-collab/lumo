/* --------------------------------------------------------------------
   sprache.js

   Natuerliche Stimmen fuer Vorlesen und Dolmetscher. Die Stimmen der
   Handys klingen je nach Geraet roboterhaft oder sprechen eine fremde
   Sprache mit falscher Aussprache. Google Cloud Text-to-Speech liefert
   neuronale Stimmen in allen Diralo-Sprachen.

   Angemeldet wird mit demselben Dienstkonto wie bei Google Play
   (GOOGLE_PLAY_DIENSTKONTO) - es gehoert zum selben Cloud-Projekt.
   Ohne Dienstkonto ist der Bereich aus; die App nimmt dann die Stimme
   des Handys.
-------------------------------------------------------------------- */
import crypto from "crypto";

function dienstkontoLesen() {
  const roh = (process.env.GOOGLE_PLAY_DIENSTKONTO || "").trim();
  if (!roh) return null;
  try {
    const text = roh.startsWith("{") ? roh : Buffer.from(roh, "base64").toString("utf8");
    const k = JSON.parse(text);
    return k.client_email && k.private_key ? k : null;
  } catch {
    return null;
  }
}
const KONTO = dienstkontoLesen();
export const spracheAn = Boolean(KONTO) && process.env.STIMMEN_AUS !== "1";

const b64url = (x) => Buffer.from(x).toString("base64url");
let zugang = { token: null, bis: 0 };

async function zugangsToken() {
  if (zugang.token && Date.now() < zugang.bis - 60 * 1000) return zugang.token;
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const inhalt = b64url(JSON.stringify({
    iss: KONTO.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: jetzt,
    exp: jetzt + 3600,
  }));
  const unterschrift = crypto.createSign("RSA-SHA256")
    .update(`${kopf}.${inhalt}`).sign(KONTO.private_key).toString("base64url");
  const antwort = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${kopf}.${inhalt}.${unterschrift}`,
    }).toString(),
  });
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok || !daten.access_token) {
    throw new Error("Google-Anmeldung: " + (daten.error_description || daten.error || `HTTP ${antwort.status}`));
  }
  zugang = { token: daten.access_token, bis: Date.now() + Number(daten.expires_in || 3600) * 1000 };
  return zugang.token;
}

async function tts(pfad, rumpf) {
  const antwort = await fetch(`https://texttospeech.googleapis.com/v1/${pfad}`, {
    method: rumpf ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${await zugangsToken()}`,
      "x-goog-user-project": KONTO.project_id,
      ...(rumpf ? { "Content-Type": "application/json" } : {}),
    },
    body: rumpf ? JSON.stringify(rumpf) : undefined,
  });
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) throw new Error("Text-to-Speech: " + (daten.error?.message || `HTTP ${antwort.status}`));
  return daten;
}

/* Diralo-Sprachcode -> Sprachcode der Stimmen. */
const REGION = {
  de: "de-DE", "de-CH": "de-DE", en: "en-GB", "en-US": "en-US", es: "es-ES", "es-419": "es-US",
  fr: "fr-FR", it: "it-IT", nl: "nl-NL", pl: "pl-PL", ru: "ru-RU", uk: "uk-UA", tr: "tr-TR",
  ar: "ar-XA", zh: "cmn-CN", "zh-TW": "cmn-TW", ja: "ja-JP", ko: "ko-KR", hi: "hi-IN",
  sv: "sv-SE", ro: "ro-RO", da: "da-DK", no: "nb-NO", fi: "fi-FI", hu: "hu-HU", th: "th-TH",
  vi: "vi-VN", id: "id-ID", "pt-PT": "pt-PT", "pt-BR": "pt-BR", pt: "pt-BR", el: "el-GR",
  cs: "cs-CZ", he: "he-IL",
};
export const stimmSprache = (code) => REGION[code] || REGION[String(code || "").split("-")[0]] || "en-GB";

/* Beste Stimme je Sprache: Chirp3-HD > Neural2 > Wavenet > Standard.
   Die Liste holen wir einmal und merken sie uns. */
let stimmen = null;
async function besteStimme(sprache) {
  if (!stimmen) stimmen = (await tts("voices")).voices || [];
  const rang = (n) => (n.includes("Chirp3-HD") ? 4 : n.includes("Neural2") ? 3 : n.includes("Wavenet") ? 2 : n.includes("Standard") ? 1 : 0);
  const passend = stimmen.filter((v) => (v.languageCodes || []).includes(sprache) && rang(v.name) > 0);
  if (!passend.length) return null;
  /* Bei gleichem Rang eine weibliche Stimme - klingt in Tests freundlicher. */
  passend.sort((a, b) => rang(b.name) - rang(a.name) || (b.ssmlGender === "FEMALE") - (a.ssmlGender === "FEMALE"));
  return passend[0].name;
}

/* Fertige Aufnahmen im Speicher - gleiche Saetze kosten nur einmal. */
const ablage = new Map();       // id -> { mp3: Buffer, at }
const nachText = new Map();     // schluessel -> id
const MAX = 400;

export async function sprechen(text, code, langsam = false) {
  const sprache = stimmSprache(code);
  const schluessel = `${sprache}|${langsam ? 1 : 0}|${text}`;
  const da = nachText.get(schluessel);
  if (da && ablage.has(da)) return { id: da, neu: false };
  const name = await besteStimme(sprache);
  const daten = await tts("text:synthesize", {
    input: { text },
    voice: name ? { languageCode: sprache, name } : { languageCode: sprache },
    audioConfig: { audioEncoding: "MP3", speakingRate: langsam ? 0.75 : 1.0 },
  });
  const id = crypto.randomBytes(9).toString("base64url");
  ablage.set(id, { mp3: Buffer.from(daten.audioContent || "", "base64"), at: Date.now() });
  nachText.set(schluessel, id);
  if (ablage.size > MAX) {
    const aeltester = ablage.keys().next().value;
    ablage.delete(aeltester);
    for (const [k, v] of nachText) if (v === aeltester) nachText.delete(k);
  }
  return { id, neu: true };
}

export const aufnahme = (id) => ablage.get(String(id || ""))?.mp3 || null;
