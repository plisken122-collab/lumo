/* --------------------------------------------------------------------
   store.js

   Zwei Speicher hinter einer gemeinsamen Schnittstelle:

   - Ist DATABASE_URL gesetzt, laeuft alles ueber Postgres. Nachrichten,
     Uebersetzungen und Push-Anmeldungen ueberleben dann jeden Neustart.
   - Fehlt die Variable, faellt alles in den Arbeitsspeicher zurueck.
     Praktisch zum lokalen Testen, aber nach einem Neustart ist alles weg.
-------------------------------------------------------------------- */
import pg from "pg";
import crypto from "crypto";

const URL = process.env.DATABASE_URL;
export const usingDatabase = Boolean(URL);

let pool = null;
if (usingDatabase) {
  pool = new pg.Pool({
    connectionString: URL,
    ssl: URL.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

/* ---------------------- Arbeitsspeicher-Variante ---------------------- */
const mem = {
  messages: new Map(), // id -> msg
  rooms: new Map(),    // room -> [id]
  subs: new Map(),     // endpoint -> sub
  usage: [],           // Verbrauch pro Uebersetzung
  media: new Map(),    // message_id -> { mime, bytes }
  plans: new Map(),    // room -> Mitgliedschaft
  funnel: new Map(),   // "tag|ereignis" -> Anzahl
  abos: new Map(),     // id -> Abo
  aboRaeume: new Map(), // room -> abo_id
  reactions: new Map(), // message_id -> { device: emoji }
  readState: new Map(), // "room|device" -> bis (bis wann gelesen)
  gruppen: new Map(),   // room -> { name, admin, erstellt }
  mitglieder: new Map(), // "room|device" -> { room, device, name, lang, zuletzt, entfernt }
  geraete: new Map(),   // device -> Abdruck des geheimen Geraete-Schluessels
  anrufSek: new Map(),  // "topf|monat" -> Sekunden
  zaehler: new Map(),   // "monat|art" -> Menge
};

/* ---------------------------- Schema ---------------------------- */
/* Haelt fest, ob das Anlegen der Tabellen schiefging. Frueher landete
   das nur im Protokoll - und wenn eine spaeter hinzugefuegte Spalte
   fehlte, scheiterte etwa das Loeschen lautlos. Steht unter /health. */
export let schemaFehler = null;

export async function init() {
  if (!usingDatabase) {
    console.log("  Hinweis: keine DATABASE_URL gesetzt - Daten nur im Arbeitsspeicher.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY,
      room      TEXT NOT NULL,
      device    TEXT NOT NULL,
      name      TEXT NOT NULL,
      body      TEXT NOT NULL,
      lang      TEXT NOT NULL,
      detected  BOOLEAN NOT NULL DEFAULT FALSE,
      at        BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_room_at ON messages (room, at);

    CREATE TABLE IF NOT EXISTS translations (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      lang       TEXT NOT NULL,
      body       TEXT NOT NULL,
      PRIMARY KEY (message_id, lang)
    );

    /* Spaeter dazugekommen: Dauer einer Sprachnachricht in Sekunden.
       NULL heisst: gewoehnliche Textnachricht. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_seconds INTEGER;

    /* Fuer alle geloescht. Der Inhalt ist dann wirklich fort - stehen
       bleibt nur diese Markierung, damit im Verlauf kein unerklaerliches
       Loch entsteht. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;

    /* Wie audio_seconds, nur fuer Bilder: TRUE heisst, zu dieser Nachricht
       liegt ein Bild in der media-Tabelle. Der Text ist dann die (optionale)
       Bildunterschrift. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_image BOOLEAN NOT NULL DEFAULT FALSE;

    /* Geteilter Standort: Breiten- und Laengengrad. NULL heisst, es ist
       kein Standort, sondern eine gewoehnliche Nachricht. Kein Kartenbild
       wird gespeichert - der Empfaenger oeffnet die Koordinaten in seiner
       Karten-App. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS ort_lat DOUBLE PRECISION;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS ort_lng DOUBLE PRECISION;

    /* Antwort auf eine andere Nachricht: die id der zitierten Nachricht.
       NULL heisst, es ist eine gewoehnliche Nachricht ohne Bezug. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to TEXT;

    /* Die Aufnahme selbst. Opus ist klein - eine halbe Minute sind rund
       40 KB, das traegt die Datenbank ohne Muehe. Bilder gehoeren spaeter
       nicht hierher, die sind hundertmal groesser.

       ON DELETE CASCADE ist wichtig: Loescht die Aufbewahrungsfrist eine
       Nachricht, verschwindet die Aufnahme von selbst mit. */
    CREATE TABLE IF NOT EXISTS media (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      bytes      BYTEA NOT NULL
    );

    /* Der aus einem Bild gelesene und uebersetzte Text - je Bild und
       Zielsprache einmal. So kostet das Sehen des Bildes nur beim ersten
       Mal. Verschwindet mit der Nachricht (CASCADE). */
    CREATE TABLE IF NOT EXISTS bild_text (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      lang       TEXT NOT NULL,
      body       TEXT NOT NULL,
      PRIMARY KEY (message_id, lang)
    );

    /* Reaktionen (Herz, Daumen ...): eine je Geraet und Nachricht.
       Verschwindet mit der Nachricht (CASCADE). */
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      device     TEXT NOT NULL,
      emoji      TEXT NOT NULL,
      PRIMARY KEY (message_id, device)
    );

    /* Lesestand je Chat und Geraet: bis zu welchem Zeitpunkt jemand alles
       gesehen hat. Daraus werden die dauerhaften Lese-Haken - auch nach
       einem Neustart und wenn der andere gerade offline ist. */
    CREATE TABLE IF NOT EXISTS read_state (
      room   TEXT NOT NULL,
      device TEXT NOT NULL,
      bis    BIGINT NOT NULL,
      PRIMARY KEY (room, device)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY,
      room     TEXT NOT NULL,
      device   TEXT NOT NULL,
      name     TEXT NOT NULL,
      lang     TEXT NOT NULL,
      data     JSONB NOT NULL,
      at       BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subscriptions_room ON subscriptions (room);
    /* Frueher war der Endpunkt allein der Schluessel. Damit konnte ein
       Geraet nur einen Chat abonnieren - jede neue Anmeldung warf die
       vorige hinaus. Jetzt zaehlt das Paar aus Endpunkt und Chat. */
    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pkey;
    ALTER TABLE subscriptions ADD PRIMARY KEY (endpoint, room);

    CREATE TABLE IF NOT EXISTS usage_log (
      id         BIGSERIAL PRIMARY KEY,
      at         BIGINT NOT NULL,
      room       TEXT,
      target     TEXT,
      chars      INTEGER NOT NULL DEFAULT 0,
      in_tokens  INTEGER NOT NULL DEFAULT 0,
      out_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_at ON usage_log (at);

    /* Untertitel-Sekunden im Anruf je Topf (Abo oder einzelner Chat) und
       Monat - fuer das Minuten-Kontingent der Live-Untertitel. */
    /* Verbrauch der Google-Dienste je Monat (Zeichen, Sekunden) - fuer
       die Kostenschaetzung in der Uebersicht. */
    CREATE TABLE IF NOT EXISTS kosten_zaehler (
      monat INTEGER NOT NULL,
      art   TEXT NOT NULL,
      menge BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (monat, art)
    );

    CREATE TABLE IF NOT EXISTS anruf_sekunden (
      topf     TEXT NOT NULL,
      monat    INTEGER NOT NULL,
      sekunden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (topf, monat)
    );

    /* Bezahlte Mitgliedschaften. Sie haengen am Chat, nicht am Geraet:
       Wer einlaedt, bezahlt, und alle im Chat schreiben mit. Das passt
       zum Rest - usage_log zaehlt ohnehin je Chat - und erspart ein
       Konto, das es hier nicht gibt.

       manage_key ist nur der Abdruck des Verwaltungsschluessels. Den
       Schluessel selbst bekommt der Zahler einmal zu sehen; ohne ihn
       kann niemand eine fremde Mitgliedschaft kuendigen. */
    CREATE TABLE IF NOT EXISTS plans (
      room        TEXT PRIMARY KEY,
      plan        TEXT NOT NULL,
      status      TEXT NOT NULL,
      customer    TEXT,
      subscription TEXT,
      manage_key  TEXT,
      period_end  BIGINT,
      at          BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plans_sub ON plans (subscription);

    /* Die Mitgliedschaft gehoert dem Zahler, nicht einem einzelnen Chat.

       Zuerst hing sie am Chat - technisch sauber, kaufmaessig unklug:
       Wer drei Gespraeche fuehrte, haette dreimal zahlen muessen. Jetzt
       haelt der Zahler ein Abo, und er schaltet damit mehrere Chats frei.

       Erkannt wird er am Verwaltungsschluessel, den nur er besitzt -
       damit braucht es weiterhin kein Konto. */
    CREATE TABLE IF NOT EXISTS abos (
      id           TEXT PRIMARY KEY,
      plan         TEXT NOT NULL,
      status       TEXT NOT NULL,
      customer     TEXT,
      subscription TEXT,
      manage_key   TEXT,
      period_end   BIGINT,
      at           BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS abos_sub ON abos (subscription);

    /* Welche Chats zu einem Abo gehoeren. Ein Chat kann nur zu einem
       Abo gehoeren - sonst liesse sich dasselbe Gespraech zweimal
       freischalten und niemand wuesste, wessen Kontingent zaehlt. */
    CREATE TABLE IF NOT EXISTS abo_raeume (
      abo_id TEXT NOT NULL REFERENCES abos(id) ON DELETE CASCADE,
      room   TEXT NOT NULL UNIQUE,
      at     BIGINT NOT NULL,
      PRIMARY KEY (abo_id, room)
    );

    /* Trichter: eine Zahl je Tag und Ereignis, sonst nichts. Keine
       Kennung, keine Adresse, kein Geraet - man kann daraus nicht
       zurueckrechnen, wer etwas getan hat. Damit ist es kein
       personenbezogenes Datum und die Datenschutzerklaerung bleibt, wie
       sie ist.

       Es beantwortet die einzige Frage, die zaehlt: Wo hoeren die Leute
       auf? Zwischen Ankommen und Eintreten, oder zwischen Eintreten und
       der ersten Nachricht? */
    CREATE TABLE IF NOT EXISTS funnel (
      tag      TEXT NOT NULL,
      ereignis TEXT NOT NULL,
      n        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tag, ereignis)
    );
  `);
  /* Die nachtraeglich gekommenen Spalten einzeln absichern: Laeuft die
     grosse Anweisung oben aus irgendeinem Grund nicht durch, faellt es
     sonst erst auf, wenn jemand etwas loeschen will. */
  for (const [spalte, art] of [["audio_seconds", "INTEGER"],
                               ["deleted", "BOOLEAN NOT NULL DEFAULT FALSE"],
                               ["has_image", "BOOLEAN NOT NULL DEFAULT FALSE"],
                               ["ort_lat", "DOUBLE PRECISION"],
                               ["ort_lng", "DOUBLE PRECISION"],
                               ["reply_to", "TEXT"],
                               /* Datei oder Video: {name, mime, groesse} als JSON.
                                  Die Bytes liegen wie bei Bildern in "media". */
                               ["datei", "TEXT"],
                               /* GIF aus der Suche: {url, b, h} als JSON */
                               ["gif", "TEXT"]]) {
    try {
      await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ${spalte} ${art}`);
    } catch (err) {
      schemaFehler = `${spalte}: ${err.message}`.slice(0, 200);
      console.error(`  Spalte ${spalte} fehlt und liess sich nicht anlegen:`, err.message);
    }
  }

  /* Gegenprobe: Ist die Spalte wirklich da? */
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages' AND column_name IN ('deleted','audio_seconds')`
    );
    const da = rows.map((r) => r.column_name);
    if (!da.includes("deleted")) schemaFehler = "Spalte deleted fehlt";
    if (!da.includes("audio_seconds")) schemaFehler = "Spalte audio_seconds fehlt";
  } catch (err) {
    schemaFehler = "Pruefung fehlgeschlagen: " + err.message.slice(0, 150);
  }

  /* Gruppen (z. B. ein Betrieb): Name und Chef je Chat, dazu wer
     dabei ist. "entfernt" sperrt ein Geraet fuer diesen Chat. */
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gruppen (
        room    TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        admin   TEXT NOT NULL,
        erstellt BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lern_aus (
        device TEXT PRIMARY KEY,
        at     BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lern_tage (
        tag TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS geraete (
        device  TEXT PRIMARY KEY,
        abdruck TEXT NOT NULL,
        erstellt BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mitglieder (
        room     TEXT NOT NULL,
        device   TEXT NOT NULL,
        name     TEXT NOT NULL,
        lang     TEXT NOT NULL,
        zuletzt  BIGINT NOT NULL,
        entfernt BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (room, device)
      );`);
    /* Angeheftete Durchsage (Nachrichten-ID) - Team Plus. */
    await pool.query(`ALTER TABLE gruppen ADD COLUMN IF NOT EXISTS angeheftet TEXT`);
  } catch (err) {
    schemaFehler = "Gruppen-Tabellen: " + err.message.slice(0, 150);
  }

  /* Einmalig: alte, am Chat haengende Mitgliedschaften in Abos ueberfuehren. */
  try {
    await umzugAltePlaene();
  } catch (err) {
    schemaFehler = "Umzug der Mitgliedschaften: " + err.message.slice(0, 150);
    console.error("  Umzug der Mitgliedschaften fehlgeschlagen:", err.message);
  }

  console.log(schemaFehler ? "  Datenbank bereit, ABER: " + schemaFehler : "  Datenbank bereit.");
}

/* --------------------------- Nachrichten --------------------------- */
export async function addMessage(msg) {
  if (!usingDatabase) {
    mem.messages.set(msg.id, msg);
    if (!mem.rooms.has(msg.room)) mem.rooms.set(msg.room, []);
    mem.rooms.get(msg.room).push(msg.id);
    return msg;
  }
  await pool.query(
    `INSERT INTO messages (id, room, device, name, body, lang, detected, at, audio_seconds, has_image, ort_lat, ort_lng, reply_to, datei, gif)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
    [msg.id, msg.room, msg.device, msg.name, msg.text, msg.lang, msg.detected, msg.at,
     msg.audioSeconds ?? null, Boolean(msg.bild),
     msg.ort ? msg.ort.lat : null, msg.ort ? msg.ort.lng : null, msg.replyTo || null,
     msg.datei ? JSON.stringify(msg.datei) : null,
     msg.gif ? JSON.stringify(msg.gif) : null]
  );
  return msg;
}

/* ------------------------ Sprachnachrichten ------------------------ */
export async function addMedia(messageId, { mime, bytes }) {
  if (!usingDatabase) {
    mem.media.set(messageId, { mime, bytes });
    return;
  }
  await pool.query(
    `INSERT INTO media (message_id, mime, bytes) VALUES ($1,$2,$3)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, mime, bytes]
  );
}

/* ------------------------- Loeschen fuer alle -------------------------
   Der Inhalt verschwindet wirklich: Text, alle Uebersetzungen und eine
   etwaige Aufnahme. Die Zeile selbst bleibt mit deleted = TRUE stehen,
   damit der Verlauf keine Luecke bekommt und jeder sieht, dass hier
   etwas war.

   Gibt zurueck, ob geloescht wurde - false heisst: gibt es nicht, oder
   jemand anderes hat sie geschrieben.
------------------------------------------------------------------- */
export async function deleteForAll(id, device) {
  if (!usingDatabase) {
    const m = mem.messages.get(id);
    if (!m || m.device !== device) return false;
    m.text = ""; m.tr = {}; m.deleted = true; m.audioSeconds = null; m.bild = false; m.ort = null; m.datei = null; m.gif = null;
    mem.media.delete(id);
    mem.reactions.delete(id);
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE messages SET body = '', deleted = TRUE, audio_seconds = NULL, has_image = FALSE, ort_lat = NULL, ort_lng = NULL, datei = NULL, gif = NULL
     WHERE id = $1 AND device = $2 AND deleted = FALSE`,
    [id, device]
  );
  if (!rowCount) return false;
  await pool.query(`DELETE FROM translations WHERE message_id = $1`, [id]);
  await pool.query(`DELETE FROM media WHERE message_id = $1`, [id]);
  await pool.query(`DELETE FROM reactions WHERE message_id = $1`, [id]);
  return true;
}

export async function getMedia(messageId) {
  if (!usingDatabase) return mem.media.get(messageId) || null;
  const { rows } = await pool.query(
    `SELECT mime, bytes FROM media WHERE message_id = $1`, [messageId]
  );
  return rows.length ? { mime: rows[0].mime, bytes: rows[0].bytes } : null;
}

/* Aus einem Bild gelesener, uebersetzter Text - je Bild und Sprache. */
const memBildText = new Map();
export async function getBildText(messageId, lang) {
  if (!usingDatabase) return memBildText.get(messageId + "|" + lang) ?? null;
  const { rows } = await pool.query(
    `SELECT body FROM bild_text WHERE message_id = $1 AND lang = $2`, [messageId, lang]
  );
  return rows.length ? rows[0].body : null;
}
export async function saveBildText(messageId, lang, body) {
  if (!usingDatabase) { memBildText.set(messageId + "|" + lang, body); return; }
  await pool.query(
    `INSERT INTO bild_text (message_id, lang, body) VALUES ($1,$2,$3)
     ON CONFLICT (message_id, lang) DO UPDATE SET body = EXCLUDED.body`,
    [messageId, lang, body]
  );
}

export async function getMessage(id) {
  if (!usingDatabase) return mem.messages.get(id) || null;
  const { rows } = await pool.query(`SELECT * FROM messages WHERE id = $1`, [id]);
  if (!rows.length) return null;
  const tr = await pool.query(`SELECT lang, body FROM translations WHERE message_id = $1`, [id]);
  return rowToMsg(rows[0], tr.rows);
}

/* Letzte Nachrichten eines Raums, aelteste zuerst. */
export async function getHistory(room, limit = 200) {
  if (!usingDatabase) {
    const ids = mem.rooms.get(room) || [];
    const list = ids.slice(-limit).map((id) => mem.messages.get(id)).filter(Boolean);
    for (const m of list) m.reaktionen = { ...(mem.reactions.get(m.id) || {}) };
    return list;
  }
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT * FROM messages WHERE room = $1 ORDER BY at DESC LIMIT $2
     ) s ORDER BY at ASC`,
    [room, limit]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const tr = await pool.query(
    `SELECT message_id, lang, body FROM translations WHERE message_id = ANY($1)`,
    [ids]
  );
  const byId = new Map();
  for (const t of tr.rows) {
    if (!byId.has(t.message_id)) byId.set(t.message_id, []);
    byId.get(t.message_id).push(t);
  }
  const reakt = await reaktionenLaden(ids);
  return rows.map((r) => {
    const m = rowToMsg(r, byId.get(r.id) || []);
    m.reaktionen = reakt.get(r.id) || {};
    return m;
  });
}

/* Eine Reaktion setzen, aendern oder (leeres Emoji) entfernen. Eine je
   Geraet und Nachricht. */
export async function setReaction(messageId, device, emoji) {
  if (!usingDatabase) {
    let r = mem.reactions.get(messageId);
    if (!r) { r = {}; mem.reactions.set(messageId, r); }
    if (emoji) r[device] = emoji; else delete r[device];
    return;
  }
  if (emoji) {
    await pool.query(
      `INSERT INTO reactions (message_id, device, emoji) VALUES ($1,$2,$3)
       ON CONFLICT (message_id, device) DO UPDATE SET emoji = EXCLUDED.emoji`,
      [messageId, device, emoji]
    );
  } else {
    await pool.query(`DELETE FROM reactions WHERE message_id = $1 AND device = $2`, [messageId, device]);
  }
}

/* Reaktionen zu mehreren Nachrichten auf einmal: id -> { device: emoji }. */
async function reaktionenLaden(ids) {
  const map = new Map();
  if (!usingDatabase) {
    for (const id of ids) {
      const r = mem.reactions.get(id);
      if (r && Object.keys(r).length) map.set(id, { ...r });
    }
    return map;
  }
  const { rows } = await pool.query(
    `SELECT message_id, device, emoji FROM reactions WHERE message_id = ANY($1)`, [ids]
  );
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, {});
    map.get(r.message_id)[r.device] = r.emoji;
  }
  return map;
}

/* Lesestand merken: bis zu welchem Zeitpunkt dieses Geraet den Chat gesehen
   hat. Nur nach oben - ein spaeteres Lesen senkt den Stand nie. */
export async function setRead(room, device, bis) {
  const t = Number(bis) || 0;
  if (!room || !device || !t) return;
  if (!usingDatabase) {
    const k = `${room}|${device}`;
    mem.readState.set(k, Math.max(t, mem.readState.get(k) || 0));
    return;
  }
  await pool.query(
    `INSERT INTO read_state (room, device, bis) VALUES ($1,$2,$3)
     ON CONFLICT (room, device) DO UPDATE SET bis = GREATEST(read_state.bis, EXCLUDED.bis)`,
    [room, device, t]
  );
}

/* Wie weit haben die ANDEREN im Chat gelesen? Daraus ergeben sich die
   Lese-Haken der eigenen Nachrichten. */
export async function getReadBisExcept(room, device) {
  if (!usingDatabase) {
    let max = 0;
    for (const [k, bis] of mem.readState) {
      const [r, d] = k.split("|");
      if (r === room && d !== device) max = Math.max(max, bis);
    }
    return max;
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(bis),0)::bigint AS bis FROM read_state WHERE room = $1 AND device <> $2`,
    [room, device]
  );
  return Number(rows[0].bis) || 0;
}

export async function setTranslation(id, lang, body) {
  if (!usingDatabase) {
    const m = mem.messages.get(id);
    if (m) m.tr[lang] = body;
    return;
  }
  await pool.query(
    `INSERT INTO translations (message_id, lang, body) VALUES ($1,$2,$3)
     ON CONFLICT (message_id, lang) DO UPDATE SET body = EXCLUDED.body`,
    [id, lang, body]
  );
}

/* Nachtraegliche Mitschrift einer Sprachnachricht (mitschrift.js). */
export async function setMessageText(id, text) {
  if (!usingDatabase) {
    const m = mem.messages.get(id);
    if (m) m.text = text;
    return;
  }
  await pool.query(`UPDATE messages SET body = $2 WHERE id = $1`, [id, text]);
}

export async function setDetectedLang(id, lang) {
  if (!usingDatabase) {
    const m = mem.messages.get(id);
    if (m) { m.lang = lang; m.detected = true; }
    return;
  }
  await pool.query(`UPDATE messages SET lang = $2, detected = TRUE WHERE id = $1`, [id, lang]);
}

function dateiLesen(wert) {
  if (!wert) return null;
  try { return JSON.parse(wert); } catch { return null; }
}

function rowToMsg(r, translations) {
  const tr = {};
  for (const t of translations) tr[t.lang] = t.body;
  return {
    id: r.id, room: r.room, device: r.device, name: r.name,
    text: r.body, lang: r.lang, detected: r.detected, at: Number(r.at), tr,
    audioSeconds: r.audio_seconds ?? null,
    bild: Boolean(r.has_image),
    ort: (r.ort_lat != null && r.ort_lng != null)
      ? { lat: Number(r.ort_lat), lng: Number(r.ort_lng) } : null,
    replyTo: r.reply_to || null,
    datei: dateiLesen(r.datei),
    gif: dateiLesen(r.gif),
    deleted: Boolean(r.deleted),
  };
}

/* ------------------------- Verbrauch zaehlen -------------------------
   Eine Zeile pro Uebersetzung. Damit laesst sich spaeter ausrechnen,
   was eine Nachricht wirklich kostet - statt zu schaetzen.
------------------------------------------------------------------- */
export async function logUsage({ room, target, chars, inTokens, outTokens }) {
  const row = { at: Date.now(), room, target, chars, in_tokens: inTokens, out_tokens: outTokens };
  if (!usingDatabase) {
    mem.usage.push(row);
    if (mem.usage.length > 20000) mem.usage.shift();
    return;
  }
  await pool.query(
    `INSERT INTO usage_log (at, room, target, chars, in_tokens, out_tokens)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.at, room, target, chars, inTokens, outTokens]
  );
}

/* Summen fuer die letzten n Tage, plus Tagesverlauf. */
export async function getUsage(days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  if (!usingDatabase) {
    const rows = mem.usage.filter((r) => r.at >= since && r.room !== "__tts__");
    const total = rows.reduce(
      (a, r) => ({
        count: a.count + 1,
        chars: a.chars + r.chars,
        inTokens: a.inTokens + r.in_tokens,
        outTokens: a.outTokens + r.out_tokens,
      }),
      { count: 0, chars: 0, inTokens: 0, outTokens: 0 }
    );
    const byDay = {};
    for (const r of rows) {
      const d = new Date(r.at).toISOString().slice(0, 10);
      byDay[d] = byDay[d] || { day: d, count: 0, inTokens: 0, outTokens: 0 };
      byDay[d].count++;
      byDay[d].inTokens += r.in_tokens;
      byDay[d].outTokens += r.out_tokens;
    }
    return { total, byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)) };
  }

  const t = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(chars),0)::int AS chars,
            COALESCE(SUM(in_tokens),0)::bigint AS in_tokens,
            COALESCE(SUM(out_tokens),0)::bigint AS out_tokens
       FROM usage_log WHERE at >= $1 AND room IS DISTINCT FROM '__tts__'`, [since]);

  const d = await pool.query(
    `SELECT to_char(to_timestamp(at/1000), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count,
            COALESCE(SUM(in_tokens),0)::bigint AS in_tokens,
            COALESCE(SUM(out_tokens),0)::bigint AS out_tokens
       FROM usage_log WHERE at >= $1 AND room IS DISTINCT FROM '__tts__'
      GROUP BY day ORDER BY day`, [since]);

  const r = t.rows[0];
  return {
    total: {
      count: r.count, chars: r.chars,
      inTokens: Number(r.in_tokens), outTokens: Number(r.out_tokens),
    },
    byDay: d.rows.map((x) => ({
      day: x.day, count: x.count,
      inTokens: Number(x.in_tokens), outTokens: Number(x.out_tokens),
    })),
  };
}

/* Nur der Verbrauch des Probe-Chats (Raum-Kuerzel "__demo__") - damit der
   Admin die Demo-Kosten von den echten Uebersetzungen trennen kann. */
export async function getDemoUsage(days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!usingDatabase) {
    const rows = mem.usage.filter((r) => r.at >= since && r.room === "__demo__");
    return rows.reduce(
      (a, r) => ({ count: a.count + 1, inTokens: a.inTokens + r.in_tokens, outTokens: a.outTokens + r.out_tokens }),
      { count: 0, inTokens: 0, outTokens: 0 }
    );
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(in_tokens),0)::bigint AS in_tokens,
            COALESCE(SUM(out_tokens),0)::bigint AS out_tokens
       FROM usage_log WHERE room = '__demo__' AND at >= $1`, [since]);
  const r = rows[0];
  return { count: r.count, inTokens: Number(r.in_tokens), outTokens: Number(r.out_tokens) };
}

/* --------------------------- Aufraeumen ---------------------------
   Nachrichten aelter als die Aufbewahrungsfrist verschwinden. Was
   geloescht ist, kann niemand mehr lesen und niemand herausverlangen.
   Uebersetzungen gehen per ON DELETE CASCADE gleich mit.
------------------------------------------------------------------- */
export async function purgeOlderThan(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  if (!usingDatabase) {
    let removed = 0;
    for (const [id, m] of [...mem.messages]) {
      if (m.at < cutoff) {
        mem.messages.delete(id);
        mem.media.delete(id);
        removed++;
      }
    }
    for (const [room, ids] of [...mem.rooms]) {
      const keep = ids.filter((id) => mem.messages.has(id));
      if (keep.length) mem.rooms.set(room, keep);
      else mem.rooms.delete(room);
    }
    return removed;
  }

  const { rowCount } = await pool.query(`DELETE FROM messages WHERE at < $1`, [cutoff]);
  /* Verbrauchszahlen bleiben ein Jahr - sie enthalten keinen Nachrichtentext. */
  await pool.query(`DELETE FROM usage_log WHERE at < $1`,
                   [Date.now() - 365 * 24 * 60 * 60 * 1000]);
  /* Mitglieder, die lange nicht mehr da waren, vergessen - Sperren
     (entfernt) bleiben ein Jahr, sonst kaeme der Entfernte zurueck. */
  await pool.query(`DELETE FROM mitglieder WHERE zuletzt < $1 AND (NOT entfernt OR zuletzt < $2)`,
                   [cutoff, Date.now() - 365 * 24 * 60 * 60 * 1000]);
  /* Push-Anmeldungen, die seit einem halben Jahr nichts mehr getan haben,
     sind mit hoher Wahrscheinlichkeit tote Geraete. */
  await pool.query(`DELETE FROM subscriptions WHERE at < $1`,
                   [Date.now() - 180 * 24 * 60 * 60 * 1000]);
  return rowCount;
}

/* ------------------------ Push-Anmeldungen ------------------------ */
/* Der Schluessel ist Endpunkt *und* Chat: Ein Geraet kann mehrere Chats
   abonnieren. Frueher war der Endpunkt allein der Schluessel - dann
   ueberschrieb jede neue Anmeldung die vorige, und die Glocke galt immer
   nur fuer den zuletzt geoeffneten Chat. */
export async function saveSubscription({ endpoint, room, device, name, lang, data }) {
  if (!usingDatabase) {
    mem.subs.set(endpoint + "|" + room, { endpoint, room, device, name, lang, data, at: Date.now() });
    return;
  }
  await pool.query(
    `INSERT INTO subscriptions (endpoint, room, device, name, lang, data, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (endpoint, room) DO UPDATE
       SET device = EXCLUDED.device,
           name = EXCLUDED.name, lang = EXCLUDED.lang, data = EXCLUDED.data`,
    [endpoint, room, device, name, lang, JSON.stringify(data), Date.now()]
  );
}

export async function getSubscriptions(room) {
  if (!usingDatabase) {
    return [...mem.subs.values()].filter((s) => s.room === room);
  }
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE room = $1`, [room]);
  return rows.map((r) => ({
    endpoint: r.endpoint, room: r.room, device: r.device,
    name: r.name, lang: r.lang, data: r.data,
  }));
}

/* Alle Anmeldungen - fuer den taeglichen Lern-Satz (lernpush.js). */
export async function alleSubscriptions() {
  if (!usingDatabase) return [...mem.subs.values()];
  const { rows } = await pool.query(`SELECT * FROM subscriptions ORDER BY at DESC`);
  return rows.map((r) => ({
    endpoint: r.endpoint, room: r.room, device: r.device,
    name: r.name, lang: r.lang, data: r.data,
  }));
}

/* Taeglicher Lern-Satz: wer ihn abgeschaltet hat, und an welchen Tagen
   er schon rausging (damit ein Neustart um 9 Uhr nicht doppelt schickt). */
const lernMem = { aus: new Set(), tage: new Set() };
export async function lernAusSetzen(device, aus) {
  if (!usingDatabase) { if (aus) lernMem.aus.add(device); else lernMem.aus.delete(device); return; }
  if (aus) await pool.query(`INSERT INTO lern_aus (device, at) VALUES ($1, $2) ON CONFLICT (device) DO NOTHING`, [device, Date.now()]);
  else await pool.query(`DELETE FROM lern_aus WHERE device = $1`, [device]);
}
export async function lernAusListe() {
  if (!usingDatabase) return new Set(lernMem.aus);
  const { rows } = await pool.query(`SELECT device FROM lern_aus`);
  return new Set(rows.map((r) => r.device));
}
/* true nur beim ersten Aufruf je Tag. */
export async function lernTagMerken(tag) {
  if (!usingDatabase) { if (lernMem.tage.has(tag)) return false; lernMem.tage.add(tag); return true; }
  const r = await pool.query(`INSERT INTO lern_tage (tag) VALUES ($1) ON CONFLICT (tag) DO NOTHING`, [tag]);
  return r.rowCount > 0;
}

/* Ein toter Endpunkt ist fuer alle seine Chats tot. */
export async function deleteSubscription(endpoint) {
  if (!usingDatabase) {
    for (const k of [...mem.subs.keys()]) if (k.startsWith(endpoint + "|")) mem.subs.delete(k);
    return;
  }
  await pool.query(`DELETE FROM subscriptions WHERE endpoint = $1`, [endpoint]);
}

/* -------------------------- Mitgliedschaften --------------------------
   Eine Zeile je Chat. Wer nichts bezahlt hat, hat hier keine Zeile und
   bekommt das freie Kontingent.
--------------------------------------------------------------------- */
export async function getPlan(room) {
  if (!usingDatabase) return mem.plans.get(room) || null;
  const { rows } = await pool.query(`SELECT * FROM plans WHERE room = $1`, [room]);
  return rows[0] || null;
}

export async function getPlanBySubscription(subscription) {
  if (!usingDatabase) {
    return [...mem.plans.values()].find((p) => p.subscription === subscription) || null;
  }
  const { rows } = await pool.query(`SELECT * FROM plans WHERE subscription = $1`, [subscription]);
  return rows[0] || null;
}

export async function savePlan(p) {
  const zeile = {
    room: p.room, plan: p.plan, status: p.status,
    customer: p.customer || null, subscription: p.subscription || null,
    manage_key: p.manage_key || null, period_end: p.period_end || null,
    at: Date.now(),
  };
  if (!usingDatabase) { mem.plans.set(p.room, zeile); return zeile; }

  /* manage_key nur setzen, wenn einer mitkommt: Eine spaetere Meldung
     von Stripe darf den Schluessel des Zahlers nicht ueberschreiben. */
  const { rows } = await pool.query(
    `INSERT INTO plans (room, plan, status, customer, subscription, manage_key, period_end, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (room) DO UPDATE SET
       plan = EXCLUDED.plan, status = EXCLUDED.status,
       customer = COALESCE(EXCLUDED.customer, plans.customer),
       subscription = COALESCE(EXCLUDED.subscription, plans.subscription),
       manage_key = COALESCE(EXCLUDED.manage_key, plans.manage_key),
       period_end = EXCLUDED.period_end, at = EXCLUDED.at
     RETURNING *`,
    [zeile.room, zeile.plan, zeile.status, zeile.customer, zeile.subscription,
     zeile.manage_key, zeile.period_end, zeile.at]
  );
  return rows[0];
}

/* Wie viele Uebersetzungen dieser Chat im laufenden Kalendermonat schon
   verbraucht hat. Zaehlt aus dem Verbrauchsprotokoll - es gibt also
   keine zweite Zahl, die aus dem Tritt geraten koennte. */
export async function translationsThisMonth(room) {
  const jetzt = new Date();
  const monatsAnfang = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1);

  if (!usingDatabase) {
    return mem.usage.filter((r) => r.room === room && r.at >= monatsAnfang).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM usage_log WHERE room = $1 AND at >= $2`,
    [room, monatsAnfang]
  );
  return rows[0]?.n || 0;
}

/* ----------------------------- Trichter -----------------------------
   Zaehlt, an welcher Stelle Leute aufhoeren. Bewusst grob: eine Zahl je
   Tag und Ereignis, keine Kennung, keine Adresse. Schlaegt das Zaehlen
   fehl, ist das gleichgueltig - es darf nie den Betrieb stoeren.
------------------------------------------------------------------- */
const heute = () => new Date().toISOString().slice(0, 10);

export async function zaehle(ereignis) {
  const tag = heute();
  if (!usingDatabase) {
    const k = `${tag}|${ereignis}`;
    mem.funnel.set(k, (mem.funnel.get(k) || 0) + 1);
    return;
  }
  await pool.query(
    `INSERT INTO funnel (tag, ereignis, n) VALUES ($1,$2,1)
     ON CONFLICT (tag, ereignis) DO UPDATE SET n = funnel.n + 1`,
    [tag, ereignis]
  );
}

/* Summen der letzten Tage, plus der Verlauf je Tag. */
export async function trichter(tage = 14) {
  const grenze = new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let zeilen;
  if (!usingDatabase) {
    zeilen = [...mem.funnel.entries()]
      .map(([k, n]) => { const [tag, ereignis] = k.split("|"); return { tag, ereignis, n }; })
      .filter((z) => z.tag >= grenze);
  } else {
    const { rows } = await pool.query(
      `SELECT tag, ereignis, n FROM funnel WHERE tag >= $1 ORDER BY tag DESC`, [grenze]
    );
    zeilen = rows.map((r) => ({ tag: r.tag, ereignis: r.ereignis, n: Number(r.n) }));
  }

  const summe = {};
  const proTag = {};
  for (const z of zeilen) {
    summe[z.ereignis] = (summe[z.ereignis] || 0) + z.n;
    (proTag[z.tag] ||= {})[z.ereignis] = z.n;
  }
  return { tage, summe, proTag };
}

/* Trichter je Chat (Admin): Was wird aus neuen Chats? Gezaehlt werden
   Chats, deren erste Nachricht in den letzten `tage` Tagen kam - ohne
   Probe-Chats (demo-...) und ohne die Chats in `auslassen` (eigene).
   Stufen: geschrieben -> zweite Person dabei -> beide schreiben ->
   an mehr als einem Tag benutzt. Nur Zahlen, keine Inhalte. */
export async function chatTrichter(tage = 28, auslassen = []) {
  const seit = Date.now() - tage * 24 * 60 * 60 * 1000;
  const weg = new Set(auslassen.map((r) => String(r).toLowerCase()));
  let raeume = [];   // { room, erst, schreiber, tage }
  const mitDabei = new Map();   // room -> Anzahl Geraete in mitglieder
  if (!usingDatabase) {
    const je = new Map();
    for (const m of mem.messages.values()) {
      if (!m || m.deleted) continue;
      const r = je.get(m.room) || { room: m.room, erst: Infinity, geraete: new Set(), tage: new Set() };
      r.erst = Math.min(r.erst, m.at); r.geraete.add(m.device); r.tage.add(new Date(m.at).toISOString().slice(0, 10));
      je.set(m.room, r);
    }
    raeume = [...je.values()].map((r) => ({ room: r.room, erst: r.erst, schreiber: r.geraete.size, tage: r.tage.size }));
    for (const v of (mem.mitglieder || new Map()).values()) {
      if (v && v.room) mitDabei.set(v.room, (mitDabei.get(v.room) || 0) + 1);
    }
  } else {
    const { rows } = await pool.query(
      `SELECT room, MIN(at) AS erst, COUNT(DISTINCT device) AS schreiber,
              COUNT(DISTINCT to_char(to_timestamp(at / 1000.0), 'YYYY-MM-DD')) AS tage
         FROM messages WHERE room NOT LIKE 'demo-%' GROUP BY room HAVING MIN(at) >= $1`, [seit]);
    raeume = rows.map((r) => ({ room: r.room, erst: Number(r.erst), schreiber: Number(r.schreiber), tage: Number(r.tage) }));
    try {
      const m = await pool.query(`SELECT room, COUNT(*) AS n FROM mitglieder GROUP BY room`);
      for (const r of m.rows) mitDabei.set(r.room, Number(r.n));
    } catch {}
  }
  raeume = raeume.filter((r) => r.erst >= seit && !String(r.room).startsWith("demo-") && !weg.has(String(r.room).toLowerCase()));
  const z = { tage, chats: raeume.length, zweitePerson: 0, beideSchreiben: 0, mehrereTage: 0, gruppen3: 0 };
  for (const r of raeume) {
    const personen = Math.max(r.schreiber, mitDabei.get(r.room) || 0);
    if (personen >= 2) z.zweitePerson++;
    if (r.schreiber >= 2) z.beideSchreiben++;
    if (r.schreiber >= 2 && r.tage >= 2) z.mehrereTage++;
    if (personen >= 3) z.gruppen3++;
  }
  return z;
}

/* ------------------------------- Abos -------------------------------
   Ein Abo gehoert dem Zahler. Welche Chats es freischaltet, steht in
   abo_raeume - ein Chat immer nur in einem Abo.
------------------------------------------------------------------- */
export function neueAboId() {
  return "abo_" + crypto.randomBytes(12).toString("hex");
}

export async function getAbo(id) {
  if (!id) return null;
  if (!usingDatabase) return mem.abos.get(id) || null;
  const { rows } = await pool.query(`SELECT * FROM abos WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getAboByRoom(room) {
  if (!usingDatabase) {
    const id = mem.aboRaeume.get(room);
    return id ? mem.abos.get(id) || null : null;
  }
  const { rows } = await pool.query(
    `SELECT a.* FROM abos a JOIN abo_raeume r ON r.abo_id = a.id WHERE r.room = $1`, [room]
  );
  return rows[0] || null;
}

export async function getAboBySubscription(subscription) {
  if (!subscription) return null;
  if (!usingDatabase) {
    return [...mem.abos.values()].find((a) => a.subscription === subscription) || null;
  }
  const { rows } = await pool.query(`SELECT * FROM abos WHERE subscription = $1`, [subscription]);
  return rows[0] || null;
}

export async function saveAbo(a) {
  const zeile = {
    id: a.id, plan: a.plan, status: a.status,
    customer: a.customer || null, subscription: a.subscription || null,
    manage_key: a.manage_key || null, period_end: a.period_end || null,
    at: Date.now(),
  };
  if (!usingDatabase) {
    const alt = mem.abos.get(a.id) || {};
    mem.abos.set(a.id, {
      ...alt, ...zeile,
      customer: zeile.customer ?? alt.customer ?? null,
      subscription: zeile.subscription ?? alt.subscription ?? null,
      manage_key: zeile.manage_key ?? alt.manage_key ?? null,
    });
    return mem.abos.get(a.id);
  }
  /* COALESCE, damit eine spaetere Meldung von Stripe den Schluessel des
     Zahlers nicht ueberschreibt. */
  const { rows } = await pool.query(
    `INSERT INTO abos (id, plan, status, customer, subscription, manage_key, period_end, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       plan = EXCLUDED.plan, status = EXCLUDED.status,
       customer = COALESCE(EXCLUDED.customer, abos.customer),
       subscription = COALESCE(EXCLUDED.subscription, abos.subscription),
       manage_key = COALESCE(EXCLUDED.manage_key, abos.manage_key),
       period_end = EXCLUDED.period_end, at = EXCLUDED.at
     RETURNING *`,
    [zeile.id, zeile.plan, zeile.status, zeile.customer, zeile.subscription,
     zeile.manage_key, zeile.period_end, zeile.at]
  );
  return rows[0];
}

export async function raeumeVonAbo(aboId) {
  if (!usingDatabase) {
    return [...mem.aboRaeume.entries()].filter(([, id]) => id === aboId).map(([r]) => r).sort();
  }
  const { rows } = await pool.query(
    `SELECT room FROM abo_raeume WHERE abo_id = $1 ORDER BY at`, [aboId]
  );
  return rows.map((r) => r.room);
}

/* Gibt zurueck, ob der Chat dazugekommen ist. false heisst: gehoert
   schon zu einem anderen Abo. */
export async function raumHinzufuegen(aboId, room) {
  /* Ein Einlade-Bonus ("bonus_...") macht einem echten Abo Platz. */
  const echt = !String(aboId).startsWith("bonus_");
  if (!usingDatabase) {
    const vorher = mem.aboRaeume.get(room);
    if (echt && vorher && String(vorher).startsWith("bonus_")) mem.aboRaeume.delete(room);
    const belegt = mem.aboRaeume.get(room);
    if (belegt && belegt !== aboId) return false;
    mem.aboRaeume.set(room, aboId);
    return true;
  }
  if (echt) await pool.query(`DELETE FROM abo_raeume WHERE room = $1 AND abo_id LIKE 'bonus%'`, [room]);
  const { rowCount } = await pool.query(
    `INSERT INTO abo_raeume (abo_id, room, at) VALUES ($1,$2,$3)
     ON CONFLICT (room) DO NOTHING`,
    [aboId, room, Date.now()]
  );
  if (rowCount > 0) return true;
  const { rows } = await pool.query(`SELECT abo_id FROM abo_raeume WHERE room = $1`, [room]);
  return rows[0]?.abo_id === aboId;
}

export async function raumEntfernen(aboId, room) {
  if (!usingDatabase) {
    if (mem.aboRaeume.get(room) === aboId) mem.aboRaeume.delete(room);
    return;
  }
  await pool.query(`DELETE FROM abo_raeume WHERE abo_id = $1 AND room = $2`, [aboId, room]);
}

/* Verbrauch eines ganzen Abos im laufenden Kalendermonat: die Summe
   ueber alle seine Chats. */
export async function translationsThisMonthForRooms(rooms) {
  if (!rooms || !rooms.length) return 0;
  const jetzt = new Date();
  const monatsAnfang = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1);

  if (!usingDatabase) {
    return mem.usage.filter((r) => rooms.includes(r.room) && r.at >= monatsAnfang).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM usage_log WHERE room = ANY($1) AND at >= $2`,
    [rooms, monatsAnfang]
  );
  return rows[0]?.n || 0;
}

/* --------------------------- Umzug ---------------------------------
   Die alten Mitgliedschaften hingen am Chat. Jede wird zu einem Abo mit
   genau diesem einen Chat - niemand verliert etwas, und ab dann kann
   der Zahler weitere Chats dazunehmen.
------------------------------------------------------------------- */
export async function umzugAltePlaene() {
  if (!usingDatabase) return 0;

  /* Ein dauerhafter Merker, dass der Umzug lief - er laeuft genau einmal.
     Frueher galt "abos ist leer" als "noch nicht umgezogen". Das ist eine
     Falle: Wird der Abo-Bestand spaeter leer (etwa nach einer Kuendigung
     oder beim Aufraeumen von Testdaten), holt der naechste Neustart die
     alten plans-Zeilen zurueck. Der Merker verhindert das fuer immer. */
  await pool.query(
    `CREATE TABLE IF NOT EXISTS meta (schluessel TEXT PRIMARY KEY, wert TEXT)`
  );
  const { rows: fertig } = await pool.query(
    `SELECT 1 FROM meta WHERE schluessel = 'umzug_plaene'`
  );
  if (fertig.length) return 0;                /* schon einmal gelaufen */

  let alt = [];
  try {
    const r = await pool.query(`SELECT * FROM plans`);
    alt = r.rows;
  } catch { alt = []; }                        /* keine alte Tabelle - nichts zu tun */
  let n = 0;
  for (const p of alt) {
    const id = neueAboId();
    await pool.query(
      `INSERT INTO abos (id, plan, status, customer, subscription, manage_key, period_end, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, p.plan, p.status, p.customer, p.subscription, p.manage_key, p.period_end, Number(p.at) || Date.now()]
    );
    await pool.query(
      `INSERT INTO abo_raeume (abo_id, room, at) VALUES ($1,$2,$3) ON CONFLICT (room) DO NOTHING`,
      [id, p.room, Number(p.at) || Date.now()]
    );
    n++;
  }
  await pool.query(
    `INSERT INTO meta (schluessel, wert) VALUES ('umzug_plaene', $1)
     ON CONFLICT (schluessel) DO NOTHING`,
    [new Date().toISOString()]
  );
  if (n) console.log(`  ${n} alte Mitgliedschaft(en) in Abos umgezogen.`);
  return n;
}

/* ------------------------- Was ist neu? -----------------------------
   Zaehlt je Chat, wie viele fremde Nachrichten seit einem Zeitpunkt
   dazugekommen sind. Gibt nur Zahlen zurueck, nie Inhalte - so kann die
   Abfrage niemandem etwas verraten, der einen Chat-Code errechnet.
------------------------------------------------------------------- */
export async function neueNachrichten(paare, device) {
  const raus = {};
  for (const { room, seit } of (paare || []).slice(0, 20)) {
    if (!room) continue;
    const ab = Number(seit) || 0;
    if (!usingDatabase) {
      const ids = mem.rooms.get(room) || [];
      raus[room] = ids
        .map((id) => mem.messages.get(id))
        .filter((m) => m && m.at > ab && m.device !== device && !m.deleted).length;
      continue;
    }
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages
       WHERE room = $1 AND at > $2 AND device <> $3 AND deleted = FALSE`,
      [room, ab, device || ""]
    );
    raus[room] = rows[0]?.n || 0;
  }
  return raus;
}

/* --------------------------- Admin-Zahlen ---------------------------
   Reine Aggregate fuer die Uebersicht - niemals Chat-Codes oder
   Nachrichteninhalte. Ein Chat-Code ist ein Zugangsschluessel; ihn
   anzuzeigen hiesse, dem Admin Zutritt zu fremden Gespraechen zu geben.
------------------------------------------------------------------- */
/* Chats, in denen in den letzten Tagen mindestens zwei verschiedene
   Geraete geschrieben haben - also echte Gespraeche. Viele Besucher der
   Webseite probieren allein in einem eigenen Chat; die zaehlen hier nicht. */
export async function gespraeche(days = 7) {
  const seit = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!usingDatabase) {
    const je = new Map();
    for (const m of mem.messages.values()) {
      if (m.at < seit) continue;
      if (!je.has(m.room)) je.set(m.room, new Set());
      je.get(m.room).add(m.device);
    }
    return [...je.values()].filter((g) => g.size >= 2).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT room FROM messages WHERE at >= $1 GROUP BY room HAVING COUNT(DISTINCT device) >= 2
     ) g`, [seit]
  );
  return rows[0]?.n || 0;
}

/* Gespraeche nach Personen statt nach Chats.

   Ein Chat-Code ist kein Gespraech: Dieselben zwei Menschen haben oft
   mehrere Chats (neu angelegt, alte App + neue App, Handy + Rechner).
   Darum verbinden wir alle Chats, die ein Geraet gemeinsam haben, zu
   einer Gruppe. Eine Gruppe mit 2+ Geraeten ist ein Gespraech; eine
   Gruppe mit einem Geraet ist jemand, der allein ausprobiert hat.
   Testgeraete ("test_...") zaehlen nicht. Nur Summen, keine Codes,
   keine Namen. */
export async function personenGruppen(days = 7) {
  const seit = Date.now() - days * 24 * 60 * 60 * 1000;
  let zeilen;
  if (!usingDatabase) {
    const je = new Map();
    for (const m of mem.messages.values()) {
      if (m.at < seit) continue;
      const k = m.room + "|" + m.device;
      const z = je.get(k) || { room: m.room, device: m.device, n: 0, lang: m.lang, last: 0 };
      z.n++; z.last = Math.max(z.last, m.at); je.set(k, z);
    }
    zeilen = [...je.values()];
  } else {
    ({ rows: zeilen } = await pool.query(
      `SELECT room, device, COUNT(*)::int AS n, MAX(lang) AS lang, MAX(at) AS last
         FROM messages WHERE at >= $1 AND device IS NOT NULL GROUP BY room, device`, [seit]
    ));
  }
  zeilen = zeilen.filter((z) => z.device && !String(z.device).startsWith("test_"));

  /* Vereinigen: Raum und Geraet sind Knoten, jede Zeile verbindet beide. */
  const eltern = new Map();
  const finde = (x) => {
    while (eltern.get(x) !== x) { eltern.set(x, eltern.get(eltern.get(x))); x = eltern.get(x); }
    return x;
  };
  const knoten = (x) => { if (!eltern.has(x)) eltern.set(x, x); return x; };
  for (const z of zeilen) {
    const a = finde(knoten("r:" + z.room)), b = finde(knoten("d:" + z.device));
    if (a !== b) eltern.set(a, b);
  }
  const gruppen = new Map();
  for (const z of zeilen) {
    const w = finde("r:" + z.room);
    const g = gruppen.get(w) || { geraete: new Set(), raeume: new Set(), sprachen: new Set(), nachrichten: 0, zuletzt: 0 };
    g.geraete.add(z.device); g.raeume.add(z.room);
    if (z.lang) g.sprachen.add(String(z.lang).split("-")[0]);
    g.nachrichten += Number(z.n); g.zuletzt = Math.max(g.zuletzt, Number(z.last));
    gruppen.set(w, g);
  }
  const liste = [...gruppen.values()].map((g) => ({
    geraete: g.geraete.size, chats: g.raeume.size, nachrichten: g.nachrichten,
    sprachen: [...g.sprachen].sort(), zuletzt: g.zuletzt,
  }));
  const gespraeche = liste.filter((g) => g.geraete >= 2).sort((a, b) => b.zuletzt - a.zuletzt);
  return {
    gespraeche: gespraeche.length,
    allein: liste.filter((g) => g.geraete < 2).length,
    liste: gespraeche.slice(0, 30),
  };
}

export async function aktiveChats(days = 7) {
  const seit = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!usingDatabase) {
    return new Set([...mem.messages.values()].filter((m) => m.at >= seit).map((m) => m.room)).size;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT room)::int AS n FROM messages WHERE at >= $1`, [seit]
  );
  return rows[0]?.n || 0;
}

/* Aktive Abos nach Tarif. "canceled" zaehlt nicht mehr. */
export async function aboZaehlung() {
  const laeuft = ["active", "trialing", "past_due", "gekuendigt"];
  if (!usingDatabase) {
    const z = { plus: 0, familie: 0 };
    for (const a of mem.abos.values()) if (laeuft.includes(a.status)) z[a.plan] = (z[a.plan] || 0) + 1;
    return z;
  }
  const { rows } = await pool.query(
    `SELECT plan, COUNT(*)::int AS n FROM abos WHERE status = ANY($1) GROUP BY plan`, [laeuft]
  );
  const z = { plus: 0, familie: 0 };
  for (const r of rows) z[r.plan] = Number(r.n);
  const b = await pool.query(`SELECT COUNT(*)::int AS n FROM abos WHERE status = 'bonus' AND period_end > $1`, [Date.now()]);
  z.bonus = b.rows[0]?.n || 0;
  return z;
}

/* Wie viele Geraete Benachrichtigungen eingeschaltet haben. */
export async function pushZaehlung() {
  if (!usingDatabase) {
    return new Set([...mem.subs.values()].map((s) => s.device)).size;
  }
  const { rows } = await pool.query(`SELECT COUNT(DISTINCT device)::int AS n FROM subscriptions`);
  return rows[0]?.n || 0;
}

/* ----------------------- Untertitel-Minuten ----------------------- */
export async function anrufSekunden(topf, monat) {
  if (!usingDatabase) return mem.anrufSek.get(`${topf}|${monat}`) || 0;
  const { rows } = await pool.query(
    `SELECT sekunden FROM anruf_sekunden WHERE topf = $1 AND monat = $2`, [topf, monat]);
  return rows[0]?.sekunden || 0;
}

export async function anrufSekundenDazu(topf, monat, sek) {
  const n = Math.max(0, Math.round(sek));
  if (!n) return;
  if (!usingDatabase) {
    const k = `${topf}|${monat}`;
    mem.anrufSek.set(k, (mem.anrufSek.get(k) || 0) + n);
    return;
  }
  await pool.query(
    `INSERT INTO anruf_sekunden (topf, monat, sekunden) VALUES ($1, $2, $3)
     ON CONFLICT (topf, monat) DO UPDATE SET sekunden = anruf_sekunden.sekunden + EXCLUDED.sekunden`,
    [topf, monat, n]);
}

/* ----------------------- Kosten-Zaehler (Google) ----------------------- */
export async function zaehlerDazu(monat, art, menge) {
  const n = Math.max(0, Math.round(menge));
  if (!n) return;
  if (!usingDatabase) {
    const k = `${monat}|${art}`;
    mem.zaehler.set(k, (mem.zaehler.get(k) || 0) + n);
    return;
  }
  await pool.query(
    `INSERT INTO kosten_zaehler (monat, art, menge) VALUES ($1, $2, $3)
     ON CONFLICT (monat, art) DO UPDATE SET menge = kosten_zaehler.menge + EXCLUDED.menge`,
    [monat, art, n]);
}

export async function zaehlerMonat(monat) {
  const out = {};
  if (!usingDatabase) {
    for (const [k, v] of mem.zaehler) { const [m, art] = k.split("|"); if (Number(m) === monat) out[art] = v; }
    return out;
  }
  const { rows } = await pool.query(`SELECT art, menge FROM kosten_zaehler WHERE monat = $1`, [monat]);
  for (const r of rows) out[r.art] = Number(r.menge);
  return out;
}

/* Vorlese-Zeichen aus der Zeit vor dem Zaehler (standen in usage_log). */
export async function ttsZeichenSeit(seit) {
  if (!usingDatabase) return mem.usage.filter((r) => r.at >= seit && r.room === "__tts__").reduce((a, r) => a + r.chars, 0);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(chars),0)::bigint AS n FROM usage_log WHERE room = '__tts__' AND at >= $1`, [seit]);
  return Number(rows[0]?.n || 0);
}

