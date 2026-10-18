/**
 * Diralo - native App (React Native / Expo), MVP
 *
 * Spricht denselben Server wie die Web-App (Socket.io):
 *   join  { roomCode, name, lang, device, build, speech }
 *   send  { text, replyTo }
 * Server sendet: history[], message{...}, translated{id,lang,text},
 *   lang{id,lang}, quotaReached{id}, system{type,name}.
 *
 * Chat + Uebersetzung bleiben komplett auf dem Server. Der Client zeigt
 * jede fremde Nachricht in DEINER Sprache (msg.tr[meineSprache]), sonst
 * den Originaltext.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  SafeAreaView, View, Text, TextInput, FlatList, Pressable,
  KeyboardAvoidingView, Platform, StyleSheet, StatusBar, ActivityIndicator,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";

/* ------------------------------------------------------------------ */
const SERVER_URL = "https://lumo-3d74.onrender.com";
const BUILD = "native-0.1";

/* Sprachen wie in der Web-App (Auswahl). Code = was der Server erwartet. */
const SPRACHEN = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "pt", label: "Portugues" },
  { code: "es", label: "Espanol" },
  { code: "fr", label: "Francais" },
  { code: "it", label: "Italiano" },
  { code: "uk", label: "Ukrainisch" },
  { code: "ru", label: "Russisch" },
  { code: "ar", label: "Arabisch" },
  { code: "tr", label: "Turkce" },
];

/* Chat-Code wie auf der Web-Startseite: 10 Zeichen ohne i l o 0 1
   (die verwechselt man beim Vorlesen). */
function neuerCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/* Dauerhafte Geraete-Kennung (fuer "meine" Nachrichten + Server-Limits). */
async function geraeteId() {
  try {
    let id = await AsyncStorage.getItem("diralo_device");
    if (!id) {
      id = "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await AsyncStorage.setItem("diralo_device", id);
    }
    return id;
  } catch {
    return "dev_" + Math.random().toString(36).slice(2);
  }
}

/* ================================================================== */
export default function App() {
  const [bereit, setBereit] = useState(false);
  const [device, setDevice] = useState(null);
  const [name, setName] = useState("");
  const [lang, setLang] = useState("de");
  const [raum, setRaum] = useState(null);     // null = Startseite, sonst Chat

  useEffect(() => {
    (async () => {
      setDevice(await geraeteId());
      try {
        const n = await AsyncStorage.getItem("diralo_name");
        const l = await AsyncStorage.getItem("diralo_lang");
        if (n) setName(n);
        if (l) setLang(l);
      } catch {}
      setBereit(true);
    })();
  }, []);

  const betreten = useCallback(async (code) => {
    const c = String(code || "").trim().toLowerCase();
    if (!c || !name.trim()) return;
    try {
      await AsyncStorage.setItem("diralo_name", name.trim());
      await AsyncStorage.setItem("diralo_lang", lang);
    } catch {}
    setRaum(c);
  }, [name, lang]);

  if (!bereit) {
    return (
      <View style={[s.full, s.center]}>
        <ActivityIndicator size="large" color={FARBE.gold} />
      </View>
    );
  }

  return (
    <SafeAreaView style={s.full}>
      <StatusBar barStyle="light-content" backgroundColor={FARBE.navy} />
      {raum ? (
        <Chat
          raum={raum} name={name.trim()} lang={lang} device={device}
          onBack={() => setRaum(null)}
        />
      ) : (
        <Home
          name={name} setName={setName}
          lang={lang} setLang={setLang}
          onStart={() => betreten(neuerCode())}
          onJoin={betreten}
        />
      )}
    </SafeAreaView>
  );
}

