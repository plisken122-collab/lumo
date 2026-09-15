/* --------------------------------------------------------------------
   bezahlung.js

   Alles, was mit Stripe zu tun hat, an einer Stelle.

   Bewusst ohne die Stripe-Bibliothek: Gebraucht werden drei Aufrufe und
   eine Unterschriftspruefung. Das sind ein paar Dutzend Zeilen gegen ein
   Paket mit hunderten Abhaengigkeiten - auf dem Weg, auf dem das Geld
   laeuft, ist weniger fremder Code das bessere Geschaeft.

   Fehlt STRIPE_SECRET_KEY, ist der ganze Bereich aus. Die App laeuft
   dann genau wie vorher weiter, die Preisseite zeigt statt der Knoepfe
   einen Hinweis. So kann nichts halb eingerichtet ins Netz gehen.
-------------------------------------------------------------------- */
import crypto from "crypto";

const SCHLUESSEL = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_GEHEIMNIS = process.env.STRIPE_WEBHOOK_SECRET || "";

export const bezahlungAn = Boolean(SCHLUESSEL);
export const webhookAn = Boolean(WEBHOOK_GEHEIMNIS);

/* Die Preis-Kennungen kommen aus der Umgebung, nicht aus dem Code: Sie
   unterscheiden sich zwischen Test- und Echtbetrieb, und ein Preis, der
   im Quelltext steht, wird irgendwann versehentlich mit veroeffentlicht. */
export const PREISE = {
  plus: {
    monat: process.env.STRIPE_PRICE_PLUS_MONAT || "",
    jahr: process.env.STRIPE_PRICE_PLUS_JAHR || "",
  },
  familie: {
    monat: process.env.STRIPE_PRICE_FAMILIE_MONAT || "",
    jahr: process.env.STRIPE_PRICE_FAMILIE_JAHR || "",
  },
};

/* Wie viele Uebersetzungen ein Chat im Monat bekommt. Der freie Wert
   gilt fuer jeden Chat ohne Mitgliedschaft. */
export const KONTINGENT = {
  frei: Number(process.env.KONTINGENT_FREI || 200),
  plus: Number(process.env.KONTINGENT_PLUS || 1500),
  familie: Number(process.env.KONTINGENT_FAMILIE || 5000),
};

/* Welche Preis-Kennungen wirklich hinterlegt sind. Die Preisseite fragt
   das ab, damit kein Knopf erscheint, der ins Leere fuehrt. */
export function verfuegbar() {
  const raus = {};
  for (const [plan, zeiten] of Object.entries(PREISE)) {
    raus[plan] = { monat: Boolean(zeiten.monat), jahr: Boolean(zeiten.jahr) };
  }
  return raus;
}

/* ---------------------------------------------------------------------
   Stripe spricht Formulardaten, kein JSON - auch fuer verschachtelte
   Angaben. Aus { a: { b: 1 } } wird a[b]=1.
--------------------------------------------------------------------- */
function alsFormular(wert, praefix = "", ziel = new URLSearchParams()) {
  if (wert === undefined || wert === null) return ziel;
  if (Array.isArray(wert)) {
    wert.forEach((w, i) => alsFormular(w, `${praefix}[${i}]`, ziel));
  } else if (typeof wert === "object") {
    for (const [k, v] of Object.entries(wert)) {
      alsFormular(v, praefix ? `${praefix}[${k}]` : k, ziel);
    }
  } else {
    ziel.append(praefix, String(wert));
  }
  return ziel;
}

async function stripe(pfad, daten, methode = "POST") {
  if (!bezahlungAn) throw new Error("STRIPE_SECRET_KEY fehlt");

  const kopf = {
    Authorization: `Bearer ${SCHLUESSEL}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  /* Bei GET gehoeren die Angaben in die Adresse, nicht in den Rumpf -
     einen Rumpf wuerde Stripe bei GET schlicht uebergehen. */
  const anhang = daten && methode === "GET" ? "?" + alsFormular(daten).toString() : "";

  const antwort = await fetch(`https://api.stripe.com/v1/${pfad}${anhang}`, {
    method: methode,
    headers: kopf,
    body: methode === "GET" ? undefined : alsFormular(daten).toString(),
  });

  const text = await antwort.text();
  let inhalt;
  try { inhalt = JSON.parse(text); } catch { inhalt = { rohtext: text.slice(0, 300) }; }

  if (!antwort.ok) {
    const grund = inhalt?.error?.message || `HTTP ${antwort.status}`;
    const fehler = new Error(grund);
    fehler.stripeArt = inhalt?.error?.type || null;
    throw fehler;
  }
  return inhalt;
}

