/* --------------------------------------------------------------------
   Spielt Kaeufe aus Google Play durch, ohne Google zu brauchen: fetch
   wird fuer die Google-Adressen durch eine Attrappe ersetzt, die auch
   die Unterschrift des Dienstkontos nachprueft.

   Laeuft immer ohne Datenbank - auch wenn in .env eine DATABASE_URL
   steht. Ein Test hat in der echten Datenbank nichts verloren.

   Aufruf:  node play-test.mjs
-------------------------------------------------------------------- */
import crypto from "crypto";

process.env.DATABASE_URL = "";
process.env.ACCESS_CODE = "";
process.env.PORT = process.env.PORT || "3997";
process.env.PLAETZE_PLUS = "3";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_PLAY_PAKET = "app.diralo.twa";
process.env.GOOGLE_PLAY_DIENSTKONTO = Buffer.from(JSON.stringify({
  client_email: "diralo@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
})).toString("base64");

/* ------------------------- Google als Attrappe ------------------------- */
const belege = new Map();      // token -> Antwort von subscriptionsv2
const quittiert = [];
let anmeldungen = 0;
const echtesFetch = globalThis.fetch;

const antworte = (status, inhalt) =>
  new Response(JSON.stringify(inhalt), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (adresse, optionen = {}) => {
  const url = String(adresse);
  if (url === "https://oauth2.googleapis.com/token") {
    const jwt = new URLSearchParams(optionen.body).get("assertion");
    const [kopf, inhalt, unterschrift] = jwt.split(".");
    const echt = crypto.createVerify("RSA-SHA256").update(`${kopf}.${inhalt}`)
      .verify(publicKey, Buffer.from(unterschrift, "base64url"));
    const daten = JSON.parse(Buffer.from(inhalt, "base64url").toString());
    if (!echt || !daten.scope.includes("androidpublisher")) return antworte(400, { error: "invalid_grant" });
    anmeldungen++;
    return antworte(200, { access_token: "ya29.attrappe", expires_in: 3600 });
  }
  if (url.startsWith("https://androidpublisher.googleapis.com/")) {
    if (optionen.headers?.Authorization !== "Bearer ya29.attrappe") return antworte(401, { error: { message: "nicht angemeldet" } });
    if (!url.includes("/applications/app.diralo.twa/")) return antworte(404, { error: { message: "fremdes Paket" } });
    const quitt = url.match(/purchases\/subscriptions\/([^/]+)\/tokens\/([^/:]+):acknowledge$/);
    if (quitt) {
      quittiert.push(decodeURIComponent(quitt[2]));
      const b = belege.get(decodeURIComponent(quitt[2]));
      if (b) b.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
      return antworte(200, {});
    }
    const lesen = url.match(/subscriptionsv2\/tokens\/([^/?]+)$/);
    if (lesen) {
      const b = belege.get(decodeURIComponent(lesen[1]));
      return b ? antworte(200, b) : antworte(400, { error: { message: "Invalid token" } });
    }
    return antworte(404, { error: { message: "unbekannt" } });
  }
  return echtesFetch(adresse, optionen);
};

const inTagen = (t) => new Date(Date.now() + t * 86400000).toISOString();
function beleg(token, { produkt = "diralo_plus_monat", zustand = "SUBSCRIPTION_STATE_ACTIVE", ende = inTagen(30), vorgaenger } = {}) {
  belege.set(token, {
    subscriptionState: zustand,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: produkt, expiryTime: ende }],
    ...(vorgaenger ? { linkedPurchaseToken: vorgaenger } : {}),
  });
}

/* ------------------------------ Server ------------------------------ */
const BASIS = `http://127.0.0.1:${process.env.PORT}`;
await import("./server.js");
const store = await import("./store.js");
await new Promise((r) => setTimeout(r, 1200));

let fehler = 0;
function pruefe(name, ist, soll) {
  const gut = JSON.stringify(ist) === JSON.stringify(soll);
  if (!gut) fehler++;
  console.log(`${gut ? "ok  " : "FEHL"} ${name.padEnd(52)} ist=${JSON.stringify(ist)}${gut ? "" : " soll=" + JSON.stringify(soll)}`);
}
const plan = (room) => fetch(`${BASIS}/api/plan?room=${room}`).then((r) => r.json());
const post = (pfad, daten) =>
  fetch(BASIS + pfad, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(daten),
  }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

/* --- 1. Die Seite erfaehrt, was es bei Play gibt --- */
let p = await plan("play-eins");
pruefe("Play ist an", p.play?.an, true);
pruefe("Produktname fuer Plus monatlich", p.play?.produkte?.plus?.monat, "diralo_plus_monat");

/* --- 2. Unsinn wird abgewiesen --- */
let a = await post("/api/play-kauf", { room: "play-eins", token: "<script>" });
pruefe("kaputter Beleg: 400", a.status, 400);
a = await post("/api/play-kauf", { room: "play-eins", token: "gibt.es.nicht" });
pruefe("unbekannter Beleg: 400", a.status, 400);
beleg("fremd.produkt", { produkt: "ein_anderes_spiel" });
a = await post("/api/play-kauf", { room: "play-eins", token: "fremd.produkt" });
pruefe("fremdes Produkt: 400", a.status, 400);
pruefe("und nichts freigeschaltet", (await plan("play-eins")).plan, "frei");

