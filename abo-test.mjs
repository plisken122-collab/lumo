/* --------------------------------------------------------------------
   Spielt den Umbau durch: Die Mitgliedschaft gehoert dem Zahler und
   schaltet mehrere Chats frei, die sich ein Kontingent teilen.

   Der Server laeuft im selben Prozess, damit der Test den
   Verwaltungsschluessel setzen kann, ohne Stripe zu brauchen.

   Aufruf:  node abo-test.mjs
-------------------------------------------------------------------- */
process.env.PORT = process.env.PORT || "3998";
process.env.STRIPE_SECRET_KEY = "sk_test_attrappe";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_testgeheimnis";
process.env.KONTINGENT_FREI = "200";
process.env.KONTINGENT_PLUS = "1500";
process.env.PLAETZE_PLUS = "3";

const BASIS = `http://127.0.0.1:${process.env.PORT}`;

await import("./server.js");
const store = await import("./store.js");
const geld = await import("./bezahlung.js");
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

/* --- Ein Abo anlegen, wie es der Kauf tut --- */
const SCHLUESSEL = geld.neuerVerwaltungsSchluessel();
const abo = await store.saveAbo({
  id: store.neueAboId(), plan: "plus", status: "active",
  customer: "cus_test", subscription: "sub_test",
  manage_key: geld.schluesselAbdruck(SCHLUESSEL),
});
await store.raumHinzufuegen(abo.id, "chat-eins");

/* --- 1. Der bezahlte Chat und ein fremder --- */
let p = await plan("chat-eins");
pruefe("bezahlter Chat: Plus mit 1500", [p.plan, p.grenze, p.bezahlt], ["plus", 1500, true]);
pruefe("drei Plaetze, zwei noch frei", [p.plaetze, p.plaetzeFrei], [3, 2]);

p = await plan("chat-zwei");
pruefe("fremder Chat bleibt frei", [p.plan, p.grenze], ["frei", 200]);

/* --- 2. Falscher Schluessel --- */
let a = await post("/api/raum-dazu", { room: "chat-eins", schluessel: "aaaaa-bbbbb-ccccc-ddddd", neuerRaum: "chat-zwei" });
pruefe("falscher Schluessel wird abgewiesen", a.status, 403);
pruefe("und hat nichts veraendert", (await plan("chat-zwei")).plan, "frei");

/* --- 3. Zweiten Chat dazunehmen --- */
a = await post("/api/raum-dazu", { room: "chat-eins", schluessel: SCHLUESSEL, neuerRaum: "chat-zwei" });
pruefe("zweiter Chat dazu", [a.status, a.raeume], [200, ["chat-eins", "chat-zwei"]]);
p = await plan("chat-zwei");
pruefe("zweiter Chat laeuft jetzt auf Plus", [p.plan, p.grenze, p.bezahlt], ["plus", 1500, true]);

/* --- 4. Das Kontingent ist gemeinsam --- */
for (let i = 0; i < 7; i++) await store.logUsage({ room: "chat-eins", target: "de", chars: 5, inTokens: 1, outTokens: 1 });
for (let i = 0; i < 4; i++) await store.logUsage({ room: "chat-zwei", target: "pt", chars: 5, inTokens: 1, outTokens: 1 });
p = await plan("chat-eins");
pruefe("Verbrauch beider Chats zusammen", p.benutzt, 11);
pruefe("Rest entsprechend", p.rest, 1489);
pruefe("vom anderen Chat aus dieselbe Zahl", (await plan("chat-zwei")).benutzt, 11);

/* --- 5. Dritter geht, vierter nicht --- */
a = await post("/api/raum-dazu", { room: "chat-eins", schluessel: SCHLUESSEL, neuerRaum: "chat-drei" });
pruefe("dritter Chat geht noch", [a.status, a.raeume.length], [200, 3]);
a = await post("/api/raum-dazu", { room: "chat-eins", schluessel: SCHLUESSEL, neuerRaum: "chat-vier" });
pruefe("vierter wird abgelehnt", a.status, 409);
pruefe("vierter Chat blieb frei", (await plan("chat-vier")).plan, "frei");

/* --- 6. Ein Chat gehoert immer nur einem Abo --- */
const zweitesAbo = await store.saveAbo({
  id: store.neueAboId(), plan: "plus", status: "active",
  customer: "cus_2", subscription: "sub_2",
  manage_key: geld.schluesselAbdruck("zzzzz-zzzzz-zzzzz-zzzzz"),
});
await store.raumHinzufuegen(zweitesAbo.id, "fremd-chat");
a = await post("/api/raum-dazu", { room: "fremd-chat", schluessel: "zzzzz-zzzzz-zzzzz-zzzzz", neuerRaum: "chat-zwei" });
pruefe("fremdes Abo kann meinen Chat nicht nehmen", a.status, 409);
pruefe("mein Chat gehoert weiter mir", (await plan("chat-zwei")).grenze, 1500);

/* --- 7. Herausnehmen --- */
a = await post("/api/raum-weg", { room: "chat-eins", schluessel: SCHLUESSEL, raumWeg: "chat-drei" });
pruefe("Chat herausgenommen", [a.status, a.raeume.length], [200, 2]);
pruefe("er ist wieder frei", (await plan("chat-drei")).plan, "frei");

a = await post("/api/raum-weg", { room: "fremd-chat", schluessel: "zzzzz-zzzzz-zzzzz-zzzzz", raumWeg: "fremd-chat" });
pruefe("letzter Chat kann nicht heraus", a.status, 409);

/* --- 8. Kuendigung wirkt auf alle Chats --- */
await store.saveAbo({ id: abo.id, plan: "plus", status: "canceled" });
pruefe("nach dem Ende ist Chat eins frei", (await plan("chat-eins")).plan, "frei");
pruefe("und Chat zwei auch", (await plan("chat-zwei")).plan, "frei");

console.log(fehler ? `\n${fehler} Pruefung(en) fehlgeschlagen.` : "\nAlle Pruefungen bestanden.");
process.exit(fehler ? 1 : 0);