/* ---------------------------------------------------------------------
   Kassengang anlegen

   client_reference_id traegt den Chat-Code mit. Der kommt spaeter im
   Webhook zurueck - so wissen wir, welcher Chat bezahlt wurde, ohne dem
   Browser vertrauen zu muessen.
--------------------------------------------------------------------- */
export async function kassengang({ preisId, raum, plan, herkunft, sprache }) {
  return stripe("checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: preisId, quantity: 1 }],
    client_reference_id: raum,
    locale: ["de", "pt", "en"].includes(sprache) ? sprache : "auto",
    success_url: `${herkunft}/preise?erfolg={CHECKOUT_SESSION_ID}`,
    cancel_url: `${herkunft}/preise?abgebrochen=1`,
    /* Steuer nach dem Land des Kaeufers. Muss in Stripe unter Tax
       eingeschaltet sein, sonst weist Stripe den Aufruf zurueck. */
    automatic_tax: { enabled: true },
    /* Fuer die Rechnung und als einzige Spur, die der Kaeufer spaeter
       vorzeigen kann, wenn er den Verwaltungsschluessel verliert. */
    customer_creation: "always",
    billing_address_collection: "auto",
    /* Tarif und Chat an beiden Stellen mitgeben. Die Meldung zum
       Kassengang bringt die Posten naemlich nicht mit, und spaetere
       Meldungen zum Abonnement kennen den Kassengang gar nicht mehr -
       ohne diese zwei Zeilen muesste der Server den Tarif raten. */
    subscription_data: { metadata: { raum, plan } },
    metadata: { raum, plan },
  });
}

export async function kassengangLesen(id) {
  return stripe(`checkout/sessions/${encodeURIComponent(id)}`,
    { "expand[]": "line_items" }, "GET");
}

/* Die Seite, auf der Stripe selbst kuendigen, Zahlungsmittel wechseln
   und Rechnungen herunterladen laesst. Das muessen wir nicht nachbauen,
   und wir sollten es auch nicht - dort liegen die Kartendaten. */
export async function verwaltungsSeite({ kunde, herkunft }) {
  return stripe("billing_portal/sessions", {
    customer: kunde,
    return_url: `${herkunft}/preise`,
  });
}

/* ---------------------------------------------------------------------
   Unterschrift des Webhooks pruefen

   Ohne diese Pruefung koennte jeder eine Nachricht an unseren Webhook
   schicken und sich eine Mitgliedschaft schenken. Der Rohtext muss
   dafuer unveraendert sein - deshalb laeuft der Pfad am JSON-Leser
   vorbei.
--------------------------------------------------------------------- */
export function webhookPruefen(rohtext, unterschrift, toleranzSekunden = 300) {
  if (!webhookAn) throw new Error("STRIPE_WEBHOOK_SECRET fehlt");
  if (!unterschrift) throw new Error("Unterschrift fehlt");

  let zeit = null;
  const gegeben = [];
  for (const teil of String(unterschrift).split(",")) {
    const [k, v] = teil.split("=");
    if (k === "t") zeit = Number(v);
    if (k === "v1" && v) gegeben.push(v);
  }
  if (!zeit || !gegeben.length) throw new Error("Unterschrift unlesbar");

  /* Gegen das Wiedereinspielen alter, einmal mitgeschnittener Meldungen. */
  const alter = Math.abs(Math.floor(Date.now() / 1000) - zeit);
  if (alter > toleranzSekunden) throw new Error(`Meldung ist ${alter} Sekunden alt`);

  const erwartet = crypto
    .createHmac("sha256", WEBHOOK_GEHEIMNIS)
    .update(`${zeit}.${rohtext}`, "utf8")
    .digest("hex");

  const stimmt = gegeben.some((g) => {
    if (g.length !== erwartet.length) return false;
    return crypto.timingSafeEqual(Buffer.from(g), Buffer.from(erwartet));
  });
  if (!stimmt) throw new Error("Unterschrift stimmt nicht");

  return JSON.parse(rohtext);
}

/* ---------------------------------------------------------------------
   Verwaltungsschluessel

   Wer bezahlt hat, bekommt ihn einmal zu sehen. Nur damit laesst sich
   kuendigen. Bei uns liegt allein der Abdruck - geht unsere Datenbank
   verloren, kann trotzdem niemand fremde Abonnements aufloesen.
--------------------------------------------------------------------- */
export function neuerVerwaltungsSchluessel() {
  /* Ohne i, l, o, 0 und 1: Die verwechselt man beim Abschreiben. */
  const zeichen = "abcdefghjkmnpqrstuvwxyz23456789";
  const roh = crypto.randomBytes(20);
  let raus = "";
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) raus += "-";
    raus += zeichen[roh[i] % zeichen.length];
  }
  return raus;
}

export const schluesselAbdruck = (s) =>
  crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

export function schluesselStimmt(gegeben, abdruck) {
  if (!gegeben || !abdruck) return false;
  const a = Buffer.from(schluesselAbdruck(gegeben));
  const b = Buffer.from(String(abdruck));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
