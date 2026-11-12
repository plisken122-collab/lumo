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
  View, Text, TextInput, FlatList, Pressable, Image, Alert, Linking,
  ScrollView, Modal, Share, Platform,
  KeyboardAvoidingView, Keyboard, StyleSheet, StatusBar, ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { File } from "expo-file-system";
import * as Notifications from "expo-notifications";
/* Android zeichnet die App bis unter Status- und Navigationsleiste
   (edge-to-edge). Das SafeAreaView aus react-native hilft nur auf iOS -
   die Abstaende kommen deshalb von hier, auf beiden Systemen. */
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";

/* ------------------------------------------------------------------ */
const SERVER_URL = "https://lumo-3d74.onrender.com";
const BUILD = "native-0.1";

/* Dieselbe Sprachliste wie die Web-App (LANGS in public/index.html).
   Code = was der Server erwartet. */
const SPRACHEN = [
  ["de","Deutsch"],["de-CH","Deutsch (Schweiz)"],
  ["pt-PT","Português (Portugal)"],["pt-BR","Português (Brasil)"],
  ["en","English (UK)"],["en-US","English (US)"],
  ["es","Español (España)"],["es-419","Español (Latinoamérica)"],
  ["fr","Français"],["it","Italiano"],["nl","Nederlands"],["pl","Polski"],
  ["ru","Русский"],["uk","Українська"],["tr","Türkçe"],["ar","العربية"],
  ["zh","中文 (简体)"],["zh-TW","中文 (繁體)"],["ja","日本語"],["ko","한국어"],
  ["hi","हिन्दी"],["sv","Svenska"],["ro","Română"],["da","Dansk"],["no","Norsk"],
  ["fi","Suomi"],["cs","Čeština"],["hu","Magyar"],["el","Ελληνικά"],["he","עברית"],
  ["th","ไทย"],["vi","Tiếng Việt"],["id","Bahasa Indonesia"],
].map(([code, label]) => ({ code, label }));
const sprachName = (code) => SPRACHEN.find((x) => x.code === code)?.label || code;

/* Einladung wie in der Web-App: Link mit dem Code hinter #c=. */
const WEB_URL = "https://diralo.app";
const einladungsLink = (code) => `${WEB_URL}/#c=${encodeURIComponent(code)}`;

/* ------------------------------ Texte ------------------------------
   Die Oberflaeche folgt der in der App gewaehlten Sprache: Deutsch,
   Portugiesisch, sonst Englisch. */
const TEXTE = {
  de: {
    claim: "Chat in jeder Sprache. Jede Nachricht wird automatisch übersetzt.",
    deinName: "Dein Name",
    nameBsp: "z. B. Carsten",
    deineSprache: "Deine Sprache",
    neuerChat: "Neuen Chat starten",
    oderBeitreten: "oder einem Chat beitreten",
    chatCode: "Chat-Code",
    beitreten: "Beitreten",
    meineChats: "Meine Chats",
    datenschutz: "Zum Übersetzen wird jede Nachricht an einen Server geschickt und ist dort lesbar — anders als bei WhatsApp. Schreib nichts hinein, was niemand sonst sehen soll. Nach 30 Tagen wird alles gelöscht.",
    ausListe: "aus der Liste nehmen?",
    abbrechen: "Abbrechen",
    entfernen: "Entfernen",
    nochKeine: "Noch keine benutzt.",
    kontingent: "Das kostenlose Übersetzungs-Kontingent ist erreicht. Mit Diralo Plus geht es unbegrenzt weiter.",
    uebersFehler: "Übersetzung gerade nicht möglich. Nachricht wird im Original gezeigt.",
    zuVieleJoins: "Zu viele Beitritts-Versuche. Bitte kurz warten.",
    langsamer: "Etwas langsamer - zu viele Nachrichten in kurzer Zeit.",
    fremdGeraet: "Diese Nachricht wurde von einem anderen Gerät geschrieben und lässt sich hier nicht löschen.",
    loeschenFehler: "Löschen gerade nicht möglich. Bitte später nochmal.",
    spracheLang: "Die Sprachnachricht ist zu lang.",
    spracheFehler: "Sprachnachricht konnte nicht gesendet werden.",
    einladung: "Schreib mit mir in Diralo — jeder in seiner Sprache:",
    fuerAlleFrage: "Für alle löschen?",
    verschwindet: "Die Nachricht verschwindet auch beim Gegenüber.",
    loeschen: "Löschen",
    ohneKamera: "Ohne Kamera-Erlaubnis geht das nicht.",
    ohneFotos: "Ohne Zugriff auf die Fotos geht das nicht.",
    fotoGross: "Das Foto ist zu groß.",
    fotoFehler: "Foto konnte nicht gesendet werden.",
    ohneStandort: "Ohne Standort-Erlaubnis geht das nicht.",
    standortFehler: "Standort konnte nicht ermittelt werden.",
    senden: "Senden",
    galerie: "Foto aus Galerie",
    kamera: "Kamera",
    standort: "Standort",
    einladen: "Einladen",
    verbunden: "verbunden",
    verbinde: "verbinde ...",
    du: "du",
    Du: "Du",
    leer: "Noch keine Nachrichten. Schreib die erste - sie wird automatisch übersetzt.",
    antworten: "↩ Antworten",
    fuerAlle: "🗑 Für alle löschen",
    schreiben: "Nachricht schreiben ...",
    geloescht: "Nachricht gelöscht",
    kartenTipp: "Zum Öffnen in der Karte tippen",
    nichtMehrDa: "Nachricht nicht mehr da",
    sprachnachricht: "Sprachnachricht",
    foto: "Foto",
    aufnahmeFehler: "Aufnahme nicht möglich: ",
    ohneMikro: "Ohne Mikrofon-Erlaubnis geht das nicht.",
    android13: "Sprachnachrichten brauchen Android 13 oder neuer.",
    kanal: "Nachrichten",
    ausblenden: "tippen zum Ausblenden",
  },
  pt: {
    claim: "Chat em qualquer língua. Cada mensagem é traduzida automaticamente.",
    deinName: "O teu nome",
    nameBsp: "p. ex. Maria",
    deineSprache: "A tua língua",
    neuerChat: "Iniciar novo chat",
    oderBeitreten: "ou entrar num chat",
    chatCode: "Código do chat",
    beitreten: "Entrar",
    meineChats: "Os meus chats",
    datenschutz: "Para traduzir, cada mensagem é enviada para um servidor e pode ser lida lá — ao contrário do WhatsApp. Não escrevas nada que mais ninguém deva ver. Ao fim de 30 dias tudo é apagado.",
    ausListe: "remover da lista?",
    abbrechen: "Cancelar",
    entfernen: "Remover",
    nochKeine: "Ainda nenhum usado.",
    kontingent: "Atingiste o limite gratuito de traduções. Com o Diralo Plus continua sem limites.",
    uebersFehler: "Tradução não disponível de momento. A mensagem aparece no original.",
    zuVieleJoins: "Demasiadas tentativas de entrada. Espera um pouco.",
    langsamer: "Mais devagar - demasiadas mensagens em pouco tempo.",
    fremdGeraet: "Esta mensagem foi escrita noutro dispositivo e não pode ser apagada aqui.",
    loeschenFehler: "Não é possível apagar agora. Tenta mais tarde.",
    spracheLang: "A mensagem de voz é demasiado longa.",
    spracheFehler: "Não foi possível enviar a mensagem de voz.",
    einladung: "Escreve comigo no Diralo — cada um na sua língua:",
    fuerAlleFrage: "Apagar para todos?",
    verschwindet: "A mensagem desaparece também para a outra pessoa.",
    loeschen: "Apagar",
    ohneKamera: "Sem permissão da câmara não é possível.",
    ohneFotos: "Sem acesso às fotos não é possível.",
    fotoGross: "A foto é demasiado grande.",
    fotoFehler: "Não foi possível enviar a foto.",
    ohneStandort: "Sem permissão de localização não é possível.",
    standortFehler: "Não foi possível obter a localização.",
    senden: "Enviar",
    galerie: "Foto da galeria",
    kamera: "Câmara",
    standort: "Localização",
    einladen: "Convidar",
    verbunden: "ligado",
    verbinde: "a ligar ...",
    du: "tu",
    Du: "Tu",
    leer: "Ainda sem mensagens. Escreve a primeira - é traduzida automaticamente.",
    antworten: "↩ Responder",
    fuerAlle: "🗑 Apagar para todos",
    schreiben: "Escreve uma mensagem ...",
    geloescht: "Mensagem apagada",
    kartenTipp: "Toca para abrir no mapa",
    nichtMehrDa: "Mensagem já não existe",
    sprachnachricht: "Mensagem de voz",
    foto: "Foto",
    aufnahmeFehler: "Gravação não possível: ",
    ohneMikro: "Sem permissão do microfone não é possível.",
    android13: "As mensagens de voz precisam do Android 13 ou mais recente.",
    kanal: "Mensagens",
    ausblenden: "toca para fechar",
  },
  en: {
    claim: "Chat in any language. Every message is translated automatically.",
    deinName: "Your name",
    nameBsp: "e.g. Maria",
    deineSprache: "Your language",
    neuerChat: "Start new chat",
    oderBeitreten: "or join a chat",
    chatCode: "Chat code",
    beitreten: "Join",
    meineChats: "My chats",
    datenschutz: "To translate, every message is sent to a server and is readable there — unlike WhatsApp. Don't write anything nobody else should see. Everything is deleted after 30 days.",
    ausListe: "remove from the list?",
    abbrechen: "Cancel",
    entfernen: "Remove",
    nochKeine: "None used yet.",
    kontingent: "The free translation quota is used up. Diralo Plus continues without limits.",
    uebersFehler: "Translation not possible right now. The message is shown in the original.",
    zuVieleJoins: "Too many join attempts. Please wait a moment.",
    langsamer: "Slow down - too many messages in a short time.",
    fremdGeraet: "This message was written on another device and can't be deleted here.",
    loeschenFehler: "Can't delete right now. Please try again later.",
    spracheLang: "The voice message is too long.",
    spracheFehler: "The voice message could not be sent.",
    einladung: "Chat with me on Diralo — each in their own language:",
    fuerAlleFrage: "Delete for everyone?",
    verschwindet: "The message also disappears for the other person.",
    loeschen: "Delete",
    ohneKamera: "Not possible without camera permission.",
    ohneFotos: "Not possible without access to photos.",
    fotoGross: "The photo is too large.",
    fotoFehler: "The photo could not be sent.",
    ohneStandort: "Not possible without location permission.",
    standortFehler: "Could not determine the location.",
    senden: "Send",
    galerie: "Photo from gallery",
    kamera: "Camera",
    standort: "Location",
    einladen: "Invite",
    verbunden: "connected",
    verbinde: "connecting ...",
    du: "you",
    Du: "You",
    leer: "No messages yet. Write the first one - it will be translated automatically.",
    antworten: "↩ Reply",
    fuerAlle: "🗑 Delete for everyone",
    schreiben: "Write a message ...",
    geloescht: "Message deleted",
    kartenTipp: "Tap to open in maps",
    nichtMehrDa: "Message no longer available",
    sprachnachricht: "Voice message",
    foto: "Photo",
    aufnahmeFehler: "Recording not possible: ",
    ohneMikro: "Not possible without microphone permission.",
    android13: "Voice messages need Android 13 or newer.",
    kanal: "Messages",
    ausblenden: "tap to dismiss",
  },
};
let uiSprache = "de";
const uiCode = (code) => {
  const c = String(code || "").toLowerCase();
  return c.startsWith("de") ? "de" : c.startsWith("pt") ? "pt" : "en";
};
const t = (k) => TEXTE[uiSprache]?.[k] ?? TEXTE.en[k] ?? k;

