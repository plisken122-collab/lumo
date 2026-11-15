/* --------------------------------------------------------------------
   Anruf.js - Sprach- und Videoanrufe mit Live-Untertiteln.

   Bild und Ton laufen ueber LiveKit. Der Server setzt einen Helfer in
   den Anruf, der mitschreibt und uebersetzt; dessen Text kommt als
   Datennachricht (Thema "untertitel") an und steht unten im Bild:
   was der andere sagt, in meiner Sprache.
-------------------------------------------------------------------- */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet, Vibration, ActivityIndicator } from "react-native";
import {
  registerGlobals, LiveKitRoom, AudioSession, AndroidAudioTypePresets,
  useTracks, VideoTrack, isTrackReference, useDataChannel, useLocalParticipant,
  useRemoteParticipants,
} from "@livekit/react-native";
import { Track } from "livekit-client";

registerGlobals();

const F = { navy: "#14213D", gold: "#E3B23C", weiss: "#FFFFFF", rot: "#E5484D", gruen: "#2BB673" };

/* UTF-8 ohne TextDecoder (fehlt in manchen Hermes-Versionen). */
function utf8(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

async function zugangHolen(server, { raum, device, name, lang }) {
  const r = await fetch(`${server}/api/anruf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: raum, device, name, lang }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || "http " + r.status);
  return j;
}

/* ------------------------- Es klingelt ------------------------- */
export function Klingeln({ wer, t, onAnnehmen, onAblehnen }) {
  useEffect(() => {
    if (!wer) return undefined;
    Vibration.vibrate([0, 700, 500, 700, 500], true);
    const aus = setTimeout(onAblehnen, 60 * 1000);
    return () => { Vibration.cancel(); clearTimeout(aus); };
  }, [wer]);
  if (!wer) return null;
  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onAblehnen}>
      <View style={st.klingeln}>
        <Text style={st.klingelIcon}>{wer.video ? "🎥" : "📞"}</Text>
        <Text style={st.klingelName}>{wer.name}</Text>
        <Text style={st.klingelText}>{t(wer.video ? "anrufVideoKommt" : "anrufKommt")}</Text>
        <Text style={st.klingelHinweis}>{t("anrufUntertitelHinweis")}</Text>
        <View style={st.klingelKnoepfe}>
          <Pressable style={[st.rund, { backgroundColor: F.rot }]} onPress={onAblehnen}>
            <Text style={st.rundTxt}>✕</Text>
          </Pressable>
          <Pressable style={[st.rund, { backgroundColor: F.gruen }]} onPress={onAnnehmen}>
            <Text style={st.rundTxt}>{wer.video ? "🎥" : "📞"}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/* ------------------------- Im Anruf ------------------------- */
export function Anruf({ offen, server, raum, device, name, lang, video, t, onEnde }) {
  const [zugang, setZugang] = useState(null);
  const [fehler, setFehler] = useState(null);

  useEffect(() => {
    if (!offen) { setZugang(null); setFehler(null); return undefined; }
    let ab = false;
    (async () => {
      try {
        await AudioSession.configureAudio({
          android: { preferredOutputList: ["speaker", "bluetooth", "headset", "earpiece"], audioTypeOptions: AndroidAudioTypePresets.communication },
        });
        await AudioSession.startAudioSession();
        const z = await zugangHolen(server, { raum, device, name, lang });
        if (!ab) setZugang(z);
      } catch (e) {
        if (!ab) setFehler(String(e.message || e));
      }
    })();
    return () => { ab = true; AudioSession.stopAudioSession().catch(() => {}); };
  }, [offen]);

  if (!offen) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onEnde}>
      <View style={st.anruf}>
        {fehler ? (
          <View style={st.mitte}>
            <Text style={st.fehler}>{t("anrufFehler")}</Text>
            <Text style={st.klein}>{fehler}</Text>
            <Pressable style={[st.rund, { backgroundColor: F.rot, marginTop: 30 }]} onPress={onEnde}>
              <Text style={st.rundTxt}>✕</Text>
            </Pressable>
          </View>
        ) : !zugang ? (
          <View style={st.mitte}><ActivityIndicator color={F.gold} size="large" /></View>
        ) : (
          <LiveKitRoom
            serverUrl={zugang.url} token={zugang.token} connect
            audio video={video}
            options={{ adaptiveStream: { pixelDensity: "screen" } }}
            onDisconnected={onEnde}
            onError={(e) => setFehler(String(e?.message || e))}
          >
            <ImAnruf lang={lang} video={video} t={t} onEnde={onEnde} />
          </LiveKitRoom>
        )}
      </View>
    </Modal>
  );
}

const BOT = "diralo-untertitel";

function ImAnruf({ lang, video, t, onEnde }) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const andere = useRemoteParticipants().filter((p) => p.identity !== BOT);
  const kameras = useTracks([Track.Source.Camera], { onlySubscribed: false }).filter(isTrackReference);
  const fremdeKamera = kameras.find((k) => !k.participant.isLocal && k.participant.identity !== BOT);
  const eigeneKamera = kameras.find((k) => k.participant.isLocal);

  /* Untertitel: je Sprecher die letzte Zeile. Fremde in meiner Sprache
     (Uebersetzung, sobald der Satz fertig ist), meine eigenen klein. */
  /* fertig: die letzten zwei fertigen Saetze (bleiben je nach Laenge
     7-15 s stehen); live: der Satz, der gerade gesprochen wird - er
     verdraengt die fertigen nicht mehr. */
  const [fertig, setFertig] = useState([]);     // [{ id, text, original }]
  const [live, setLive] = useState({});         // von -> { text, uebersetzt }
  const [eigene, setEigene] = useState("");
  const letzterFertig = useRef({});
  const zaehler = useRef(0);
  const uhren = useRef([]);
  useDataChannel("untertitel", (msg) => {
    let d;
    try { d = JSON.parse(utf8(msg.payload)); } catch { return; }
    if (!d?.text) return;
    if (d.von === localParticipant?.identity) { setEigene(d.text); return; }
    const basis = String(lang).split("-")[0];
    const gleich = String(d.lang || "").split("-")[0] === basis;
    const uebersetzt = d.tr?.[lang] || Object.entries(d.tr || {}).find(([k]) => k.split("-")[0] === basis)?.[1];
    if (!d.fertig) {
      /* Verspaetete Zwischenstaende eines schon fertigen Satzes nicht
         wieder anzeigen. */
      const lf = letzterFertig.current[d.von];
      if (lf && lf.startsWith(d.text.replace(/[.,!?]+$/, ""))) return;
      setLive((alt) => {
        const vorher = alt[d.von];
        const neu = { text: d.text, uebersetzt: gleich ? null : (uebersetzt || (vorher && d.text.startsWith(vorher.text.slice(0, 10)) ? vorher.uebersetzt : null)) };
        return { ...alt, [d.von]: neu };
      });
      return;
    }
    letzterFertig.current[d.von] = d.text;
    setLive((alt) => { const n = { ...alt }; delete n[d.von]; return n; });
    const id = ++zaehler.current;
    const zeile = { id, text: gleich ? d.text : (uebersetzt || d.text), original: gleich ? null : d.text };
    setFertig((alt) => [...alt, zeile].slice(-2));
    const dauer = Math.min(15000, Math.max(7000, 4000 + zeile.text.length * 70));
    uhren.current.push(setTimeout(() => setFertig((alt) => alt.filter((z) => z.id !== id)), dauer));
  });
  useEffect(() => () => uhren.current.forEach(clearTimeout), []);

  const name = andere[0]?.name || andere[0]?.identity || "";
  const [sek, setSek] = useState(0);
  useEffect(() => {
    if (!andere.length) return undefined;
    const i = setInterval(() => setSek((s) => s + 1), 1000);
    return () => clearInterval(i);
  }, [andere.length > 0]);
  const dauer = `${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, "0")}`;

  /* Der andere hat aufgelegt: kurz danach auch hier beenden. Nimmt
     niemand ab, nach 70 Sekunden aufgeben. */
  const warDa = useRef(false);
  useEffect(() => {
    if (andere.length) { warDa.current = true; return undefined; }
    if (warDa.current) { const z = setTimeout(onEnde, 1500); return () => clearTimeout(z); }
    const z = setTimeout(onEnde, 70 * 1000);
    return () => clearTimeout(z);
  }, [andere.length]);

  return (
    <View style={{ flex: 1 }}>
      {fremdeKamera ? (
        <VideoTrack trackRef={fremdeKamera} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : (
        <View style={st.mitte}>
          <View style={st.avatar}><Text style={st.avatarTxt}>{(name || "?").slice(0, 1).toUpperCase()}</Text></View>
        </View>
      )}
      {video && eigeneKamera && isCameraEnabled && (
        <VideoTrack trackRef={eigeneKamera} style={st.eigenesBild} objectFit="cover" mirror />
      )}

      <View style={st.oben}>
        <Text style={st.obenName}>{name || t("anrufWartet")}</Text>
        <Text style={st.obenSub}>{andere.length ? dauer : t("anrufKlingelt")}</Text>
      </View>

      <View style={st.untertitelBox} pointerEvents="none">
        {fertig.map((z) => (
          <View key={z.id} style={st.untertitel}>
            <Text style={st.utText}>{z.text}</Text>
            {z.original ? <Text style={st.utOriginal}>{z.original}</Text> : null}
          </View>
        ))}
        {Object.entries(live).map(([von, z]) => (
          <View key={"live" + von} style={st.untertitel}>
            <Text style={[st.utText, st.utVorlaeufig]}>{z.uebersetzt || z.text} …</Text>
            {z.uebersetzt ? <Text style={st.utOriginal}>{z.text}</Text> : null}
          </View>
        ))}
        {eigene ? <Text style={st.utEigene} numberOfLines={2}>🎙 {eigene}</Text> : null}
      </View>

      <View style={st.leiste}>
        <Pressable
          style={[st.knopf, !isMicrophoneEnabled && st.knopfAus]}
          onPress={() => localParticipant?.setMicrophoneEnabled(!isMicrophoneEnabled)}
        >
          <Text style={st.knopfTxt}>{isMicrophoneEnabled ? "🎙" : "🔇"}</Text>
        </Pressable>
        <Pressable
          style={[st.knopf, !isCameraEnabled && st.knopfAus]}
          onPress={() => localParticipant?.setCameraEnabled(!isCameraEnabled)}
        >
          <Text style={st.knopfTxt}>{isCameraEnabled ? "🎥" : "📷"}</Text>
        </Pressable>
        <Pressable style={[st.knopf, { backgroundColor: F.rot }]} onPress={onEnde}>
          <Text style={st.knopfTxt}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  klingeln: { flex: 1, backgroundColor: F.navy, alignItems: "center", justifyContent: "center", padding: 30 },
  klingelIcon: { fontSize: 64 },
  klingelName: { color: F.weiss, fontSize: 30, fontWeight: "800", marginTop: 18 },
  klingelText: { color: "#C9D1E6", fontSize: 17, marginTop: 8 },
  klingelHinweis: { color: F.gold, fontSize: 14, marginTop: 22, textAlign: "center" },
  klingelKnoepfe: { flexDirection: "row", gap: 70, marginTop: 70 },
  rund: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  rundTxt: { color: F.weiss, fontSize: 30, fontWeight: "800" },
  anruf: { flex: 1, backgroundColor: "#0B1220" },
  mitte: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  fehler: { color: F.weiss, fontSize: 18, fontWeight: "700", textAlign: "center" },
  klein: { color: "#8C96AD", fontSize: 13, marginTop: 8, textAlign: "center" },
  avatar: { width: 130, height: 130, borderRadius: 65, backgroundColor: F.gold, alignItems: "center", justifyContent: "center" },
  avatarTxt: { color: F.navy, fontSize: 56, fontWeight: "800" },
  eigenesBild: { position: "absolute", right: 16, top: 110, width: 110, height: 160, borderRadius: 14, overflow: "hidden" },
  oben: { position: "absolute", top: 46, left: 0, right: 0, alignItems: "center" },
  obenName: { color: F.weiss, fontSize: 22, fontWeight: "800", textShadowColor: "#000", textShadowRadius: 6 },
  obenSub: { color: "#DDE3F0", fontSize: 14, marginTop: 4, textShadowColor: "#000", textShadowRadius: 6 },
  untertitelBox: { position: "absolute", left: 14, right: 14, bottom: 130, gap: 8 },
  untertitel: { backgroundColor: "rgba(0,0,0,0.62)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  utText: { color: F.weiss, fontSize: 21, fontWeight: "700", lineHeight: 27 },
  utVorlaeufig: { color: "#C9D1E6", fontWeight: "500", fontStyle: "italic" },
  utOriginal: { color: "#AEB7CC", fontSize: 14, marginTop: 4, fontStyle: "italic" },
  utEigene: { color: "#DDE3F0", fontSize: 13, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 10, padding: 8, alignSelf: "flex-start" },
  leiste: { position: "absolute", bottom: 40, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 26 },
  knopf: { width: 64, height: 64, borderRadius: 32, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },
  knopfAus: { backgroundColor: "rgba(255,255,255,0.42)" },
  knopfTxt: { color: F.weiss, fontSize: 26 },
});