/* Wie viele Einlade-Boni hat dieses Geraet seit einem Zeitpunkt bekommen? */
export async function bonusAnzahl(geraet, seit) {
  if (!usingDatabase) {
    return [...mem.abos.values()].filter((a) => a.status === "bonus" && a.customer === geraet && a.at >= seit).length;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM abos WHERE status = 'bonus' AND customer = $1 AND at >= $2`, [geraet, seit]);
  return rows[0]?.n || 0;
}

/* ------------------------------ Gruppen ------------------------------
   Ein Chat wird zur Gruppe, sobald jemand ihm einen Namen gibt. Wer das
   als Erster tut, ist der Chef (admin): Er darf umbenennen und Leute
   entfernen. Die Mitgliederliste fuehrt jedes Geraet, das den Chat
   betreten hat - mit Name, Sprache und wann es zuletzt da war.
--------------------------------------------------------------------- */
export async function getGruppe(room) {
  if (!usingDatabase) return mem.gruppen.get(room) || null;
  const { rows } = await pool.query(`SELECT name, admin, erstellt, angeheftet FROM gruppen WHERE room = $1`, [room]);
  return rows[0] ? { name: rows[0].name, admin: rows[0].admin, erstellt: Number(rows[0].erstellt),
                     angeheftet: rows[0].angeheftet || null } : null;
}

export async function setGruppe(room, name, admin) {
  if (!usingDatabase) {
    const alt = mem.gruppen.get(room);
    mem.gruppen.set(room, { name, admin: alt?.admin || admin, erstellt: alt?.erstellt || Date.now(), angeheftet: alt?.angeheftet || null });
    return;
  }
  await pool.query(
    `INSERT INTO gruppen (room, name, admin, erstellt) VALUES ($1,$2,$3,$4)
     ON CONFLICT (room) DO UPDATE SET name = EXCLUDED.name`,
    [room, name, admin, Date.now()]
  );
}

/* Durchsage anheften (Nachrichten-ID) oder loesen (null). */
export async function setAngeheftet(room, id) {
  if (!usingDatabase) {
    const g = mem.gruppen.get(room);
    if (g) g.angeheftet = id || null;
    return;
  }
  await pool.query(`UPDATE gruppen SET angeheftet = $2 WHERE room = $1`, [room, id || null]);
}

export async function mitgliedDa(room, device, name, lang) {
  if (!usingDatabase) {
    const k = `${room}|${device}`;
    const alt = mem.mitglieder.get(k);
    mem.mitglieder.set(k, { room, device, name, lang, zuletzt: Date.now(), entfernt: alt?.entfernt || false });
    return;
  }
  await pool.query(
    `INSERT INTO mitglieder (room, device, name, lang, zuletzt) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (room, device) DO UPDATE
       SET name = EXCLUDED.name, lang = EXCLUDED.lang, zuletzt = EXCLUDED.zuletzt`,
    [room, device, name, lang, Date.now()]
  );
}

/* Alle (nicht entfernten) Mitglieder, dazu ihr Lesestand. */
export async function mitgliederVon(room) {
  if (!usingDatabase) {
    return [...mem.mitglieder.values()]
      .filter((m) => m.room === room && !m.entfernt)
      .map((m) => ({ device: m.device, name: m.name, lang: m.lang, zuletzt: m.zuletzt,
                     bis: mem.readState.get(`${room}|${m.device}`) || 0 }));
  }
  const { rows } = await pool.query(
    `SELECT m.device, m.name, m.lang, m.zuletzt, COALESCE(r.bis, 0)::bigint AS bis
       FROM mitglieder m LEFT JOIN read_state r ON r.room = m.room AND r.device = m.device
      WHERE m.room = $1 AND NOT m.entfernt
      ORDER BY m.zuletzt DESC LIMIT 300`,
    [room]
  );
  return rows.map((r) => ({ device: r.device, name: r.name, lang: r.lang,
                            zuletzt: Number(r.zuletzt), bis: Number(r.bis) }));
}

/* Geraet aus dem Chat sperren und seine Push-Anmeldungen fuer diesen
   Chat loeschen - sonst bekaeme es weiter die Nachrichten aufs Handy. */
export async function mitgliedEntfernen(room, device) {
  if (!usingDatabase) {
    const k = `${room}|${device}`;
    const alt = mem.mitglieder.get(k) || { room, device, name: "?", lang: "de" };
    mem.mitglieder.set(k, { ...alt, zuletzt: Date.now(), entfernt: true });
    for (const [key, sub] of [...mem.subs]) if (sub.room === room && sub.device === device) mem.subs.delete(key);
    return;
  }
  await pool.query(
    `INSERT INTO mitglieder (room, device, name, lang, zuletzt, entfernt) VALUES ($1,$2,'?','de',$3,TRUE)
     ON CONFLICT (room, device) DO UPDATE SET entfernt = TRUE, zuletzt = EXCLUDED.zuletzt`,
    [room, device, Date.now()]
  );
  await pool.query(`DELETE FROM subscriptions WHERE room = $1 AND device = $2`, [room, device]);
}

/* Wie viele verschiedene Personen sind in diesen Chats (ohne Entfernte),
   und ist dieses Geraet schon darunter? Fuer die Team-Grenze. */
export async function personenInRaeumen(raeume, device) {
  const liste = (raeume || []).filter(Boolean);
  if (!liste.length) return { anzahl: 0, dabei: false };
  if (!usingDatabase) {
    const geraete = new Set();
    for (const m of mem.mitglieder.values()) if (liste.includes(m.room) && !m.entfernt) geraete.add(m.device);
    return { anzahl: geraete.size, dabei: geraete.has(device) };
  }
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT device)::int AS anzahl, BOOL_OR(device = $2) AS dabei
       FROM mitglieder WHERE room = ANY($1) AND NOT entfernt`,
    [liste, device]
  );
  return { anzahl: rows[0]?.anzahl || 0, dabei: Boolean(rows[0]?.dabei) };
}

