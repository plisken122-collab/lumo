/* --------------------------------------------------------------------
   playkasse.js

   Alles, was mit Google Play zu tun hat, an einer Stelle - das
   Gegenstueck zu bezahlung.js.

   In der Android-App darf ein Abo nur ueber Google Play verkauft
   werden, nicht ueber Stripe. Der Kauf selbst laeuft im Geraet (Digital
   Goods API + Payment Request). Hier kommt nur der Beleg an, den Google
   dabei ausstellt: der purchaseToken. Den pruefen wir bei Google nach,
   bevor irgendetwas freigeschaltet wird - dem Browser glauben wir nie.

   Wie bei Stripe bewusst ohne Google-Bibliothek: Gebraucht werden ein
   signiertes JWT, ein Tausch gegen ein Zugangstoken und zwei Aufrufe.

   Fehlt GOOGLE_PLAY_PAKET oder GOOGLE_PLAY_DIENSTKONTO, ist der ganze
   Bereich aus. Die Preisseite zeigt in der App dann einen Hinweis statt
   der Knoepfe.
-------------------------------------------------------------------- */
import crypto from "crypto";

export const PAKET = process.env.GOOGLE_PLAY_PAKET || "";

/* Der Schluessel des Dienstkontos aus der Google Cloud. Darf als rohes
   JSON oder base64-verpackt in der Umgebung stehen - Render nimmt
   beides, aber manche Oberflaechen verschlucken Zeilenumbrueche. */
function dienstkontoLesen() {
  const roh = (process.env.GOOGLE_PLAY_DIENSTKONTO || "").trim();
  if (!roh) return null;
  try {
    const text = roh.startsWith("{") ? roh : Buffer.from(roh, "base64").toString("utf8");
    const k = JSON.parse(text);
    return k.client_email && k.private_key ? k : null;
  } catch {
    console.error("  GOOGLE_PLAY_DIENSTKONTO ist kein lesbarer Dienstkonto-Schluessel.");
    return null;
  }
}
const KONTO = dienstkontoLesen();

export const playAn = Boolean(PAKET && KONTO);

/* Ein Abo-Produkt je Tarif und Zeitraum, jedes mit genau einem
   Basis-Abo. Die Digital Goods API kennt nur Produkte, keine Basis-Abos -
   mehrere Zeitraeume unter einem Produkt waeren aus der App heraus
   nicht auswaehlbar. Genau so muessen sie in der Play Console heissen. */
export const PRODUKTE = {
  plus: { monat: "diralo_plus_monat", jahr: "diralo_plus_jahr" },
  familie: { monat: "diralo_familie_monat", jahr: "diralo_familie_jahr" },
  team: { monat: "diralo_team_monat", jahr: "diralo_team_jahr" },
  teamplus: { monat: "diralo_teamplus_monat", jahr: "diralo_teamplus_jahr" },
};

export function planZuProdukt(produkt) {
  for (const [plan, zeiten] of Object.entries(PRODUKTE)) {
    if (Object.values(zeiten).includes(produkt)) return plan;
  }
  return null;
}

/* Woran ein Abo aus Google Play in der Datenbank zu erkennen ist. Die
   Spalte subscription haelt sonst die Stripe-Kennung (sub_...). */
export const VORSILBE = "gp:";
export const istPlay = (abo) => String(abo?.subscription || "").startsWith(VORSILBE);

/* Wo man ein Play-Abo kuendigt. Das kann nur Google - wie bei Stripe
   bauen wir es nicht nach. */
export function verwaltungsAdresse(produkt) {
  const p = new URLSearchParams({ package: PAKET });
  if (produkt) p.set("sku", produkt);
  return `https://play.google.com/store/account/subscriptions?${p}`;
}

/* ---------------------------------------------------------------------
   Zugangstoken

   Das Dienstkonto unterschreibt ein kurzes JWT, Google tauscht es gegen
   ein Zugangstoken fuer eine Stunde. Das merken wir uns, statt fuer
   jeden Kauf neu zu tauschen.
--------------------------------------------------------------------- */
let zugang = { token: null, bis: 0 };

const b64url = (x) => Buffer.from(x).toString("base64url");

