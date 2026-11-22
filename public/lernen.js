/* --------------------------------------------------------------------
   Diralo Lernen

   Die Sprache des anderen lernen - mit den Saetzen, die man wirklich
   miteinander schreibt. Jede Nachricht liegt im Chat ja schon in beiden
   Sprachen vor (Original + Uebersetzung). Daraus werden Lernkarten:
   vorne der Satz in meiner Sprache, hinten in der des anderen.

   - "Zum Lernen merken" im Menue einer Nachricht
   - Vorschlaege: kurze Saetze, die im Chat oft vorkommen
   - Wiederholen nach Faecherprinzip: gewusst -> spaeter wieder,
     nicht gewusst -> gleich nochmal
   - Vorlesen mit natuerlicher Stimme (Server), sonst Browser-Stimme
   - Fortschritt: gelernte Saetze und Tage am Stueck
   - Gratis 5 Karten am Tag, mit einem Abo unbegrenzt

   Alles liegt nur in diesem Browser (localStorage), nichts auf dem
   Server. Nutzt die Hilfsmittel aus index.html: $, T, me, msgs,
   deviceId, LANGS, RTL, sheet, schliesseSheet, vorlesen, showErr.
-------------------------------------------------------------------- */
(function () {
  const SPEICHER = "diralo-lernen";
  const STUFEN = [0, 1, 3, 7, 16, 35];      // Tage bis zur naechsten Abfrage je Fach
  const GRATIS_PRO_TAG = 5;
  const TAG_MS = 24 * 60 * 60 * 1000;

  const tag = (d = new Date()) => d.toLocaleDateString("sv");   // JJJJ-MM-TT, lokale Zeit
  const gestern = () => tag(new Date(Date.now() - TAG_MS));

  function laden() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(SPEICHER) || "{}") || {}; } catch {}
    d.karten = Array.isArray(d.karten) ? d.karten : [];
    d.serie = d.serie || { tag: null, n: 0 };
    d.heute = d.heute || { tag: null, n: 0 };
    if (d.heute.tag !== tag()) d.heute = { tag: tag(), n: 0 };
    return d;
  }
  function sichern(d) {
    try { localStorage.setItem(SPEICHER, JSON.stringify(d)); } catch {}
  }

  const sprachName = (code) => (LANGS.find(([c]) => c === code) || [])[1] || String(code || "").toUpperCase();
  const basis = (l) => String(l || "").slice(0, 2);

  /* Die Sprache des Gegenuebers: die haeufigste fremde Sprache im Chat. */
  function partnerSprache() {
    const n = {};
    for (const m of msgs.values()) {
      if (m.deleted || !m.lang || m.device === deviceId) continue;
      if (basis(m.lang) === basis(me.lang)) continue;
      n[m.lang] = (n[m.lang] || 0) + 1;
    }
    const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    /* Noch keine fremde Nachricht: dann eine Uebersetzung eigener Nachrichten. */
    for (const m of msgs.values()) {
      for (const l of Object.keys(m.tr || {})) if (basis(l) !== basis(me.lang)) return l;
    }
    return null;
  }

  /* Text einer Nachricht in einer bestimmten Sprache - Original oder Uebersetzung. */
  function textIn(m, l) {
    if (!m || m.deleted) return "";
    if (m.lang === l || basis(m.lang) === basis(l) && !(m.tr || {})[l]) return (m.text || "").trim();
    return String((m.tr || {})[l] || "").trim();
  }

  function karteAus(m, zl) {
    if (!m || m.deleted || m.ort || m.datei || m.gif || m.bild) return null;
    const ziel = textIn(m, zl), mein = textIn(m, me.lang);
    if (!ziel || !mein || ziel === mein || ziel.length > 220) return null;
    if (!/\p{L}/u.test(ziel)) return null;
    return { id: m.id, ziel, mein, zl, ml: me.lang, fach: 0, faellig: 0, neu: Date.now() };
  }

  const schonDa = (d, k) => d.karten.some((x) => x.id === k.id || (x.zl === k.zl && x.ziel.toLowerCase() === k.ziel.toLowerCase()));

  /* ---------------- Merken aus dem Nachrichten-Menue ---------------- */
  function merken(m) {
    const zl = basis(m.lang) !== basis(me.lang) ? m.lang : partnerSprache();
    const k = zl && karteAus(m, zl);
    if (!k) { hinweis(T("lernenNichtMoeglich")); return; }
    const d = laden();
    if (schonDa(d, k)) { hinweis(T("lernenSchon")); return; }
    d.karten.push(k);
    sichern(d);
    hinweis("⭐ " + T("lernenGemerkt"));
    knopfAktualisieren();
  }

  function kannMerken(m) {
    if (!m || m.deleted || m.ort || m.datei || m.gif || m.bild || !(m.text || "").trim()) return false;
    return !!partnerSprache() || basis(m.lang) !== basis(me.lang);
  }

  /* ---------------- Vorschlaege aus dem Chat ---------------- */
  function vorschlaege(zl, wie = 6) {
    if (!zl) return [];
    const d = laden();
    const zaehl = new Map();
    for (const m of msgs.values()) {
      const k = karteAus(m, zl);
      if (!k) continue;
      const w = k.ziel.split(/\s+/).length;
      if (k.ziel.length < 2 || k.ziel.length > 70 || w > 9) continue;
      if (schonDa(d, k)) continue;
      const schluessel = k.ziel.toLowerCase().replace(/[!?.,…]+$/u, "").trim();
      const alt = zaehl.get(schluessel);
      if (alt) alt.n += 1;
      else zaehl.set(schluessel, { k, n: 1 });
    }
    /* Haeufig vor selten, kurz vor lang, neu vor alt. */
    return [...zaehl.values()]
      .sort((a, b) => b.n - a.n || a.k.ziel.length - b.k.ziel.length || b.k.id.localeCompare(a.k.id))
      .slice(0, wie)
      .map((x) => x.k);
  }

  /* ---------------- Abo: unbegrenzt lernen ---------------- */
  let planWert = null;   // null = unbekannt, true/false
  async function hatAbo() {
    if (planWert !== null) return planWert;
    try {
      const a = await fetch("/api/plan?room=" + encodeURIComponent(me.room));
      const p = await a.json();
      planWert = !!(p && p.plan && p.plan !== "frei");
    } catch { planWert = false; }
    return planWert;
  }

  /* ---------------- Vorlesen ---------------- */
  let audio = null;
  async function sprechen(text, lang) {
    try {
      if (audio) { audio.pause(); audio = null; }
      const a = await fetch("/api/sprechen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang, device: deviceId }),
      });
      if (!a.ok) throw new Error();
      const { id } = await a.json();
      audio = new Audio("/api/sprechen/" + encodeURIComponent(id));
      await audio.play();
    } catch {
      vorlesen(text, lang);   // Browser-Stimme als Ersatz
    }
  }

  /* ---------------- Fortschritt ---------------- */
  function geuebt(d) {
    d.heute.n += 1;
    if (d.serie.tag !== tag()) {
      d.serie = { tag: tag(), n: d.serie.tag === gestern() ? d.serie.n + 1 : 1 };
    }
  }
  const gelernt = (d) => d.karten.filter((k) => k.fach >= 2).length;
  const faellige = (d, zl) => d.karten
    .filter((k) => (!zl || k.zl === zl) && k.ml === me.lang && k.faellig <= Date.now())
    .sort((a, b) => a.faellig - b.faellig);
  const serieJetzt = (d) => (d.serie.tag === tag() || d.serie.tag === gestern()) ? d.serie.n : 0;

  /* ---------------- Kleine Hilfen ---------------- */
  function el(tagName, klasse, text) {
    const e = document.createElement(tagName);
    if (klasse) e.className = klasse;
    if (text != null) e.textContent = text;
    return e;
  }
  function knopf(text, klasse, beiKlick) {
    const b = el("button", klasse, text);
    b.type = "button";
    b.onclick = beiKlick;
    return b;
  }
  let hinweisUhr = null;
  function hinweis(text) {
    let h = $("lernHinweis");
    if (!h) { h = el("div", "lern-hinweis"); h.id = "lernHinweis"; document.body.appendChild(h); }
    h.textContent = text;
    h.classList.add("an");
    clearTimeout(hinweisUhr);
    hinweisUhr = setTimeout(() => h.classList.remove("an"), 2200);
  }

  function knopfAktualisieren() {
    const b = $("lernenBtn");
    if (!b) return;
    b.title = T("lernenTitel");
    b.setAttribute("aria-label", T("lernenTitel"));
    const zl = partnerSprache();
    const n = zl ? faellige(laden(), zl).length : 0;
    b.dataset.n = n > 0 ? String(Math.min(n, 99)) : "";
  }

  /* ---------------- Die Lern-Ansicht ---------------- */
  let sitzung = null;   // { zl, reihe: [id...], aufgedeckt }

  async function oeffnen() {
    schliesseSheet();
    const zl = partnerSprache();
    sheet = el("div", "sheet");
    const box = el("div", "sheet-inner lernen");
    sheet.appendChild(box);
    sheet.onclick = (e) => { if (e.target === sheet) schliessen(); };
    document.body.appendChild(sheet);

    if (!zl) {
      box.appendChild(el("p", "lern-titel", "🎓 " + T("lernenTitel")));
      box.appendChild(el("p", "lern-leer", T("lernenKeinPartner")));
      box.appendChild(knopf(T("cancel"), "lern-zu", schliessen));
      return;
    }
    const d = laden();
    sitzung = { zl, reihe: faellige(d, zl).map((k) => k.id), aufgedeckt: false };
    const abo = await hatAbo();
    zeichnen(box, abo);
  }

  function schliessen() {
    sitzung = null;
    if (audio) { audio.pause(); audio = null; }
    schliesseSheet();
    knopfAktualisieren();
  }

  function zeichnen(box, abo) {
    if (!sitzung) return;
    box.textContent = "";
    const d = laden();
    const zl = sitzung.zl;

    const kopf = el("div", "lern-kopf");
    kopf.appendChild(el("p", "lern-titel", "🎓 " + T("lernenTitel") + " · " + sprachName(zl)));
    const stand = el("p", "lern-stand",
      T("lernenGelernt", { n: gelernt(d) }) + (serieJetzt(d) ? " · 🔥 " + T("lernenSerie", { n: serieJetzt(d) }) : ""));
    kopf.appendChild(stand);
    box.appendChild(kopf);

    const restGratis = Math.max(0, GRATIS_PRO_TAG - d.heute.n);
    const reihe = sitzung.reihe.filter((id) => d.karten.some((k) => k.id === id));
    const karte = reihe.length ? d.karten.find((k) => k.id === reihe[0]) : null;

    if (karte && !abo && restGratis === 0) {
      /* Gratis-Grenze fuer heute erreicht. */
      const p = el("div", "lern-plus");
      p.appendChild(el("p", null, "🎉 " + T("lernenPlus")));
      const a = el("a", "lern-plus-knopf", T("lernenPlusKnopf"));
      a.href = "/preise.html?room=" + encodeURIComponent(me.room);
      p.appendChild(a);
      box.appendChild(p);
    } else if (karte) {
      const k = el("div", "lern-karte");
      k.appendChild(el("p", "lern-frage", T("lernenWie", { lang: sprachName(zl) })));
      const vorne = el("p", "lern-vorne", karte.mein);
      vorne.dir = RTL.has(karte.ml) ? "rtl" : "auto";
      k.appendChild(vorne);
      if (sitzung.aufgedeckt) {
        const hinten = el("p", "lern-hinten", karte.ziel);
        hinten.dir = RTL.has(zl) ? "rtl" : "auto";
        k.appendChild(hinten);
        k.appendChild(knopf("🔊 " + T("vorlesen"), "lern-hoeren", () => sprechen(karte.ziel, zl)));
        const wahl = el("div", "lern-wahl");
        wahl.appendChild(knopf("↺ " + T("lernenNochmal"), "lern-nochmal", () => bewerten(box, abo, karte.id, false)));
        wahl.appendChild(knopf("✓ " + T("lernenWusste"), "lern-wusste", () => bewerten(box, abo, karte.id, true)));
        k.appendChild(wahl);
        sprechen(karte.ziel, zl);
      } else {
        k.appendChild(knopf(T("lernenAufdecken"), "lern-aufdecken", () => { sitzung.aufgedeckt = true; zeichnen(box, abo); }));
      }
      box.appendChild(k);
      if (!abo) box.appendChild(el("p", "lern-gratis", T("lernenGratis", { n: restGratis })));
    } else {
      const fertig = el("div", "lern-fertig");
      const anzahl = d.karten.filter((x) => x.zl === zl && x.ml === me.lang).length;
      fertig.appendChild(el("p", null, anzahl ? "🎉 " + T("lernenFertig") : T("lernenLeer")));
      box.appendChild(fertig);
    }

    /* Vorschlaege aus dem Chat */
    const vs = vorschlaege(zl);
    if (vs.length) {
      box.appendChild(el("p", "lern-abschnitt", "💡 " + T("lernenVorschlaege")));
      const liste = el("div", "lern-liste");
      for (const v of vs) {
        const z = el("button", "lern-vorschlag");
        z.type = "button";
        const t1 = el("span", "lv-ziel", v.ziel); t1.dir = "auto";
        const t2 = el("span", "lv-mein", v.mein); t2.dir = "auto";
        z.appendChild(el("span", "lv-plus", "+"));
        const txt = el("span", "lv-text"); txt.appendChild(t1); txt.appendChild(t2);
        z.appendChild(txt);
        z.onclick = () => {
          const dd = laden();
          if (!schonDa(dd, v)) { dd.karten.push({ ...v, neu: Date.now() }); sichern(dd); }
          sitzung.reihe.push(v.id);
          hinweis("⭐ " + T("lernenGemerkt"));
          zeichnen(box, abo);
        };
        liste.appendChild(z);
      }
      box.appendChild(liste);
    }

    const anzahl = d.karten.filter((x) => x.zl === zl && x.ml === me.lang).length;
    box.appendChild(el("p", "lern-anzahl", T("lernenKarten", { n: anzahl })));
    box.appendChild(knopf(T("cancel"), "lern-zu", schliessen));
  }

  function bewerten(box, abo, id, gewusst) {
    const d = laden();
    const k = d.karten.find((x) => x.id === id);
    if (k) {
      if (gewusst) {
        k.fach = Math.min(STUFEN.length - 1, k.fach + 1);
        k.faellig = Date.now() + STUFEN[k.fach] * TAG_MS;
      } else {
        k.fach = 0;
        k.faellig = Date.now();
      }
      geuebt(d);
      sichern(d);
    }
    sitzung.reihe.shift();
    /* Nicht gewusst: in dieser Runde noch einmal, ein paar Karten spaeter. */
    if (!gewusst) sitzung.reihe.splice(Math.min(3, sitzung.reihe.length), 0, id);
    sitzung.aufgedeckt = false;
    zeichnen(box, abo);
  }

  window.DiraloLernen = { merken, kannMerken, oeffnen, knopfAktualisieren };
})();
