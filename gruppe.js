/* --------------------------------------------------------------------
   gruppe.js  -  Gruppen, z. B. fuer einen Betrieb

   In Diralo kann jeder Chat beliebig viele Leute haben; jeder liest in
   seiner Sprache. Diese Datei macht daraus eine richtige Gruppe:

   - ein Name, den alle sehen (statt nur auf dem eigenen Handy)
   - ein Chef (wer der Gruppe als Erster einen Namen gibt): darf
     umbenennen und Leute entfernen
   - eine Mitgliederliste mit Sprache, "zuletzt da" und Lesestand -
     daraus zeigen die Apps "gelesen von 5 von 7"
   - Entfernen: Das Geraet kommt nicht mehr in den Chat, bekommt keine
     Push-Nachrichten mehr und wird sofort hinausgeworfen (der Raum wird
     ihm in server.js weggenommen, die Verbindung bleibt)

   Eingehaengt wird alles aus server.js: darfRein() vor dem Beitritt,
   beigetreten() danach, handler() fuer die Ereignisse.
-------------------------------------------------------------------- */
import * as store from "./store.js";
import crypto from "crypto";

const NAME_MAX = 50;

/* ------------------------- Geraete-Schluessel -------------------------
   Ergebnis je Verbindung (socket.data.geraet):
   "ok"    Schluessel passt         -> darf alles als dieses Geraet
   "neu"   erster Schluessel, jetzt fest an die Kennung gebunden -> ebenso
   "ohne"  alte App ohne Schluessel, Kennung noch frei -> wie bisher, aber
           keine Gruppen-Verwaltung (die gibt es dort ohnehin nicht)
   "falsch" Kennung gehoert jemand anderem (oder App neu installiert) ->
           darf chatten, aber nichts "als dieses Geraet" (Loeschen, Chef) */
const abdruckVon = (geheim) => crypto.createHash("sha256").update("diralo-geraet:" + geheim).digest("hex");
export async function geraetPruefen(device, geheim) {
  try {
    const g = typeof geheim === "string" && geheim.length >= 20 && geheim.length <= 200 ? geheim : null;
    const vorhanden = await store.geraetAbdruck(device);
    if (!g) return vorhanden ? "falsch" : "ohne";
    const mein = abdruckVon(g);
    if (!vorhanden) return (await store.geraetMerken(device, mein)) === mein ? "neu" : "falsch";
    const a = Buffer.from(vorhanden), b = Buffer.from(mein);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "falsch";
  } catch {
    return "ohne";
  }
}
const verifiziert = (socket) => ["ok", "neu"].includes(socket.data.geraet);
export const darfAlsGeraet = (socket) => socket.data.geraet !== "falsch";

/* Probe-Chats der Startseite und Firmen-Kundenchats sind keine Gruppen. */
const zaehltNicht = (room) => !room || room.startsWith("demo-") || room.startsWith("f-") || room === "lobby";

/* Alles, was die Apps fuer die Gruppenansicht brauchen. */
export async function info(io, room) {
  const [gruppe, mitglieder] = await Promise.all([store.getGruppe(room), store.mitgliederVon(room)]);
  /* Wer gerade verbunden ist (gleiche Quelle wie "🟢 ... im Chat"). */
  const online = new Set();
  try {
    for (const s of await io.in(room).fetchSockets()) if (s.data?.wer?.device) online.add(s.data.wer.device);
  } catch {}
  return {
    name: gruppe?.name || "",
    admin: gruppe?.admin || "",
    mitglieder: mitglieder.map((m) => ({ ...m, online: online.has(m.device) })),
  };
}

async function anAlle(io, room) {
  try { io.to(room).emit("gruppe", await info(io, room)); } catch (err) {
    console.error("Gruppe senden:", err.message);
  }
}

/* Vor dem Beitritt: Ist dieses Geraet aus dem Chat entfernt worden? */
export async function darfRein(room, device) {
  if (zaehltNicht(room)) return true;
  try { return !(await store.istEntfernt(room, device)); } catch { return true; }
}