export async function istEntfernt(room, device) {
  if (!room || !device) return false;
  if (!usingDatabase) return Boolean(mem.mitglieder.get(`${room}|${device}`)?.entfernt);
  const { rows } = await pool.query(
    `SELECT 1 FROM mitglieder WHERE room = $1 AND device = $2 AND entfernt`, [room, device]);
  return rows.length > 0;
}

/* ------------------------- Geraete-Schluessel -------------------------
   Die Geraete-Kennung ist oeffentlich (sie steht an jeder Nachricht).
   Wer etwas "als dieses Geraet" tun will - eigene Nachrichten loeschen,
   eine Gruppe verwalten - muss zusaetzlich den geheimen Schluessel
   kennen, den nur das Geraet selbst hat. Gespeichert wird nur sein
   Abdruck. Wer zuerst einen Schluessel fuer eine Kennung bringt, dem
   gehoert sie (danach bleibt sie fest). */
export async function geraetAbdruck(device) {
  if (!device) return null;
  if (!usingDatabase) return mem.geraete.get(device) || null;
  const { rows } = await pool.query(`SELECT abdruck FROM geraete WHERE device = $1`, [device]);
  return rows[0]?.abdruck || null;
}

/* Legt den Abdruck an, falls es noch keinen gibt. Gibt den gueltigen
   Abdruck zurueck (den neuen oder den, der schon da war). */