/* Startsprache fuer neue Nutzer: die des Handys, falls Diralo sie kennt. */
function geraeteSprache() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || "";
    const genau = SPRACHEN.find((x) => x.code.toLowerCase() === loc.toLowerCase());
    if (genau) return genau.code;
    const basis = loc.split("-")[0].toLowerCase();
    const passend = SPRACHEN.find((x) => x.code.toLowerCase().split("-")[0] === basis);
    if (passend) return passend.code;
  } catch {}
  return "en";
}

/* ---------------------------- Meine Chats ---------------------------
   Wie in der Web-App: die Liste liegt nur auf diesem Geraet. Dazu je
   Chat, wann er zuletzt offen war - daraus fragt die Startseite beim
   Server ab, wie viel Neues gekommen ist (/api/neues, nur Zahlen). */
const CHATS_KEY = "diralo_chats";
const GELESEN_KEY = "diralo_gelesen";

async function jsonLaden(key, leer) {
  try { return JSON.parse((await AsyncStorage.getItem(key)) || "null") ?? leer; } catch { return leer; }
}
async function chatsLaden() {
  const roh = await jsonLaden(CHATS_KEY, []);
  return Array.isArray(roh) ? roh.filter((c) => c && typeof c.code === "string") : [];
}
/* Zuletzt benutzter nach oben. */
async function chatMerken(code) {
  const liste = await chatsLaden();
  const da = liste.find((c) => c.code === code);
  if (da) da.zuletzt = Date.now(); else liste.push({ code, name: "", zuletzt: Date.now() });
  liste.sort((a, b) => (b.zuletzt || 0) - (a.zuletzt || 0));
  try { await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(liste.slice(0, 50))); } catch {}
}
async function chatVergessen(code) {
  const liste = (await chatsLaden()).filter((c) => c.code !== code);
  try { await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(liste)); } catch {}
}
async function gelesenSetzen(code) {
  const g = await jsonLaden(GELESEN_KEY, {});
  g[code] = Date.now();
  try { await AsyncStorage.setItem(GELESEN_KEY, JSON.stringify(g)); } catch {}
}
/* ------------------------- Push-Benachrichtigungen -------------------------
   Der Server schickt ueber den Expo-Push-Dienst. Angemeldet wird das Geraet
   fuer alle "Meine Chats" auf einmal - wie die Glocke in der Web-App. Im
   gerade offenen Chat zeigt die App keine Meldung, die Nachricht ist ja
   schon zu sehen. */
