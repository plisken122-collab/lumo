/* --------------------------------------------------------------------
   Prueft die Ungelesen-Zaehlung: Was ist in meinen Chats neu, seit ich
   zuletzt hineingesehen habe?

   Der Server laeuft im selben Prozess, damit der Test Nachrichten
   ablegen kann, ohne einen zweiten Browser zu brauchen.

   Aufruf:  node neues-test.mjs
-------------------------------------------------------------------- */
process.env.PORT = process.env.PORT || "3997";

const BASIS = `http://127.0.0.1:${process.env.PORT}`;
await import("./server.js");
const store = await import("./store.js");
await new Promise((r) => setTimeout(r, 1200));

let fehler = 0;
const pruefe = (name, ist, soll) => {
  const gut = JSON.stringify(ist) === JSON.stringify(soll);
  if (!gut) fehler++;
  console.log(`${gut ? "ok  " : "FEHL"} ${name.padEnd(50)} ist=${JSON.stringify(ist)}${gut ? "" : " soll=" + JSON.stringify(soll)}`);
};

const neues = (chats, device) =>
  fetch(BASIS + "/api/neues", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chats, device }),
  }).then((r) => r.json());

let lauf = 0;
const schreibe = (room, device, text, at) =>
  store.addMessage({
    id: "m" + ++lauf, room, device, name: "Test", text,
    lang: "pt", detected: false, at: at || Date.now(), tr: {},
  });

const marke = Date.now() - 1000;

/* Manuel schreibt in zwei Chats, ich bin dort nicht. */
await schreibe("nachbar", "geraet-manuel", "Bom dia");
await schreibe("nachbar", "geraet-manuel", "Tudo bem?");
await schreibe("handwerker", "geraet-manuel", "Venho amanha");

let n = await neues([{ room: "nachbar", seit: marke }, { room: "handwerker", seit: marke }], "geraet-ich");
pruefe("zwei neue im einen, eine im anderen", [n.nachbar, n.handwerker], [2, 1]);

/* Ich lese den einen Chat. */
const jetzt = Date.now() + 1;
n = await neues([{ room: "nachbar", seit: jetzt }, { room: "handwerker", seit: marke }], "geraet-ich");
pruefe("gelesener Chat faellt auf null", [n.nachbar, n.handwerker], [0, 1]);

/* Eigene Nachrichten zaehlen nicht als neu. */
await schreibe("nachbar", "geraet-ich", "Bom dia Manuel", jetzt + 10);
n = await neues([{ room: "nachbar", seit: jetzt }], "geraet-ich");
pruefe("eigene Nachricht zaehlt nicht", n.nachbar, 0);
n = await neues([{ room: "nachbar", seit: jetzt }], "geraet-manuel");
pruefe("fuer den anderen zaehlt sie sehr wohl", n.nachbar, 1);

/* Geloeschtes zaehlt nicht mehr. */
await schreibe("nachbar", "geraet-manuel", "Ups", jetzt + 20);
n = await neues([{ room: "nachbar", seit: jetzt }], "geraet-ich");
pruefe("vor dem Loeschen zaehlt sie", n.nachbar, 1);
await store.deleteForAll("m" + lauf, "geraet-manuel");
n = await neues([{ room: "nachbar", seit: jetzt }], "geraet-ich");
pruefe("nach dem Loeschen nicht mehr", n.nachbar, 0);

/* Ein Chat ohne Nachrichten. */
n = await neues([{ room: "gibtsnicht", seit: 0 }], "geraet-ich");
pruefe("unbekannter Chat ergibt null", n.gibtsnicht, 0);

/* Es kommen nur Zahlen zurueck, nie Text - sonst koennte jemand mit
   geratenen Chat-Codes fremde Nachrichten abfischen. */
const roh = JSON.stringify(await neues([{ room: "nachbar", seit: 0 }], "geraet-ich"));
pruefe("Antwort enthaelt keinen Nachrichtentext", /Bom dia|Tudo bem|Venho/.test(roh), false);

/* Mehr als zwanzig Chats werden abgeschnitten, damit niemand die
   Abfrage als Massenwerkzeug benutzt. */
const viele = Array.from({ length: 30 }, (_, i) => ({ room: "chat" + i, seit: 0 }));
pruefe("hoechstens zwanzig Chats je Abfrage", Object.keys(await neues(viele, "x")).length, 20);

console.log(fehler ? `\n${fehler} Pruefung(en) fehlgeschlagen.` : "\nAlle Pruefungen bestanden.");
process.exit(fehler ? 1 : 0);