/* Team-Tarife haben eine Personen-Grenze ueber alle Gruppen des Abos.
   teamGrenze(room) kommt aus server.js und liefert { grenze, raeume }
   oder null. Wer schon dabei ist, kommt immer hinein. Im Zweifel (Fehler)
   wird durchgelassen - lieber einer zu viel als ein Betrieb ausgesperrt. */
export async function platzFrei(room, device, teamGrenze) {
  if (zaehltNicht(room)) return true;
  try {
    const t = await teamGrenze(room);
    if (!t) return true;
    const { anzahl, dabei } = await store.personenInRaeumen(t.raeume, device);
    return dabei || anzahl < t.grenze;
  } catch {
    return true;
  }
}

/* Nach dem Beitritt: Mitglied vermerken, allen die neue Liste schicken. */
export async function beigetreten(io, room, me) {
  if (zaehltNicht(room)) return;
  try {
    await store.mitgliedDa(room, me.device, me.name, me.lang);
    await anAlle(io, room);
  } catch (err) {
    console.error("Mitglied vermerken:", err.message);
  }
}

export async function spracheNeu(io, room, me) {
  if (zaehltNicht(room)) return;
  try {
    await store.mitgliedDa(room, me.device, me.name, me.lang);
    await anAlle(io, room);
  } catch {}
}

/* Die Socket-Ereignisse. raum() und ich() liefern den aktuellen Stand
   aus server.js (der Raum wechselt, wenn jemand einen anderen Chat oeffnet). */
export function handler(io, socket, raum, ich, rauswerfen) {
  /* Damit ein Chef dieses Geraet hinauswerfen kann, ohne die Verbindung
     zu kappen (sonst haengt die Web-App danach fest). */
  socket.data.rauswerfen = rauswerfen;
  socket.on("gruppeInfo", async () => {
    const room = raum();
    if (zaehltNicht(room)) return;
    try { socket.emit("gruppe", await info(io, room)); } catch {}
  });

  socket.on("gruppeName", async ({ name } = {}) => {
    const room = raum();
    const me = ich();
    if (zaehltNicht(room) || !me?.device) return;
    if (!verifiziert(socket)) { socket.emit("gruppeFehler", { grund: "geraet" }); return; }
    const neu = String(name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    if (!neu) return;
    try {
      const g = await store.getGruppe(room);
      /* Gibt es schon einen Chef, darf nur er umbenennen. */
      if (g && g.admin !== me.device) {
        socket.emit("gruppeFehler", { grund: "nurChef" });
        return;
      }
      await store.setGruppe(room, neu, me.device);
      await anAlle(io, room);
    } catch (err) {
      console.error("Gruppenname:", err.message);
    }
  });

  socket.on("gruppeEntfernen", async ({ device } = {}) => {
    const room = raum();
    const me = ich();
    const wen = String(device || "").slice(0, 60);
    if (zaehltNicht(room) || !me?.device || !wen || wen === me.device) return;
    if (!verifiziert(socket)) { socket.emit("gruppeFehler", { grund: "geraet" }); return; }
    try {
      const g = await store.getGruppe(room);
      if (!g || g.admin !== me.device) {
        socket.emit("gruppeFehler", { grund: "nurChef" });
        return;
      }
      await store.mitgliedEntfernen(room, wen);
      /* Sofort hinauswerfen: aus dem Raum nehmen und Bescheid sagen. Beim
         erneuten Beitritt laesst darfRein() das Geraet nicht mehr hinein. */
      for (const s of await io.in(room).fetchSockets()) {
        if (s.data?.wer?.device !== wen) continue;
        const echt = io.of("/").sockets.get(s.id);
        if (echt) {
          echt.leave(room);
          try { echt.data.rauswerfen?.(); } catch {}
          echt.emit("system", { type: "entfernt" });
        } else {
          s.leave(room);
          s.disconnect(true);
        }
      }
      await anAlle(io, room);
    } catch (err) {
      console.error("Entfernen:", err.message);
    }
  });
}
