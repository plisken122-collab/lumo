/* --------------------------------------------------------------------
   store.js

   Zwei Speicher hinter einer gemeinsamen Schnittstelle:

   - Ist DATABASE_URL gesetzt, laeuft alles ueber Postgres. Nachrichten,
     Uebersetzungen und Push-Anmeldungen ueberleben dann jeden Neustart.
   - Fehlt die Variable, faellt alles in den Arbeitsspeicher zurueck.
     Praktisch zum lokalen Testen, aber nach einem Neustart ist alles weg.
-------------------------------------------------------------------- */
import pg from "pg";

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
};

/* ---------------------------- Schema ---------------------------- */
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
  `);
  console.log("  Datenbank bereit.");
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
    `INSERT INTO messages (id, room, device, name, body, lang, detected, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [msg.id, msg.room, msg.device, msg.name, msg.text, msg.lang, msg.detected, msg.at]
  );
  return msg;
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
    return ids.slice(-limit).map((id) => mem.messages.get(id)).filter(Boolean);
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
  return rows.map((r) => rowToMsg(r, byId.get(r.id) || []));
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

export async function setDetectedLang(id, lang) {
  if (!usingDatabase) {
    const m = mem.messages.get(id);
    if (m) { m.lang = lang; m.detected = true; }
    return;
  }
  await pool.query(`UPDATE messages SET lang = $2, detected = TRUE WHERE id = $1`, [id, lang]);
}

function rowToMsg(r, translations) {
  const tr = {};
  for (const t of translations) tr[t.lang] = t.body;
  return {
    id: r.id, room: r.room, device: r.device, name: r.name,
    text: r.body, lang: r.lang, detected: r.detected, at: Number(r.at), tr,
  };
}

/* ------------------------ Push-Anmeldungen ------------------------ */
export async function saveSubscription({ endpoint, room, device, name, lang, data }) {
  if (!usingDatabase) {
    mem.subs.set(endpoint, { endpoint, room, device, name, lang, data, at: Date.now() });
    return;
  }
  await pool.query(
    `INSERT INTO subscriptions (endpoint, room, device, name, lang, data, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (endpoint) DO UPDATE
       SET room = EXCLUDED.room, device = EXCLUDED.device,
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

export async function deleteSubscription(endpoint) {
  if (!usingDatabase) { mem.subs.delete(endpoint); return; }
  await pool.query(`DELETE FROM subscriptions WHERE endpoint = $1`, [endpoint]);
}