const EAS_PROJECT_ID = "09d4805b-90d1-4164-a87e-17aa42d73a5f";
let offenerRaum = null;
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const zeigen = n?.request?.content?.data?.room !== offenerRaum;
    return { shouldShowBanner: zeigen, shouldShowList: zeigen, shouldPlaySound: zeigen, shouldSetBadge: false };
  },
});

async function pushAnmelden({ device, name, lang }) {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("nachrichten", {
        name: t("kanal"),
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== "granted") return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
    const rooms = (await chatsLaden()).map((c) => c.code).slice(0, 20);
    if (!token || !rooms.length) return;
    await fetch(`${SERVER_URL}/api/expo-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, rooms, device, name, lang }),
    });
  } catch (e) {
    /* Ohne Push laeuft alles andere weiter - nur leise protokollieren. */
    console.log("Push-Anmeldung:", e?.message);
  }
}

async function neuesHolen(liste, device) {
  if (!liste.length) return {};
  const g = await jsonLaden(GELESEN_KEY, {});
  try {
    const a = await fetch(`${SERVER_URL}/api/neues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chats: liste.map((c) => ({ room: c.code, seit: g[c.code] || 0 })), device }),
    });
    return a.ok ? await a.json() : {};
  } catch { return {}; }
}

/* Dieselben Reaktionen, die der Server annimmt (REAKTIONEN in server.js). */
const REAKTIONEN = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

/* Fotos werden vor dem Senden verkleinert - der Server nimmt hoechstens
   2,5 MB, und ein Handyfoto in voller Groesse waere ohnehin Verschwendung. */
const FOTO_MAX_BREITE = 1600;

/* Sprachnachrichten: hoechstens so lang wie der Server annimmt. */
const SPRACHE_MAX_SEK = 120;

/* Die Spracherkennung will eine Region (de-DE), die App kennt oft nur
   die Sprache (de). Fuer die haeufigen Faelle die uebliche Region. */
const REGION = {
  de: "de-DE", en: "en-GB", es: "es-ES", fr: "fr-FR", it: "it-IT", nl: "nl-NL",
  pl: "pl-PL", ru: "ru-RU", uk: "uk-UA", tr: "tr-TR", ar: "ar-SA", zh: "zh-CN",
  ja: "ja-JP", ko: "ko-KR", hi: "hi-IN", sv: "sv-SE", ro: "ro-RO", da: "da-DK",
  no: "nb-NO", fi: "fi-FI", cs: "cs-CZ", hu: "hu-HU", el: "el-GR", he: "he-IL",
  th: "th-TH", vi: "vi-VN", id: "id-ID", "es-419": "es-MX",
};
const erkennerSprache = (code) => REGION[code] || (code.includes("-") ? code : `${code}-${code.toUpperCase()}`);

const medienUrl = (id) => `${SERVER_URL}/medien/${encodeURIComponent(id)}`;

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
  return (
    <SafeAreaProvider>
      <Haupt />
    </SafeAreaProvider>
  );
}

function Haupt() {
  const insets = useSafeAreaInsets();
  const [bereit, setBereit] = useState(false);
  const [device, setDevice] = useState(null);
  const [name, setName] = useState("");
  const [lang, setLang] = useState(geraeteSprache);
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
    await chatMerken(c);
    setRaum(c);
    pushAnmelden({ device, name: name.trim(), lang });
  }, [name, lang, device]);

  /* Offener Chat: dort keine Meldung zeigen. */
  useEffect(() => { offenerRaum = raum; }, [raum]);

  /* Tipp auf eine Benachrichtigung oeffnet ihren Chat - auch wenn die App
     dadurch erst gestartet wurde. */
  useEffect(() => {
    if (!bereit) return;
    const oeffnen = (antwort) => {
      const r = antwort?.notification?.request?.content?.data?.room;
      if (r && name.trim()) setRaum(String(r));
    };
    Notifications.getLastNotificationResponseAsync().then(oeffnen).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(oeffnen);
    return () => sub.remove();
  }, [bereit]);

  /* Beim Start neu anmelden: Das Token kann sich aendern, und die Liste
     der Chats soll beim Server aktuell bleiben. */
  useEffect(() => {
    if (bereit && device && name.trim()) pushAnmelden({ device, name: name.trim(), lang });
  }, [bereit, device]);

  /* Beim Verlassen gilt der Chat als gelesen - sonst zaehlte die
     Startseite eigene, gerade gesehene Nachrichten als neu. */
  const verlassen = useCallback(async () => {
    if (raum) await gelesenSetzen(raum);
    setRaum(null);
  }, [raum]);

  uiSprache = uiCode(lang);

  if (!bereit) {
    return (
      <View style={[s.full, s.center]}>
        <ActivityIndicator size="large" color={FARBE.gold} />
      </View>
    );
  }

  return (
    /* Oben navy, damit die Statusleiste zur Chat-Kopfzeile passt. Den
       Abstand unten setzen Startseite und Eingabezeile selbst - so bleibt
       ihr Hintergrund bis an den Rand. */
    <View style={[s.full, { paddingTop: insets.top, backgroundColor: FARBE.navy }]}>
      <StatusBar barStyle="light-content" backgroundColor={FARBE.navy} />
      <View style={s.full}>
        {raum ? (
          <Chat
            raum={raum} name={name.trim()} lang={lang} device={device}
            unten={insets.bottom}
            onBack={verlassen}
          />
        ) : (
          <Home
            name={name} setName={setName}
            lang={lang} setLang={setLang}
            device={device}
            unten={insets.bottom}
            onStart={() => betreten(neuerCode())}
            onJoin={betreten}
          />
        )}
      </View>
    </View>
  );
}