/* --- 3. Ein echter Kauf --- */
beleg("tok.eins");
a = await post("/api/play-kauf", { room: "play-eins", token: "tok.eins" });
pruefe("Kauf eingetragen", [a.status, a.fertig, a.plan, a.room], [200, true, "plus", "play-eins"]);
pruefe("mit Verwaltungsschluessel", /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/.test(a.schluessel || ""), true);
pruefe("bei Google quittiert", quittiert.includes("tok.eins"), true);
pruefe("Anmeldung bei Google mit gueltiger Unterschrift", anmeldungen, 1);
p = await plan("play-eins");
pruefe("Chat laeuft auf Plus", [p.plan, p.bezahlt, p.herkunft], ["plus", true, "play"]);
const SCHLUESSEL = a.schluessel;

/* --- 4. Stiller Abgleich gibt keinen neuen Schluessel --- */
a = await post("/api/play-kauf", { room: "play-eins", token: "tok.eins", still: true });
pruefe("Abgleich: kein neuer Schluessel", [a.status, a.schluessel], [200, null]);
a = await post("/api/raeume", { room: "play-eins", schluessel: SCHLUESSEL });
pruefe("alter Schluessel gilt weiter", a.raeume, ["play-eins"]);

/* --- 5. Verwalten fuehrt in den Play Store --- */
a = await post("/api/verwalten", { room: "play-eins", schluessel: SCHLUESSEL });
pruefe("Verwaltung zeigt auf Google Play", String(a.url).startsWith("https://play.google.com/store/account/subscriptions"), true);
pruefe("mit unserem Paket", String(a.url).includes("package=app.diralo.twa"), true);

/* --- 6. Tarifwechsel: neuer Beleg, dasselbe Abo --- */
const vorher = await store.getAboByRoom("play-eins");
beleg("tok.zwei", { produkt: "diralo_familie_jahr", vorgaenger: "tok.eins" });
a = await post("/api/play-kauf", { room: "play-eins", token: "tok.zwei" });
const nachher = await store.getAboByRoom("play-eins");
pruefe("Wechsel landet im selben Abo", nachher.id, vorher.id);
pruefe("jetzt Familie", (await plan("play-eins")).plan, "familie");

/* --- 7. Noch nicht bezahlt --- */
beleg("tok.wartet", { zustand: "SUBSCRIPTION_STATE_PENDING" });
a = await post("/api/play-kauf", { room: "play-zwei", token: "tok.wartet" });
pruefe("ausstehende Zahlung: wartet", [a.fertig, a.wartet], [false, true]);
pruefe("und schaltet nichts frei", (await plan("play-zwei")).plan, "frei");

/* --- 8. Gekuendigt: laeuft bis zum Ende, danach frei --- */
beleg("tok.drei", { zustand: "SUBSCRIPTION_STATE_CANCELED", ende: inTagen(5) });
a = await post("/api/play-kauf", { room: "play-drei", token: "tok.drei" });
p = await plan("play-drei");
pruefe("gekuendigt, aber bezahlt: laeuft noch", [a.status, p.plan, p.status], [200, "plus", "gekuendigt"]);

/* Zeitraum vorbei: Beim naechsten Blick fragt der Server bei Google nach. */
belege.get("tok.drei").subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
belege.get("tok.drei").lineItems[0].expiryTime = inTagen(-1);
const abo3 = await store.getAboByRoom("play-drei");
await store.saveAbo({ ...abo3, period_end: Date.now() - 1000 });
p = await plan("play-drei");
pruefe("nach Ablauf wieder frei", [p.plan, p.bezahlt], ["frei", false]);

/* --- 9. Verlaengert: Google meldet ein neues Ende --- */
beleg("tok.vier", { ende: inTagen(30) });
await post("/api/play-kauf", { room: "play-vier", token: "tok.vier" });
belege.get("tok.vier").lineItems[0].expiryTime = inTagen(60);
const abo4 = await store.getAboByRoom("play-vier");
await store.saveAbo({ ...abo4, period_end: Date.now() - 1000 });
p = await plan("play-vier");
pruefe("verlaengert: laeuft weiter", [p.plan, p.bezahlt], ["plus", true]);
pruefe("mit neuem Ende", p.bisEnde > Date.now() + 50 * 86400000, true);

/* --- 10. Chat haengt an laufendem Abo: Kauf ok, Chat bleibt --- */
beleg("tok.fuenf");
a = await post("/api/play-kauf", { room: "play-vier", token: "tok.fuenf" });
pruefe("Kauf ok, aber ohne Chat", [a.status, a.fertig, a.room], [200, true, null]);
pruefe("Chat bleibt beim ersten Abo", (await store.getAboByRoom("play-vier")).id, abo4.id);

/* --- 11. Datei fuer Android wird ausgeliefert (sobald es sie gibt) --- */
const r = await fetch(`${BASIS}/.well-known/assetlinks.json`);
pruefe("assetlinks: kein 401 hinter dem Zugangswort", r.status === 200 || r.status === 404, true);

console.log(fehler ? `\n${fehler} Pruefung(en) fehlgeschlagen.` : "\nAlle Pruefungen bestanden.");
process.exit(fehler ? 1 : 0);
