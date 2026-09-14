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
  usage: [],           // Verbrauch pro Uebersetzung
  media: new Map(),    // message_id -> { mime, bytes }
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

    /* Spaeter dazugekommen: Dauer einer Sprachnachricht in Sekunden.
       NULL heisst: gewoehnliche Textnachricht. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_seconds INTEGER;

    /* Fuer alle geloescht. Der Inhalt ist dann wirklich fort - stehen
       bleibt nur diese Markierung, damit im Verlauf kein unerklaerliches
       Loch entsteht. */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;

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
    `INSERT INTO messages (id, room, device, name, body, lang, detected, at, audio_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [msg.id, msg.room, msg.device, msg.name, msg.text, msg.lang, msg.detected, msg.at,
     msg.audioSeconds ?? null]
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
    m.text = ""; m.tr = {}; m.deleted = true; m.audioSeconds = null;
    mem.media.delete(id);
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE messages SET body = '', deleted = TRUE, audio_seconds = NULL
     WHERE id = $1 AND device = $2 AND deleted = FALSE`,
    [id, device]
  );
  if (!rowCount) return false;
  await pool.query(`DELETE FROM translations WHERE message_id = $1`, [id]);
  await pool.query(`DELETE FROM media WHERE message_id = $1`, [id]);
  return true;
}

export async function getMedia(messageId) {
  if (!usingDatabase) return mem.media.get(messageId) || null;
  const { rows } = await pool.query(
    `SELECT mime, bytes FROM media WHERE message_id = $1`, [messageId]
  );
  return rows.length ? { mime: rows[0].mime, bytes: rows[0].bytes } : null;
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
    audioSeconds: r.audio_seconds ?? null,
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
    const rows = mem.usage.filter((r) => r.at >= since);
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
       FROM usage_log WHERE at >= $1`, [since]);

  const d = await pool.query(
    `SELECT to_char(to_timestamp(at/1000), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count,
            COALESCE(SUM(in_tokens),0)::bigint AS in_tokens,
            COALESCE(SUM(out_tokens),0)::bigint AS out_tokens
       FROM usage_log WHERE at >= $1
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
  /* Push-Anmeldungen, die seit einem halben Jahr nichts mehr getan haben,
     sind mit hoher Wahrscheinlichkeit tote Geraete. */
  await pool.query(`DELETE FROM subscriptions WHERE at < $1`,
                   [Date.now() - 180 * 24 * 60 * 60 * 1000]);
  return rowCount;
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