export async function geraetMerken(device, abdruck) {
  if (!usingDatabase) {
    if (!mem.geraete.has(device)) mem.geraete.set(device, abdruck);
    return mem.geraete.get(device);
  }
  await pool.query(
    `INSERT INTO geraete (device, abdruck, erstellt) VALUES ($1,$2,$3) ON CONFLICT (device) DO NOTHING`,
    [device, abdruck, Date.now()]
  );
  return geraetAbdruck(device);
}

/* ---------------------------- Chat umziehen ----------------------------
   Alles eines Chats unter einen neuen Code legen: Nachrichten, Lesestand,
   Push-Anmeldungen, Abo-Zuordnung, Gruppe, Mitglieder, Verbrauch. Fuer den
   Fall, dass ein Code erraten werden kann. Nur in einen LEEREN Ziel-Chat. */
export async function raumUmziehen(von, nach) {
  if (!usingDatabase) {
    if ((mem.rooms.get(nach) || []).length) throw new Error("Ziel-Chat ist nicht leer");
    const ids = mem.rooms.get(von) || [];
    for (const id of ids) { const m = mem.messages.get(id); if (m) m.room = nach; }
    mem.rooms.set(nach, ids); mem.rooms.delete(von);
    for (const map of [mem.readState, mem.mitglieder]) {
      for (const [k, v] of [...map]) if (k.startsWith(von + "|")) {
        map.delete(k);
        map.set(nach + k.slice(von.length), typeof v === "object" ? { ...v, room: nach } : v);
      }
    }
    for (const [k, v] of [...mem.subs]) if (v.room === von) { mem.subs.delete(k); mem.subs.set(v.endpoint + "|" + nach, { ...v, room: nach }); }
    if (mem.gruppen.has(von)) { mem.gruppen.set(nach, mem.gruppen.get(von)); mem.gruppen.delete(von); }
    if (mem.aboRaeume.has(von)) { mem.aboRaeume.set(nach, mem.aboRaeume.get(von)); mem.aboRaeume.delete(von); }
    return { nachrichten: ids.length };
  }
  const leer = await pool.query(`SELECT 1 FROM messages WHERE room = $1 LIMIT 1`, [nach]);
  if (leer.rows.length) throw new Error("Ziel-Chat ist nicht leer");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`UPDATE messages SET room = $2 WHERE room = $1`, [von, nach]);
    for (const tabelle of ["read_state", "subscriptions", "abo_raeume", "mitglieder", "gruppen", "usage_log", "plans"]) {
      await client.query(`UPDATE ${tabelle} SET room = $2 WHERE room = $1`, [von, nach]);
    }
    await client.query("COMMIT");
    return { nachrichten: r.rowCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