async function zugangsToken() {
  if (!playAn) throw new Error("Google Play ist nicht eingerichtet");
  if (zugang.token && Date.now() < zugang.bis - 60 * 1000) return zugang.token;

  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const inhalt = b64url(JSON.stringify({
    iss: KONTO.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
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

async function google(pfad, methode = "GET", rumpf) {
  const antwort = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PAKET)}/${pfad}`,
    {
      method: methode,
      headers: {
        Authorization: `Bearer ${await zugangsToken()}`,
        ...(rumpf ? { "Content-Type": "application/json" } : {}),
      },
      body: rumpf ? JSON.stringify(rumpf) : undefined,
    }
  );
  const text = await antwort.text();
  let inhalt;
  try { inhalt = text ? JSON.parse(text) : {}; } catch { inhalt = { rohtext: text.slice(0, 300) }; }
  if (!antwort.ok) {
    const fehler = new Error(inhalt?.error?.message || `HTTP ${antwort.status}`);
    fehler.status = antwort.status;
    throw fehler;
  }
  return inhalt;
}

/* ---------------------------------------------------------------------
   Einen Kaufbeleg nachschlagen

   Gibt zurueck, was wir fuer ein Abo brauchen - in denselben Begriffen
   wie bei Stripe, damit der Rest des Servers nicht wissen muss, woher
   ein Abo kommt.
--------------------------------------------------------------------- */
export async function kaufLesen(token) {
  const k = await google(`purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  const posten = k.lineItems?.[0] || {};
  const ende = posten.expiryTime ? Date.parse(posten.expiryTime) : null;

  /* Googles Zustaende auf unsere abbilden. "gekuendigt" heisst wie bei
     Stripe: bezahlt bis zum Ende des Zeitraums, danach frei. Waehrend der
     Nachfrist (Zahlung fehlgeschlagen, Google versucht es weiter) bleibt
     der Tarif, wie bei Stripes past_due. */
  const status = {
    SUBSCRIPTION_STATE_ACTIVE: "active",
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "past_due",
    SUBSCRIPTION_STATE_CANCELED: ende && ende > Date.now() ? "gekuendigt" : "canceled",
  }[k.subscriptionState] || "canceled";

  return {
    status,
    /* Noch nicht bezahlt (etwa Barzahlung am Kiosk ausstehend): nichts
       freischalten, aber auch nichts wegwerfen. */
    wartet: k.subscriptionState === "SUBSCRIPTION_STATE_PENDING",
    produkt: posten.productId || null,
    plan: planZuProdukt(posten.productId),
    ende,
    quittiert: k.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    /* Bei einem Tarifwechsel stellt Google einen neuen Beleg aus und
       verweist auf den alten. Das Abo dahinter bleibt dasselbe. */
    vorgaenger: k.linkedPurchaseToken || null,
  };
}

/* Jeder Kauf muss binnen drei Tagen quittiert werden. Sonst erstattet
   Google ihn von selbst und das Abo ist weg. */
export async function quittieren(produkt, token) {
  await google(
    `purchases/subscriptions/${encodeURIComponent(produkt)}/tokens/${encodeURIComponent(token)}:acknowledge`,
    "POST", {}
  );
}

/* ---------------------------------------------------------------------
   Statistik aus der Play Console (fuer die Admin-Seite)

   Google legt jeden Tag CSV-Berichte in einen Cloud-Storage-Ordner des
   Entwicklerkontos: Installationen je Tag und Store-Besuche je Quelle
   (auch nach utm_source). Das Dienstkonto braucht dafuer in der Play
   Console das Recht "App-Informationen ansehen und Berichte
   herunterladen". Gelesen wird mit eigenem Token (nur Lesen, Storage).
--------------------------------------------------------------------- */
const BERICHTE = process.env.PLAY_BERICHTE_BUCKET || "pubsite_prod_8313497320678553532";
let speicherZugang = { token: null, bis: 0 };

async function speicherToken() {
  if (!KONTO) throw new Error("Google Play ist nicht eingerichtet");
  if (speicherZugang.token && Date.now() < speicherZugang.bis - 60 * 1000) return speicherZugang.token;
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const inhalt = b64url(JSON.stringify({
    iss: KONTO.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_only",
    aud: "https://oauth2.googleapis.com/token",
    iat: jetzt, exp: jetzt + 3600,
  }));
  const unterschrift = crypto.createSign("RSA-SHA256")
    .update(`${kopf}.${inhalt}`).sign(KONTO.private_key).toString("base64url");
  const antwort = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${kopf}.${inhalt}.${unterschrift}` }).toString(),
  });
  const d = await antwort.json().catch(() => ({}));
  if (!antwort.ok || !d.access_token) throw new Error("Google-Anmeldung (Berichte): " + (d.error_description || d.error || antwort.status));
  speicherZugang = { token: d.access_token, bis: Date.now() + Number(d.expires_in || 3600) * 1000 };
  return speicherZugang.token;
}

/* Play-Berichte sind UTF-16 mit BOM; manche UTF-8. */
function csvLesen(buf) {
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString("utf16le")
    : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.slice(2)).swap16().toString("utf16le")
    : buf.toString("utf8").replace(/^\uFEFF/, "");
  const zeilen = [];
  for (const z of text.split(/\r?\n/)) {
    if (!z.trim()) continue;
    const felder = []; let f = "", q = false;
    for (let i = 0; i < z.length; i++) {
      const c = z[i];
      if (q) { if (c === '"' && z[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true;
      else if (c === ",") { felder.push(f); f = ""; }
      else f += c;
    }
    felder.push(f);
    zeilen.push(felder);
  }
  const kopf = (zeilen.shift() || []).map((h) => h.trim().toLowerCase());
  return zeilen.map((z) => Object.fromEntries(kopf.map((h, i) => [h, (z[i] || "").trim()])));
}

async function bericht(pfad) {
  const token = await speicherToken();
  const a = await fetch(`https://storage.googleapis.com/storage/v1/b/${BERICHTE}/o/${encodeURIComponent(pfad)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (a.status === 404) return [];
  if (!a.ok) throw new Error(`Bericht ${pfad.split("/").pop()}: HTTP ${a.status}` + (a.status === 403 ? " (Recht \"Berichte herunterladen\" fehlt?)" : ""));
  return csvLesen(Buffer.from(await a.arrayBuffer()));
}

const zahl = (x) => Number(String(x || "0").replace(/[^0-9.-]/g, "")) || 0;
const spalte = (z, ...namen) => { for (const n of namen) if (z[n] !== undefined) return z[n]; return ""; };

/* Letzte 28 Tage: Installationen, aktive Geraete, Store-Besucher und
   Installationen je Quelle (utm_source). */
let statistikZwischen = { wert: null, bis: 0 };
export async function statistik() {
  if (statistikZwischen.wert && Date.now() < statistikZwischen.bis) return statistikZwischen.wert;
  const jetzt = new Date();
  const monate = [0, 1].map((m) => {
    const d = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - m, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const seit = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const inst = [], quelle = [];
  for (const m of monate) {
    inst.push(...await bericht(`stats/installs/installs_${PAKET}_${m}_overview.csv`));
    quelle.push(...await bericht(`stats/store_performance/store_performance_${PAKET}_${m}_traffic_source.csv`));
  }
  const imZeitraum = (z) => String(spalte(z, "date")).slice(0, 10) >= seit;
  const tage = inst.filter(imZeitraum).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const installationen = tage.reduce((s, z) => s + zahl(spalte(z, "daily device installs", "daily user installs")), 0);
  const deinstalliert = tage.reduce((s, z) => s + zahl(spalte(z, "daily device uninstalls", "daily user uninstalls")), 0);
  const letzte = tage[tage.length - 1] || {};
  const aktiv = zahl(spalte(letzte, "active device installs", "total user installs"));
  const jeQuelle = {};
  let besucher = 0, gewonnen = 0;
  for (const z of quelle.filter(imZeitraum)) {
    const v = zahl(spalte(z, "store listing visitors")), g = zahl(spalte(z, "store listing acquisitions"));
    besucher += v; gewonnen += g;
    const k = spalte(z, "utm source") || spalte(z, "traffic source") || "?";
    jeQuelle[k] ||= { besucher: 0, installationen: 0 };
    jeQuelle[k].besucher += v; jeQuelle[k].installationen += g;
  }
  const wert = {
    seit, bis: String(letzte.date || "").slice(0, 10) || null,
    installationen, deinstalliert, aktiv, besucher, gewonnen,
    quote: besucher ? Math.round((gewonnen / besucher) * 1000) / 10 : null,
    jeQuelle, tage: tage.map((z) => ({ tag: String(z.date).slice(0, 10), n: zahl(spalte(z, "daily device installs", "daily user installs")) })),
  };
  statistikZwischen = { wert, bis: Date.now() + 60 * 60 * 1000 };
  return wert;
}
