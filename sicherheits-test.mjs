/* --------------------------------------------------------------------
   Sicherheitspruefungen gegen die eigene App.

   Prueft die Stellen, an denen eine fehlende Berechtigung teuer waere:
   fremde Nachrichten loeschen, fremde Mitgliedschaften aendern, Inhalte
   ueber Umwege auslesen.

   Aufruf:  node sicherheits-test.mjs
-------------------------------------------------------------------- */
process.env.PORT = process.env.PORT || "3996";
process.env.STRIPE_SECRET_KEY = "sk_test_attrappe";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_testgeheimnis";

const BASIS = `http://127.0.0.1:${process.env.PORT}`;
await import("./server.js");
const store = await import("./store.js");
const geld = await import("./bezahlung.js");
await new Promise((r) => setTimeout(r, 1200));

let fehler = 0;
const pruefe = (name, ist, soll) => {
  const gut = JSON.stringify(ist) === JSON.stringify(soll);
  if (!gut) fehler++;
  console.log(`${gut ? "ok  " : "FEHL"} ${name.padEnd(56)} ist=${JSON.stringify(ist)}${gut ? "" : " soll=" + JSON.stringify(soll)}`);
};
/* Der HTTP-Status kommt getrennt zurueck: Die Antworten haben selbst ein
   Feld "status" - beides zusammenzuwerfen verfaelscht die Pruefung. */
const post = (pfad, daten) =>
  fetch(BASIS + pfad, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(daten),
  }).then(async (r) => ({ code: r.status, inhalt: await r.json().catch(() => ({})) }));

/* ---------- Fremde Nachrichten loeschen ---------- */
await store.addMessage({
  id: "opfer", room: "geheim", device: "geraet-opfer", name: "Manuel",
  text: "Meine Kontonummer ist ...", lang: "pt", detected: false, at: Date.now(), tr: {},
});

pruefe("fremdes Geraet kann nicht loeschen",
  await store.deleteForAll("opfer", "geraet-angreifer"), false);
pruefe("die Nachricht steht noch",
  (await store.getMessage("opfer"))?.text, "Meine Kontonummer ist ...");
pruefe("das eigene Geraet darf loeschen",
  await store.deleteForAll("opfer", "geraet-opfer"), true);
pruefe("danach ist der Inhalt wirklich fort",
  (await store.getMessage("opfer"))?.text, "");

/* ---------- Fremde Mitgliedschaft ---------- */
const schluessel = geld.neuerVerwaltungsSchluessel();
const abo = await store.saveAbo({
  id: store.neueAboId(), plan: "plus", status: "active",
  customer: "cus_x", subscription: "sub_x",
  manage_key: geld.schluesselAbdruck(schluessel),
});
await store.raumHinzufuegen(abo.id, "bezahlt");

pruefe("ohne Schluessel keine Chatliste",
  (await post("/api/raeume", { room: "bezahlt", schluessel: "" })).code, 403);
pruefe("mit falschem Schluessel auch nicht",
  (await post("/api/raeume", { room: "bezahlt", schluessel: "aaaaa-bbbbb-ccccc-ddddd" })).code, 403);
pruefe("kein fremder Chat laesst sich anhaengen",
  (await post("/api/raum-dazu", { room: "bezahlt", schluessel: "falsch", neuerRaum: "meiner" })).code, 403);
pruefe("und keiner herausnehmen",
  (await post("/api/raum-weg", { room: "bezahlt", schluessel: "falsch", raumWeg: "bezahlt" })).code, 403);
pruefe("die Verwaltung bleibt zu",
  (await post("/api/verwalten", { room: "bezahlt", schluessel: "falsch" })).code, 403);
pruefe("mit dem richtigen Schluessel geht es",
  (await post("/api/raeume", { room: "bezahlt", schluessel })).code, 200);

/* ---------- Auskunft ueber fremde Chats ---------- */
await store.addMessage({
  id: "fremd1", room: "privat", device: "d", name: "X",
  text: "streng vertraulich", lang: "de", detected: false, at: Date.now(), tr: {},
});
const neues = await post("/api/neues", { chats: [{ room: "privat", seit: 0 }], device: "angreifer" });
pruefe("Auskunft gibt es, aber nur als Zahl", neues.inhalt.privat, 1);
pruefe("kein Nachrichtentext in der Antwort",
  /vertraulich/.test(JSON.stringify(neues.inhalt)), false);

/* ---------- Erfundene Angaben ---------- */
pruefe("erfundener Tarif wird abgelehnt",
  (await post("/api/kasse", { room: "x", plan: "gold", zeitraum: "monat" })).code, 400);
pruefe("Zaehler nimmt keine erfundenen Ereignisse",
  (await post("/api/zaehl", { ereignis: "beliebig" })).code, 204);
pruefe("und hat es nicht gezaehlt",
  Object.keys((await fetch(BASIS + "/api/trichter").then((r) => r.json())).summe).includes("beliebig"), false);

/* ---------- Webhook ---------- */
const ohne = await fetch(BASIS + "/api/stripe", { method: "POST", body: "{}" });
pruefe("Webhook ohne Unterschrift", ohne.status, 400);
const falsch = await fetch(BASIS + "/api/stripe", {
  method: "POST", headers: { "Stripe-Signature": "t=1,v1=abc" }, body: "{}",
});
pruefe("Webhook mit falscher Unterschrift", falsch.status, 400);

console.log(fehler ? `\n${fehler} Pruefung(en) fehlgeschlagen.` : "\nAlle Pruefungen bestanden.");
process.exit(fehler ? 1 : 0);