/* ----------------------------- Startseite ------------------------- */
function Home({ name, setName, lang, setLang, onStart, onJoin }) {
  const [code, setCode] = useState("");
  const kannLos = name.trim().length > 0;

  return (
    <View style={s.homeWrap}>
      <View style={s.brandRow}>
        <View style={s.logoDot}><Text style={s.logoDotTxt}>D</Text></View>
        <Text style={s.brand}>Diralo</Text>
      </View>
      <Text style={s.claim}>Chat in jeder Sprache. Jede Nachricht wird automatisch uebersetzt.</Text>

      <Text style={s.label}>Dein Name</Text>
      <TextInput
        style={s.input} value={name} onChangeText={setName}
        placeholder="z. B. Carsten" placeholderTextColor={FARBE.grau}
        maxLength={40}
      />

      <Text style={s.label}>Deine Sprache</Text>
      <View style={s.chips}>
        {SPRACHEN.map((sp) => (
          <Pressable
            key={sp.code}
            onPress={() => setLang(sp.code)}
            style={[s.chip, lang === sp.code && s.chipAktiv]}
          >
            <Text style={[s.chipTxt, lang === sp.code && s.chipTxtAktiv]}>{sp.label}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[s.btnPrimary, !kannLos && s.btnAus]}
        disabled={!kannLos} onPress={onStart}
      >
        <Text style={s.btnPrimaryTxt}>Neuen Chat starten</Text>
      </Pressable>

      <Text style={s.oder}>oder einem Chat beitreten</Text>
      <View style={s.joinRow}>
        <TextInput
          style={[s.input, s.joinInput]} value={code} onChangeText={setCode}
          placeholder="Chat-Code" placeholderTextColor={FARBE.grau}
          autoCapitalize="none" maxLength={60}
        />
        <Pressable
          style={[s.btnGold, (!kannLos || !code.trim()) && s.btnAus]}
          disabled={!kannLos || !code.trim()}
          onPress={() => onJoin(code)}
        >
          <Text style={s.btnGoldTxt}>Beitreten</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ------------------------------- Chat ----------------------------- */
function Chat({ raum, name, lang, device, onBack }) {
  const [nachrichten, setNachrichten] = useState([]);
  const [text, setText] = useState("");
  const [verbunden, setVerbunden] = useState(false);
  const [hinweis, setHinweis] = useState(null);
  const sockRef = useRef(null);
  const listRef = useRef(null);
  const askedRef = useRef(new Set());

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    sockRef.current = socket;

    socket.on("connect", () => {
      setVerbunden(true);
      socket.emit("join", { roomCode: raum, name, lang, device, build: BUILD, speech: false });
    });
    socket.on("disconnect", () => setVerbunden(false));

    /* Fuer jede fremde Nachricht ohne Uebersetzung in MEINE Sprache beim
       Server die Uebersetzung anfordern - genau wie die Web-App
       (socket.emit("need", {id, lang})). Der Server antwortet mit
       "translated". Ein Set verhindert doppelte Anfragen. */
    const frageWennNoetig = (m) => {
      if (!m || m.device === device) return;
      if (m.tr && m.tr[lang]) return;
      if (askedRef.current.has(m.id)) return;
      askedRef.current.add(m.id);
      socket.emit("need", { id: m.id, lang });
    };
    socket.on("history", (liste) => {
      const arr = Array.isArray(liste) ? liste.map(normMsg) : [];
      setNachrichten(arr);
      arr.forEach(frageWennNoetig);
      scrollUnten();
    });
    socket.on("message", (msg) => {
      const m = normMsg(msg);
      setNachrichten((alt) => [...alt, m]);
      frageWennNoetig(m);
      scrollUnten();
    });
    /* Uebersetzung fuer EINE Sprache trifft nach ein paar Sekunden ein. */
    socket.on("translated", ({ id, lang: zl, text: t }) => {
      setNachrichten((alt) => alt.map((m) =>
        m.id === id ? { ...m, tr: { ...m.tr, [zl]: t } } : m));
    });
    socket.on("lang", ({ id, lang: dl }) => {
      setNachrichten((alt) => alt.map((m) =>
        m.id === id ? { ...m, detected: dl } : m));
    });
    socket.on("quotaReached", () => {
      setHinweis("Das kostenlose Uebersetzungs-Kontingent ist erreicht. Mit Diralo Plus geht es unbegrenzt weiter.");
    });
    socket.on("translationError", () => {
      setHinweis("Uebersetzung gerade nicht moeglich. Nachricht wird im Original gezeigt.");
    });
    socket.on("system", (ev) => {
      if (ev?.type === "tooManyJoins") setHinweis("Zu viele Beitritts-Versuche. Bitte kurz warten.");
    });
    socket.on("tooFast", () => setHinweis("Etwas langsamer - zu viele Nachrichten in kurzer Zeit."));

    return () => { socket.removeAllListeners(); socket.close(); };
  }, [raum, name, lang, device]);

  const scrollUnten = () => {
    setTimeout(() => { try { listRef.current?.scrollToEnd({ animated: true }); } catch {} }, 80);
  };

  const senden = () => {
    const t = text.trim();
    if (!t || !sockRef.current) return;
    sockRef.current.emit("send", { text: t });
    setText("");
  };

  return (
    <KeyboardAvoidingView
      style={s.full}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Kopfzeile */}
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.chatTitel}>Chat {raum}</Text>
          <Text style={s.chatSub}>{verbunden ? "verbunden" : "verbinde ..."} · du: {name} ({lang})</Text>
        </View>
      </View>

      {hinweis && (
        <Pressable onPress={() => setHinweis(null)} style={s.hinweis}>
          <Text style={s.hinweisTxt}>{hinweis}  (tippen zum Ausblenden)</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={nachrichten}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.liste}
        renderItem={({ item }) => <Bubble msg={item} lang={lang} device={device} />}
        onContentSizeChange={scrollUnten}
        ListEmptyComponent={
          <Text style={s.leer}>Noch keine Nachrichten. Schreib die erste - sie wird automatisch uebersetzt.</Text>
        }
      />

      <View style={s.eingabe}>
        <TextInput
          style={s.eingabeInput} value={text} onChangeText={setText}
          placeholder="Nachricht schreiben ..." placeholderTextColor={FARBE.grau}
          multiline
        />
        <Pressable style={[s.senden, !text.trim() && s.btnAus]} disabled={!text.trim()} onPress={senden}>
          <Text style={s.sendenTxt}>Senden</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/* Eine Sprechblase. Zeigt die Nachricht in MEINER Sprache (sonst Original). */
function Bubble({ msg, lang, device }) {
  const meins = msg.device === device;
  const uebersetzt = !meins && msg.tr && msg.tr[lang];
  const anzeige = meins ? msg.text : (uebersetzt || msg.text);
  const original = !meins && uebersetzt && msg.text && msg.text !== uebersetzt;

  if (msg.ort) {
    return (
      <View style={[s.bubble, meins ? s.bubbleMeins : s.bubbleFremd]}>
        {!meins && <Text style={s.bubbleName}>{msg.name}</Text>}
        <Text style={s.bubbleTxt}>Standort: {msg.ort.lat}, {msg.ort.lng}</Text>
      </View>
    );
  }
  return (
    <View style={[s.bubble, meins ? s.bubbleMeins : s.bubbleFremd]}>
      {!meins && <Text style={s.bubbleName}>{msg.name}</Text>}
      <Text style={[s.bubbleTxt, meins && s.bubbleTxtMeins]}>{anzeige || "..."}</Text>
      {original ? <Text style={s.bubbleOrig}>{msg.text}</Text> : null}
    </View>
  );
}

function normMsg(m) {
  return {
    id: String(m.id),
    device: m.device || null,
    name: m.name || "Gast",
    text: m.text || "",
    lang: m.lang || "",
    tr: m.tr || {},
    ort: m.ort || null,
    at: m.at || Date.now(),
  };
}

/* ------------------------------- Stil ----------------------------- */
const FARBE = {
  navy: "#122036",
  navy2: "#1b2f4d",
  gold: "#e3b23c",
  hell: "#f4f6fb",
  weiss: "#ffffff",
  grau: "#8a93a6",
  grauHell: "#e7ebf2",
  text: "#1b2535",
};

const s = StyleSheet.create({
  full: { flex: 1, backgroundColor: FARBE.hell },
  center: { alignItems: "center", justifyContent: "center" },

  /* Startseite */
  homeWrap: { flex: 1, padding: 22, paddingTop: 36 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  logoDot: { width: 40, height: 40, borderRadius: 12, backgroundColor: FARBE.navy, alignItems: "center", justifyContent: "center" },
  logoDotTxt: { color: FARBE.gold, fontSize: 22, fontWeight: "800" },
  brand: { fontSize: 28, fontWeight: "800", color: FARBE.navy },
  claim: { color: FARBE.grau, marginTop: 10, marginBottom: 24, fontSize: 15, lineHeight: 21 },
  label: { color: FARBE.text, fontWeight: "700", marginBottom: 8, marginTop: 6 },
  input: {
    backgroundColor: FARBE.weiss, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: FARBE.text, borderWidth: 1, borderColor: FARBE.grauHell,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: FARBE.weiss, borderWidth: 1, borderColor: FARBE.grauHell },
  chipAktiv: { backgroundColor: FARBE.navy, borderColor: FARBE.navy },
  chipTxt: { color: FARBE.text, fontWeight: "600" },
  chipTxtAktiv: { color: FARBE.weiss },
  btnPrimary: { backgroundColor: FARBE.navy, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 6 },
  btnPrimaryTxt: { color: FARBE.weiss, fontSize: 17, fontWeight: "800" },
  btnAus: { opacity: 0.4 },
  oder: { textAlign: "center", color: FARBE.grau, marginVertical: 18 },
  joinRow: { flexDirection: "row", gap: 10 },
  joinInput: { flex: 1 },
  btnGold: { backgroundColor: FARBE.gold, borderRadius: 12, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  btnGoldTxt: { color: FARBE.navy, fontWeight: "800", fontSize: 15 },

  /* Chat */
  chatHead: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: FARBE.navy, paddingHorizontal: 14, paddingVertical: 14 },
  back: { color: FARBE.weiss, fontSize: 34, lineHeight: 34, paddingRight: 6, marginTop: -4 },
  chatTitel: { color: FARBE.weiss, fontSize: 17, fontWeight: "800" },
  chatSub: { color: "#aeb9cc", fontSize: 12, marginTop: 2 },
  hinweis: { backgroundColor: "#fff5d6", borderBottomWidth: 1, borderBottomColor: "#f0e3b0", paddingHorizontal: 14, paddingVertical: 10 },
  hinweisTxt: { color: "#7a5b00", fontSize: 13 },
  liste: { padding: 14, paddingBottom: 18 },
  leer: { color: FARBE.grau, textAlign: "center", marginTop: 40, paddingHorizontal: 20, lineHeight: 20 },

  bubble: { maxWidth: "82%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10 },
  bubbleFremd: { backgroundColor: FARBE.weiss, alignSelf: "flex-start", borderTopLeftRadius: 4, borderWidth: 1, borderColor: FARBE.grauHell },
  bubbleMeins: { backgroundColor: FARBE.navy, alignSelf: "flex-end", borderTopRightRadius: 4 },
  bubbleName: { color: FARBE.gold, fontWeight: "700", fontSize: 12, marginBottom: 3 },
  bubbleTxt: { color: FARBE.text, fontSize: 16, lineHeight: 22 },
  bubbleTxtMeins: { color: FARBE.weiss },
  bubbleOrig: { color: FARBE.grau, fontSize: 12, marginTop: 5, fontStyle: "italic" },

  eingabe: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell },
  eingabeInput: { flex: 1, maxHeight: 120, backgroundColor: FARBE.hell, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, color: FARBE.text },
  senden: { backgroundColor: FARBE.gold, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 11 },
  sendenTxt: { color: FARBE.navy, fontWeight: "800" },
});