/* ----------------------------- Startseite ------------------------- */
function Home({ name, setName, lang, setLang, device, unten, onStart, onJoin }) {
  const [code, setCode] = useState("");
  const [chats, setChats] = useState([]);
  const [neues, setNeues] = useState({});
  const [sprachWahl, setSprachWahl] = useState(false);
  const kannLos = name.trim().length > 0;

  const laden = useCallback(async () => {
    const liste = await chatsLaden();
    setChats(liste);
    setNeues(await neuesHolen(liste.slice(0, 20), device));
  }, [device]);
  useEffect(() => { laden(); }, [laden]);

  const vergessen = (c) => {
    Alert.alert(`„#${c.code}“ ${t("ausListe")}`, null, [
      { text: t("abbrechen"), style: "cancel" },
      { text: t("entfernen"), style: "destructive", onPress: async () => { await chatVergessen(c.code); laden(); } },
    ]);
  };

  return (
    <ScrollView
      style={s.full} keyboardShouldPersistTaps="handled"
      contentContainerStyle={[s.homeWrap, { paddingBottom: 22 + unten }]}
    >
      <View style={s.brandRow}>
        <View style={s.logoDot}><Text style={s.logoDotTxt}>D</Text></View>
        <Text style={s.brand}>Diralo</Text>
      </View>
      <Text style={s.claim}>{t("claim")}</Text>

      <Text style={s.label}>{t("deinName")}</Text>
      <TextInput
        style={s.input} value={name} onChangeText={setName}
        placeholder={t("nameBsp")} placeholderTextColor={FARBE.grau}
        maxLength={40}
      />

      <Text style={s.label}>{t("deineSprache")}</Text>
      <Pressable style={[s.input, s.sprachFeld]} onPress={() => setSprachWahl(true)}>
        <Text style={s.sprachFeldTxt}>{sprachName(lang)}</Text>
        <Text style={s.sprachPfeil}>▾</Text>
      </Pressable>
      <Sprachauswahl
        offen={sprachWahl} aktuell={lang}
        onWahl={(c) => { setLang(c); setSprachWahl(false); }}
        onZu={() => setSprachWahl(false)}
      />
      <View style={{ height: 20 }} />

      <Pressable
        style={[s.btnPrimary, !kannLos && s.btnAus]}
        disabled={!kannLos} onPress={onStart}
      >
        <Text style={s.btnPrimaryTxt}>{t("neuerChat")}</Text>
      </Pressable>

      <Text style={s.oder}>{t("oderBeitreten")}</Text>
      <View style={s.joinRow}>
        <TextInput
          style={[s.input, s.joinInput]} value={code} onChangeText={setCode}
          placeholder={t("chatCode")} placeholderTextColor={FARBE.grau}
          autoCapitalize="none" maxLength={60}
        />
        <Pressable
          style={[s.btnGold, (!kannLos || !code.trim()) && s.btnAus]}
          disabled={!kannLos || !code.trim()}
          onPress={() => onJoin(code)}
        >
          <Text style={s.btnGoldTxt}>{t("beitreten")}</Text>
        </Pressable>
      </View>

      {chats.length > 0 && (
        <View style={s.meineChats}>
          <Text style={s.label}>{t("meineChats")}</Text>
          {chats.slice(0, 8).map((c) => {
            const n = neues[c.code] || 0;
            return (
              <View key={c.code} style={s.chatZeile}>
                <Pressable
                  style={[s.input, s.chatOffen, !kannLos && s.btnAus]}
                  disabled={!kannLos} onPress={() => onJoin(c.code)}
                >
                  <Text style={s.chatOffenTxt} numberOfLines={1}>#{c.code}</Text>
                  {n > 0 && <View style={s.neu}><Text style={s.neuTxt}>{n > 99 ? "99+" : n}</Text></View>}
                </Pressable>
                <Pressable style={[s.input, s.chatWeg]} onPress={() => vergessen(c)} hitSlop={4}>
                  <Text style={s.chatWegTxt}>✕</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <Text style={s.note}>
        {t("datenschutz")}
      </Text>
    </ScrollView>
  );
}

/* Ganze Sprachliste als Auswahlfenster - 33 Sprachen passen nicht als Knoepfe. */
function Sprachauswahl({ offen, aktuell, onWahl, onZu }) {
  return (
    <Modal visible={offen} transparent animationType="slide" onRequestClose={onZu}>
      <Pressable style={s.modalHinten} onPress={onZu} />
      <View style={s.modalBox}>
        <Text style={s.modalTitel}>{t("deineSprache")}</Text>
        <FlatList
          data={SPRACHEN}
          keyExtractor={(x) => x.code}
          initialNumToRender={40}
          renderItem={({ item }) => (
            <Pressable style={s.sprachZeile} onPress={() => onWahl(item.code)}>
              <Text style={[s.sprachZeileTxt, item.code === aktuell && s.sprachAktiv]}>{item.label}</Text>
              {item.code === aktuell && <Text style={s.sprachAktiv}>✓</Text>}
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

/* Emoji-Auswahl wie in der Web-App: erste Gruppe = zuletzt benutzte. */
const EMOJI = [
  ["🕘", ""],
  ["🙂", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤨 😐 😑 😶 🙄 😏 😣 😥 😮 🤐 😯 😪 😫 🥱 😴 😌 😛 🤤 😒 😓 😔 😕 🙃 🤑 😲 🙁 😖 😞 😟 😤 😢 😭 😦 😧 😨 😩 🤯 😬 😰 😱 🥵 🥶 😳 🤪 😵 😡 😠 🤬 😷 🤒 🤕 🤢 🤮 🤧 😇 🥳 🥸 🤠 😎 🤓 🧐 😈 👿 💀 👻 👽 🤖 💩"],
  ["👍", "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦾 🤳 👀 👁️ 👄 👅 🧠 🦷 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙆 🙅 🤷 🤦 💁 🙇 🚶 🏃 💃 🕺 👫 👬 👭 👪 🫂"],
  ["❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 👑 💎 🔥 ✨ 🌟 ⭐ 💫 ⚡ 💥 🎉 🎊 🎈 🎁 🎀 🥂 🍻 🎂 🧁 ☕ 🍵 🍺 🍷 🎵 🎶 🎤 🎧 🎸 🎹 🎬 📷 💡 🔔 📣 💬 💭"],
  ["🍕", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🥐 🥖 🍞 🧀 🥚 🍳 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍿 🍝 🍜 🍲 🍣 🍱 🍤 🍚 🍦 🍰 🍫 🍬 🍭 🍩 🍪"],
  ["⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 ⛳ 🏹 🎣 🎿 🎯 🎮 🎲 ♟️ 🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚲 🛵 🏍️ ✈️ 🚀 🚁 ⛵ 🚤 🚢 🏠 🏡 🏢 🏥 🏨 🏪 ⛪ 🗼 🗽 ⛲ ⛺ 🌍 🌎 🌏 🌙 ⛰️ 🏔️ 🌋 🏖️ 🏝️"],
  ["🐶", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🐢 🐍 🐙 🦀 🐠 🐟 🐬 🐳 🦈 🐘 🐫 🦒 🐄 🐎 🐑 🐐 🦌 🐕 🐈 🌵 🌲 🌳 🌴 🌱 🍀 🍃 🍁 🌺 🌻 🌹 🌷 🌸 💐 🍄"],
  ["✅", "✅ ❌ ❎ ➕ ➖ ✖️ ❓ ❔ ❕ ❗ ‼️ ⁉️ 💯 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 🔶 🔷 ⚠️ 🚫 ⛔ 📛 ♻️ ✔️ ☑️ 📌 📍 🔒 🔓 ⏰ ⌛ ⏳ 🔋 📱 💻 ⌨️ 🖨️ 📁 📄 📅 📊 ✏️ 📝 💰 💶 🛒 🎓 ⚙️ 🔧 🔨"],
];
const EMOJI_KEY = "diralo_emoji";

function EmojiAuswahl({ zuletzt, onWahl }) {
  const [gruppe, setGruppe] = useState(zuletzt.length ? 0 : 1);
  const zeichen = gruppe === 0 ? zuletzt : EMOJI[gruppe][1].split(" ");
  return (
    <View style={s.emojiPanel}>
      <View style={s.emojiTabs}>
        {EMOJI.map(([icon], i) => (
          <Pressable key={i} onPress={() => setGruppe(i)} style={[s.emojiTab, gruppe === i && s.emojiTabAn]}>
            <Text style={s.emojiTabTxt}>{icon}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={s.emojiGrid} keyboardShouldPersistTaps="always">
        {zeichen.length === 0 && <Text style={s.leer}>{t("nochKeine")}</Text>}
        {zeichen.map((ch, i) => (
          <Pressable key={ch + i} onPress={() => onWahl(ch)} style={s.emojiZelle}>
            <Text style={s.emojiZeichen}>{ch}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/* ------------------------------- Chat ----------------------------- */
function Chat({ raum, name, lang, device, unten, onBack }) {
  /* Offene Tastatur deckt die Navigationsleiste ab - dann braucht die
     Eingabezeile unten keinen eigenen Abstand mehr. */
  const tastatur = useTastaturOffen();
  const [nachrichten, setNachrichten] = useState([]);
  const [text, setText] = useState("");
  const [verbunden, setVerbunden] = useState(false);
  const [hinweis, setHinweis] = useState(null);
  const [laedt, setLaedt] = useState(false);          // Foto wird hochgeladen
  const [reagierenAuf, setReagierenAuf] = useState(null); // Nachricht fuer die Emoji-Leiste
  const [antwortAuf, setAntwortAuf] = useState(null);     // Zitat ueber dem Eingabefeld
  const [emojiAuf, setEmojiAuf] = useState(false);
  const [zuletztEmoji, setZuletztEmoji] = useState([]);
  const auswahlRef = useRef({ start: 0, end: 0 });
  useEffect(() => { jsonLaden(EMOJI_KEY, []).then(setZuletztEmoji); }, []);
  const emojiEinfuegen = (ch) => {
    const { start, end } = auswahlRef.current;
    setText((t) => {
      const a = Math.min(start, t.length), b = Math.min(end, t.length);
      auswahlRef.current = { start: a + ch.length, end: a + ch.length };
      return t.slice(0, a) + ch + t.slice(b);
    });
    setZuletztEmoji((alt) => {
      const neu = [ch, ...alt.filter((c) => c !== ch)].slice(0, 24);
      AsyncStorage.setItem(EMOJI_KEY, JSON.stringify(neu)).catch(() => {});
      return neu;
    });
  };
  const aufnahme = useSprachaufnahme({
    lang,
    onFertig: (a) => spracheSenden(a),
    onFehler: (t) => setHinweis(t),
  });
  const sockRef = useRef(null);
  const listRef = useRef(null);
  /* Nur mitscrollen, wenn man unten ist - sonst springt der Chat beim
     Zurueckscrollen bei jedem Bild, jeder Uebersetzung wieder nach unten. */
  const amEnde = useRef(true);
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
      if (m.device === device) amEnde.current = true;   // eigene Nachricht: immer runter
      if (amEnde.current) scrollUnten();
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
      setHinweis(t("kontingent"));
    });
    socket.on("translationError", () => {
      setHinweis(t("uebersFehler"));
    });
    socket.on("system", (ev) => {
      if (ev?.type === "tooManyJoins") setHinweis(t("zuVieleJoins"));
    });
    socket.on("tooFast", () => setHinweis(t("langsamer")));
    /* Reaktion von irgendwem im Raum (auch die eigene kommt so zurueck).
       Leeres Emoji = aufgehoben. */
    /* Der Server loescht nur, was dieses Geraet selbst geschrieben hat. */
    socket.on("deleteFailed", ({ grund }) => {
      setHinweis(grund === "nicht erlaubt"
        ? t("fremdGeraet")
        : t("loeschenFehler"));
    });
    socket.on("deleted", ({ id }) => {
      setNachrichten((alt) => alt.map((m) => (m.id === id ? { ...m, deleted: true, text: "" } : m)));
    });
    socket.on("reaktion", ({ id, device: von, emoji }) => {
      setNachrichten((alt) => alt.map((m) => {
        if (m.id !== id) return m;
        const r = { ...m.reaktionen };
        if (emoji) r[von] = emoji; else delete r[von];
        return { ...m, reaktionen: r };
      }));
    });

    return () => { socket.removeAllListeners(); socket.close(); };
  }, [raum, name, lang, device]);

  const scrollUnten = () => {
    setTimeout(() => { try { listRef.current?.scrollToEnd({ animated: true }); } catch {} }, 80);
  };

  const senden = () => {
    const t = text.trim();
    if (!t || !sockRef.current) return;
    sockRef.current.emit("send", { text: t, replyTo: antwortAuf?.id || null });
    setText("");
    setAntwortAuf(null);
  };

  /* Aufnahme + Mitschrift an den Server. Die Mitschrift wird dort wie
     jede Nachricht uebersetzt; die Aufnahme laesst sich abspielen. */
  const spracheSenden = async ({ uri, sekunden, mitschrift }) => {
    setLaedt(true);
    try {
      const audio = await new File(uri).base64();
      const antwort = await fetch(`${SERVER_URL}/api/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: raum, device, name, lang,
          seconds: sekunden, transcript: mitschrift, mime: "audio/wav", audio,
        }),
      });
      if (!antwort.ok) {
        setHinweis(antwort.status === 413 ? t("spracheLang") : t("spracheFehler"));
      }
    } catch {
      setHinweis(t("spracheFehler"));
    } finally {
      setLaedt(false);
      try { new File(uri).delete(); } catch {}
    }
  };

  const einladen = () => {
    Share.share({
      message: `${t("einladung")} ${einladungsLink(raum)}`,
    }).catch(() => {});
  };

  /* Nur die eigene Nachricht; der Server prueft das ohnehin am Geraet. */
  const loeschen = (m) => {
    Alert.alert(t("fuerAlleFrage"), t("verschwindet"), [
      { text: t("abbrechen"), style: "cancel" },
      { text: t("loeschen"), style: "destructive", onPress: () => sockRef.current?.emit("deleteForAll", { id: m.id }) },
    ]);
  };

  /* Foto aus Galerie oder Kamera. Ein bereits getippter Text geht als
     Bildunterschrift mit und wird wie jede Nachricht uebersetzt. */
  const fotoSenden = async (quelle) => {
    try {
      const recht = quelle === "kamera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!recht.granted) {
        setHinweis(quelle === "kamera" ? t("ohneKamera") : t("ohneFotos"));
        return;
      }
      const opt = { mediaTypes: ["images"], quality: 1 };
      const wahl = quelle === "kamera"
        ? await ImagePicker.launchCameraAsync(opt)
        : await ImagePicker.launchImageLibraryAsync(opt);
      if (wahl.canceled || !wahl.assets?.length) return;

      setLaedt(true);
      const a = wahl.assets[0];
      const resize = a.width > FOTO_MAX_BREITE ? [{ resize: { width: FOTO_MAX_BREITE } }] : [];
      const klein = await manipulateAsync(a.uri, resize, {
        compress: 0.75, format: SaveFormat.JPEG, base64: true,
      });
      const antwort = await fetch(`${SERVER_URL}/api/bild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: raum, device, name, lang,
          caption: text.trim(), mime: "image/jpeg", bild: klein.base64,
        }),
      });
      if (!antwort.ok) {
        setHinweis(antwort.status === 413 ? t("fotoGross") : t("fotoFehler"));
        return;
      }
      setText("");
    } catch {
      setHinweis(t("fotoFehler"));
    } finally {
      setLaedt(false);
    }
  };

  const standortSenden = async () => {
    try {
      const recht = await Location.requestForegroundPermissionsAsync();
      if (!recht.granted) { setHinweis(t("ohneStandort")); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      sockRef.current?.emit("sendOrt", { lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {
      setHinweis(t("standortFehler"));
    }
  };

  const anhangMenue = () => {
    Keyboard.dismiss();
    Alert.alert(t("senden"), null, [
      { text: t("galerie"), onPress: () => fotoSenden("galerie") },
      { text: t("kamera"), onPress: () => fotoSenden("kamera") },
      { text: t("standort"), onPress: standortSenden },
    ], { cancelable: true });
  };

  /* Gleiche Reaktion nochmal = zuruecknehmen (wie in der Web-App). */
  const reagieren = (emoji) => {
    const m = reagierenAuf;
    setReagierenAuf(null);
    if (!m || !sockRef.current) return;
    const aktuell = m.reaktionen?.[device];
    sockRef.current.emit("reagieren", { id: m.id, emoji: aktuell === emoji ? "" : emoji });
  };

  return (
    /* "padding" auch auf Android: edge-to-edge schaltet das automatische
       Verkleinern des Fensters ab, sonst laege die Tastatur ueber dem Feld. */
    <KeyboardAvoidingView style={s.full} behavior="padding">
      {/* Kopfzeile */}
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.chatTitel}>Chat {raum}</Text>
          <Text style={s.chatSub}>{verbunden ? t("verbunden") : t("verbinde")} · {t("du")}: {name} ({lang})</Text>
        </View>
        <Pressable onPress={einladen} style={s.einladen} hitSlop={8}>
          <Text style={s.einladenTxt}>{t("einladen")}</Text>
        </Pressable>
      </View>

      {hinweis && (
        <Pressable onPress={() => setHinweis(null)} style={s.hinweis}>
          <Text style={s.hinweisTxt}>{hinweis}  ({t("ausblenden")})</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={nachrichten}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.liste}
        renderItem={({ item }) => (
          <Bubble
            msg={item} lang={lang} device={device}
            zitat={item.replyTo ? nachrichten.find((m) => m.id === item.replyTo) || { fehlt: true } : null}
            onLangDruck={() => setReagierenAuf(item)}
          />
        )}
        onContentSizeChange={() => { if (amEnde.current) scrollUnten(); }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          amEnde.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 150;
        }}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <Text style={s.leer}>{t("leer")}</Text>
        }
      />

      {reagierenAuf && (
        <View style={s.reaktLeiste}>
          {REAKTIONEN.map((e) => (
            <Pressable key={e} onPress={() => reagieren(e)} style={s.reaktKnopf} hitSlop={4}>
              <Text style={s.reaktKnopfTxt}>{e}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setReagierenAuf(null)} hitSlop={8}>
            <Text style={s.reaktZu}>✕</Text>
          </Pressable>
        </View>
      )}
      {reagierenAuf && (
        <View style={s.aktionLeiste}>
          <Pressable
            style={s.aktion}
            onPress={() => { setAntwortAuf(reagierenAuf); setReagierenAuf(null); }}
          >
            <Text style={s.aktionTxt}>{t("antworten")}</Text>
          </Pressable>
          {reagierenAuf.device === device && !reagierenAuf.deleted && (
            <Pressable
              style={s.aktion}
              onPress={() => { const m = reagierenAuf; setReagierenAuf(null); loeschen(m); }}
            >
              <Text style={[s.aktionTxt, s.aktionRot]}>{t("fuerAlle")}</Text>
            </Pressable>
          )}
        </View>
      )}
      {antwortAuf && (
        <View style={s.antwortBar}>
          <View style={{ flex: 1 }}>
            <Text style={s.antwortName}>{antwortAuf.device === device ? t("Du") : antwortAuf.name}</Text>
            <Text style={s.antwortText} numberOfLines={1}>{kurzText(antwortAuf, lang, device)}</Text>
          </View>
          <Pressable onPress={() => setAntwortAuf(null)} hitSlop={8}>
            <Text style={s.reaktZu}>✕</Text>
          </Pressable>
        </View>
      )}

      {emojiAuf && <EmojiAuswahl zuletzt={zuletztEmoji} onWahl={emojiEinfuegen} />}

      <View style={[s.eingabe, { paddingBottom: 10 + (tastatur ? 0 : unten) }]}>
        <Pressable style={s.anhang} onPress={anhangMenue} disabled={laedt} hitSlop={6}>
          {laedt
            ? <ActivityIndicator color={FARBE.navy} />
            : <Text style={s.anhangTxt}>+</Text>}
        </Pressable>
        <Pressable
          style={[s.anhang, emojiAuf && s.emojiKnopfAn]} hitSlop={6}
          onPress={() => { if (!emojiAuf) Keyboard.dismiss(); setEmojiAuf(!emojiAuf); }}
        >
          <Text style={s.emojiKnopfTxt}>{emojiAuf ? "⌨️" : "🙂"}</Text>
        </Pressable>
        <TextInput
          style={s.eingabeInput} value={text} onChangeText={setText}
          onSelectionChange={(e) => { auswahlRef.current = e.nativeEvent.selection; }}
          onFocus={() => setEmojiAuf(false)}
          placeholder={t("schreiben")} placeholderTextColor={FARBE.grau}
          multiline
        />
        {/* Leeres Feld: Mikrofon statt Senden - wie bei WhatsApp. Tippen
            startet die Aufnahme, nochmal tippen schickt sie ab. */}
        {text.trim() ? (
          <Pressable style={s.senden} onPress={senden}>
            <Text style={s.sendenTxt}>{t("senden")}</Text>
          </Pressable>
        ) : aufnahme.laeuft ? (
          <View style={s.aufnahmeRow}>
            <Pressable onPress={aufnahme.abbrechen} hitSlop={8}><Text style={s.reaktZu}>✕</Text></Pressable>
            <Pressable style={[s.senden, s.aufnahmeAn]} onPress={aufnahme.stopp}>
              <Text style={s.sendenTxt}>● {aufnahme.sekunden}s  {t("senden")}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={[s.senden, laedt && s.btnAus]} disabled={laedt} onPress={aufnahme.start}>
            <Text style={s.sendenTxt}>🎤</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/* Eine Sprechblase. Zeigt die Nachricht in MEINER Sprache (sonst Original).
   Langes Druecken oeffnet die Emoji-Leiste. */
function Bubble({ msg, lang, device, zitat, onLangDruck }) {
  const meins = msg.device === device;
  const uebersetzt = !meins && msg.tr && msg.tr[lang];
  const anzeige = meins ? msg.text : (uebersetzt || msg.text);
  const original = !meins && uebersetzt && msg.text && msg.text !== uebersetzt;
  const txtStil = [s.bubbleTxt, meins && s.bubbleTxtMeins];

  if (msg.deleted) {
    return (
      <View style={[s.bubble, meins ? s.bubbleMeins : s.bubbleFremd]}>
        <Text style={[txtStil, s.geloescht]}>{t("geloescht")}</Text>
      </View>
    );
  }

  let inhalt;
  if (msg.ort) {
    const karte = `https://www.google.com/maps/search/?api=1&query=${msg.ort.lat},${msg.ort.lng}`;
    inhalt = (
      <Pressable onPress={() => Linking.openURL(karte)} onLongPress={onLangDruck}>
        <Text style={txtStil}>📍 {t("standort")}</Text>
        <Text style={[s.bubbleOrig, meins && s.bubbleOrigMeins]}>{t("kartenTipp")}</Text>
      </Pressable>
    );
  } else {
    inhalt = (
      <>
        {msg.bild ? (
          <Pressable onPress={() => Linking.openURL(medienUrl(msg.id))} onLongPress={onLangDruck}>
            <Image source={{ uri: medienUrl(msg.id) }} style={s.foto} resizeMode="cover" />
          </Pressable>
        ) : null}
        {msg.audioSeconds ? <Sprachnachricht id={msg.id} sekunden={msg.audioSeconds} meins={meins} /> : null}
        {anzeige ? <Text style={txtStil}>{anzeige}</Text> : null}
        {!anzeige && !msg.bild && !msg.audioSeconds ? <Text style={txtStil}>...</Text> : null}
        {original ? <Text style={[s.bubbleOrig, meins && s.bubbleOrigMeins]}>{msg.text}</Text> : null}
      </>
    );
  }

  /* Gleiche Emojis zusammenfassen: "❤️ 2". */
  const zaehlung = {};
  for (const e of Object.values(msg.reaktionen || {})) zaehlung[e] = (zaehlung[e] || 0) + 1;
  const reakt = Object.entries(zaehlung);

  return (
    <View style={[s.bubbleWrap, meins ? s.wrapMeins : s.wrapFremd]}>
      <Pressable
        onLongPress={onLangDruck} delayLongPress={350}
        style={[s.bubble, meins ? s.bubbleMeins : s.bubbleFremd]}
      >
        {!meins && <Text style={s.bubbleName}>{msg.name}</Text>}
        {zitat && (
          <View style={[s.zitat, meins && s.zitatMeins]}>
            {zitat.fehlt ? (
              <Text style={[s.zitatText, meins && s.bubbleOrigMeins]}>{t("nichtMehrDa")}</Text>
            ) : (
              <>
                <Text style={[s.zitatName, meins && s.bubbleOrigMeins]}>{zitat.device === device ? t("Du") : zitat.name}</Text>
                <Text style={[s.zitatText, meins && s.bubbleOrigMeins]} numberOfLines={2}>{kurzText(zitat, lang, device)}</Text>
              </>
            )}
          </View>
        )}
        {inhalt}
      </Pressable>
      {reakt.length > 0 && (
        <View style={[s.reaktAnzeige, meins ? s.wrapMeins : s.wrapFremd]}>
          {reakt.map(([e, n]) => (
            <Text key={e} style={s.reaktAnzeigeTxt}>{e}{n > 1 ? ` ${n}` : ""}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

/* Abspielen einer empfangenen (oder eigenen) Sprachnachricht. Der Text
   darunter ist die Mitschrift, uebersetzt wie jede andere Nachricht. */
function Sprachnachricht({ id, sekunden, meins }) {
  const player = useAudioPlayer(medienUrl(id));
  const status = useAudioPlayerStatus(player);
  const laeuft = status.playing;

  const umschalten = () => {
    if (laeuft) { player.pause(); return; }
    if (status.didJustFinish || (status.duration && status.currentTime >= status.duration - 0.2)) {
      player.seekTo(0);
    }
    player.play();
  };

  const rest = Math.max(0, Math.round((status.duration || sekunden) - (laeuft ? status.currentTime : 0)));
  const zeit = `${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, "0")}`;

  return (
    <Pressable onPress={umschalten} style={s.sprache} hitSlop={6}>
      <Text style={[s.spracheKnopf, meins && s.bubbleTxtMeins]}>{laeuft ? "⏸" : "▶"}</Text>
      <Text style={[s.spracheZeit, meins && s.bubbleTxtMeins]}>{t("sprachnachricht")} · {zeit}</Text>
    </Pressable>
  );
}

/* Sprachaufnahme mit Mitschrift in einem Rutsch: die Spracherkennung
   schreibt mit und legt die Aufnahme zugleich als WAV-Datei ab
   (recordingOptions.persist, Android 13+). Ein zweites Programm am
   Mikrofon waere auf Android unzuverlaessig. */
function useSprachaufnahme({ lang, onFertig, onFehler }) {
  const [laeuft, setLaeuft] = useState(false);
  const [sekunden, setSekunden] = useState(0);
  const teile = useRef([]);         // fertige Saetze
  const zwischen = useRef("");      // laufender, noch unfertiger Satz
  const start = useRef(0);
  const verwerfen = useRef(false);
  const datei = useRef(null);
  const beendet = useRef(false);

  useEffect(() => {
    if (!laeuft) return;
    const t = setInterval(() => {
      const s2 = Math.round((Date.now() - start.current) / 1000);
      setSekunden(s2);
      if (s2 >= SPRACHE_MAX_SEK) ExpoSpeechRecognitionModule.stop();
    }, 500);
    return () => clearInterval(t);
  }, [laeuft]);

  useSpeechRecognitionEvent("result", (ev) => {
    const t = ev.results?.[0]?.transcript || "";
    if (ev.isFinal) { if (t) teile.current.push(t); zwischen.current = ""; }
    else zwischen.current = t;
  });
  /* "end" und "audioend" kommen nicht immer in derselben Reihenfolge.
     Abgeschickt wird, sobald beides da ist. */
  const abschliessen = () => {
    const uri = datei.current;
    if (!beendet.current || !uri) return;
    beendet.current = false;
    const mitschrift = [...teile.current, zwischen.current].join(" ").replace(/\s+/g, " ").trim();
    const dauer = Math.max(1, Math.round((Date.now() - start.current) / 1000));
    if (verwerfen.current) return;
    onFertig({ uri, sekunden: Math.min(dauer, SPRACHE_MAX_SEK), mitschrift });
  };
  useSpeechRecognitionEvent("audioend", (ev) => { datei.current = ev.uri || null; abschliessen(); });
  useSpeechRecognitionEvent("error", (ev) => {
    /* "Nichts gehoert" ist kein Fehler, den man melden muss - dann
       gibt es eben keine Nachricht. */
    if (ev.error !== "no-speech" && ev.error !== "aborted") {
      onFehler(t("aufnahmeFehler") + (ev.message || ev.error));
    }
  });
  useSpeechRecognitionEvent("end", () => {
    setLaeuft(false);
    beendet.current = true;
    abschliessen();
  });

  const los = async () => {
    const recht = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!recht.granted) { onFehler(t("ohneMikro")); return; }
    if (Platform.OS === "android" && Platform.Version < 33) {
      onFehler(t("android13"));
      return;
    }
    teile.current = []; zwischen.current = ""; datei.current = null; beendet.current = false;
    verwerfen.current = false;
    start.current = Date.now();
    setSekunden(0);
    setLaeuft(true);
    ExpoSpeechRecognitionModule.start({
      lang: erkennerSprache(lang),
      interimResults: true,
      continuous: true,
      recordingOptions: { persist: true, outputSampleRate: 16000, outputEncoding: "pcmFormatInt16" },
    });
  };

  return {
    laeuft, sekunden,
    start: los,
    stopp: () => ExpoSpeechRecognitionModule.stop(),
    abbrechen: () => { verwerfen.current = true; ExpoSpeechRecognitionModule.abort(); },
  };
}

/* Eine Zeile fuer Zitate: Text in meiner Sprache, sonst was die Nachricht ist. */
function kurzText(m, lang, device) {
  if (m.deleted) return t("geloescht");
  const t = m.device !== device && m.tr?.[lang] ? m.tr[lang] : m.text;
  if (t) return t;
  if (m.bild) return "📷 " + t("foto");
  if (m.audioSeconds) return "🎤 " + t("sprachnachricht");
  if (m.ort) return "📍 " + t("standort");
  return "";
}

function useTastaturOffen() {
  const [offen, setOffen] = useState(false);
  useEffect(() => {
    const auf = Keyboard.addListener("keyboardDidShow", () => setOffen(true));
    const zu = Keyboard.addListener("keyboardDidHide", () => setOffen(false));
    return () => { auf.remove(); zu.remove(); };
  }, []);
  return offen;
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
    bild: Boolean(m.bild),
    audioSeconds: m.audioSeconds || null,
    reaktionen: m.reaktionen || {},
    deleted: Boolean(m.deleted),
    replyTo: m.replyTo || null,
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
  homeWrap: { flexGrow: 1, padding: 22, paddingTop: 36 },
  sprachFeld: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sprachFeldTxt: { fontSize: 16, color: FARBE.text },
  sprachPfeil: { fontSize: 16, color: FARBE.grau },
  modalHinten: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  modalBox: { maxHeight: "70%", backgroundColor: FARBE.weiss, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 14, paddingBottom: 24 },
  modalTitel: { fontSize: 16, fontWeight: "800", color: FARBE.navy, paddingHorizontal: 20, marginBottom: 8 },
  sprachZeile: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: FARBE.grauHell },
  sprachZeileTxt: { fontSize: 16, color: FARBE.text },
  sprachAktiv: { color: FARBE.navy, fontWeight: "800" },
  meineChats: { marginTop: 18 },
  chatZeile: { flexDirection: "row", gap: 8, marginBottom: 8 },
  chatOffen: { flex: 1, flexDirection: "row", alignItems: "center" },
  chatOffenTxt: { fontSize: 16, color: FARBE.text, flexShrink: 1 },
  chatWeg: { width: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 0 },
  chatWegTxt: { fontSize: 16, color: FARBE.grau },
  neu: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: "#C0392B", alignItems: "center", justifyContent: "center", paddingHorizontal: 6, marginLeft: 10 },
  neuTxt: { color: FARBE.weiss, fontSize: 12, fontWeight: "700" },
  note: { marginTop: 18, padding: 13, borderRadius: 11, backgroundColor: "#F1F2F5", borderLeftWidth: 3, borderLeftColor: FARBE.navy, fontSize: 13, lineHeight: 20, color: FARBE.grau },
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

  bubbleWrap: { maxWidth: "82%", marginBottom: 10 },
  wrapFremd: { alignSelf: "flex-start" },
  wrapMeins: { alignSelf: "flex-end" },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleFremd: { backgroundColor: FARBE.weiss, borderTopLeftRadius: 4, borderWidth: 1, borderColor: FARBE.grauHell },
  bubbleMeins: { backgroundColor: FARBE.navy, borderTopRightRadius: 4 },
  bubbleOrigMeins: { color: "#aeb9cc" },
  geloescht: { fontStyle: "italic", opacity: 0.6 },
  foto: { width: 230, height: 230, borderRadius: 10, marginBottom: 6, backgroundColor: FARBE.grauHell },
  sprache: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4, marginBottom: 4 },
  spracheKnopf: { fontSize: 22, color: FARBE.navy, width: 24, textAlign: "center" },
  spracheZeit: { fontSize: 14, color: FARBE.text },
  reaktAnzeige: { flexDirection: "row", gap: 4, marginTop: -6, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: FARBE.weiss, borderRadius: 12, borderWidth: 1, borderColor: FARBE.grauHell },
  reaktAnzeigeTxt: { fontSize: 14 },
  reaktLeiste: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell, paddingVertical: 8, paddingHorizontal: 10 },
  reaktKnopf: { padding: 4 },
  reaktKnopfTxt: { fontSize: 28 },
  reaktZu: { fontSize: 18, color: FARBE.grau, paddingHorizontal: 6 },
  aufnahmeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  aufnahmeAn: { backgroundColor: "#E46A5E" },
  einladen: { backgroundColor: FARBE.gold, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  einladenTxt: { color: FARBE.navy, fontWeight: "800", fontSize: 13 },
  aktionLeiste: { flexDirection: "row", gap: 10, backgroundColor: FARBE.weiss, paddingHorizontal: 12, paddingBottom: 8 },
  aktion: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: FARBE.hell },
  aktionTxt: { color: FARBE.navy, fontWeight: "700" },
  aktionRot: { color: "#9B2C25" },
  antwortBar: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell, borderLeftWidth: 3, borderLeftColor: FARBE.gold, paddingHorizontal: 12, paddingVertical: 8 },
  antwortName: { color: FARBE.gold, fontWeight: "700", fontSize: 12 },
  antwortText: { color: FARBE.text, fontSize: 14 },
  zitat: { borderLeftWidth: 3, borderLeftColor: FARBE.gold, backgroundColor: FARBE.hell, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6 },
  zitatMeins: { backgroundColor: FARBE.navy2 },
  zitatName: { color: FARBE.gold, fontWeight: "700", fontSize: 12 },
  zitatText: { color: FARBE.grau, fontSize: 13 },
  anhang: { width: 40, height: 40, borderRadius: 20, backgroundColor: FARBE.hell, alignItems: "center", justifyContent: "center" },
  emojiKnopfAn: { backgroundColor: FARBE.grauHell },
  emojiKnopfTxt: { fontSize: 22 },
  emojiPanel: { height: 260, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell },
  emojiTabs: { flexDirection: "row", paddingHorizontal: 6, paddingTop: 6, gap: 2 },
  emojiTab: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10 },
  emojiTabAn: { backgroundColor: FARBE.hell },
  emojiTabTxt: { fontSize: 20 },
  emojiGrid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 6, paddingBottom: 8 },
  emojiZelle: { width: "12.5%", alignItems: "center", paddingVertical: 6 },
  emojiZeichen: { fontSize: 26 },
  anhangTxt: { fontSize: 26, lineHeight: 28, color: FARBE.navy, fontWeight: "700" },
  bubbleName: { color: FARBE.gold, fontWeight: "700", fontSize: 12, marginBottom: 3 },
  bubbleTxt: { color: FARBE.text, fontSize: 16, lineHeight: 22 },
  bubbleTxtMeins: { color: FARBE.weiss },
  bubbleOrig: { color: FARBE.grau, fontSize: 12, marginTop: 5, fontStyle: "italic" },

  eingabe: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell },
  eingabeInput: { flex: 1, maxHeight: 120, backgroundColor: FARBE.hell, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, color: FARBE.text },
  senden: { backgroundColor: FARBE.gold, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 11 },
  sendenTxt: { color: FARBE.navy, fontWeight: "800" },
});
