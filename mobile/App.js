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
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View, Text, TextInput, FlatList, Pressable, Image, Alert, Linking,
  ScrollView, Modal, Share, Platform, AppState,
  KeyboardAvoidingView, Keyboard, StyleSheet, StatusBar, ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Image as GifBild } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { Video as VideoKompressor } from "react-native-compressor";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";
import { useAudioPlayer, useAudioPlayerStatus, createAudioPlayer } from "expo-audio";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { File } from "expo-file-system";
import * as Notifications from "expo-notifications";
import * as Speech from "expo-speech";
import { useShareIntent } from "expo-share-intent";
import * as Application from "expo-application";
import * as StoreReview from "expo-store-review";
import { Anruf, Klingeln } from "./Anruf";
import {
  initConnection, fetchProducts, requestPurchase, finishTransaction,
  purchaseUpdatedListener, purchaseErrorListener, isUserCancelledError,
} from "expo-iap";
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
  ["hi","हिन्दी"],["ur","اردو"],["bn","বাংলা"],["pa","ਪੰਜਾਬੀ"],["ne","नेपाली"],["sv","Svenska"],["ro","Română"],["da","Dansk"],["no","Norsk"],
  ["fi","Suomi"],["cs","Čeština"],["hu","Magyar"],["el","Ελληνικά"],["he","עברית"],
  ["th","ไทย"],["vi","Tiếng Việt"],["id","Bahasa Indonesia"],
].map(([code, label]) => ({ code, label }));
const sprachName = (code) => SPRACHEN.find((x) => x.code === code)?.label || code;

/* Einladung wie in der Web-App: Link mit dem Code hinter #c=. */
const WEB_URL = "https://diralo.app";
const einladungsLink = (code) => `${WEB_URL}/#c=${encodeURIComponent(code)}`;
/* Umgekehrt: Code aus einem Einladungs-Link (diralo.app/#c=...) lesen. */
const codeAusLink = (url) => {
  const m = /[#&?]c=([^&#]+)/.exec(String(url || ""));
  try { return m ? decodeURIComponent(m[1]).trim().toLowerCase().slice(0, 60) : null; } catch { return null; }
};

/* ------------------------------ Texte ------------------------------
   Die Oberflaeche folgt der in der App gewaehlten Sprache: Deutsch,
   Portugiesisch, sonst Englisch. */
const TEXTE = {
  de: {
    videoAufnehmen: "Video aufnehmen",
    videoVorbereiten: "Video wird vorbereitet …",
    bonusHinweis: "🎁 Schreibt deine Person mit, bekommt ihr beide 1 Monat Diralo Plus gratis.",
    bonusDa: "🎁 Geschafft! Ihr habt für diesen Chat 1 Monat Diralo Plus gratis bekommen.",
    anrufMinutenLeer: "Die Live-Untertitel-Minuten für diesen Monat sind aufgebraucht. Der Anruf läuft ohne Untertitel weiter – mit Diralo Plus gibt es mehr.",
    anrufMinutenRest: "Live-Untertitel: noch {n} Min. diesen Monat.",
    anrufen: "Anrufen",
    anrufSprache: "📞 Sprachanruf",
    anrufVideo: "🎥 Videoanruf",
    anrufKommt: "ruft dich an …",
    anrufVideoKommt: "Videoanruf …",
    anrufUntertitelHinweis: "Mit Live-Untertiteln: Du liest in deiner Sprache, was gesagt wird.",
    anrufFehler: "Der Anruf hat gerade nicht geklappt.",
    anrufWartet: "Warte auf Antwort …",
    anrufKlingelt: "klingelt …",
    anrufVorbei: "Anruf beendet",
    anrufAbgelehnt: "hat nicht angenommen",
    updTitel: "Neue Version verfügbar",
    updText: "Diralo wurde verbessert. Tippe auf „Aktualisieren“ – das dauert nur einen Moment.",
    updKnopf: "Aktualisieren",
    updSpaeter: "Später",
    updPflicht: "Dieses Update ist nötig, damit Diralo weiter funktioniert.",
    autoAn: "Neue Nachrichten werden jetzt vorgelesen.",
    autoAus: "Automatisches Vorlesen ist aus.",
    keineStimme: "Für diese Sprache ist keine Stimme installiert. Android-Einstellungen → Sprachausgabe (Text-in-Sprache) → Sprachdaten installieren.",
    imChat: "im Chat",
    einlTitel: "Du hast eine Einladung bekommen?",
    einlText: "Gib den Chat-Code aus dem Link ein, dann landest du im selben Chat wie deine Person.",
    neuTitel: "Du möchtest jemanden einladen?",
    neuText: "Das startet einen neuen, leeren Chat. Danach schickst du deiner Person den Link.",
    leerTitel: "Dieser Chat ist neu",
    leerText2: "Hier ist noch niemand. Schick deiner Person den Link, damit sie dazukommt.",
    falschHier: "Du hast selbst eine Einladung bekommen? Dann bist du hier falsch.",
    codeEingeben: "Zurück und Code eingeben",
    umbenennen: "Name für diesen Chat",
    chatNameBsp: "z. B. Maria 💕",
    lernenTitel: "Lernen",
    lernenMerken: "⭐ Zum Lernen merken",
    lernenGemerkt: "Gemerkt – du findest es unter 🎓",
    lernenSchon: "Diesen Satz hast du schon gemerkt.",
    lernenNichtMoeglich: "Für diesen Satz gibt es noch keine Übersetzung.",
    lernenKeinPartner: "Sobald jemand in einer anderen Sprache schreibt, kannst du hier seine Sprache lernen – mit euren eigenen Sätzen.",
    lernenGelernt: "{n} Sätze gelernt",
    lernenSerie: "{n}. Tag in Folge",
    lernenWie: "Wie heißt das auf {lang}?",
    lernenAufdecken: "Aufdecken",
    lernenWusste: "Wusste ich",
    lernenNochmal: "Nochmal",
    lernenFertig: "Für heute alles geschafft! Morgen geht's weiter.",
    lernenLeer: "Noch keine Karten. Tippe unten auf einen Vorschlag oder halte eine Nachricht gedrückt → „Zum Lernen merken“.",
    lernenVorschlaege: "Vorschläge aus eurem Chat",
    lernenGratis: "Heute noch {n} Karten gratis",
    lernenPlus: "Für heute geschafft! Unbegrenzt lernen mit einem Diralo-Abo.",
    lernenPlusKnopf: "Abos ansehen",
    lernenKarten: "{n} Karten gesammelt",
    lernenPakete: "Startpakete",
    lernenPaketPaar: "Paar & Familie",
    lernenPaketArbeit: "Arbeit (Bau, Feld, Gewächshaus)",
    lernenPaketAlltag: "Alltag, Arzt & Ämter",
    lernenPaketDazu: "{n} Karten hinzugefügt",
    lernenPaketLaedt: "Wird vorbereitet …",
    lernenTaeglich: "Täglicher Satz um 9 Uhr",
    lernenAusblenden: "Lernen ausblenden",
    lernenAusgeblendet: "Lernen ist ausgeblendet. Wieder einschalten: 👥 oben im Chat.",
    lernenEinblenden: "Lernen wieder einblenden",
    lernenEingeblendet: "Lernen ist wieder da",
    gruppeErstellen: "Gruppe für mein Team erstellen",
    gruppeTipp: "Lade dein Team mit dem Link ein – jeder schreibt und liest in seiner Sprache.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Für alle anheften",
    losloesen: "Nicht mehr anheften",
    durchsage: "📌 Durchsage",
    nurTeamPlus: "Durchsagen gibt es mit Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "Für Betriebe: bis 20 Personen, 3 Gruppen, 5.000 Übersetzungen im Monat",
    teamplusName: "Diralo Team Plus",
    teamplusText: "Für größere Betriebe: bis 60 Personen, 10 Gruppen, 12.000 Übersetzungen im Monat",
    teamFreischalten: "🏢 Für den Betrieb freischalten",
    teamVoll: "Diese Gruppe ist voll – das Team-Abo hat keine freien Plätze mehr. Sag dem Chef Bescheid.",
    kontingentTeam: "Die {n} Übersetzungen eures Team-Abos sind für diesen Monat aufgebraucht. Nachrichten kommen weiter an, nur nicht übersetzt.",
    gruppe: "Gruppe",
    gruppeName: "Name der Gruppe",
    gruppeNameBsp: "z. B. Estufa Silva – Team",
    gruppeChef: "👑 Chef",
    gruppeDuChef: "Du verwaltest diese Gruppe.",
    gruppeNurChef: "Nur wer die Gruppe verwaltet, kann das ändern.",
    gruppeMitglieder: "{n} Mitglieder",
    gruppeEntfernen: "Entfernen",
    gruppeEntfernenFrage: "{name} aus der Gruppe entfernen? Die Person kann den Chat danach nicht mehr öffnen.",
    gruppeEntferntDu: "Du wurdest aus dieser Gruppe entfernt.",
    gruppeOnline: "online",
    gruppeZuletzt: "zuletzt",
    gruppeGelesen: "Gelesen von",
    gruppeUngelesen: "Noch nicht gelesen",
    gruppeHinweis: "Gib dem Chat einen Namen – dann wird er zur Gruppe mit Mitgliederliste und „Gelesen von“. Wer den Namen zuerst vergibt, verwaltet die Gruppe.",
    speichern: "Speichern",
    fuerMich: "🙈 Für mich löschen",
    geteiltTitel: "Geteilt – übersetzt",
    geteiltLaedt: "Wird übersetzt …",
    dateiTitel: "Datei teilen",
    video: "Video",
    datei: "Datei",
    dateiGross: "Die Datei ist zu groß (max. 25 MB).",
    dateiFehler: "Datei konnte nicht gesendet werden.",
    dateiOeffnen: "Tippen zum Öffnen",
    abbrechen2: "Abbrechen",
    dateiKeinChat: "Du hast noch keinen Chat. Starte zuerst einen Chat und lade deine Person ein.",
    gifSuchen: "GIFs suchen",
    gifAus: "GIFs sind gerade nicht verfügbar.",
    gifFehler: "GIF konnte nicht gesendet werden.",
    linkTitel: "Link teilen",
    linkWelcher: "In welchen Chat?",
    linkKeinChat: "Du hast noch keinen Chat. Starte zuerst einen Chat und lade deine Person ein.",
    dolmetscher: "🎙\nDolmetscher",
    fotoKnopf: "📷\nFoto übersetzen",
    dolmInfo: "Handy zwischen euch legen. Jeder tippt auf sein Mikrofon und spricht in seiner Sprache.",
    tippenSprechen: "Tippen und sprechen",
    hoere: "Ich höre zu …",
    andereSprache: "Andere Sprache",
    fotoInfo: "Speisekarte, Brief oder Schild fotografieren – Diralo liest den Text und übersetzt ihn.",
    erklaeren: "Einfach erklären",
    erklaerung: "Erklärung",
    originalText: "Originaltext",
    keinText: "Auf dem Foto wurde kein Text gefunden.",
    fotoLesen: "Lese das Foto …",
    zurueck: "Zurück",
    hilfeFehler: "Das hat gerade nicht geklappt. Bitte nochmal versuchen.",
    vorschau: "So kommt es an:",
    vorschauAus: "Vorschau aus",
    vorlesen: "🔊 Vorlesen",
    langsam: "🐢 Original langsam",
    aussprache: "🗣 Aussprache",
    ausspracheFehler: "Aussprache-Hilfe gerade nicht möglich.",
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
    kontingent: "Die {n} kostenlosen Übersetzungen für diesen Monat sind aufgebraucht. Nachrichten kommen weiter an, im Original. Mit Diralo Plus hast du 1.500 im Monat.",
    kontingentPlus: "Die {n} Übersetzungen von Diralo Plus sind für diesen Monat aufgebraucht. Nachrichten kommen weiter an, im Original. Ab dem 1. geht es weiter – oder wechsle zu Diralo Family.",
    kontingentFamilie: "Die {n} Übersetzungen von Diralo Family sind für diesen Monat aufgebraucht. Nachrichten kommen weiter an, im Original. Ab dem 1. geht es weiter.",
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
    schreiben: "Nachricht",
    geloescht: "Nachricht gelöscht",
    kartenTipp: "Zum Öffnen in der Karte tippen",
    nichtMehrDa: "Nachricht nicht mehr da",
    sprachnachricht: "Sprachnachricht",
    foto: "Foto",
    aufnahmeFehler: "Aufnahme nicht möglich: ",
    ohneMikro: "Ohne Mikrofon-Erlaubnis geht das nicht.",
    android13: "Sprachnachrichten brauchen Android 13 oder neuer.",
    kanal: "Nachrichten",
    aboTitel: "Mehr Übersetzungen",
    aboText: "Bezahlt wird über Google Play. Jederzeit im Play Store kündbar.",
    aboStand: "Dieser Chat: {b} von {g} Übersetzungen diesen Monat.",
    aboAktiv: "Dieser Chat hat Diralo {p}.",
    plusName: "Plus",
    plusText: "1.500 Übersetzungen im Monat, bis zu 3 Chats",
    familieName: "Family",
    familieText: "5.000 Übersetzungen im Monat, bis zu 10 Chats",
    monat: "pro Monat",
    jahr: "pro Jahr",
    aboNichtDa: "Abos sind gerade nicht verfügbar. Bitte später nochmal.",
    aboDanke: "Danke! Dieser Chat ist jetzt freigeschaltet.",
    aboWartet: "Die Zahlung wird noch bestätigt. Das kann ein paar Minuten dauern.",
    aboFehler: "Der Kauf konnte nicht abgeschlossen werden.",
    schliessen: "Schließen",
    heute: "Heute",
    gestern: "Gestern",
    ausblenden: "tippen zum Ausblenden",
  },
  pt: {
    videoAufnehmen: "Gravar vídeo",
    videoVorbereiten: "A preparar o vídeo …",
    bonusHinweis: "🎁 Quando a tua pessoa também escrever, ganham os dois 1 mês de Diralo Plus grátis.",
    bonusDa: "🎁 Conseguido! Ganharam 1 mês de Diralo Plus grátis para este chat.",
    anrufMinutenLeer: "Os minutos de legendas ao vivo deste mês esgotaram-se. A chamada continua sem legendas – com o Diralo Plus tem mais.",
    anrufMinutenRest: "Legendas ao vivo: ainda {n} min este mês.",
    anrufen: "Ligar",
    anrufSprache: "📞 Chamada de voz",
    anrufVideo: "🎥 Videochamada",
    anrufKommt: "está a ligar …",
    anrufVideoKommt: "Videochamada …",
    anrufUntertitelHinweis: "Com legendas ao vivo: lês na tua língua o que é dito.",
    anrufFehler: "A chamada não funcionou agora.",
    anrufWartet: "À espera de resposta …",
    anrufKlingelt: "a chamar …",
    anrufVorbei: "Chamada terminada",
    anrufAbgelehnt: "não atendeu",
    updTitel: "Nova versão disponível",
    updText: "O Diralo foi melhorado. Toca em „Atualizar“ – demora só um momento.",
    updKnopf: "Atualizar",
    updSpaeter: "Mais tarde",
    updPflicht: "Esta atualização é necessária para o Diralo continuar a funcionar.",
    autoAn: "As novas mensagens vão ser lidas em voz alta.",
    autoAus: "A leitura automática está desligada.",
    keineStimme: "Não há voz instalada para esta língua. Definições do Android → Saída de texto para voz → instalar dados de voz.",
    imChat: "no chat",
    einlTitel: "Recebeste um convite?",
    einlText: "Escreve o código do chat que vem no link e entras no mesmo chat que a outra pessoa.",
    neuTitel: "Queres convidar alguém?",
    neuText: "Isto cria um chat novo e vazio. Depois envias o link à outra pessoa.",
    leerTitel: "Este chat é novo",
    leerText2: "Ainda não está cá ninguém. Envia o link à tua pessoa para ela entrar.",
    falschHier: "Recebeste tu um convite? Então estás no sítio errado.",
    codeEingeben: "Voltar e escrever o código",
    umbenennen: "Nome para este chat",
    chatNameBsp: "p. ex. Carsten 💕",
    lernenTitel: "Aprender",
    lernenMerken: "⭐ Guardar para aprender",
    lernenGemerkt: "Guardado – encontra em 🎓",
    lernenSchon: "Já guardou esta frase.",
    lernenNichtMoeglich: "Ainda não há tradução para esta frase.",
    lernenKeinPartner: "Assim que alguém escrever noutra língua, pode aprender a língua dessa pessoa aqui – com as vossas próprias frases.",
    lernenGelernt: "{n} frases aprendidas",
    lernenSerie: "{n} dias seguidos",
    lernenWie: "Como se diz em {lang}?",
    lernenAufdecken: "Mostrar",
    lernenWusste: "Já sabia",
    lernenNochmal: "Outra vez",
    lernenFertig: "Tudo feito por hoje! Amanhã há mais.",
    lernenLeer: "Ainda sem cartões. Toque numa sugestão em baixo ou mantenha uma mensagem premida → «Guardar para aprender».",
    lernenVorschlaege: "Sugestões da vossa conversa",
    lernenGratis: "Hoje ainda {n} cartões grátis",
    lernenPlus: "Feito por hoje! Aprenda sem limites com uma assinatura Diralo.",
    lernenPlusKnopf: "Ver planos",
    lernenKarten: "{n} cartões guardados",
    lernenPakete: "Pacotes iniciais",
    lernenPaketPaar: "Casal e família",
    lernenPaketArbeit: "Trabalho (obras, campo, estufa)",
    lernenPaketAlltag: "Dia a dia, médico e serviços",
    lernenPaketDazu: "{n} cartões adicionados",
    lernenPaketLaedt: "A preparar …",
    lernenTaeglich: "Frase diária às 9h",
    lernenAusblenden: "Ocultar aprender",
    lernenAusgeblendet: "Aprender está oculto. Para voltar a ligar: 👥 no topo da conversa.",
    lernenEinblenden: "Mostrar aprender outra vez",
    lernenEingeblendet: "Aprender voltou",
    gruppeErstellen: "Criar grupo para a minha equipa",
    gruppeTipp: "Convide a sua equipa com o link – cada um escreve e lê na sua língua.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Fixar para todos",
    losloesen: "Desafixar",
    durchsage: "📌 Aviso",
    nurTeamPlus: "Os avisos fixados fazem parte do Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "Para empresas: até 20 pessoas, 3 grupos, 5.000 traduções por mês",
    teamplusName: "Diralo Team Plus",
    teamplusText: "Para empresas maiores: até 60 pessoas, 10 grupos, 12.000 traduções por mês",
    teamFreischalten: "🏢 Ativar para a empresa",
    teamVoll: "Este grupo está cheio – a subscrição Team não tem mais lugares. Avise o responsável.",
    kontingentTeam: "As {n} traduções da vossa subscrição Team acabaram este mês. As mensagens continuam a chegar, mas sem tradução.",
    gruppe: "Grupo",
    gruppeName: "Nome do grupo",
    gruppeNameBsp: "p. ex. Estufa Silva – Equipa",
    gruppeChef: "👑 Responsável",
    gruppeDuChef: "É você quem gere este grupo.",
    gruppeNurChef: "Só quem gere o grupo pode alterar isto.",
    gruppeMitglieder: "{n} membros",
    gruppeEntfernen: "Remover",
    gruppeEntfernenFrage: "Remover {name} do grupo? Essa pessoa deixa de poder abrir o chat.",
    gruppeEntferntDu: "Foi removido deste grupo.",
    gruppeOnline: "online",
    gruppeZuletzt: "última vez",
    gruppeGelesen: "Lido por",
    gruppeUngelesen: "Ainda não leu",
    gruppeHinweis: "Dê um nome ao chat – passa a ser um grupo com lista de membros e «Lido por». Quem der o nome primeiro gere o grupo.",
    speichern: "Guardar",
    fuerMich: "🙈 Apagar para mim",
    geteiltTitel: "Partilhado – traduzido",
    geteiltLaedt: "A traduzir …",
    dateiTitel: "Partilhar ficheiro",
    video: "Vídeo",
    datei: "Ficheiro",
    dateiGross: "O ficheiro é demasiado grande (máx. 25 MB).",
    dateiFehler: "Não foi possível enviar o ficheiro.",
    dateiOeffnen: "Toque para abrir",
    abbrechen2: "Cancelar",
    dateiKeinChat: "Ainda não tens nenhuma conversa. Começa uma conversa e convida a tua pessoa.",
    gifSuchen: "Pesquisar GIFs",
    gifAus: "Os GIFs não estão disponíveis de momento.",
    gifFehler: "Não foi possível enviar o GIF.",
    linkTitel: "Partilhar link",
    linkWelcher: "Em que conversa?",
    linkKeinChat: "Ainda não tens nenhuma conversa. Começa primeiro uma conversa e convida a tua pessoa.",
    dolmetscher: "🎙\nIntérprete",
    fotoKnopf: "📷\nTraduzir foto",
    dolmInfo: "Ponham o telemóvel entre vocês. Cada um toca no seu microfone e fala na sua língua.",
    tippenSprechen: "Tocar e falar",
    hoere: "Estou a ouvir …",
    andereSprache: "Outra língua",
    fotoInfo: "Fotografa uma ementa, carta ou placa – o Diralo lê o texto e traduz.",
    erklaeren: "Explicar de forma simples",
    erklaerung: "Explicação",
    originalText: "Texto original",
    keinText: "Não foi encontrado texto na foto.",
    fotoLesen: "A ler a foto …",
    zurueck: "Voltar",
    hilfeFehler: "Não funcionou. Tenta outra vez.",
    vorschau: "Vai chegar assim:",
    vorschauAus: "Desligar pré-visualização",
    vorlesen: "🔊 Ouvir",
    langsam: "🐢 Original devagar",
    aussprache: "🗣 Pronúncia",
    ausspracheFehler: "Ajuda de pronúncia indisponível de momento.",
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
    kontingent: "As {n} traduções gratuitas deste mês esgotaram-se. As mensagens continuam a chegar, no original. Com o Diralo Plus tens 1.500 por mês.",
    kontingentPlus: "As {n} traduções do Diralo Plus deste mês esgotaram-se. As mensagens continuam a chegar, no original. Recomeça no dia 1 – ou muda para o Diralo Family.",
    kontingentFamilie: "As {n} traduções do Diralo Family deste mês esgotaram-se. As mensagens continuam a chegar, no original. Recomeça no dia 1.",
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
    schreiben: "Mensagem",
    geloescht: "Mensagem apagada",
    kartenTipp: "Toca para abrir no mapa",
    nichtMehrDa: "Mensagem já não existe",
    sprachnachricht: "Mensagem de voz",
    foto: "Foto",
    aufnahmeFehler: "Gravação não possível: ",
    ohneMikro: "Sem permissão do microfone não é possível.",
    android13: "As mensagens de voz precisam do Android 13 ou mais recente.",
    kanal: "Mensagens",
    aboTitel: "Mais traduções",
    aboText: "O pagamento é feito pelo Google Play. Podes cancelar a qualquer momento na Play Store.",
    aboStand: "Este chat: {b} de {g} traduções este mês.",
    aboAktiv: "Este chat tem o Diralo {p}.",
    plusName: "Plus",
    plusText: "1.500 traduções por mês, até 3 chats",
    familieName: "Family",
    familieText: "5.000 traduções por mês, até 10 chats",
    monat: "por mês",
    jahr: "por ano",
    aboNichtDa: "As assinaturas não estão disponíveis de momento. Tenta mais tarde.",
    aboDanke: "Obrigado! Este chat está agora desbloqueado.",
    aboWartet: "O pagamento ainda está a ser confirmado. Pode demorar alguns minutos.",
    aboFehler: "Não foi possível concluir a compra.",
    schliessen: "Fechar",
    heute: "Hoje",
    gestern: "Ontem",
    ausblenden: "toca para fechar",
  },
  en: {
    videoAufnehmen: "Record video",
    videoVorbereiten: "Preparing video …",
    bonusHinweis: "🎁 Once your person writes too, you both get 1 month of Diralo Plus free.",
    bonusDa: "🎁 Done! You both got 1 month of Diralo Plus free for this chat.",
    anrufMinutenLeer: "This month's live subtitle minutes are used up. The call continues without subtitles – Diralo Plus gives you more.",
    anrufMinutenRest: "Live subtitles: {n} min left this month.",
    anrufen: "Call",
    anrufSprache: "📞 Voice call",
    anrufVideo: "🎥 Video call",
    anrufKommt: "is calling …",
    anrufVideoKommt: "Video call …",
    anrufUntertitelHinweis: "With live subtitles: you read what is said in your language.",
    anrufFehler: "The call didn't work just now.",
    anrufWartet: "Waiting for answer …",
    anrufKlingelt: "ringing …",
    anrufVorbei: "Call ended",
    anrufAbgelehnt: "didn't answer",
    updTitel: "New version available",
    updText: "Diralo has been improved. Tap “Update” – it only takes a moment.",
    updKnopf: "Update",
    updSpaeter: "Later",
    updPflicht: "This update is required for Diralo to keep working.",
    autoAn: "New messages will now be read aloud.",
    autoAus: "Automatic read-aloud is off.",
    keineStimme: "No voice is installed for this language. Android settings → Text-to-speech output → install voice data.",
    imChat: "in the chat",
    einlTitel: "Did you get an invitation?",
    einlText: "Enter the chat code from the link and you'll join the same chat as your person.",
    neuTitel: "Want to invite someone?",
    neuText: "This starts a new, empty chat. Then you send your person the link.",
    leerTitel: "This chat is new",
    leerText2: "Nobody is here yet. Send your person the link so they can join.",
    falschHier: "Did you get an invitation yourself? Then you're in the wrong place.",
    codeEingeben: "Go back and enter the code",
    umbenennen: "Name for this chat",
    chatNameBsp: "e.g. Maria 💕",
    lernenTitel: "Learn",
    lernenMerken: "⭐ Save to learn",
    lernenGemerkt: "Saved – find it under 🎓",
    lernenSchon: "You already saved this sentence.",
    lernenNichtMoeglich: "There's no translation for this sentence yet.",
    lernenKeinPartner: "As soon as someone writes in another language, you can learn their language here – with your own sentences.",
    lernenGelernt: "{n} sentences learned",
    lernenSerie: "{n}-day streak",
    lernenWie: "How do you say this in {lang}?",
    lernenAufdecken: "Reveal",
    lernenWusste: "I knew it",
    lernenNochmal: "Again",
    lernenFertig: "All done for today! See you tomorrow.",
    lernenLeer: "No cards yet. Tap a suggestion below, or long-press a message → “Save to learn”.",
    lernenVorschlaege: "Suggestions from your chat",
    lernenGratis: "{n} free cards left today",
    lernenPlus: "Done for today! Learn without limits with a Diralo subscription.",
    lernenPlusKnopf: "See plans",
    lernenKarten: "{n} cards saved",
    lernenPakete: "Starter packs",
    lernenPaketPaar: "Couple & family",
    lernenPaketArbeit: "Work (building, farm, greenhouse)",
    lernenPaketAlltag: "Daily life, doctor & offices",
    lernenPaketDazu: "{n} cards added",
    lernenPaketLaedt: "Preparing …",
    lernenTaeglich: "Daily sentence at 9 am",
    lernenAusblenden: "Hide learning",
    lernenAusgeblendet: "Learning is hidden. To turn it back on: 👥 at the top of the chat.",
    lernenEinblenden: "Show learning again",
    lernenEingeblendet: "Learning is back",
    gruppeErstellen: "Create a group for my team",
    gruppeTipp: "Invite your team with the link – everyone writes and reads in their own language.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Pin for everyone",
    losloesen: "Unpin",
    durchsage: "📌 Announcement",
    nurTeamPlus: "Pinned announcements come with Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "For businesses: up to 20 people, 3 groups, 5,000 translations a month",
    teamplusName: "Diralo Team Plus",
    teamplusText: "For larger businesses: up to 60 people, 10 groups, 12,000 translations a month",
    teamFreischalten: "🏢 Activate for the business",
    teamVoll: "This group is full – the Team plan has no free places left. Let the admin know.",
    kontingentTeam: "Your Team plan's {n} translations are used up for this month. Messages still arrive, just untranslated.",
    gruppe: "Group",
    gruppeName: "Group name",
    gruppeNameBsp: "e.g. Estufa Silva – Team",
    gruppeChef: "👑 Admin",
    gruppeDuChef: "You manage this group.",
    gruppeNurChef: "Only the group admin can change this.",
    gruppeMitglieder: "{n} members",
    gruppeEntfernen: "Remove",
    gruppeEntfernenFrage: "Remove {name} from the group? They won't be able to open the chat any more.",
    gruppeEntferntDu: "You have been removed from this group.",
    gruppeOnline: "online",
    gruppeZuletzt: "last seen",
    gruppeGelesen: "Read by",
    gruppeUngelesen: "Not read yet",
    gruppeHinweis: "Give the chat a name and it becomes a group with a member list and “Read by”. Whoever names it first manages the group.",
    speichern: "Save",
    fuerMich: "🙈 Delete for me",
    geteiltTitel: "Shared – translated",
    geteiltLaedt: "Translating …",
    dateiTitel: "Share file",
    video: "Video",
    datei: "File",
    dateiGross: "The file is too large (max. 25 MB).",
    dateiFehler: "The file could not be sent.",
    dateiOeffnen: "Tap to open",
    abbrechen2: "Cancel",
    dateiKeinChat: "You don't have a chat yet. Start a chat first and invite your person.",
    gifSuchen: "Search GIFs",
    gifAus: "GIFs are not available right now.",
    gifFehler: "The GIF could not be sent.",
    linkTitel: "Share link",
    linkWelcher: "Which chat?",
    linkKeinChat: "You don't have a chat yet. Start a chat first and invite your person.",
    dolmetscher: "🎙\nInterpreter",
    fotoKnopf: "📷\nTranslate photo",
    dolmInfo: "Put the phone between you. Each person taps their microphone and speaks in their own language.",
    tippenSprechen: "Tap and speak",
    hoere: "Listening …",
    andereSprache: "Other language",
    fotoInfo: "Take a photo of a menu, letter or sign – Diralo reads the text and translates it.",
    erklaeren: "Explain simply",
    erklaerung: "Explanation",
    originalText: "Original text",
    keinText: "No text was found in the photo.",
    fotoLesen: "Reading the photo …",
    zurueck: "Back",
    hilfeFehler: "That didn't work. Please try again.",
    vorschau: "It will arrive as:",
    vorschauAus: "Preview off",
    vorlesen: "🔊 Read aloud",
    langsam: "🐢 Original slowly",
    aussprache: "🗣 Pronunciation",
    ausspracheFehler: "Pronunciation help not available right now.",
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
    kontingent: "Your {n} free translations for this month are used up. Messages still arrive, in the original. Diralo Plus gives you 1,500 a month.",
    kontingentPlus: "Your {n} Diralo Plus translations for this month are used up. Messages still arrive, in the original. It resets on the 1st – or switch to Diralo Family.",
    kontingentFamilie: "Your {n} Diralo Family translations for this month are used up. Messages still arrive, in the original. It resets on the 1st.",
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
    schreiben: "Message",
    geloescht: "Message deleted",
    kartenTipp: "Tap to open in maps",
    nichtMehrDa: "Message no longer available",
    sprachnachricht: "Voice message",
    foto: "Photo",
    aufnahmeFehler: "Recording not possible: ",
    ohneMikro: "Not possible without microphone permission.",
    android13: "Voice messages need Android 13 or newer.",
    kanal: "Messages",
    aboTitel: "More translations",
    aboText: "Billed through Google Play. Cancel anytime in the Play Store.",
    aboStand: "This chat: {b} of {g} translations this month.",
    aboAktiv: "This chat has Diralo {p}.",
    plusName: "Plus",
    plusText: "1,500 translations per month, up to 3 chats",
    familieName: "Family",
    familieText: "5,000 translations per month, up to 10 chats",
    monat: "per month",
    jahr: "per year",
    aboNichtDa: "Subscriptions are not available right now. Please try again later.",
    aboDanke: "Thank you! This chat is now unlocked.",
    aboWartet: "The payment is still being confirmed. This can take a few minutes.",
    aboFehler: "The purchase could not be completed.",
    schliessen: "Close",
    heute: "Today",
    gestern: "Yesterday",
    ausblenden: "tap to dismiss",
  },
  es: {
    videoAufnehmen: "Grabar vídeo",
    videoVorbereiten: "Preparando el vídeo …",
    bonusHinweis: "🎁 Cuando tu persona también escriba, los dos recibís 1 mes de Diralo Plus gratis.",
    bonusDa: "🎁 ¡Listo! Habéis recibido 1 mes de Diralo Plus gratis para este chat.",
    anrufMinutenLeer: "Se han agotado los minutos de subtítulos en directo de este mes. La llamada sigue sin subtítulos; con Diralo Plus tienes más.",
    anrufMinutenRest: "Subtítulos en directo: quedan {n} min este mes.",
    anrufen: "Llamar",
    anrufSprache: "📞 Llamada de voz",
    anrufVideo: "🎥 Videollamada",
    anrufKommt: "te está llamando …",
    anrufVideoKommt: "Videollamada …",
    anrufUntertitelHinweis: "Con subtítulos en directo: lees en tu idioma lo que se dice.",
    anrufFehler: "La llamada no ha funcionado.",
    anrufWartet: "Esperando respuesta …",
    anrufKlingelt: "llamando …",
    anrufVorbei: "Llamada finalizada",
    anrufAbgelehnt: "no ha contestado",
    updTitel: "Nueva versión disponible",
    updText: "Diralo ha mejorado. Toca «Actualizar»: solo tarda un momento.",
    updKnopf: "Actualizar",
    updSpaeter: "Más tarde",
    updPflicht: "Esta actualización es necesaria para que Diralo siga funcionando.",
    autoAn: "Los mensajes nuevos se leerán en voz alta.",
    autoAus: "La lectura automática está desactivada.",
    keineStimme: "No hay ninguna voz instalada para este idioma. Ajustes de Android → Salida de texto a voz → instalar datos de voz.",
    imChat: "en el chat",
    einlTitel: "¿Has recibido una invitación?",
    einlText: "Escribe el código del chat que viene en el enlace y entrarás en el mismo chat que la otra persona.",
    neuTitel: "¿Quieres invitar a alguien?",
    neuText: "Esto crea un chat nuevo y vacío. Después envías el enlace a tu persona.",
    leerTitel: "Este chat es nuevo",
    leerText2: "Todavía no hay nadie. Envía el enlace a tu persona para que entre.",
    falschHier: "¿Has recibido tú una invitación? Entonces estás en el sitio equivocado.",
    codeEingeben: "Volver y escribir el código",
    umbenennen: "Nombre para este chat",
    chatNameBsp: "p. ej. María 💕",
    lernenTitel: "Aprender",
    lernenMerken: "⭐ Guardar para aprender",
    lernenGemerkt: "Guardado – lo encuentras en 🎓",
    lernenSchon: "Ya guardaste esta frase.",
    lernenNichtMoeglich: "Aún no hay traducción para esta frase.",
    lernenKeinPartner: "En cuanto alguien escriba en otro idioma, podrás aprender su idioma aquí, con vuestras propias frases.",
    lernenGelernt: "{n} frases aprendidas",
    lernenSerie: "{n} días seguidos",
    lernenWie: "¿Cómo se dice en {lang}?",
    lernenAufdecken: "Mostrar",
    lernenWusste: "Lo sabía",
    lernenNochmal: "Otra vez",
    lernenFertig: "¡Todo hecho por hoy! Mañana más.",
    lernenLeer: "Aún no hay tarjetas. Toca una sugerencia abajo o mantén pulsado un mensaje → «Guardar para aprender».",
    lernenVorschlaege: "Sugerencias de vuestro chat",
    lernenGratis: "Hoy quedan {n} tarjetas gratis",
    lernenPlus: "¡Hecho por hoy! Aprende sin límites con una suscripción Diralo.",
    lernenPlusKnopf: "Ver planes",
    lernenKarten: "{n} tarjetas guardadas",
    lernenPakete: "Paquetes iniciales",
    lernenPaketPaar: "Pareja y familia",
    lernenPaketArbeit: "Trabajo (obra, campo, invernadero)",
    lernenPaketAlltag: "Día a día, médico y trámites",
    lernenPaketDazu: "{n} tarjetas añadidas",
    lernenPaketLaedt: "Preparando …",
    lernenTaeglich: "Frase diaria a las 9",
    lernenAusblenden: "Ocultar aprender",
    lernenAusgeblendet: "Aprender está oculto. Para volver a activarlo: 👥 arriba en el chat.",
    lernenEinblenden: "Volver a mostrar aprender",
    lernenEingeblendet: "Aprender ha vuelto",
    gruppeErstellen: "Crear grupo para mi equipo",
    gruppeTipp: "Invita a tu equipo con el enlace: cada uno escribe y lee en su idioma.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Fijar para todos",
    losloesen: "Dejar de fijar",
    durchsage: "📌 Aviso",
    nurTeamPlus: "Los avisos fijados vienen con Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "Para empresas: hasta 20 personas, 3 grupos, 5.000 traducciones al mes",
    teamplusName: "Diralo Team Plus",
    teamplusText: "Para empresas más grandes: hasta 60 personas, 10 grupos, 12.000 traducciones al mes",
    teamFreischalten: "🏢 Activar para la empresa",
    teamVoll: "Este grupo está lleno: la suscripción Team no tiene plazas libres. Avisa al administrador.",
    kontingentTeam: "Las {n} traducciones de vuestra suscripción Team se han agotado este mes. Los mensajes siguen llegando, pero sin traducir.",
    gruppe: "Grupo",
    gruppeName: "Nombre del grupo",
    gruppeNameBsp: "p. ej. Estufa Silva – Equipo",
    gruppeChef: "👑 Admin",
    gruppeDuChef: "Tú administras este grupo.",
    gruppeNurChef: "Solo quien administra el grupo puede cambiar esto.",
    gruppeMitglieder: "{n} miembros",
    gruppeEntfernen: "Eliminar",
    gruppeEntfernenFrage: "¿Eliminar a {name} del grupo? Ya no podrá abrir el chat.",
    gruppeEntferntDu: "Te han eliminado de este grupo.",
    gruppeOnline: "en línea",
    gruppeZuletzt: "últ. vez",
    gruppeGelesen: "Leído por",
    gruppeUngelesen: "Aún no lo ha leído",
    gruppeHinweis: "Ponle un nombre al chat y se convierte en un grupo con lista de miembros y «Leído por». Quien le pone el nombre primero administra el grupo.",
    speichern: "Guardar",
    fuerMich: "🙈 Borrar para mí",
    geteiltTitel: "Compartido – traducido",
    geteiltLaedt: "Traduciendo …",
    dateiTitel: "Compartir archivo",
    video: "Vídeo",
    datei: "Archivo",
    dateiGross: "El archivo es demasiado grande (máx. 25 MB).",
    dateiFehler: "No se pudo enviar el archivo.",
    dateiOeffnen: "Toca para abrir",
    abbrechen2: "Cancelar",
    dateiKeinChat: "Aún no tienes ningún chat. Empieza un chat e invita a tu persona.",
    gifSuchen: "Buscar GIFs",
    gifAus: "Los GIFs no están disponibles ahora mismo.",
    gifFehler: "No se pudo enviar el GIF.",
    linkTitel: "Compartir enlace",
    linkWelcher: "¿En qué chat?",
    linkKeinChat: "Todavía no tienes ningún chat. Primero inicia un chat e invita a tu persona.",
    dolmetscher: "🎙\nIntérprete",
    fotoKnopf: "📷\nTraducir foto",
    dolmInfo: "Poned el móvil entre vosotros. Cada uno toca su micrófono y habla en su idioma.",
    tippenSprechen: "Toca y habla",
    hoere: "Escuchando …",
    andereSprache: "Otro idioma",
    fotoInfo: "Fotografía una carta, menú o cartel – Diralo lee el texto y lo traduce.",
    erklaeren: "Explicar de forma sencilla",
    erklaerung: "Explicación",
    originalText: "Texto original",
    keinText: "No se encontró texto en la foto.",
    fotoLesen: "Leyendo la foto …",
    zurueck: "Volver",
    hilfeFehler: "No ha funcionado. Inténtalo de nuevo.",
    vorschau: "Llegará así:",
    vorschauAus: "Desactivar vista previa",
    vorlesen: "🔊 Escuchar",
    langsam: "🐢 Original despacio",
    aussprache: "🗣 Pronunciación",
    ausspracheFehler: "Ayuda de pronunciación no disponible ahora.",
    claim: "Chatea en cualquier idioma. Cada mensaje se traduce automáticamente.",
    deinName: "Tu nombre",
    nameBsp: "p. ej. María",
    deineSprache: "Tu idioma",
    neuerChat: "Iniciar nuevo chat",
    oderBeitreten: "o unirse a un chat",
    chatCode: "Código del chat",
    beitreten: "Unirse",
    meineChats: "Mis chats",
    datenschutz: "Para traducir, cada mensaje se envía a un servidor y allí se puede leer — a diferencia de WhatsApp. No escribas nada que nadie más deba ver. Todo se borra a los 30 días.",
    ausListe: "¿quitar de la lista?",
    abbrechen: "Cancelar",
    entfernen: "Quitar",
    nochKeine: "Ninguno usado aún.",
    kontingent: "Se han agotado las {n} traducciones gratuitas de este mes. Los mensajes siguen llegando, en el original. Con Diralo Plus tienes 1.500 al mes.",
    kontingentPlus: "Se han agotado las {n} traducciones de Diralo Plus de este mes. Los mensajes siguen llegando, en el original. Se renuevan el día 1, o cambia a Diralo Family.",
    kontingentFamilie: "Se han agotado las {n} traducciones de Diralo Family de este mes. Los mensajes siguen llegando, en el original. Se renuevan el día 1.",
    uebersFehler: "Traducción no disponible ahora. El mensaje se muestra en el original.",
    zuVieleJoins: "Demasiados intentos de unirse. Espera un momento.",
    langsamer: "Más despacio - demasiados mensajes en poco tiempo.",
    fremdGeraet: "Este mensaje se escribió en otro dispositivo y no se puede borrar aquí.",
    loeschenFehler: "No se puede borrar ahora. Inténtalo más tarde.",
    spracheLang: "El mensaje de voz es demasiado largo.",
    spracheFehler: "No se pudo enviar el mensaje de voz.",
    einladung: "Chatea conmigo en Diralo — cada uno en su idioma:",
    fuerAlleFrage: "¿Borrar para todos?",
    verschwindet: "El mensaje también desaparece para la otra persona.",
    loeschen: "Borrar",
    ohneKamera: "No es posible sin permiso de cámara.",
    ohneFotos: "No es posible sin acceso a las fotos.",
    fotoGross: "La foto es demasiado grande.",
    fotoFehler: "No se pudo enviar la foto.",
    ohneStandort: "No es posible sin permiso de ubicación.",
    standortFehler: "No se pudo obtener la ubicación.",
    senden: "Enviar",
    galerie: "Foto de la galería",
    kamera: "Cámara",
    standort: "Ubicación",
    einladen: "Invitar",
    verbunden: "conectado",
    verbinde: "conectando ...",
    du: "tú",
    Du: "Tú",
    leer: "Aún no hay mensajes. Escribe el primero - se traduce automáticamente.",
    antworten: "↩ Responder",
    fuerAlle: "🗑 Borrar para todos",
    schreiben: "Mensaje",
    geloescht: "Mensaje borrado",
    kartenTipp: "Toca para abrir en el mapa",
    nichtMehrDa: "El mensaje ya no existe",
    sprachnachricht: "Mensaje de voz",
    foto: "Foto",
    aufnahmeFehler: "No se puede grabar: ",
    ohneMikro: "No es posible sin permiso de micrófono.",
    android13: "Los mensajes de voz necesitan Android 13 o posterior.",
    kanal: "Mensajes",
    aboTitel: "Más traducciones",
    aboText: "El pago se hace con Google Play. Cancela cuando quieras en Play Store.",
    aboStand: "Este chat: {b} de {g} traducciones este mes.",
    aboAktiv: "Este chat tiene Diralo {p}.",
    plusName: "Plus",
    plusText: "1.500 traducciones al mes, hasta 3 chats",
    familieName: "Family",
    familieText: "5.000 traducciones al mes, hasta 10 chats",
    monat: "al mes",
    jahr: "al año",
    aboNichtDa: "Las suscripciones no están disponibles ahora. Inténtalo más tarde.",
    aboDanke: "¡Gracias! Este chat ya está desbloqueado.",
    aboWartet: "El pago aún se está confirmando. Puede tardar unos minutos.",
    aboFehler: "No se pudo completar la compra.",
    schliessen: "Cerrar",
    heute: "Hoy",
    gestern: "Ayer",
    ausblenden: "toca para cerrar",
  },
  fr: {
    videoAufnehmen: "Filmer une vidéo",
    videoVorbereiten: "Préparation de la vidéo …",
    bonusHinweis: "🎁 Dès que ta personne écrit aussi, vous recevez tous les deux 1 mois de Diralo Plus gratuit.",
    bonusDa: "🎁 C'est fait ! Vous avez reçu 1 mois de Diralo Plus gratuit pour ce chat.",
    anrufMinutenLeer: "Les minutes de sous-titres en direct de ce mois sont épuisées. L'appel continue sans sous-titres – Diralo Plus t'en donne plus.",
    anrufMinutenRest: "Sous-titres en direct : encore {n} min ce mois-ci.",
    anrufen: "Appeler",
    anrufSprache: "📞 Appel vocal",
    anrufVideo: "🎥 Appel vidéo",
    anrufKommt: "t'appelle …",
    anrufVideoKommt: "Appel vidéo …",
    anrufUntertitelHinweis: "Avec sous-titres en direct : tu lis dans ta langue ce qui est dit.",
    anrufFehler: "L'appel n'a pas fonctionné.",
    anrufWartet: "En attente de réponse …",
    anrufKlingelt: "ça sonne …",
    anrufVorbei: "Appel terminé",
    anrufAbgelehnt: "n'a pas répondu",
    updTitel: "Nouvelle version disponible",
    updText: "Diralo a été amélioré. Appuie sur « Mettre à jour » – cela ne prend qu'un instant.",
    updKnopf: "Mettre à jour",
    updSpaeter: "Plus tard",
    updPflicht: "Cette mise à jour est nécessaire pour que Diralo continue de fonctionner.",
    autoAn: "Les nouveaux messages seront lus à voix haute.",
    autoAus: "La lecture automatique est désactivée.",
    keineStimme: "Aucune voix n'est installée pour cette langue. Paramètres Android → Synthèse vocale → installer les données vocales.",
    imChat: "dans le chat",
    einlTitel: "Tu as reçu une invitation ?",
    einlText: "Saisis le code du chat qui figure dans le lien et tu rejoins le même chat que l'autre personne.",
    neuTitel: "Tu veux inviter quelqu'un ?",
    neuText: "Cela crée un nouveau chat vide. Ensuite tu envoies le lien à ta personne.",
    leerTitel: "Ce chat est nouveau",
    leerText2: "Personne n'est encore là. Envoie le lien à ta personne pour qu'elle rejoigne.",
    falschHier: "Tu as reçu toi-même une invitation ? Alors tu n'es pas au bon endroit.",
    codeEingeben: "Revenir et saisir le code",
    umbenennen: "Nom de ce chat",
    chatNameBsp: "p. ex. Marie 💕",
    lernenTitel: "Apprendre",
    lernenMerken: "⭐ Garder pour apprendre",
    lernenGemerkt: "Gardé – à retrouver sous 🎓",
    lernenSchon: "Tu as déjà gardé cette phrase.",
    lernenNichtMoeglich: "Pas encore de traduction pour cette phrase.",
    lernenKeinPartner: "Dès que quelqu'un écrit dans une autre langue, tu peux apprendre sa langue ici – avec vos propres phrases.",
    lernenGelernt: "{n} phrases apprises",
    lernenSerie: "{n} jours d'affilée",
    lernenWie: "Comment dit-on en {lang} ?",
    lernenAufdecken: "Afficher",
    lernenWusste: "Je savais",
    lernenNochmal: "Encore",
    lernenFertig: "Tout est fait pour aujourd'hui ! À demain.",
    lernenLeer: "Pas encore de cartes. Touche une suggestion ci-dessous ou appuie longuement sur un message → « Garder pour apprendre ».",
    lernenVorschlaege: "Suggestions de votre chat",
    lernenGratis: "Encore {n} cartes gratuites aujourd'hui",
    lernenPlus: "C'est fait pour aujourd'hui ! Apprends sans limite avec un abonnement Diralo.",
    lernenPlusKnopf: "Voir les offres",
    lernenKarten: "{n} cartes gardées",
    lernenPakete: "Packs de départ",
    lernenPaketPaar: "Couple et famille",
    lernenPaketArbeit: "Travail (chantier, champs, serre)",
    lernenPaketAlltag: "Quotidien, médecin et administrations",
    lernenPaketDazu: "{n} cartes ajoutées",
    lernenPaketLaedt: "Préparation …",
    lernenTaeglich: "Phrase du jour à 9 h",
    lernenAusblenden: "Masquer l'apprentissage",
    lernenAusgeblendet: "L'apprentissage est masqué. Pour le réactiver : 👥 en haut du chat.",
    lernenEinblenden: "Réafficher l'apprentissage",
    lernenEingeblendet: "L'apprentissage est de retour",
    gruppeErstellen: "Créer un groupe pour mon équipe",
    gruppeTipp: "Invite ton équipe avec le lien – chacun écrit et lit dans sa langue.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Épingler pour tous",
    losloesen: "Désépingler",
    durchsage: "📌 Annonce",
    nurTeamPlus: "Les annonces épinglées sont incluses dans Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "Pour les entreprises : jusqu’à 20 personnes, 3 groupes, 5 000 traductions par mois",
    teamplusName: "Diralo Team Plus",
    teamplusText: "Pour les plus grandes entreprises : jusqu’à 60 personnes, 10 groupes, 12 000 traductions par mois",
    teamFreischalten: "🏢 Activer pour l’entreprise",
    teamVoll: "Ce groupe est complet : l’abonnement Team n’a plus de place. Préviens l’admin.",
    kontingentTeam: "Les {n} traductions de votre abonnement Team sont épuisées ce mois-ci. Les messages arrivent toujours, mais sans traduction.",
    gruppe: "Groupe",
    gruppeName: "Nom du groupe",
    gruppeNameBsp: "p. ex. Estufa Silva – Équipe",
    gruppeChef: "👑 Admin",
    gruppeDuChef: "Tu gères ce groupe.",
    gruppeNurChef: "Seul l’admin du groupe peut modifier ceci.",
    gruppeMitglieder: "{n} membres",
    gruppeEntfernen: "Retirer",
    gruppeEntfernenFrage: "Retirer {name} du groupe ? Cette personne ne pourra plus ouvrir le chat.",
    gruppeEntferntDu: "Tu as été retiré(e) de ce groupe.",
    gruppeOnline: "en ligne",
    gruppeZuletzt: "vu",
    gruppeGelesen: "Lu par",
    gruppeUngelesen: "Pas encore lu",
    gruppeHinweis: "Donne un nom au chat : il devient un groupe avec liste des membres et « Lu par ». Celui qui le nomme en premier gère le groupe.",
    speichern: "Enregistrer",
    fuerMich: "🙈 Supprimer pour moi",
    geteiltTitel: "Partagé – traduit",
    geteiltLaedt: "Traduction …",
    dateiTitel: "Partager le fichier",
    video: "Vidéo",
    datei: "Fichier",
    dateiGross: "Le fichier est trop volumineux (max. 25 Mo).",
    dateiFehler: "Le fichier n'a pas pu être envoyé.",
    dateiOeffnen: "Touchez pour ouvrir",
    abbrechen2: "Annuler",
    dateiKeinChat: "Tu n'as pas encore de discussion. Commence une discussion et invite ta personne.",
    gifSuchen: "Rechercher des GIF",
    gifAus: "Les GIF ne sont pas disponibles pour le moment.",
    gifFehler: "Le GIF n'a pas pu être envoyé.",
    linkTitel: "Partager le lien",
    linkWelcher: "Dans quel chat ?",
    linkKeinChat: "Tu n'as pas encore de chat. Commence d'abord un chat et invite ta personne.",
    dolmetscher: "🎙\nInterprète",
    fotoKnopf: "📷\nTraduire une photo",
    dolmInfo: "Posez le téléphone entre vous. Chacun touche son micro et parle dans sa langue.",
    tippenSprechen: "Touche et parle",
    hoere: "J'écoute …",
    andereSprache: "Autre langue",
    fotoInfo: "Photographie un menu, une lettre ou un panneau – Diralo lit le texte et le traduit.",
    erklaeren: "Expliquer simplement",
    erklaerung: "Explication",
    originalText: "Texte original",
    keinText: "Aucun texte trouvé sur la photo.",
    fotoLesen: "Lecture de la photo …",
    zurueck: "Retour",
    hilfeFehler: "Ça n'a pas marché. Réessaie.",
    vorschau: "Ce sera reçu ainsi :",
    vorschauAus: "Désactiver l'aperçu",
    vorlesen: "🔊 Écouter",
    langsam: "🐢 Original lentement",
    aussprache: "🗣 Prononciation",
    ausspracheFehler: "Aide à la prononciation indisponible pour le moment.",
    claim: "Discute dans n'importe quelle langue. Chaque message est traduit automatiquement.",
    deinName: "Ton prénom",
    nameBsp: "p. ex. Marie",
    deineSprache: "Ta langue",
    neuerChat: "Nouveau chat",
    oderBeitreten: "ou rejoindre un chat",
    chatCode: "Code du chat",
    beitreten: "Rejoindre",
    meineChats: "Mes chats",
    datenschutz: "Pour la traduction, chaque message est envoyé à un serveur et y est lisible — contrairement à WhatsApp. N'écris rien que personne d'autre ne doit voir. Tout est supprimé après 30 jours.",
    ausListe: "retirer de la liste ?",
    abbrechen: "Annuler",
    entfernen: "Retirer",
    nochKeine: "Aucun utilisé pour l'instant.",
    kontingent: "Vos {n} traductions gratuites de ce mois sont épuisées. Les messages arrivent toujours, dans la langue d'origine. Avec Diralo Plus, vous en avez 1 500 par mois.",
    kontingentPlus: "Vos {n} traductions Diralo Plus de ce mois sont épuisées. Les messages arrivent toujours, dans la langue d'origine. Elles reviennent le 1er – ou passez à Diralo Family.",
    kontingentFamilie: "Vos {n} traductions Diralo Family de ce mois sont épuisées. Les messages arrivent toujours, dans la langue d'origine. Elles reviennent le 1er.",
    uebersFehler: "Traduction impossible pour le moment. Le message s'affiche en original.",
    zuVieleJoins: "Trop de tentatives. Patiente un instant.",
    langsamer: "Plus doucement - trop de messages en peu de temps.",
    fremdGeraet: "Ce message a été écrit sur un autre appareil et ne peut pas être supprimé ici.",
    loeschenFehler: "Suppression impossible pour le moment. Réessaie plus tard.",
    spracheLang: "Le message vocal est trop long.",
    spracheFehler: "Le message vocal n'a pas pu être envoyé.",
    einladung: "Discute avec moi sur Diralo — chacun dans sa langue :",
    fuerAlleFrage: "Supprimer pour tous ?",
    verschwindet: "Le message disparaît aussi chez l'autre personne.",
    loeschen: "Supprimer",
    ohneKamera: "Impossible sans autorisation de la caméra.",
    ohneFotos: "Impossible sans accès aux photos.",
    fotoGross: "La photo est trop grande.",
    fotoFehler: "La photo n'a pas pu être envoyée.",
    ohneStandort: "Impossible sans autorisation de localisation.",
    standortFehler: "Impossible de déterminer la position.",
    senden: "Envoyer",
    galerie: "Photo de la galerie",
    kamera: "Appareil photo",
    standort: "Position",
    einladen: "Inviter",
    verbunden: "connecté",
    verbinde: "connexion ...",
    du: "toi",
    Du: "Toi",
    leer: "Pas encore de messages. Écris le premier - il sera traduit automatiquement.",
    antworten: "↩ Répondre",
    fuerAlle: "🗑 Supprimer pour tous",
    schreiben: "Message",
    geloescht: "Message supprimé",
    kartenTipp: "Touche pour ouvrir la carte",
    nichtMehrDa: "Message introuvable",
    sprachnachricht: "Message vocal",
    foto: "Photo",
    aufnahmeFehler: "Enregistrement impossible : ",
    ohneMikro: "Impossible sans autorisation du micro.",
    android13: "Les messages vocaux nécessitent Android 13 ou plus récent.",
    kanal: "Messages",
    aboTitel: "Plus de traductions",
    aboText: "Paiement via Google Play. Résiliable à tout moment dans le Play Store.",
    aboStand: "Ce chat : {b} sur {g} traductions ce mois-ci.",
    aboAktiv: "Ce chat a Diralo {p}.",
    plusName: "Plus",
    plusText: "1 500 traductions par mois, jusqu'à 3 chats",
    familieName: "Family",
    familieText: "5 000 traductions par mois, jusqu'à 10 chats",
    monat: "par mois",
    jahr: "par an",
    aboNichtDa: "Les abonnements ne sont pas disponibles pour le moment. Réessaie plus tard.",
    aboDanke: "Merci ! Ce chat est maintenant débloqué.",
    aboWartet: "Le paiement est en cours de confirmation. Cela peut prendre quelques minutes.",
    aboFehler: "L'achat n'a pas pu être finalisé.",
    schliessen: "Fermer",
    heute: "Aujourd'hui",
    gestern: "Hier",
    ausblenden: "touche pour fermer",
  },
  it: {
    videoAufnehmen: "Registra video",
    videoVorbereiten: "Preparazione del video …",
    bonusHinweis: "🎁 Quando anche la tua persona scrive, ricevete entrambi 1 mese di Diralo Plus gratis.",
    bonusDa: "🎁 Fatto! Avete ricevuto 1 mese di Diralo Plus gratis per questa chat.",
    anrufMinutenLeer: "I minuti di sottotitoli dal vivo di questo mese sono esauriti. La chiamata continua senza sottotitoli: con Diralo Plus ne hai di più.",
    anrufMinutenRest: "Sottotitoli dal vivo: ancora {n} min questo mese.",
    anrufen: "Chiama",
    anrufSprache: "📞 Chiamata vocale",
    anrufVideo: "🎥 Videochiamata",
    anrufKommt: "ti sta chiamando …",
    anrufVideoKommt: "Videochiamata …",
    anrufUntertitelHinweis: "Con sottotitoli dal vivo: leggi nella tua lingua ciò che viene detto.",
    anrufFehler: "La chiamata non è riuscita.",
    anrufWartet: "In attesa di risposta …",
    anrufKlingelt: "squilla …",
    anrufVorbei: "Chiamata terminata",
    anrufAbgelehnt: "non ha risposto",
    updTitel: "Nuova versione disponibile",
    updText: "Diralo è stato migliorato. Tocca «Aggiorna»: ci vuole solo un attimo.",
    updKnopf: "Aggiorna",
    updSpaeter: "Più tardi",
    updPflicht: "Questo aggiornamento è necessario perché Diralo continui a funzionare.",
    autoAn: "I nuovi messaggi verranno letti ad alta voce.",
    autoAus: "La lettura automatica è disattivata.",
    keineStimme: "Nessuna voce installata per questa lingua. Impostazioni Android → Sintesi vocale → installa dati vocali.",
    imChat: "in chat",
    einlTitel: "Hai ricevuto un invito?",
    einlText: "Inserisci il codice chat che trovi nel link ed entri nella stessa chat dell'altra persona.",
    neuTitel: "Vuoi invitare qualcuno?",
    neuText: "Così si crea una chat nuova e vuota. Poi mandi il link alla tua persona.",
    leerTitel: "Questa chat è nuova",
    leerText2: "Non c'è ancora nessuno. Manda il link alla tua persona perché possa entrare.",
    falschHier: "Hai ricevuto tu un invito? Allora sei nel posto sbagliato.",
    codeEingeben: "Torna indietro e inserisci il codice",
    umbenennen: "Nome di questa chat",
    chatNameBsp: "es. Maria 💕",
    lernenTitel: "Impara",
    lernenMerken: "⭐ Salva per imparare",
    lernenGemerkt: "Salvato – lo trovi sotto 🎓",
    lernenSchon: "Hai già salvato questa frase.",
    lernenNichtMoeglich: "Non c'è ancora una traduzione per questa frase.",
    lernenKeinPartner: "Appena qualcuno scrive in un'altra lingua, qui puoi imparare la sua lingua – con le vostre frasi.",
    lernenGelernt: "{n} frasi imparate",
    lernenSerie: "{n} giorni di fila",
    lernenWie: "Come si dice in {lang}?",
    lernenAufdecken: "Mostra",
    lernenWusste: "Lo sapevo",
    lernenNochmal: "Ancora",
    lernenFertig: "Tutto fatto per oggi! A domani.",
    lernenLeer: "Ancora nessuna scheda. Tocca un suggerimento qui sotto o tieni premuto un messaggio → «Salva per imparare».",
    lernenVorschlaege: "Suggerimenti dalla vostra chat",
    lernenGratis: "Oggi ancora {n} schede gratis",
    lernenPlus: "Fatto per oggi! Impara senza limiti con un abbonamento Diralo.",
    lernenPlusKnopf: "Vedi i piani",
    lernenKarten: "{n} schede salvate",
    lernenPakete: "Pacchetti iniziali",
    lernenPaketPaar: "Coppia e famiglia",
    lernenPaketArbeit: "Lavoro (cantiere, campi, serra)",
    lernenPaketAlltag: "Vita quotidiana, medico e uffici",
    lernenPaketDazu: "{n} schede aggiunte",
    lernenPaketLaedt: "Preparazione …",
    lernenTaeglich: "Frase del giorno alle 9",
    lernenAusblenden: "Nascondi impara",
    lernenAusgeblendet: "Impara è nascosto. Per riattivarlo: 👥 in alto nella chat.",
    lernenEinblenden: "Mostra di nuovo impara",
    lernenEingeblendet: "Impara è tornato",
    gruppeErstellen: "Crea un gruppo per il mio team",
    gruppeTipp: "Invita il tuo team con il link: ognuno scrive e legge nella sua lingua.",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 Fissa per tutti",
    losloesen: "Non fissare più",
    durchsage: "📌 Avviso",
    nurTeamPlus: "Gli avvisi fissati sono inclusi in Diralo Team Plus.",
    teamName: "Diralo Team",
    teamText: "Per aziende: fino a 20 persone, 3 gruppi, 5.000 traduzioni al mese",
    teamplusName: "Diralo Team Plus",
    teamplusText: "Per aziende più grandi: fino a 60 persone, 10 gruppi, 12.000 traduzioni al mese",
    teamFreischalten: "🏢 Attiva per l’azienda",
    teamVoll: "Questo gruppo è pieno: l’abbonamento Team non ha più posti. Avvisa l’amministratore.",
    kontingentTeam: "Le {n} traduzioni del vostro abbonamento Team sono finite per questo mese. I messaggi arrivano comunque, ma senza traduzione.",
    gruppe: "Gruppo",
    gruppeName: "Nome del gruppo",
    gruppeNameBsp: "es. Estufa Silva – Squadra",
    gruppeChef: "👑 Admin",
    gruppeDuChef: "Gestisci tu questo gruppo.",
    gruppeNurChef: "Solo chi gestisce il gruppo può modificarlo.",
    gruppeMitglieder: "{n} membri",
    gruppeEntfernen: "Rimuovi",
    gruppeEntfernenFrage: "Rimuovere {name} dal gruppo? Non potrà più aprire la chat.",
    gruppeEntferntDu: "Sei stato rimosso da questo gruppo.",
    gruppeOnline: "online",
    gruppeZuletzt: "ultimo accesso",
    gruppeGelesen: "Letto da",
    gruppeUngelesen: "Non ancora letto",
    gruppeHinweis: "Dai un nome alla chat: diventa un gruppo con elenco dei membri e «Letto da». Chi la nomina per primo gestisce il gruppo.",
    speichern: "Salva",
    fuerMich: "🙈 Elimina per me",
    geteiltTitel: "Condiviso – tradotto",
    geteiltLaedt: "Traduzione …",
    dateiTitel: "Condividi file",
    video: "Video",
    datei: "File",
    dateiGross: "Il file è troppo grande (max. 25 MB).",
    dateiFehler: "Impossibile inviare il file.",
    dateiOeffnen: "Tocca per aprire",
    abbrechen2: "Annulla",
    dateiKeinChat: "Non hai ancora una chat. Inizia una chat e invita la tua persona.",
    gifSuchen: "Cerca GIF",
    gifAus: "Le GIF non sono disponibili al momento.",
    gifFehler: "Impossibile inviare la GIF.",
    linkTitel: "Condividi link",
    linkWelcher: "In quale chat?",
    linkKeinChat: "Non hai ancora nessuna chat. Inizia prima una chat e invita la tua persona.",
    dolmetscher: "🎙\nInterprete",
    fotoKnopf: "📷\nTraduci foto",
    dolmInfo: "Mettete il telefono tra voi. Ognuno tocca il suo microfono e parla nella sua lingua.",
    tippenSprechen: "Tocca e parla",
    hoere: "Sto ascoltando …",
    andereSprache: "Altra lingua",
    fotoInfo: "Fotografa un menù, una lettera o un cartello – Diralo legge il testo e lo traduce.",
    erklaeren: "Spiega in modo semplice",
    erklaerung: "Spiegazione",
    originalText: "Testo originale",
    keinText: "Nessun testo trovato nella foto.",
    fotoLesen: "Leggo la foto …",
    zurueck: "Indietro",
    hilfeFehler: "Non ha funzionato. Riprova.",
    vorschau: "Arriverà così:",
    vorschauAus: "Disattiva anteprima",
    vorlesen: "🔊 Ascolta",
    langsam: "🐢 Originale lentamente",
    aussprache: "🗣 Pronuncia",
    ausspracheFehler: "Aiuto pronuncia non disponibile ora.",
    claim: "Chatta in qualsiasi lingua. Ogni messaggio viene tradotto automaticamente.",
    deinName: "Il tuo nome",
    nameBsp: "es. Maria",
    deineSprache: "La tua lingua",
    neuerChat: "Nuova chat",
    oderBeitreten: "o entra in una chat",
    chatCode: "Codice chat",
    beitreten: "Entra",
    meineChats: "Le mie chat",
    datenschutz: "Per tradurre, ogni messaggio viene inviato a un server ed è leggibile lì — a differenza di WhatsApp. Non scrivere nulla che nessun altro debba vedere. Dopo 30 giorni tutto viene cancellato.",
    ausListe: "togliere dalla lista?",
    abbrechen: "Annulla",
    entfernen: "Rimuovi",
    nochKeine: "Nessuno usato finora.",
    kontingent: "Le {n} traduzioni gratuite di questo mese sono esaurite. I messaggi arrivano ancora, in originale. Con Diralo Plus ne hai 1.500 al mese.",
    kontingentPlus: "Le {n} traduzioni di Diralo Plus di questo mese sono esaurite. I messaggi arrivano ancora, in originale. Si rinnovano il giorno 1, oppure passa a Diralo Family.",
    kontingentFamilie: "Le {n} traduzioni di Diralo Family di questo mese sono esaurite. I messaggi arrivano ancora, in originale. Si rinnovano il giorno 1.",
    uebersFehler: "Traduzione non disponibile ora. Il messaggio è mostrato in originale.",
    zuVieleJoins: "Troppi tentativi di accesso. Attendi un momento.",
    langsamer: "Più piano - troppi messaggi in poco tempo.",
    fremdGeraet: "Questo messaggio è stato scritto su un altro dispositivo e non si può cancellare qui.",
    loeschenFehler: "Impossibile cancellare ora. Riprova più tardi.",
    spracheLang: "Il messaggio vocale è troppo lungo.",
    spracheFehler: "Impossibile inviare il messaggio vocale.",
    einladung: "Scrivimi su Diralo — ognuno nella sua lingua:",
    fuerAlleFrage: "Eliminare per tutti?",
    verschwindet: "Il messaggio sparisce anche per l'altra persona.",
    loeschen: "Elimina",
    ohneKamera: "Non possibile senza permesso della fotocamera.",
    ohneFotos: "Non possibile senza accesso alle foto.",
    fotoGross: "La foto è troppo grande.",
    fotoFehler: "Impossibile inviare la foto.",
    ohneStandort: "Non possibile senza permesso di posizione.",
    standortFehler: "Impossibile determinare la posizione.",
    senden: "Invia",
    galerie: "Foto dalla galleria",
    kamera: "Fotocamera",
    standort: "Posizione",
    einladen: "Invita",
    verbunden: "connesso",
    verbinde: "connessione ...",
    du: "tu",
    Du: "Tu",
    leer: "Ancora nessun messaggio. Scrivi il primo - viene tradotto automaticamente.",
    antworten: "↩ Rispondi",
    fuerAlle: "🗑 Elimina per tutti",
    schreiben: "Messaggio",
    geloescht: "Messaggio eliminato",
    kartenTipp: "Tocca per aprire la mappa",
    nichtMehrDa: "Messaggio non più disponibile",
    sprachnachricht: "Messaggio vocale",
    foto: "Foto",
    aufnahmeFehler: "Registrazione non possibile: ",
    ohneMikro: "Non possibile senza permesso del microfono.",
    android13: "I messaggi vocali richiedono Android 13 o successivo.",
    kanal: "Messaggi",
    aboTitel: "Più traduzioni",
    aboText: "Il pagamento avviene tramite Google Play. Puoi disdire quando vuoi nel Play Store.",
    aboStand: "Questa chat: {b} di {g} traduzioni questo mese.",
    aboAktiv: "Questa chat ha Diralo {p}.",
    plusName: "Plus",
    plusText: "1.500 traduzioni al mese, fino a 3 chat",
    familieName: "Family",
    familieText: "5.000 traduzioni al mese, fino a 10 chat",
    monat: "al mese",
    jahr: "all'anno",
    aboNichtDa: "Gli abbonamenti non sono disponibili ora. Riprova più tardi.",
    aboDanke: "Grazie! Questa chat è ora sbloccata.",
    aboWartet: "Il pagamento è in fase di conferma. Può richiedere qualche minuto.",
    aboFehler: "Impossibile completare l'acquisto.",
    schliessen: "Chiudi",
    heute: "Oggi",
    gestern: "Ieri",
    ausblenden: "tocca per chiudere",
  },
  ja: {
    videoAufnehmen: "動画を撮影",
    videoVorbereiten: "動画を準備中…",
    bonusHinweis: "🎁 相手からもメッセージが届くと、2人ともDiralo Plusが1か月無料になります。",
    bonusDa: "🎁 完了！このチャットで2人ともDiralo Plusが1か月無料になりました。",
    anrufMinutenLeer: "今月のライブ字幕の時間を使い切りました。通話は字幕なしで続きます。Diralo Plusならもっと使えます。",
    anrufMinutenRest: "ライブ字幕：今月の残り{n}分",
    anrufen: "通話",
    anrufSprache: "📞 音声通話",
    anrufVideo: "🎥 ビデオ通話",
    anrufKommt: "から着信中…",
    anrufVideoKommt: "ビデオ通話…",
    anrufUntertitelHinweis: "ライブ字幕付き：相手の話があなたの言語で表示されます。",
    anrufFehler: "通話につながりませんでした。",
    anrufWartet: "応答を待っています…",
    anrufKlingelt: "呼び出し中…",
    anrufVorbei: "通話終了",
    anrufAbgelehnt: "応答なし",
    updTitel: "新しいバージョンがあります",
    updText: "Diraloが改善されました。「アップデート」をタップしてください。すぐに終わります。",
    updKnopf: "アップデート",
    updSpaeter: "あとで",
    updPflicht: "Diraloを引き続き使うには、このアップデートが必要です。",
    autoAn: "新しいメッセージを読み上げます。",
    autoAus: "自動読み上げはオフです。",
    keineStimme: "この言語の音声がインストールされていません。Androidの設定 → テキスト読み上げ → 音声データをインストールしてください。",
    imChat: "チャット内",
    einlTitel: "招待されましたか？",
    einlText: "リンクにあるチャットコードを入力すると、相手と同じチャットに参加できます。",
    neuTitel: "誰かを招待しますか？",
    neuText: "新しい空のチャットを作成します。そのあと相手にリンクを送ってください。",
    leerTitel: "新しいチャットです",
    leerText2: "まだ誰もいません。相手にリンクを送って参加してもらいましょう。",
    falschHier: "あなたが招待された側ですか？ それならここではありません。",
    codeEingeben: "戻ってコードを入力",
    umbenennen: "チャット名",
    chatNameBsp: "例：マリア 💕",
    lernenTitel: "学ぶ",
    lernenMerken: "⭐ 学習用に保存",
    lernenGemerkt: "保存しました – 🎓 から見られます",
    lernenSchon: "この文はもう保存済みです。",
    lernenNichtMoeglich: "この文にはまだ翻訳がありません。",
    lernenKeinPartner: "相手が別の言語で書くと、ここで二人の実際の文を使って相手の言語を学べます。",
    lernenGelernt: "{n} 文を覚えました",
    lernenSerie: "{n} 日連続",
    lernenWie: "{lang}で何と言う？",
    lernenAufdecken: "答えを見る",
    lernenWusste: "わかった",
    lernenNochmal: "もう一度",
    lernenFertig: "今日の分は完了！また明日。",
    lernenLeer: "カードはまだありません。下の候補をタップするか、メッセージを長押し →「学習用に保存」。",
    lernenVorschlaege: "チャットからのおすすめ",
    lernenGratis: "今日の無料カード：あと {n} 枚",
    lernenPlus: "今日の分は完了！Diralo のプランなら無制限に学べます。",
    lernenPlusKnopf: "プランを見る",
    lernenKarten: "保存したカード {n} 枚",
    lernenPakete: "スターターパック",
    lernenPaketPaar: "カップル・家族",
    lernenPaketArbeit: "仕事（建設・畑・温室）",
    lernenPaketAlltag: "日常・病院・役所",
    lernenPaketDazu: "{n} 枚のカードを追加しました",
    lernenPaketLaedt: "準備中…",
    lernenTaeglich: "毎朝9時にひとこと",
    lernenAusblenden: "学習を非表示",
    lernenAusgeblendet: "学習を非表示にしました。戻すには：チャット上部の 👥",
    lernenEinblenden: "学習を再表示",
    lernenEingeblendet: "学習が戻りました",
    gruppeErstellen: "チーム用のグループを作成",
    gruppeTipp: "リンクでチームを招待 — それぞれ自分の言語で書いて読めます。",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 全員に固定",
    losloesen: "固定を解除",
    durchsage: "📌 お知らせ",
    nurTeamPlus: "固定のお知らせは Diralo Team Plus で使えます。",
    teamName: "Diralo Team",
    teamText: "事業者向け：最大20人、3グループ、月5,000回の翻訳",
    teamplusName: "Diralo Team Plus",
    teamplusText: "大きな事業者向け：最大60人、10グループ、月12,000回の翻訳",
    teamFreischalten: "🏢 事業用に有効にする",
    teamVoll: "このグループは満員です。Teamプランに空きがありません。管理者に知らせてください。",
    kontingentTeam: "Teamプランの今月の翻訳{n}回を使い切りました。メッセージは届きますが、翻訳されません。",
    gruppe: "グループ",
    gruppeName: "グループ名",
    gruppeNameBsp: "例：Estufa Silva チーム",
    gruppeChef: "👑 管理者",
    gruppeDuChef: "あなたがこのグループの管理者です。",
    gruppeNurChef: "グループの管理者だけが変更できます。",
    gruppeMitglieder: "メンバー {n} 人",
    gruppeEntfernen: "削除",
    gruppeEntfernenFrage: "{name} さんをグループから削除しますか？このチャットを開けなくなります。",
    gruppeEntferntDu: "このグループから削除されました。",
    gruppeOnline: "オンライン",
    gruppeZuletzt: "最終",
    gruppeGelesen: "既読",
    gruppeUngelesen: "未読",
    gruppeHinweis: "チャットに名前を付けると、メンバー一覧と既読表示のあるグループになります。最初に名前を付けた人が管理者になります。",
    speichern: "保存",
    fuerMich: "🙈 自分だけ削除",
    geteiltTitel: "共有 – 翻訳済み",
    geteiltLaedt: "翻訳中…",
    dateiTitel: "ファイルを共有",
    video: "動画",
    datei: "ファイル",
    dateiGross: "ファイルが大きすぎます（最大25MB）。",
    dateiFehler: "ファイルを送信できませんでした。",
    dateiOeffnen: "タップして開く",
    abbrechen2: "キャンセル",
    dateiKeinChat: "まだチャットがありません。チャットを始めて相手を招待してください。",
    gifSuchen: "GIFを検索",
    gifAus: "現在GIFは利用できません。",
    gifFehler: "GIFを送信できませんでした。",
    linkTitel: "リンクを共有",
    linkWelcher: "どのチャット？",
    linkKeinChat: "まだチャットがありません。チャットを始めて相手を招待してください。",
    dolmetscher: "🎙\n通訳",
    fotoKnopf: "📷\n写真を翻訳",
    dolmInfo: "スマホを2人の間に置いてください。それぞれマイクをタップして自分の言語で話します。",
    tippenSprechen: "タップして話す",
    hoere: "聞き取り中…",
    andereSprache: "相手の言語",
    fotoInfo: "メニューや手紙、看板を撮影すると、Diraloが文字を読み取って翻訳します。",
    erklaeren: "やさしく説明",
    erklaerung: "説明",
    originalText: "原文",
    keinText: "写真から文字が見つかりませんでした。",
    fotoLesen: "写真を読み取り中…",
    zurueck: "戻る",
    hilfeFehler: "うまくいきませんでした。もう一度お試しください。",
    vorschau: "相手にはこう届きます：",
    vorschauAus: "プレビューオフ",
    vorlesen: "🔊 読み上げ",
    langsam: "🐢 原文をゆっくり",
    aussprache: "🗣 発音",
    ausspracheFehler: "現在、発音ヘルプは利用できません。",
    claim: "どんな言語でもチャット。メッセージはすべて自動で翻訳されます。",
    deinName: "あなたの名前",
    nameBsp: "例：マリア",
    deineSprache: "あなたの言語",
    neuerChat: "新しいチャットを開始",
    oderBeitreten: "またはチャットに参加",
    chatCode: "チャットコード",
    beitreten: "参加",
    meineChats: "マイチャット",
    datenschutz: "翻訳のため、メッセージはすべてサーバーに送信され、そこで読める状態になります（WhatsAppとは異なります）。他人に見られたくない内容は書かないでください。すべて30日後に削除されます。",
    ausListe: "をリストから削除しますか？",
    abbrechen: "キャンセル",
    entfernen: "削除",
    nochKeine: "まだ使用していません。",
    kontingent: "今月の無料翻訳{n}回を使い切りました。メッセージは原文のまま届きます。Diralo Plusなら月1,500回使えます。",
    kontingentPlus: "今月のDiralo Plus翻訳{n}回を使い切りました。メッセージは原文のまま届きます。毎月1日にリセットされます。Diralo Familyへの変更も可能です。",
    kontingentFamilie: "今月のDiralo Family翻訳{n}回を使い切りました。メッセージは原文のまま届きます。毎月1日にリセットされます。",
    uebersFehler: "現在翻訳できません。メッセージは原文で表示されます。",
    zuVieleJoins: "参加の試行が多すぎます。しばらくお待ちください。",
    langsamer: "短時間にメッセージが多すぎます。少し待ってください。",
    fremdGeraet: "このメッセージは別の端末で書かれたため、ここでは削除できません。",
    loeschenFehler: "現在削除できません。あとでもう一度お試しください。",
    spracheLang: "ボイスメッセージが長すぎます。",
    spracheFehler: "ボイスメッセージを送信できませんでした。",
    einladung: "Diraloでチャットしよう。それぞれ自分の言語で話せます：",
    fuerAlleFrage: "全員から削除しますか？",
    verschwindet: "相手の画面からもメッセージが消えます。",
    loeschen: "削除",
    ohneKamera: "カメラへのアクセスを許可してください。",
    ohneFotos: "写真へのアクセスを許可してください。",
    fotoGross: "写真が大きすぎます。",
    fotoFehler: "写真を送信できませんでした。",
    ohneStandort: "位置情報へのアクセスを許可してください。",
    standortFehler: "位置情報を取得できませんでした。",
    senden: "送信",
    galerie: "ギャラリーから選択",
    kamera: "カメラ",
    standort: "位置情報",
    einladen: "招待",
    verbunden: "接続済み",
    verbinde: "接続中...",
    du: "あなた",
    Du: "あなた",
    leer: "まだメッセージはありません。最初のメッセージを送りましょう。自動で翻訳されます。",
    antworten: "↩ 返信",
    fuerAlle: "🗑 全員から削除",
    schreiben: "メッセージ",
    geloescht: "メッセージを削除しました",
    kartenTipp: "タップして地図で開く",
    nichtMehrDa: "このメッセージは表示できません",
    sprachnachricht: "ボイスメッセージ",
    foto: "写真",
    aufnahmeFehler: "録音できません：",
    ohneMikro: "マイクへのアクセスを許可してください。",
    android13: "ボイスメッセージにはAndroid 13以降が必要です。",
    kanal: "メッセージ",
    aboTitel: "翻訳をもっと使う",
    aboText: "Google Playで請求されます。Playストアでいつでも解約できます。",
    aboStand: "このチャット：今月の翻訳 {b}/{g}回",
    aboAktiv: "このチャットはDiralo {p}です。",
    plusName: "Plus",
    plusText: "月1,500回の翻訳、最大3チャット",
    familieName: "Family",
    familieText: "月5,000回の翻訳、最大10チャット",
    monat: "月額",
    jahr: "年額",
    aboNichtDa: "現在サブスクリプションは利用できません。あとでもう一度お試しください。",
    aboDanke: "ありがとうございます！このチャットが有効になりました。",
    aboWartet: "支払いを確認中です。数分かかる場合があります。",
    aboFehler: "購入を完了できませんでした。",
    schliessen: "閉じる",
    heute: "今日",
    gestern: "昨日",
    ausblenden: "タップして閉じる",
  },
  hi: {
    videoAufnehmen: "वीडियो रिकॉर्ड करें",
    videoVorbereiten: "वीडियो तैयार हो रहा है …",
    bonusHinweis: "🎁 जैसे ही आपका साथी भी लिखेगा, आप दोनों को 1 महीने का Diralo Plus मुफ़्त मिलेगा।",
    bonusDa: "🎁 हो गया! इस चैट के लिए आप दोनों को 1 महीने का Diralo Plus मुफ़्त मिला।",
    anrufMinutenLeer: "इस महीने के लाइव सबटाइटल मिनट खत्म हो गए। कॉल बिना सबटाइटल के जारी रहेगी – Diralo Plus में ज़्यादा मिनट मिलते हैं।",
    anrufMinutenRest: "लाइव सबटाइटल: इस महीने {n} मिनट बाकी।",
    anrufen: "कॉल करें",
    anrufSprache: "📞 वॉइस कॉल",
    anrufVideo: "🎥 वीडियो कॉल",
    anrufKommt: "कॉल कर रहे हैं …",
    anrufVideoKommt: "वीडियो कॉल …",
    anrufUntertitelHinweis: "लाइव सबटाइटल के साथ: जो बोला जाए, वह आप अपनी भाषा में पढ़ें।",
    anrufFehler: "अभी कॉल नहीं लग पाई।",
    anrufWartet: "जवाब का इंतज़ार …",
    anrufKlingelt: "घंटी बज रही है …",
    anrufVorbei: "कॉल खत्म",
    anrufAbgelehnt: "जवाब नहीं दिया",
    updTitel: "नया वर्शन उपलब्ध है",
    updText: "Diralo को बेहतर बनाया गया है। “अपडेट करें” पर टैप करें – बस एक पल लगेगा।",
    updKnopf: "अपडेट करें",
    updSpaeter: "बाद में",
    updPflicht: "Diralo चलता रहे, इसके लिए यह अपडेट ज़रूरी है।",
    autoAn: "नए मैसेज अब पढ़कर सुनाए जाएँगे।",
    autoAus: "अपने-आप पढ़कर सुनाना बंद है।",
    keineStimme: "इस भाषा के लिए कोई आवाज़ इंस्टॉल नहीं है। Android सेटिंग → टेक्स्ट-टू-स्पीच आउटपुट → वॉइस डेटा इंस्टॉल करें।",
    imChat: "चैट में",
    einlTitel: "क्या आपको न्योता मिला है?",
    einlText: "लिंक से चैट कोड डालें, आप अपने साथी वाली चैट में पहुँच जाएँगे।",
    neuTitel: "किसी को बुलाना है?",
    neuText: "इससे एक नई, खाली चैट शुरू होगी। फिर अपने साथी को लिंक भेजें।",
    leerTitel: "यह चैट नई है",
    leerText2: "अभी यहाँ कोई नहीं है। अपने साथी को लिंक भेजें ताकि वे जुड़ सकें।",
    falschHier: "क्या आपको खुद न्योता मिला है? तो आप गलत जगह पर हैं।",
    codeEingeben: "वापस जाएँ और कोड डालें",
    umbenennen: "इस चैट का नाम",
    chatNameBsp: "जैसे मारिया 💕",
    lernenTitel: "सीखें",
    lernenMerken: "⭐ सीखने के लिए सहेजें",
    lernenGemerkt: "सहेज लिया – 🎓 में मिलेगा",
    lernenSchon: "यह वाक्य पहले से सहेजा हुआ है।",
    lernenNichtMoeglich: "इस वाक्य का अभी अनुवाद नहीं है।",
    lernenKeinPartner: "जैसे ही कोई दूसरी भाषा में लिखेगा, आप यहाँ उसकी भाषा अपने ही वाक्यों से सीख सकते हैं।",
    lernenGelernt: "{n} वाक्य सीखे",
    lernenSerie: "लगातार {n} दिन",
    lernenWie: "{lang} में इसे क्या कहते हैं?",
    lernenAufdecken: "दिखाएँ",
    lernenWusste: "मुझे पता था",
    lernenNochmal: "फिर से",
    lernenFertig: "आज का पूरा हुआ! कल फिर मिलते हैं।",
    lernenLeer: "अभी कोई कार्ड नहीं। नीचे किसी सुझाव पर टैप करें या किसी संदेश को देर तक दबाएँ → “सीखने के लिए सहेजें”।",
    lernenVorschlaege: "आपकी चैट से सुझाव",
    lernenGratis: "आज {n} मुफ़्त कार्ड बाकी",
    lernenPlus: "आज का हो गया! Diralo सदस्यता से बिना सीमा सीखें।",
    lernenPlusKnopf: "प्लान देखें",
    lernenKarten: "{n} कार्ड सहेजे",
    lernenPakete: "शुरुआती पैक",
    lernenPaketPaar: "जोड़ा और परिवार",
    lernenPaketArbeit: "काम (निर्माण, खेत, ग्रीनहाउस)",
    lernenPaketAlltag: "रोज़मर्रा, डॉक्टर और दफ़्तर",
    lernenPaketDazu: "{n} कार्ड जोड़े गए",
    lernenPaketLaedt: "तैयार हो रहा है …",
    lernenTaeglich: "रोज़ सुबह 9 बजे एक वाक्य",
    lernenAusblenden: "सीखना छिपाएँ",
    lernenAusgeblendet: "सीखना छिपा दिया गया। फिर से चालू करें: चैट में ऊपर 👥।",
    lernenEinblenden: "सीखना फिर दिखाएँ",
    lernenEingeblendet: "सीखना वापस आ गया",
    gruppeErstellen: "अपनी टीम के लिए ग्रुप बनाएँ",
    gruppeTipp: "लिंक से अपनी टीम को बुलाएँ – हर कोई अपनी भाषा में लिखता और पढ़ता है।",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 सबके लिए पिन करें",
    losloesen: "पिन हटाएँ",
    durchsage: "📌 घोषणा",
    nurTeamPlus: "पिन की गई घोषणाएँ Diralo Team Plus में मिलती हैं।",
    teamName: "Diralo Team",
    teamText: "व्यवसायों के लिए: 20 लोग तक, 3 समूह, हर महीने 5,000 अनुवाद",
    teamplusName: "Diralo Team Plus",
    teamplusText: "बड़े व्यवसायों के लिए: 60 लोग तक, 10 समूह, हर महीने 12,000 अनुवाद",
    teamFreischalten: "🏢 व्यवसाय के लिए चालू करें",
    teamVoll: "यह समूह भर गया है – Team प्लान में कोई जगह नहीं बची। एडमिन को बताएँ।",
    kontingentTeam: "आपके Team प्लान के इस महीने के {n} अनुवाद ख़त्म हो गए हैं। संदेश आते रहेंगे, बस अनुवाद नहीं होंगे।",
    gruppe: "समूह",
    gruppeName: "समूह का नाम",
    gruppeNameBsp: "जैसे Estufa Silva – टीम",
    gruppeChef: "👑 एडमिन",
    gruppeDuChef: "आप इस समूह के एडमिन हैं।",
    gruppeNurChef: "सिर्फ़ समूह का एडमिन इसे बदल सकता है।",
    gruppeMitglieder: "{n} सदस्य",
    gruppeEntfernen: "हटाएँ",
    gruppeEntfernenFrage: "{name} को समूह से हटाएँ? वे यह चैट फिर नहीं खोल पाएँगे।",
    gruppeEntferntDu: "आपको इस समूह से हटा दिया गया है।",
    gruppeOnline: "ऑनलाइन",
    gruppeZuletzt: "आख़िरी बार",
    gruppeGelesen: "इन्होंने पढ़ा",
    gruppeUngelesen: "अभी नहीं पढ़ा",
    gruppeHinweis: "चैट को नाम दें – यह सदस्य सूची और “किसने पढ़ा” वाला समूह बन जाएगा। जो पहले नाम देता है, वही समूह का एडमिन होता है।",
    speichern: "सेव करें",
    fuerMich: "🙈 मेरे लिए डिलीट करें",
    geteiltTitel: "शेयर किया गया – अनुवादित",
    geteiltLaedt: "अनुवाद हो रहा है …",
    dateiTitel: "फ़ाइल शेयर करें",
    video: "वीडियो",
    datei: "फ़ाइल",
    dateiGross: "फ़ाइल बहुत बड़ी है (अधिकतम 25 MB)।",
    dateiFehler: "फ़ाइल नहीं भेजी जा सकी।",
    dateiOeffnen: "खोलने के लिए टैप करें",
    abbrechen2: "रद्द करें",
    dateiKeinChat: "आपकी अभी कोई चैट नहीं है। पहले चैट शुरू करें और अपने साथी को बुलाएँ।",
    gifSuchen: "GIF खोजें",
    gifAus: "अभी GIF उपलब्ध नहीं हैं।",
    gifFehler: "GIF नहीं भेजा जा सका।",
    linkTitel: "लिंक शेयर करें",
    linkWelcher: "कौन-सी चैट?",
    linkKeinChat: "आपकी अभी कोई चैट नहीं है। पहले चैट शुरू करें और अपने साथी को बुलाएँ।",
    dolmetscher: "🎙\nदुभाषिया",
    fotoKnopf: "📷\nफ़ोटो का अनुवाद",
    dolmInfo: "फ़ोन को अपने बीच रखें। हर व्यक्ति अपना माइक टैप करे और अपनी भाषा में बोले।",
    tippenSprechen: "टैप करें और बोलें",
    hoere: "सुन रहा है …",
    andereSprache: "दूसरी भाषा",
    fotoInfo: "मेन्यू, चिट्ठी या बोर्ड की फ़ोटो लें – Diralo टेक्स्ट पढ़कर उसका अनुवाद करेगा।",
    erklaeren: "आसान भाषा में समझाएँ",
    erklaerung: "समझाइश",
    originalText: "मूल टेक्स्ट",
    keinText: "फ़ोटो में कोई टेक्स्ट नहीं मिला।",
    fotoLesen: "फ़ोटो पढ़ रहा है …",
    zurueck: "वापस",
    hilfeFehler: "यह नहीं हो पाया। कृपया फिर से कोशिश करें।",
    vorschau: "ऐसे पहुँचेगा:",
    vorschauAus: "प्रीव्यू बंद",
    vorlesen: "🔊 पढ़कर सुनाएँ",
    langsam: "🐢 मूल धीरे-धीरे",
    aussprache: "🗣 उच्चारण",
    ausspracheFehler: "उच्चारण मदद अभी उपलब्ध नहीं है।",
    claim: "किसी भी भाषा में चैट करें। हर मैसेज का अपने-आप अनुवाद होता है।",
    deinName: "आपका नाम",
    nameBsp: "जैसे मारिया",
    deineSprache: "आपकी भाषा",
    neuerChat: "नई चैट शुरू करें",
    oderBeitreten: "या किसी चैट से जुड़ें",
    chatCode: "चैट कोड",
    beitreten: "जुड़ें",
    meineChats: "मेरी चैट",
    datenschutz: "अनुवाद के लिए हर मैसेज एक सर्वर पर भेजा जाता है और वहाँ पढ़ा जा सकता है — WhatsApp की तरह नहीं। ऐसा कुछ न लिखें जो किसी और को नहीं दिखना चाहिए। 30 दिन बाद सब कुछ डिलीट हो जाता है।",
    ausListe: "सूची से हटाएँ?",
    abbrechen: "रद्द करें",
    entfernen: "हटाएँ",
    nochKeine: "अभी तक कोई इस्तेमाल नहीं हुआ।",
    kontingent: "इस महीने के आपके {n} मुफ़्त अनुवाद खत्म हो गए। मैसेज अब भी मूल भाषा में आएँगे। Diralo Plus में हर महीने 1,500 मिलते हैं।",
    kontingentPlus: "इस महीने के आपके {n} Diralo Plus अनुवाद खत्म हो गए। मैसेज अब भी मूल भाषा में आएँगे। 1 तारीख को फिर से मिलेंगे – या Diralo Family पर जाएँ।",
    kontingentFamilie: "इस महीने के आपके {n} Diralo Family अनुवाद खत्म हो गए। मैसेज अब भी मूल भाषा में आएँगे। 1 तारीख को फिर से मिलेंगे।",
    uebersFehler: "अभी अनुवाद नहीं हो सकता। मैसेज मूल भाषा में दिखाया गया है।",
    zuVieleJoins: "जुड़ने की बहुत ज़्यादा कोशिशें। कृपया थोड़ा रुकें।",
    langsamer: "थोड़ा धीरे - कम समय में बहुत ज़्यादा मैसेज।",
    fremdGeraet: "यह मैसेज किसी दूसरे डिवाइस से लिखा गया था, इसे यहाँ डिलीट नहीं किया जा सकता।",
    loeschenFehler: "अभी डिलीट नहीं हो सकता। कृपया बाद में फिर कोशिश करें।",
    spracheLang: "वॉइस मैसेज बहुत लंबा है।",
    spracheFehler: "वॉइस मैसेज नहीं भेजा जा सका।",
    einladung: "Diralo पर मुझसे चैट करें — हर कोई अपनी भाषा में:",
    fuerAlleFrage: "सबके लिए डिलीट करें?",
    verschwindet: "मैसेज दूसरे व्यक्ति के लिए भी हट जाएगा।",
    loeschen: "डिलीट करें",
    ohneKamera: "कैमरा अनुमति के बिना संभव नहीं।",
    ohneFotos: "फ़ोटो की अनुमति के बिना संभव नहीं।",
    fotoGross: "फ़ोटो बहुत बड़ी है।",
    fotoFehler: "फ़ोटो नहीं भेजी जा सकी।",
    ohneStandort: "लोकेशन अनुमति के बिना संभव नहीं।",
    standortFehler: "लोकेशन पता नहीं चल सकी।",
    senden: "भेजें",
    galerie: "गैलरी से फ़ोटो",
    kamera: "कैमरा",
    standort: "लोकेशन",
    einladen: "बुलाएँ",
    verbunden: "कनेक्टेड",
    verbinde: "कनेक्ट हो रहा है ...",
    du: "आप",
    Du: "आप",
    leer: "अभी कोई मैसेज नहीं। पहला मैसेज लिखें - उसका अपने-आप अनुवाद होगा।",
    antworten: "↩ जवाब दें",
    fuerAlle: "🗑 सबके लिए डिलीट करें",
    schreiben: "मैसेज",
    geloescht: "मैसेज डिलीट किया गया",
    kartenTipp: "मैप में खोलने के लिए टैप करें",
    nichtMehrDa: "मैसेज अब उपलब्ध नहीं है",
    sprachnachricht: "वॉइस मैसेज",
    foto: "फ़ोटो",
    aufnahmeFehler: "रिकॉर्डिंग संभव नहीं: ",
    ohneMikro: "माइक्रोफ़ोन अनुमति के बिना संभव नहीं।",
    android13: "वॉइस मैसेज के लिए Android 13 या नया चाहिए।",
    kanal: "मैसेज",
    aboTitel: "ज़्यादा अनुवाद",
    aboText: "बिलिंग Google Play से। Play Store में कभी भी रद्द करें।",
    aboStand: "यह चैट: इस महीने {g} में से {b} अनुवाद।",
    aboAktiv: "इस चैट में Diralo {p} है।",
    plusName: "Plus",
    plusText: "हर महीने 1,500 अनुवाद, 3 चैट तक",
    familieName: "Family",
    familieText: "हर महीने 5,000 अनुवाद, 10 चैट तक",
    monat: "प्रति माह",
    jahr: "प्रति वर्ष",
    aboNichtDa: "सब्सक्रिप्शन अभी उपलब्ध नहीं हैं। कृपया बाद में फिर कोशिश करें।",
    aboDanke: "धन्यवाद! यह चैट अब अनलॉक हो गई है।",
    aboWartet: "पेमेंट की पुष्टि अभी हो रही है। इसमें कुछ मिनट लग सकते हैं।",
    aboFehler: "खरीदारी पूरी नहीं हो सकी।",
    schliessen: "बंद करें",
    heute: "आज",
    gestern: "कल",
    ausblenden: "हटाने के लिए टैप करें",
  },
  ur: {
    videoAufnehmen: "ویڈیو ریکارڈ کریں",
    videoVorbereiten: "ویڈیو تیار ہو رہی ہے …",
    bonusHinweis: "🎁 جیسے ہی آپ کا ساتھی بھی لکھے گا، آپ دونوں کو 1 مہینہ Diralo Plus مفت ملے گا۔",
    bonusDa: "🎁 ہو گیا! اس چیٹ کے لیے آپ دونوں کو 1 مہینہ Diralo Plus مفت مل گیا۔",
    anrufMinutenLeer: "اس مہینے کے لائیو سب ٹائٹل منٹ ختم ہو گئے ہیں۔ کال سب ٹائٹل کے بغیر جاری رہے گی – Diralo Plus میں زیادہ منٹ ملتے ہیں۔",
    anrufMinutenRest: "لائیو سب ٹائٹل: اس مہینے {n} منٹ باقی۔",
    anrufen: "کال",
    anrufSprache: "📞 وائس کال",
    anrufVideo: "🎥 ویڈیو کال",
    anrufKommt: "کال کر رہے ہیں …",
    anrufVideoKommt: "ویڈیو کال …",
    anrufUntertitelHinweis: "لائیو سب ٹائٹل کے ساتھ: جو کہا جائے، آپ اپنی زبان میں پڑھیں۔",
    anrufFehler: "ابھی کال نہیں ہو سکی۔",
    anrufWartet: "جواب کا انتظار …",
    anrufKlingelt: "گھنٹی بج رہی ہے …",
    anrufVorbei: "کال ختم",
    anrufAbgelehnt: "جواب نہیں دیا",
    updTitel: "نیا ورژن دستیاب ہے",
    updText: "Diralo کو بہتر بنایا گیا ہے۔ “اپ ڈیٹ” پر ٹیپ کریں – بس ایک لمحہ لگے گا۔",
    updKnopf: "اپ ڈیٹ",
    updSpaeter: "بعد میں",
    updPflicht: "Diralo کو چلتے رہنے کے لیے یہ اپ ڈیٹ ضروری ہے۔",
    autoAn: "اب نئے پیغامات بلند آواز میں پڑھے جائیں گے۔",
    autoAus: "خودکار بلند خوانی بند ہے۔",
    keineStimme: "اس زبان کی کوئی آواز انسٹال نہیں ہے۔ Android سیٹنگز ← ٹیکسٹ ٹو اسپیچ آؤٹ پٹ ← وائس ڈیٹا انسٹال کریں۔",
    imChat: "چیٹ میں",
    einlTitel: "کیا آپ کو دعوت ملی ہے؟",
    einlText: "لنک سے چیٹ کوڈ درج کریں اور آپ اپنے ساتھی والی چیٹ میں شامل ہو جائیں گے۔",
    neuTitel: "کسی کو دعوت دینا چاہتے ہیں؟",
    neuText: "اس سے ایک نئی، خالی چیٹ شروع ہوگی۔ پھر آپ اپنے ساتھی کو لنک بھیجیں۔",
    leerTitel: "یہ چیٹ نئی ہے",
    leerText2: "ابھی یہاں کوئی نہیں ہے۔ اپنے ساتھی کو لنک بھیجیں تاکہ وہ شامل ہو سکیں۔",
    falschHier: "کیا آپ کو خود دعوت ملی ہے؟ تو آپ غلط جگہ پر ہیں۔",
    codeEingeben: "واپس جائیں اور کوڈ درج کریں",
    umbenennen: "اس چیٹ کا نام",
    chatNameBsp: "مثلاً ماریہ 💕",
    lernenTitel: "سیکھیں",
    lernenMerken: "⭐ سیکھنے کے لیے محفوظ کریں",
    lernenGemerkt: "محفوظ ہو گیا – 🎓 میں ملے گا",
    lernenSchon: "یہ جملہ پہلے سے محفوظ ہے۔",
    lernenNichtMoeglich: "اس جملے کا ابھی ترجمہ نہیں ہے۔",
    lernenKeinPartner: "جیسے ہی کوئی دوسری زبان میں لکھے گا، آپ یہاں اس کی زبان اپنے ہی جملوں سے سیکھ سکتے ہیں۔",
    lernenGelernt: "{n} جملے سیکھے",
    lernenSerie: "لگاتار {n} دن",
    lernenWie: "{lang} میں اسے کیا کہتے ہیں؟",
    lernenAufdecken: "دکھائیں",
    lernenWusste: "مجھے معلوم تھا",
    lernenNochmal: "دوبارہ",
    lernenFertig: "آج کا مکمل! کل پھر ملتے ہیں۔",
    lernenLeer: "ابھی کوئی کارڈ نہیں۔ نیچے کسی تجویز پر ٹیپ کریں یا کسی پیغام کو دیر تک دبائیں ← “سیکھنے کے لیے محفوظ کریں”۔",
    lernenVorschlaege: "آپ کی چیٹ سے تجاویز",
    lernenGratis: "آج {n} مفت کارڈ باقی",
    lernenPlus: "آج کا ہو گیا! Diralo سبسکرپشن کے ساتھ بے حد سیکھیں۔",
    lernenPlusKnopf: "پلان دیکھیں",
    lernenKarten: "{n} کارڈ محفوظ",
    lernenPakete: "ابتدائی پیک",
    lernenPaketPaar: "جوڑا اور خاندان",
    lernenPaketArbeit: "کام (تعمیر، کھیت، گرین ہاؤس)",
    lernenPaketAlltag: "روزمرہ، ڈاکٹر اور دفاتر",
    lernenPaketDazu: "{n} کارڈ شامل کیے گئے",
    lernenPaketLaedt: "تیار ہو رہا ہے …",
    lernenTaeglich: "روزانہ صبح 9 بجے ایک جملہ",
    lernenAusblenden: "سیکھنا چھپائیں",
    lernenAusgeblendet: "سیکھنا چھپا دیا گیا۔ دوبارہ آن کریں: چیٹ میں اوپر 👥۔",
    lernenEinblenden: "سیکھنا دوبارہ دکھائیں",
    lernenEingeblendet: "سیکھنا واپس آ گیا",
    gruppeErstellen: "اپنی ٹیم کے لیے گروپ بنائیں",
    gruppeTipp: "لنک سے اپنی ٹیم کو بلائیں – ہر کوئی اپنی زبان میں لکھتا اور پڑھتا ہے۔",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 سب کے لیے پن کریں",
    losloesen: "پن ہٹائیں",
    durchsage: "📌 اعلان",
    nurTeamPlus: "پن کیے گئے اعلانات Diralo Team Plus میں ملتے ہیں۔",
    teamName: "Diralo Team",
    teamText: "کاروبار کے لیے: 20 افراد تک، 3 گروپ، ہر ماہ 5,000 ترجمے",
    teamplusName: "Diralo Team Plus",
    teamplusText: "بڑے کاروبار کے لیے: 60 افراد تک، 10 گروپ، ہر ماہ 12,000 ترجمے",
    teamFreischalten: "🏢 کاروبار کے لیے فعال کریں",
    teamVoll: "یہ گروپ بھر گیا ہے – Team پلان میں کوئی جگہ نہیں بچی۔ ایڈمن کو بتائیں۔",
    kontingentTeam: "آپ کے Team پلان کے اس مہینے کے {n} ترجمے ختم ہو گئے ہیں۔ پیغامات آتے رہیں گے، بس ترجمہ نہیں ہوگا۔",
    gruppe: "گروپ",
    gruppeName: "گروپ کا نام",
    gruppeNameBsp: "مثلاً Estufa Silva – ٹیم",
    gruppeChef: "👑 ایڈمن",
    gruppeDuChef: "آپ اس گروپ کے ایڈمن ہیں۔",
    gruppeNurChef: "صرف گروپ کا ایڈمن اسے بدل سکتا ہے۔",
    gruppeMitglieder: "{n} ممبر",
    gruppeEntfernen: "ہٹائیں",
    gruppeEntfernenFrage: "{name} کو گروپ سے ہٹائیں؟ وہ یہ چیٹ دوبارہ نہیں کھول سکیں گے۔",
    gruppeEntferntDu: "آپ کو اس گروپ سے ہٹا دیا گیا ہے۔",
    gruppeOnline: "آن لائن",
    gruppeZuletzt: "آخری بار",
    gruppeGelesen: "جنہوں نے پڑھا",
    gruppeUngelesen: "ابھی نہیں پڑھا",
    gruppeHinweis: "چیٹ کو نام دیں – یہ ممبر لسٹ اور “کس نے پڑھا” والا گروپ بن جائے گا۔ جو پہلے نام دے، وہی گروپ کا ایڈمن ہوتا ہے۔",
    speichern: "محفوظ کریں",
    fuerMich: "🙈 میرے لیے حذف کریں",
    geteiltTitel: "شیئر کیا گیا – ترجمہ شدہ",
    geteiltLaedt: "ترجمہ ہو رہا ہے …",
    dateiTitel: "فائل شیئر کریں",
    video: "ویڈیو",
    datei: "فائل",
    dateiGross: "فائل بہت بڑی ہے (زیادہ سے زیادہ 25 MB)۔",
    dateiFehler: "فائل نہیں بھیجی جا سکی۔",
    dateiOeffnen: "کھولنے کے لیے ٹیپ کریں",
    abbrechen2: "منسوخ",
    dateiKeinChat: "آپ کی ابھی کوئی چیٹ نہیں ہے۔ پہلے چیٹ شروع کریں اور اپنے ساتھی کو دعوت دیں۔",
    gifSuchen: "GIF تلاش کریں",
    gifAus: "ابھی GIF دستیاب نہیں ہیں۔",
    gifFehler: "GIF نہیں بھیجا جا سکا۔",
    linkTitel: "لنک شیئر کریں",
    linkWelcher: "کون سی چیٹ؟",
    linkKeinChat: "آپ کی ابھی کوئی چیٹ نہیں ہے۔ پہلے چیٹ شروع کریں اور اپنے ساتھی کو دعوت دیں۔",
    dolmetscher: "🎙\nترجمان",
    fotoKnopf: "📷\nتصویر کا ترجمہ",
    dolmInfo: "فون اپنے درمیان رکھیں۔ ہر شخص اپنے مائیک پر ٹیپ کرے اور اپنی زبان میں بولے۔",
    tippenSprechen: "ٹیپ کریں اور بولیں",
    hoere: "سن رہا ہے …",
    andereSprache: "دوسری زبان",
    fotoInfo: "مینو، خط یا بورڈ کی تصویر لیں – Diralo متن پڑھ کر اس کا ترجمہ کرے گا۔",
    erklaeren: "آسان الفاظ میں سمجھائیں",
    erklaerung: "وضاحت",
    originalText: "اصل متن",
    keinText: "تصویر میں کوئی متن نہیں ملا۔",
    fotoLesen: "تصویر پڑھی جا رہی ہے …",
    zurueck: "واپس",
    hilfeFehler: "یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔",
    vorschau: "یوں پہنچے گا:",
    vorschauAus: "پیش منظر بند",
    vorlesen: "🔊 بلند آواز میں سنیں",
    langsam: "🐢 اصل، آہستہ",
    aussprache: "🗣 تلفظ",
    ausspracheFehler: "تلفظ کی مدد ابھی دستیاب نہیں۔",
    claim: "کسی بھی زبان میں چیٹ کریں۔ ہر پیغام کا خودبخود ترجمہ ہوتا ہے۔",
    deinName: "آپ کا نام",
    nameBsp: "مثلاً ماریہ",
    deineSprache: "آپ کی زبان",
    neuerChat: "نئی چیٹ شروع کریں",
    oderBeitreten: "یا کسی چیٹ میں شامل ہوں",
    chatCode: "چیٹ کوڈ",
    beitreten: "شامل ہوں",
    meineChats: "میری چیٹس",
    datenschutz: "ترجمے کے لیے ہر پیغام سرور پر بھیجا جاتا ہے اور وہاں پڑھا جا سکتا ہے — WhatsApp کے برعکس۔ ایسی کوئی بات نہ لکھیں جو کسی اور کو نہیں دیکھنی چاہیے۔ سب کچھ 30 دن بعد حذف ہو جاتا ہے۔",
    ausListe: "فہرست سے ہٹائیں؟",
    abbrechen: "منسوخ",
    entfernen: "ہٹائیں",
    nochKeine: "ابھی تک کوئی استعمال نہیں ہوا۔",
    kontingent: "اس مہینے کے آپ کے {n} مفت ترجمے ختم ہو گئے ہیں۔ پیغامات اب بھی اصل زبان میں پہنچیں گے۔ Diralo Plus میں ہر مہینے 1,500 ملتے ہیں۔",
    kontingentPlus: "اس مہینے کے آپ کے {n} Diralo Plus ترجمے ختم ہو گئے ہیں۔ پیغامات اب بھی اصل زبان میں پہنچیں گے۔ یکم تاریخ کو دوبارہ شروع ہوں گے – یا Diralo Family پر جائیں۔",
    kontingentFamilie: "اس مہینے کے آپ کے {n} Diralo Family ترجمے ختم ہو گئے ہیں۔ پیغامات اب بھی اصل زبان میں پہنچیں گے۔ یکم تاریخ کو دوبارہ شروع ہوں گے۔",
    uebersFehler: "ابھی ترجمہ ممکن نہیں۔ پیغام اصل زبان میں دکھایا جا رہا ہے۔",
    zuVieleJoins: "شامل ہونے کی بہت زیادہ کوششیں۔ تھوڑا انتظار کریں۔",
    langsamer: "آہستہ کریں - کم وقت میں بہت زیادہ پیغامات۔",
    fremdGeraet: "یہ پیغام کسی دوسرے ڈیوائس پر لکھا گیا تھا اور یہاں حذف نہیں ہو سکتا۔",
    loeschenFehler: "ابھی حذف نہیں ہو سکتا۔ بعد میں دوبارہ کوشش کریں۔",
    spracheLang: "وائس میسج بہت لمبا ہے۔",
    spracheFehler: "وائس میسج نہیں بھیجا جا سکا۔",
    einladung: "Diralo پر میرے ساتھ چیٹ کریں — ہر کوئی اپنی زبان میں:",
    fuerAlleFrage: "سب کے لیے حذف کریں؟",
    verschwindet: "پیغام دوسرے شخص کے لیے بھی غائب ہو جائے گا۔",
    loeschen: "حذف کریں",
    ohneKamera: "کیمرے کی اجازت کے بغیر ممکن نہیں۔",
    ohneFotos: "تصاویر تک رسائی کے بغیر ممکن نہیں۔",
    fotoGross: "تصویر بہت بڑی ہے۔",
    fotoFehler: "تصویر نہیں بھیجی جا سکی۔",
    ohneStandort: "لوکیشن کی اجازت کے بغیر ممکن نہیں۔",
    standortFehler: "لوکیشن معلوم نہیں ہو سکی۔",
    senden: "بھیجیں",
    galerie: "گیلری سے تصویر",
    kamera: "کیمرا",
    standort: "لوکیشن",
    einladen: "دعوت دیں",
    verbunden: "منسلک",
    verbinde: "منسلک ہو رہا ہے ...",
    du: "آپ",
    Du: "آپ",
    leer: "ابھی کوئی پیغام نہیں۔ پہلا پیغام لکھیں - اس کا خودبخود ترجمہ ہو جائے گا۔",
    antworten: "↩ جواب دیں",
    fuerAlle: "🗑 سب کے لیے حذف کریں",
    schreiben: "پیغام",
    geloescht: "پیغام حذف کر دیا گیا",
    kartenTipp: "نقشے میں کھولنے کے لیے ٹیپ کریں",
    nichtMehrDa: "پیغام اب دستیاب نہیں",
    sprachnachricht: "وائس میسج",
    foto: "تصویر",
    aufnahmeFehler: "ریکارڈنگ ممکن نہیں: ",
    ohneMikro: "مائیکروفون کی اجازت کے بغیر ممکن نہیں۔",
    android13: "وائس میسج کے لیے Android 13 یا نیا ورژن ضروری ہے۔",
    kanal: "پیغامات",
    aboTitel: "مزید ترجمے",
    aboText: "ادائیگی Google Play کے ذریعے۔ Play Store میں کسی بھی وقت منسوخ کریں۔",
    aboStand: "یہ چیٹ: اس مہینے {g} میں سے {b} ترجمے۔",
    aboAktiv: "اس چیٹ میں Diralo {p} ہے۔",
    plusName: "Plus",
    plusText: "ہر مہینے 1,500 ترجمے، زیادہ سے زیادہ 3 چیٹس",
    familieName: "Family",
    familieText: "ہر مہینے 5,000 ترجمے، زیادہ سے زیادہ 10 چیٹس",
    monat: "فی مہینہ",
    jahr: "فی سال",
    aboNichtDa: "سبسکرپشن ابھی دستیاب نہیں۔ بعد میں دوبارہ کوشش کریں۔",
    aboDanke: "شکریہ! یہ چیٹ اب ان لاک ہو گئی ہے۔",
    aboWartet: "ادائیگی کی تصدیق ابھی ہو رہی ہے۔ اس میں چند منٹ لگ سکتے ہیں۔",
    aboFehler: "خریداری مکمل نہیں ہو سکی۔",
    schliessen: "بند کریں",
    heute: "آج",
    gestern: "کل",
    ausblenden: "ہٹانے کے لیے ٹیپ کریں",
  },
  bn: {
    videoAufnehmen: "ভিডিও রেকর্ড করুন",
    videoVorbereiten: "ভিডিও তৈরি হচ্ছে …",
    bonusHinweis: "🎁 আপনার মানুষটিও লিখলেই আপনারা দুজনেই ১ মাস Diralo Plus ফ্রি পাবেন।",
    bonusDa: "🎁 হয়ে গেছে! এই চ্যাটের জন্য আপনারা দুজনেই ১ মাস Diralo Plus ফ্রি পেয়েছেন।",
    anrufMinutenLeer: "এই মাসের লাইভ সাবটাইটেল মিনিট শেষ। কলটি সাবটাইটেল ছাড়াই চলবে – Diralo Plus-এ আরও বেশি পাবেন।",
    anrufMinutenRest: "লাইভ সাবটাইটেল: এই মাসে আর {n} মিনিট বাকি।",
    anrufen: "কল",
    anrufSprache: "📞 ভয়েস কল",
    anrufVideo: "🎥 ভিডিও কল",
    anrufKommt: "কল করছেন …",
    anrufVideoKommt: "ভিডিও কল …",
    anrufUntertitelHinweis: "লাইভ সাবটাইটেল সহ: যা বলা হচ্ছে তা আপনার ভাষায় পড়ুন।",
    anrufFehler: "কলটি এই মুহূর্তে হয়নি।",
    anrufWartet: "উত্তরের অপেক্ষায় …",
    anrufKlingelt: "রিং হচ্ছে …",
    anrufVorbei: "কল শেষ",
    anrufAbgelehnt: "উত্তর দেননি",
    updTitel: "নতুন ভার্সন এসেছে",
    updText: "Diralo আরও উন্নত হয়েছে। “আপডেট” ট্যাপ করুন – মাত্র এক মুহূর্ত লাগবে।",
    updKnopf: "আপডেট",
    updSpaeter: "পরে",
    updPflicht: "Diralo চালু রাখতে এই আপডেটটি দরকার।",
    autoAn: "নতুন মেসেজ এখন থেকে পড়ে শোনানো হবে।",
    autoAus: "স্বয়ংক্রিয়ভাবে পড়ে শোনানো বন্ধ।",
    keineStimme: "এই ভাষার জন্য কোনো ভয়েস ইনস্টল করা নেই। Android সেটিংস → টেক্সট-টু-স্পিচ আউটপুট → ভয়েস ডেটা ইনস্টল করুন।",
    imChat: "চ্যাটে",
    einlTitel: "আমন্ত্রণ পেয়েছেন?",
    einlText: "লিঙ্ক থেকে চ্যাট কোডটি দিন, তাহলে আপনার মানুষটির সাথে একই চ্যাটে যোগ দেবেন।",
    neuTitel: "কাউকে আমন্ত্রণ জানাতে চান?",
    neuText: "এতে একটি নতুন, খালি চ্যাট শুরু হবে। তারপর আপনার মানুষটিকে লিঙ্কটি পাঠান।",
    leerTitel: "এই চ্যাটটি নতুন",
    leerText2: "এখানে এখনো কেউ নেই। আপনার মানুষটিকে লিঙ্কটি পাঠান যাতে তিনি যোগ দিতে পারেন।",
    falschHier: "আপনি নিজেই কি আমন্ত্রণ পেয়েছেন? তাহলে আপনি ভুল জায়গায় আছেন।",
    codeEingeben: "ফিরে গিয়ে কোডটি দিন",
    umbenennen: "এই চ্যাটের নাম",
    chatNameBsp: "যেমন মারিয়া 💕",
    lernenTitel: "শিখুন",
    lernenMerken: "⭐ শেখার জন্য সংরক্ষণ",
    lernenGemerkt: "সংরক্ষিত – 🎓-এ পাবেন",
    lernenSchon: "এই বাক্যটি আগেই সংরক্ষিত।",
    lernenNichtMoeglich: "এই বাক্যের এখনো অনুবাদ নেই।",
    lernenKeinPartner: "কেউ অন্য ভাষায় লিখলেই আপনি এখানে নিজেদের বাক্য দিয়ে তার ভাষা শিখতে পারবেন।",
    lernenGelernt: "{n}টি বাক্য শেখা হয়েছে",
    lernenSerie: "টানা {n} দিন",
    lernenWie: "{lang}-তে এটা কী বলে?",
    lernenAufdecken: "দেখান",
    lernenWusste: "জানতাম",
    lernenNochmal: "আবার",
    lernenFertig: "আজকের সব শেষ! কাল আবার।",
    lernenLeer: "এখনো কোনো কার্ড নেই। নিচের একটি পরামর্শে ট্যাপ করুন বা কোনো বার্তা চেপে ধরুন → “শেখার জন্য সংরক্ষণ”।",
    lernenVorschlaege: "আপনাদের চ্যাট থেকে পরামর্শ",
    lernenGratis: "আজ আর {n}টি ফ্রি কার্ড",
    lernenPlus: "আজকের হয়ে গেছে! Diralo সাবস্ক্রিপশনে সীমাহীন শিখুন।",
    lernenPlusKnopf: "প্ল্যান দেখুন",
    lernenKarten: "{n}টি কার্ড সংরক্ষিত",
    lernenPakete: "শুরুর প্যাক",
    lernenPaketPaar: "দম্পতি ও পরিবার",
    lernenPaketArbeit: "কাজ (নির্মাণ, মাঠ, গ্রিনহাউস)",
    lernenPaketAlltag: "দৈনন্দিন, ডাক্তার ও অফিস",
    lernenPaketDazu: "{n}টি কার্ড যোগ হয়েছে",
    lernenPaketLaedt: "তৈরি হচ্ছে …",
    lernenTaeglich: "প্রতিদিন সকাল ৯টায় একটি বাক্য",
    lernenAusblenden: "শেখা লুকান",
    lernenAusgeblendet: "শেখা লুকানো হয়েছে। আবার চালু করতে: চ্যাটের উপরে 👥।",
    lernenEinblenden: "শেখা আবার দেখান",
    lernenEingeblendet: "শেখা ফিরে এসেছে",
    gruppeErstellen: "আমার দলের জন্য গ্রুপ তৈরি করুন",
    gruppeTipp: "লিংক দিয়ে আপনার দলকে আমন্ত্রণ জানান – সবাই নিজের ভাষায় লেখে ও পড়ে।",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 সবার জন্য পিন করুন",
    losloesen: "পিন সরান",
    durchsage: "📌 ঘোষণা",
    nurTeamPlus: "পিন করা ঘোষণা Diralo Team Plus-এ পাওয়া যায়।",
    teamName: "Diralo Team",
    teamText: "ব্যবসার জন্য: ২০ জন পর্যন্ত, ৩টি গ্রুপ, মাসে ৫,০০০ অনুবাদ",
    teamplusName: "Diralo Team Plus",
    teamplusText: "বড় ব্যবসার জন্য: ৬০ জন পর্যন্ত, ১০টি গ্রুপ, মাসে ১২,০০০ অনুবাদ",
    teamFreischalten: "🏢 ব্যবসার জন্য চালু করুন",
    teamVoll: "এই গ্রুপ পূর্ণ – Team প্ল্যানে আর জায়গা নেই। অ্যাডমিনকে জানান।",
    kontingentTeam: "আপনাদের Team প্ল্যানের এই মাসের {n}টি অনুবাদ শেষ। মেসেজ আসতে থাকবে, শুধু অনুবাদ হবে না।",
    gruppe: "গ্রুপ",
    gruppeName: "গ্রুপের নাম",
    gruppeNameBsp: "যেমন Estufa Silva – টিম",
    gruppeChef: "👑 অ্যাডমিন",
    gruppeDuChef: "আপনি এই গ্রুপের অ্যাডমিন।",
    gruppeNurChef: "শুধু গ্রুপের অ্যাডমিন এটা বদলাতে পারেন।",
    gruppeMitglieder: "{n} জন সদস্য",
    gruppeEntfernen: "সরান",
    gruppeEntfernenFrage: "{name}-কে গ্রুপ থেকে সরাবেন? তিনি আর এই চ্যাট খুলতে পারবেন না।",
    gruppeEntferntDu: "আপনাকে এই গ্রুপ থেকে সরিয়ে দেওয়া হয়েছে।",
    gruppeOnline: "অনলাইন",
    gruppeZuletzt: "শেষ দেখা",
    gruppeGelesen: "যাঁরা পড়েছেন",
    gruppeUngelesen: "এখনও পড়েননি",
    gruppeHinweis: "চ্যাটের একটা নাম দিন – এটা সদস্য তালিকা ও “কে পড়েছে” সহ একটি গ্রুপ হয়ে যাবে। যিনি প্রথম নাম দেন, তিনিই গ্রুপের অ্যাডমিন।",
    speichern: "সেভ করুন",
    fuerMich: "🙈 আমার জন্য মুছুন",
    geteiltTitel: "শেয়ার করা – অনুবাদিত",
    geteiltLaedt: "অনুবাদ হচ্ছে …",
    dateiTitel: "ফাইল শেয়ার করুন",
    video: "ভিডিও",
    datei: "ফাইল",
    dateiGross: "ফাইলটি খুব বড় (সর্বোচ্চ ২৫ MB)।",
    dateiFehler: "ফাইলটি পাঠানো যায়নি।",
    dateiOeffnen: "খুলতে ট্যাপ করুন",
    abbrechen2: "বাতিল",
    dateiKeinChat: "আপনার এখনো কোনো চ্যাট নেই। আগে একটি চ্যাট শুরু করে আপনার মানুষটিকে আমন্ত্রণ জানান।",
    gifSuchen: "GIF খুঁজুন",
    gifAus: "এই মুহূর্তে GIF পাওয়া যাচ্ছে না।",
    gifFehler: "GIF পাঠানো যায়নি।",
    linkTitel: "লিঙ্ক শেয়ার করুন",
    linkWelcher: "কোন চ্যাট?",
    linkKeinChat: "আপনার এখনো কোনো চ্যাট নেই। আগে একটি চ্যাট শুরু করে আপনার মানুষটিকে আমন্ত্রণ জানান।",
    dolmetscher: "🎙\nদোভাষী",
    fotoKnopf: "📷\nছবি অনুবাদ",
    dolmInfo: "ফোনটি আপনাদের দুজনের মাঝে রাখুন। প্রত্যেকে নিজের মাইক্রোফোনে ট্যাপ করে নিজের ভাষায় বলুন।",
    tippenSprechen: "ট্যাপ করে বলুন",
    hoere: "শুনছি …",
    andereSprache: "অন্য ভাষা",
    fotoInfo: "মেনু, চিঠি বা সাইনবোর্ডের ছবি তুলুন – Diralo লেখাটি পড়ে অনুবাদ করে দেবে।",
    erklaeren: "সহজভাবে বুঝিয়ে দিন",
    erklaerung: "ব্যাখ্যা",
    originalText: "মূল লেখা",
    keinText: "ছবিতে কোনো লেখা পাওয়া যায়নি।",
    fotoLesen: "ছবি পড়া হচ্ছে …",
    zurueck: "ফিরে যান",
    hilfeFehler: "কাজ হয়নি। আবার চেষ্টা করুন।",
    vorschau: "এভাবে পৌঁছাবে:",
    vorschauAus: "প্রিভিউ বন্ধ",
    vorlesen: "🔊 পড়ে শোনান",
    langsam: "🐢 মূলটি ধীরে",
    aussprache: "🗣 উচ্চারণ",
    ausspracheFehler: "এই মুহূর্তে উচ্চারণ সহায়তা পাওয়া যাচ্ছে না।",
    claim: "যেকোনো ভাষায় চ্যাট করুন। প্রতিটি মেসেজ স্বয়ংক্রিয়ভাবে অনুবাদ হয়।",
    deinName: "আপনার নাম",
    nameBsp: "যেমন মারিয়া",
    deineSprache: "আপনার ভাষা",
    neuerChat: "নতুন চ্যাট শুরু করুন",
    oderBeitreten: "অথবা একটি চ্যাটে যোগ দিন",
    chatCode: "চ্যাট কোড",
    beitreten: "যোগ দিন",
    meineChats: "আমার চ্যাট",
    datenschutz: "অনুবাদের জন্য প্রতিটি মেসেজ একটি সার্ভারে পাঠানো হয় এবং সেখানে পড়া যায় — WhatsApp-এর মতো নয়। এমন কিছু লিখবেন না যা অন্য কারো দেখা উচিত নয়। ৩০ দিন পর সবকিছু মুছে ফেলা হয়।",
    ausListe: "তালিকা থেকে সরাবেন?",
    abbrechen: "বাতিল",
    entfernen: "সরান",
    nochKeine: "এখনো কিছু ব্যবহার হয়নি।",
    kontingent: "এই মাসের আপনার {n}টি ফ্রি অনুবাদ শেষ। মেসেজ এখনো আসবে, মূল ভাষায়। Diralo Plus-এ মাসে ১,৫০০টি পাবেন।",
    kontingentPlus: "এই মাসের আপনার {n}টি Diralo Plus অনুবাদ শেষ। মেসেজ এখনো আসবে, মূল ভাষায়। ১ তারিখে আবার শুরু হবে – অথবা Diralo Family-তে যান।",
    kontingentFamilie: "এই মাসের আপনার {n}টি Diralo Family অনুবাদ শেষ। মেসেজ এখনো আসবে, মূল ভাষায়। ১ তারিখে আবার শুরু হবে।",
    uebersFehler: "এই মুহূর্তে অনুবাদ সম্ভব নয়। মেসেজটি মূল ভাষায় দেখানো হচ্ছে।",
    zuVieleJoins: "অনেকবার যোগ দেওয়ার চেষ্টা হয়েছে। একটু অপেক্ষা করুন।",
    langsamer: "একটু ধীরে - অল্প সময়ে অনেক বেশি মেসেজ।",
    fremdGeraet: "এই মেসেজটি অন্য ডিভাইসে লেখা হয়েছে, এখান থেকে মোছা যাবে না।",
    loeschenFehler: "এখন মোছা যাচ্ছে না। পরে আবার চেষ্টা করুন।",
    spracheLang: "ভয়েস মেসেজটি খুব লম্বা।",
    spracheFehler: "ভয়েস মেসেজটি পাঠানো যায়নি।",
    einladung: "Diralo-তে আমার সাথে চ্যাট করুন — যার যার নিজের ভাষায়:",
    fuerAlleFrage: "সবার জন্য মুছবেন?",
    verschwindet: "মেসেজটি অন্যজনের কাছ থেকেও মুছে যাবে।",
    loeschen: "মুছুন",
    ohneKamera: "ক্যামেরার অনুমতি ছাড়া সম্ভব নয়।",
    ohneFotos: "ছবির অ্যাক্সেস ছাড়া সম্ভব নয়।",
    fotoGross: "ছবিটি খুব বড়।",
    fotoFehler: "ছবিটি পাঠানো যায়নি।",
    ohneStandort: "লোকেশনের অনুমতি ছাড়া সম্ভব নয়।",
    standortFehler: "লোকেশন নির্ধারণ করা যায়নি।",
    senden: "পাঠান",
    galerie: "গ্যালারি থেকে ছবি",
    kamera: "ক্যামেরা",
    standort: "লোকেশন",
    einladen: "আমন্ত্রণ",
    verbunden: "সংযুক্ত",
    verbinde: "সংযোগ হচ্ছে ...",
    du: "আপনি",
    Du: "আপনি",
    leer: "এখনো কোনো মেসেজ নেই। প্রথমটি লিখুন - এটি স্বয়ংক্রিয়ভাবে অনুবাদ হবে।",
    antworten: "↩ উত্তর দিন",
    fuerAlle: "🗑 সবার জন্য মুছুন",
    schreiben: "মেসেজ",
    geloescht: "মেসেজ মুছে ফেলা হয়েছে",
    kartenTipp: "ম্যাপে খুলতে ট্যাপ করুন",
    nichtMehrDa: "মেসেজটি আর নেই",
    sprachnachricht: "ভয়েস মেসেজ",
    foto: "ছবি",
    aufnahmeFehler: "রেকর্ড করা সম্ভব নয়: ",
    ohneMikro: "মাইক্রোফোনের অনুমতি ছাড়া সম্ভব নয়।",
    android13: "ভয়েস মেসেজের জন্য Android 13 বা তার নতুন ভার্সন লাগবে।",
    kanal: "মেসেজ",
    aboTitel: "আরও অনুবাদ",
    aboText: "Google Play-এর মাধ্যমে বিল করা হয়। Play Store-এ যেকোনো সময় বাতিল করুন।",
    aboStand: "এই চ্যাট: এই মাসে {g}টির মধ্যে {b}টি অনুবাদ।",
    aboAktiv: "এই চ্যাটে Diralo {p} আছে।",
    plusName: "Plus",
    plusText: "মাসে ১,৫০০টি অনুবাদ, সর্বোচ্চ ৩টি চ্যাট",
    familieName: "Family",
    familieText: "মাসে ৫,০০০টি অনুবাদ, সর্বোচ্চ ১০টি চ্যাট",
    monat: "প্রতি মাসে",
    jahr: "প্রতি বছরে",
    aboNichtDa: "এই মুহূর্তে সাবস্ক্রিপশন পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।",
    aboDanke: "ধন্যবাদ! এই চ্যাটটি এখন আনলক হয়েছে।",
    aboWartet: "পেমেন্ট এখনো নিশ্চিত হচ্ছে। কয়েক মিনিট লাগতে পারে।",
    aboFehler: "কেনাকাটা সম্পন্ন করা যায়নি।",
    schliessen: "বন্ধ করুন",
    heute: "আজ",
    gestern: "গতকাল",
    ausblenden: "সরাতে ট্যাপ করুন",
  },
  pa: {
    videoAufnehmen: "ਵੀਡੀਓ ਰਿਕਾਰਡ ਕਰੋ",
    videoVorbereiten: "ਵੀਡੀਓ ਤਿਆਰ ਹੋ ਰਹੀ ਹੈ …",
    bonusHinweis: "🎁 ਜਦੋਂ ਤੁਹਾਡਾ ਸਾਥੀ ਵੀ ਲਿਖੇਗਾ, ਤੁਹਾਨੂੰ ਦੋਵਾਂ ਨੂੰ 1 ਮਹੀਨੇ ਲਈ Diralo Plus ਮੁਫ਼ਤ ਮਿਲੇਗਾ।",
    bonusDa: "🎁 ਹੋ ਗਿਆ! ਤੁਹਾਨੂੰ ਦੋਵਾਂ ਨੂੰ ਇਸ ਚੈਟ ਲਈ 1 ਮਹੀਨੇ ਦਾ Diralo Plus ਮੁਫ਼ਤ ਮਿਲ ਗਿਆ।",
    anrufMinutenLeer: "ਇਸ ਮਹੀਨੇ ਦੇ ਲਾਈਵ ਸਬਟਾਈਟਲ ਮਿੰਟ ਖ਼ਤਮ ਹੋ ਗਏ ਹਨ। ਕਾਲ ਸਬਟਾਈਟਲ ਤੋਂ ਬਿਨਾਂ ਜਾਰੀ ਰਹੇਗੀ – Diralo Plus ਨਾਲ ਤੁਹਾਨੂੰ ਹੋਰ ਮਿਲਦੇ ਹਨ।",
    anrufMinutenRest: "ਲਾਈਵ ਸਬਟਾਈਟਲ: ਇਸ ਮਹੀਨੇ {n} ਮਿੰਟ ਬਾਕੀ।",
    anrufen: "ਕਾਲ ਕਰੋ",
    anrufSprache: "📞 ਵੌਇਸ ਕਾਲ",
    anrufVideo: "🎥 ਵੀਡੀਓ ਕਾਲ",
    anrufKommt: "ਕਾਲ ਕਰ ਰਹੇ ਹਨ …",
    anrufVideoKommt: "ਵੀਡੀਓ ਕਾਲ …",
    anrufUntertitelHinweis: "ਲਾਈਵ ਸਬਟਾਈਟਲ ਨਾਲ: ਜੋ ਕਿਹਾ ਜਾਂਦਾ ਹੈ, ਤੁਸੀਂ ਆਪਣੀ ਭਾਸ਼ਾ ਵਿੱਚ ਪੜ੍ਹਦੇ ਹੋ।",
    anrufFehler: "ਕਾਲ ਹੁਣੇ ਨਹੀਂ ਹੋ ਸਕੀ।",
    anrufWartet: "ਜਵਾਬ ਦੀ ਉਡੀਕ …",
    anrufKlingelt: "ਘੰਟੀ ਵੱਜ ਰਹੀ ਹੈ …",
    anrufVorbei: "ਕਾਲ ਖ਼ਤਮ ਹੋਈ",
    anrufAbgelehnt: "ਜਵਾਬ ਨਹੀਂ ਦਿੱਤਾ",
    updTitel: "ਨਵਾਂ ਵਰਜ਼ਨ ਉਪਲਬਧ ਹੈ",
    updText: "Diralo ਨੂੰ ਬਿਹਤਰ ਬਣਾਇਆ ਗਿਆ ਹੈ। “ਅੱਪਡੇਟ” 'ਤੇ ਟੈਪ ਕਰੋ – ਬੱਸ ਇੱਕ ਪਲ ਲੱਗੇਗਾ।",
    updKnopf: "ਅੱਪਡੇਟ",
    updSpaeter: "ਬਾਅਦ ਵਿੱਚ",
    updPflicht: "Diralo ਨੂੰ ਚੱਲਦਾ ਰੱਖਣ ਲਈ ਇਹ ਅੱਪਡੇਟ ਲਾਜ਼ਮੀ ਹੈ।",
    autoAn: "ਹੁਣ ਨਵੇਂ ਸੁਨੇਹੇ ਪੜ੍ਹ ਕੇ ਸੁਣਾਏ ਜਾਣਗੇ।",
    autoAus: "ਆਪਣੇ-ਆਪ ਪੜ੍ਹ ਕੇ ਸੁਣਾਉਣਾ ਬੰਦ ਹੈ।",
    keineStimme: "ਇਸ ਭਾਸ਼ਾ ਲਈ ਕੋਈ ਆਵਾਜ਼ ਇੰਸਟਾਲ ਨਹੀਂ ਹੈ। Android ਸੈਟਿੰਗਾਂ → ਟੈਕਸਟ-ਟੂ-ਸਪੀਚ ਆਉਟਪੁੱਟ → ਆਵਾਜ਼ ਡਾਟਾ ਇੰਸਟਾਲ ਕਰੋ।",
    imChat: "ਚੈਟ ਵਿੱਚ",
    einlTitel: "ਕੀ ਤੁਹਾਨੂੰ ਸੱਦਾ ਮਿਲਿਆ ਹੈ?",
    einlText: "ਲਿੰਕ ਵਾਲਾ ਚੈਟ ਕੋਡ ਦਰਜ ਕਰੋ, ਤੁਸੀਂ ਆਪਣੇ ਸਾਥੀ ਵਾਲੀ ਚੈਟ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋ ਜਾਓਗੇ।",
    neuTitel: "ਕਿਸੇ ਨੂੰ ਸੱਦਾ ਦੇਣਾ ਚਾਹੁੰਦੇ ਹੋ?",
    neuText: "ਇਸ ਨਾਲ ਇੱਕ ਨਵੀਂ, ਖਾਲੀ ਚੈਟ ਸ਼ੁਰੂ ਹੁੰਦੀ ਹੈ। ਫਿਰ ਤੁਸੀਂ ਆਪਣੇ ਸਾਥੀ ਨੂੰ ਲਿੰਕ ਭੇਜੋ।",
    leerTitel: "ਇਹ ਚੈਟ ਨਵੀਂ ਹੈ",
    leerText2: "ਇੱਥੇ ਹਾਲੇ ਕੋਈ ਨਹੀਂ ਹੈ। ਆਪਣੇ ਸਾਥੀ ਨੂੰ ਲਿੰਕ ਭੇਜੋ ਤਾਂ ਜੋ ਉਹ ਸ਼ਾਮਲ ਹੋ ਸਕਣ।",
    falschHier: "ਕੀ ਤੁਹਾਨੂੰ ਖ਼ੁਦ ਸੱਦਾ ਮਿਲਿਆ ਸੀ? ਤਾਂ ਤੁਸੀਂ ਗ਼ਲਤ ਥਾਂ 'ਤੇ ਹੋ।",
    codeEingeben: "ਵਾਪਸ ਜਾਓ ਅਤੇ ਕੋਡ ਦਰਜ ਕਰੋ",
    umbenennen: "ਇਸ ਚੈਟ ਦਾ ਨਾਮ",
    chatNameBsp: "ਜਿਵੇਂ Maria 💕",
    lernenTitel: "ਸਿੱਖੋ",
    lernenMerken: "⭐ ਸਿੱਖਣ ਲਈ ਸੰਭਾਲੋ",
    lernenGemerkt: "ਸੰਭਾਲ ਲਿਆ – 🎓 ਵਿੱਚ ਮਿਲੇਗਾ",
    lernenSchon: "ਇਹ ਵਾਕ ਪਹਿਲਾਂ ਹੀ ਸੰਭਾਲਿਆ ਹੈ।",
    lernenNichtMoeglich: "ਇਸ ਵਾਕ ਦਾ ਅਜੇ ਅਨੁਵਾਦ ਨਹੀਂ ਹੈ।",
    lernenKeinPartner: "ਜਿਵੇਂ ਹੀ ਕੋਈ ਹੋਰ ਭਾਸ਼ਾ ਵਿੱਚ ਲਿਖੇਗਾ, ਤੁਸੀਂ ਇੱਥੇ ਆਪਣੇ ਹੀ ਵਾਕਾਂ ਨਾਲ ਉਸਦੀ ਭਾਸ਼ਾ ਸਿੱਖ ਸਕਦੇ ਹੋ।",
    lernenGelernt: "{n} ਵਾਕ ਸਿੱਖੇ",
    lernenSerie: "ਲਗਾਤਾਰ {n} ਦਿਨ",
    lernenWie: "{lang} ਵਿੱਚ ਇਸਨੂੰ ਕੀ ਕਹਿੰਦੇ ਹਨ?",
    lernenAufdecken: "ਦਿਖਾਓ",
    lernenWusste: "ਮੈਨੂੰ ਪਤਾ ਸੀ",
    lernenNochmal: "ਫਿਰ ਤੋਂ",
    lernenFertig: "ਅੱਜ ਦਾ ਪੂਰਾ! ਕੱਲ੍ਹ ਫਿਰ।",
    lernenLeer: "ਅਜੇ ਕੋਈ ਕਾਰਡ ਨਹੀਂ। ਹੇਠਾਂ ਕਿਸੇ ਸੁਝਾਅ 'ਤੇ ਟੈਪ ਕਰੋ ਜਾਂ ਕਿਸੇ ਸੁਨੇਹੇ ਨੂੰ ਦਬਾ ਕੇ ਰੱਖੋ → “ਸਿੱਖਣ ਲਈ ਸੰਭਾਲੋ”।",
    lernenVorschlaege: "ਤੁਹਾਡੀ ਚੈਟ ਤੋਂ ਸੁਝਾਅ",
    lernenGratis: "ਅੱਜ {n} ਮੁਫ਼ਤ ਕਾਰਡ ਬਾਕੀ",
    lernenPlus: "ਅੱਜ ਦਾ ਹੋ ਗਿਆ! Diralo ਸਬਸਕ੍ਰਿਪਸ਼ਨ ਨਾਲ ਬੇਅੰਤ ਸਿੱਖੋ।",
    lernenPlusKnopf: "ਪਲਾਨ ਵੇਖੋ",
    lernenKarten: "{n} ਕਾਰਡ ਸੰਭਾਲੇ",
    lernenPakete: "ਸ਼ੁਰੂਆਤੀ ਪੈਕ",
    lernenPaketPaar: "ਜੋੜਾ ਅਤੇ ਪਰਿਵਾਰ",
    lernenPaketArbeit: "ਕੰਮ (ਉਸਾਰੀ, ਖੇਤ, ਗ੍ਰੀਨਹਾਊਸ)",
    lernenPaketAlltag: "ਰੋਜ਼ਾਨਾ, ਡਾਕਟਰ ਅਤੇ ਦਫ਼ਤਰ",
    lernenPaketDazu: "{n} ਕਾਰਡ ਜੋੜੇ ਗਏ",
    lernenPaketLaedt: "ਤਿਆਰ ਹੋ ਰਿਹਾ ਹੈ …",
    lernenTaeglich: "ਰੋਜ਼ ਸਵੇਰੇ 9 ਵਜੇ ਇੱਕ ਵਾਕ",
    lernenAusblenden: "ਸਿੱਖਣਾ ਲੁਕਾਓ",
    lernenAusgeblendet: "ਸਿੱਖਣਾ ਲੁਕਾ ਦਿੱਤਾ। ਮੁੜ ਚਾਲੂ ਕਰੋ: ਚੈਟ ਵਿੱਚ ਉੱਪਰ 👥।",
    lernenEinblenden: "ਸਿੱਖਣਾ ਮੁੜ ਦਿਖਾਓ",
    lernenEingeblendet: "ਸਿੱਖਣਾ ਵਾਪਸ ਆ ਗਿਆ",
    gruppeErstellen: "ਆਪਣੀ ਟੀਮ ਲਈ ਗਰੁੱਪ ਬਣਾਓ",
    gruppeTipp: "ਲਿੰਕ ਨਾਲ ਆਪਣੀ ਟੀਮ ਨੂੰ ਸੱਦੋ – ਹਰ ਕੋਈ ਆਪਣੀ ਭਾਸ਼ਾ ਵਿੱਚ ਲਿਖਦਾ ਅਤੇ ਪੜ੍ਹਦਾ ਹੈ।",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 ਸਭ ਲਈ ਪਿੰਨ ਕਰੋ",
    losloesen: "ਪਿੰਨ ਹਟਾਓ",
    durchsage: "📌 ਘੋਸ਼ਣਾ",
    nurTeamPlus: "ਪਿੰਨ ਕੀਤੀਆਂ ਘੋਸ਼ਣਾਵਾਂ Diralo Team Plus ਵਿੱਚ ਮਿਲਦੀਆਂ ਹਨ।",
    teamName: "Diralo Team",
    teamText: "ਕਾਰੋਬਾਰਾਂ ਲਈ: 20 ਲੋਕਾਂ ਤੱਕ, 3 ਗਰੁੱਪ, ਹਰ ਮਹੀਨੇ 5,000 ਅਨੁਵਾਦ",
    teamplusName: "Diralo Team Plus",
    teamplusText: "ਵੱਡੇ ਕਾਰੋਬਾਰਾਂ ਲਈ: 60 ਲੋਕਾਂ ਤੱਕ, 10 ਗਰੁੱਪ, ਹਰ ਮਹੀਨੇ 12,000 ਅਨੁਵਾਦ",
    teamFreischalten: "🏢 ਕਾਰੋਬਾਰ ਲਈ ਚਾਲੂ ਕਰੋ",
    teamVoll: "ਇਹ ਗਰੁੱਪ ਭਰ ਗਿਆ ਹੈ – Team ਪਲਾਨ ਵਿੱਚ ਕੋਈ ਥਾਂ ਨਹੀਂ ਬਚੀ। ਐਡਮਿਨ ਨੂੰ ਦੱਸੋ।",
    kontingentTeam: "ਤੁਹਾਡੇ Team ਪਲਾਨ ਦੇ ਇਸ ਮਹੀਨੇ ਦੇ {n} ਅਨੁਵਾਦ ਖ਼ਤਮ ਹੋ ਗਏ ਹਨ। ਸੁਨੇਹੇ ਆਉਂਦੇ ਰਹਿਣਗੇ, ਬੱਸ ਅਨੁਵਾਦ ਨਹੀਂ ਹੋਣਗੇ।",
    gruppe: "ਗਰੁੱਪ",
    gruppeName: "ਗਰੁੱਪ ਦਾ ਨਾਮ",
    gruppeNameBsp: "ਜਿਵੇਂ Estufa Silva – ਟੀਮ",
    gruppeChef: "👑 ਐਡਮਿਨ",
    gruppeDuChef: "ਤੁਸੀਂ ਇਸ ਗਰੁੱਪ ਦੇ ਐਡਮਿਨ ਹੋ।",
    gruppeNurChef: "ਸਿਰਫ਼ ਗਰੁੱਪ ਦਾ ਐਡਮਿਨ ਇਹ ਬਦਲ ਸਕਦਾ ਹੈ।",
    gruppeMitglieder: "{n} ਮੈਂਬਰ",
    gruppeEntfernen: "ਹਟਾਓ",
    gruppeEntfernenFrage: "{name} ਨੂੰ ਗਰੁੱਪ ਤੋਂ ਹਟਾਉਣਾ ਹੈ? ਉਹ ਇਹ ਚੈਟ ਫਿਰ ਨਹੀਂ ਖੋਲ੍ਹ ਸਕਣਗੇ।",
    gruppeEntferntDu: "ਤੁਹਾਨੂੰ ਇਸ ਗਰੁੱਪ ਤੋਂ ਹਟਾ ਦਿੱਤਾ ਗਿਆ ਹੈ।",
    gruppeOnline: "ਆਨਲਾਈਨ",
    gruppeZuletzt: "ਆਖਰੀ ਵਾਰ",
    gruppeGelesen: "ਜਿਨ੍ਹਾਂ ਨੇ ਪੜ੍ਹਿਆ",
    gruppeUngelesen: "ਹਾਲੇ ਨਹੀਂ ਪੜ੍ਹਿਆ",
    gruppeHinweis: "ਚੈਟ ਨੂੰ ਨਾਮ ਦਿਓ – ਇਹ ਮੈਂਬਰਾਂ ਦੀ ਸੂਚੀ ਅਤੇ “ਕਿਸ ਨੇ ਪੜ੍ਹਿਆ” ਵਾਲਾ ਗਰੁੱਪ ਬਣ ਜਾਵੇਗਾ। ਜੋ ਪਹਿਲਾਂ ਨਾਮ ਦਿੰਦਾ ਹੈ, ਉਹੀ ਐਡਮਿਨ ਹੁੰਦਾ ਹੈ।",
    speichern: "ਸੇਵ ਕਰੋ",
    fuerMich: "🙈 ਮੇਰੇ ਲਈ ਮਿਟਾਓ",
    geteiltTitel: "ਸਾਂਝਾ ਕੀਤਾ – ਅਨੁਵਾਦਿਤ",
    geteiltLaedt: "ਅਨੁਵਾਦ ਹੋ ਰਿਹਾ ਹੈ …",
    dateiTitel: "ਫ਼ਾਈਲ ਸਾਂਝੀ ਕਰੋ",
    video: "ਵੀਡੀਓ",
    datei: "ਫ਼ਾਈਲ",
    dateiGross: "ਫ਼ਾਈਲ ਬਹੁਤ ਵੱਡੀ ਹੈ (ਵੱਧ ਤੋਂ ਵੱਧ 25 MB)।",
    dateiFehler: "ਫ਼ਾਈਲ ਭੇਜੀ ਨਹੀਂ ਜਾ ਸਕੀ।",
    dateiOeffnen: "ਖੋਲ੍ਹਣ ਲਈ ਟੈਪ ਕਰੋ",
    abbrechen2: "ਰੱਦ ਕਰੋ",
    dateiKeinChat: "ਤੁਹਾਡੀ ਹਾਲੇ ਕੋਈ ਚੈਟ ਨਹੀਂ ਹੈ। ਪਹਿਲਾਂ ਚੈਟ ਸ਼ੁਰੂ ਕਰੋ ਅਤੇ ਆਪਣੇ ਸਾਥੀ ਨੂੰ ਸੱਦਾ ਦਿਓ।",
    gifSuchen: "GIF ਖੋਜੋ",
    gifAus: "GIF ਹੁਣੇ ਉਪਲਬਧ ਨਹੀਂ ਹਨ।",
    gifFehler: "GIF ਭੇਜਿਆ ਨਹੀਂ ਜਾ ਸਕਿਆ।",
    linkTitel: "ਲਿੰਕ ਸਾਂਝਾ ਕਰੋ",
    linkWelcher: "ਕਿਹੜੀ ਚੈਟ?",
    linkKeinChat: "ਤੁਹਾਡੀ ਹਾਲੇ ਕੋਈ ਚੈਟ ਨਹੀਂ ਹੈ। ਪਹਿਲਾਂ ਚੈਟ ਸ਼ੁਰੂ ਕਰੋ ਅਤੇ ਆਪਣੇ ਸਾਥੀ ਨੂੰ ਸੱਦਾ ਦਿਓ।",
    dolmetscher: "🎙\nਦੁਭਾਸ਼ੀਆ",
    fotoKnopf: "📷\nਫ਼ੋਟੋ ਅਨੁਵਾਦ ਕਰੋ",
    dolmInfo: "ਫ਼ੋਨ ਨੂੰ ਆਪਣੇ ਵਿਚਕਾਰ ਰੱਖੋ। ਹਰ ਕੋਈ ਆਪਣੇ ਮਾਈਕ੍ਰੋਫ਼ੋਨ 'ਤੇ ਟੈਪ ਕਰਕੇ ਆਪਣੀ ਭਾਸ਼ਾ ਵਿੱਚ ਬੋਲੇ।",
    tippenSprechen: "ਟੈਪ ਕਰੋ ਅਤੇ ਬੋਲੋ",
    hoere: "ਸੁਣ ਰਿਹਾ ਹੈ …",
    andereSprache: "ਹੋਰ ਭਾਸ਼ਾ",
    fotoInfo: "ਮੀਨੂ, ਚਿੱਠੀ ਜਾਂ ਬੋਰਡ ਦੀ ਫ਼ੋਟੋ ਖਿੱਚੋ – Diralo ਟੈਕਸਟ ਪੜ੍ਹ ਕੇ ਉਸਦਾ ਅਨੁਵਾਦ ਕਰਦਾ ਹੈ।",
    erklaeren: "ਸੌਖੇ ਸ਼ਬਦਾਂ ਵਿੱਚ ਸਮਝਾਓ",
    erklaerung: "ਵਿਆਖਿਆ",
    originalText: "ਮੂਲ ਟੈਕਸਟ",
    keinText: "ਫ਼ੋਟੋ ਵਿੱਚ ਕੋਈ ਟੈਕਸਟ ਨਹੀਂ ਮਿਲਿਆ।",
    fotoLesen: "ਫ਼ੋਟੋ ਪੜ੍ਹੀ ਜਾ ਰਹੀ ਹੈ …",
    zurueck: "ਵਾਪਸ",
    hilfeFehler: "ਇਹ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    vorschau: "ਇਹ ਇਸ ਤਰ੍ਹਾਂ ਪਹੁੰਚੇਗਾ:",
    vorschauAus: "ਪ੍ਰੀਵਿਊ ਬੰਦ",
    vorlesen: "🔊 ਪੜ੍ਹ ਕੇ ਸੁਣਾਓ",
    langsam: "🐢 ਮੂਲ ਹੌਲੀ-ਹੌਲੀ",
    aussprache: "🗣 ਉਚਾਰਣ",
    ausspracheFehler: "ਉਚਾਰਣ ਮਦਦ ਹੁਣੇ ਉਪਲਬਧ ਨਹੀਂ ਹੈ।",
    claim: "ਕਿਸੇ ਵੀ ਭਾਸ਼ਾ ਵਿੱਚ ਚੈਟ ਕਰੋ। ਹਰ ਸੁਨੇਹੇ ਦਾ ਆਪਣੇ-ਆਪ ਅਨੁਵਾਦ ਹੁੰਦਾ ਹੈ।",
    deinName: "ਤੁਹਾਡਾ ਨਾਮ",
    nameBsp: "ਜਿਵੇਂ Maria",
    deineSprache: "ਤੁਹਾਡੀ ਭਾਸ਼ਾ",
    neuerChat: "ਨਵੀਂ ਚੈਟ ਸ਼ੁਰੂ ਕਰੋ",
    oderBeitreten: "ਜਾਂ ਕਿਸੇ ਚੈਟ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋਵੋ",
    chatCode: "ਚੈਟ ਕੋਡ",
    beitreten: "ਸ਼ਾਮਲ ਹੋਵੋ",
    meineChats: "ਮੇਰੀਆਂ ਚੈਟਾਂ",
    datenschutz: "ਅਨੁਵਾਦ ਲਈ ਹਰ ਸੁਨੇਹਾ ਇੱਕ ਸਰਵਰ 'ਤੇ ਭੇਜਿਆ ਜਾਂਦਾ ਹੈ ਅਤੇ ਉੱਥੇ ਪੜ੍ਹਿਆ ਜਾ ਸਕਦਾ ਹੈ — WhatsApp ਵਾਂਗ ਨਹੀਂ। ਅਜਿਹਾ ਕੁਝ ਨਾ ਲਿਖੋ ਜੋ ਕਿਸੇ ਹੋਰ ਨੂੰ ਨਹੀਂ ਦਿਸਣਾ ਚਾਹੀਦਾ। ਸਭ ਕੁਝ 30 ਦਿਨਾਂ ਬਾਅਦ ਮਿਟਾ ਦਿੱਤਾ ਜਾਂਦਾ ਹੈ।",
    ausListe: "ਸੂਚੀ ਵਿੱਚੋਂ ਹਟਾਉਣਾ ਹੈ?",
    abbrechen: "ਰੱਦ ਕਰੋ",
    entfernen: "ਹਟਾਓ",
    nochKeine: "ਹਾਲੇ ਕੋਈ ਨਹੀਂ ਵਰਤਿਆ।",
    kontingent: "ਇਸ ਮਹੀਨੇ ਦੇ ਤੁਹਾਡੇ {n} ਮੁਫ਼ਤ ਅਨੁਵਾਦ ਖ਼ਤਮ ਹੋ ਗਏ ਹਨ। ਸੁਨੇਹੇ ਫਿਰ ਵੀ ਮੂਲ ਭਾਸ਼ਾ ਵਿੱਚ ਪਹੁੰਚਦੇ ਹਨ। Diralo Plus ਨਾਲ ਤੁਹਾਨੂੰ ਮਹੀਨੇ ਦੇ 1,500 ਮਿਲਦੇ ਹਨ।",
    kontingentPlus: "ਇਸ ਮਹੀਨੇ ਦੇ ਤੁਹਾਡੇ {n} Diralo Plus ਅਨੁਵਾਦ ਖ਼ਤਮ ਹੋ ਗਏ ਹਨ। ਸੁਨੇਹੇ ਫਿਰ ਵੀ ਮੂਲ ਭਾਸ਼ਾ ਵਿੱਚ ਪਹੁੰਚਦੇ ਹਨ। ਇਹ 1 ਤਾਰੀਖ਼ ਨੂੰ ਰੀਸੈੱਟ ਹੁੰਦੇ ਹਨ – ਜਾਂ Diralo Family 'ਤੇ ਜਾਓ।",
    kontingentFamilie: "ਇਸ ਮਹੀਨੇ ਦੇ ਤੁਹਾਡੇ {n} Diralo Family ਅਨੁਵਾਦ ਖ਼ਤਮ ਹੋ ਗਏ ਹਨ। ਸੁਨੇਹੇ ਫਿਰ ਵੀ ਮੂਲ ਭਾਸ਼ਾ ਵਿੱਚ ਪਹੁੰਚਦੇ ਹਨ। ਇਹ 1 ਤਾਰੀਖ਼ ਨੂੰ ਰੀਸੈੱਟ ਹੁੰਦੇ ਹਨ।",
    uebersFehler: "ਹੁਣੇ ਅਨੁਵਾਦ ਨਹੀਂ ਹੋ ਸਕਦਾ। ਸੁਨੇਹਾ ਮੂਲ ਭਾਸ਼ਾ ਵਿੱਚ ਦਿਖਾਇਆ ਗਿਆ ਹੈ।",
    zuVieleJoins: "ਸ਼ਾਮਲ ਹੋਣ ਦੀਆਂ ਬਹੁਤ ਜ਼ਿਆਦਾ ਕੋਸ਼ਿਸ਼ਾਂ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹਾ ਰੁਕੋ।",
    langsamer: "ਥੋੜ੍ਹਾ ਹੌਲੀ - ਘੱਟ ਸਮੇਂ ਵਿੱਚ ਬਹੁਤ ਜ਼ਿਆਦਾ ਸੁਨੇਹੇ।",
    fremdGeraet: "ਇਹ ਸੁਨੇਹਾ ਕਿਸੇ ਹੋਰ ਡਿਵਾਈਸ 'ਤੇ ਲਿਖਿਆ ਗਿਆ ਸੀ ਅਤੇ ਇੱਥੋਂ ਮਿਟਾਇਆ ਨਹੀਂ ਜਾ ਸਕਦਾ।",
    loeschenFehler: "ਹੁਣੇ ਮਿਟਾਇਆ ਨਹੀਂ ਜਾ ਸਕਦਾ। ਕਿਰਪਾ ਕਰਕੇ ਬਾਅਦ ਵਿੱਚ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    spracheLang: "ਵੌਇਸ ਸੁਨੇਹਾ ਬਹੁਤ ਲੰਬਾ ਹੈ।",
    spracheFehler: "ਵੌਇਸ ਸੁਨੇਹਾ ਭੇਜਿਆ ਨਹੀਂ ਜਾ ਸਕਿਆ।",
    einladung: "ਮੇਰੇ ਨਾਲ Diralo 'ਤੇ ਚੈਟ ਕਰੋ — ਹਰ ਕੋਈ ਆਪਣੀ ਭਾਸ਼ਾ ਵਿੱਚ:",
    fuerAlleFrage: "ਸਾਰਿਆਂ ਲਈ ਮਿਟਾਉਣਾ ਹੈ?",
    verschwindet: "ਸੁਨੇਹਾ ਦੂਜੇ ਵਿਅਕਤੀ ਲਈ ਵੀ ਗਾਇਬ ਹੋ ਜਾਵੇਗਾ।",
    loeschen: "ਮਿਟਾਓ",
    ohneKamera: "ਕੈਮਰੇ ਦੀ ਇਜਾਜ਼ਤ ਤੋਂ ਬਿਨਾਂ ਸੰਭਵ ਨਹੀਂ।",
    ohneFotos: "ਫ਼ੋਟੋਆਂ ਤੱਕ ਪਹੁੰਚ ਤੋਂ ਬਿਨਾਂ ਸੰਭਵ ਨਹੀਂ।",
    fotoGross: "ਫ਼ੋਟੋ ਬਹੁਤ ਵੱਡੀ ਹੈ।",
    fotoFehler: "ਫ਼ੋਟੋ ਭੇਜੀ ਨਹੀਂ ਜਾ ਸਕੀ।",
    ohneStandort: "ਟਿਕਾਣੇ ਦੀ ਇਜਾਜ਼ਤ ਤੋਂ ਬਿਨਾਂ ਸੰਭਵ ਨਹੀਂ।",
    standortFehler: "ਟਿਕਾਣਾ ਪਤਾ ਨਹੀਂ ਲੱਗ ਸਕਿਆ।",
    senden: "ਭੇਜੋ",
    galerie: "ਗੈਲਰੀ ਤੋਂ ਫ਼ੋਟੋ",
    kamera: "ਕੈਮਰਾ",
    standort: "ਟਿਕਾਣਾ",
    einladen: "ਸੱਦਾ ਦਿਓ",
    verbunden: "ਕਨੈਕਟ ਹੈ",
    verbinde: "ਕਨੈਕਟ ਹੋ ਰਿਹਾ ਹੈ ...",
    du: "ਤੁਸੀਂ",
    Du: "ਤੁਸੀਂ",
    leer: "ਹਾਲੇ ਕੋਈ ਸੁਨੇਹਾ ਨਹੀਂ। ਪਹਿਲਾ ਸੁਨੇਹਾ ਲਿਖੋ - ਉਸਦਾ ਆਪਣੇ-ਆਪ ਅਨੁਵਾਦ ਹੋਵੇਗਾ।",
    antworten: "↩ ਜਵਾਬ ਦਿਓ",
    fuerAlle: "🗑 ਸਾਰਿਆਂ ਲਈ ਮਿਟਾਓ",
    schreiben: "ਸੁਨੇਹਾ",
    geloescht: "ਸੁਨੇਹਾ ਮਿਟਾ ਦਿੱਤਾ ਗਿਆ",
    kartenTipp: "ਨਕਸ਼ੇ ਵਿੱਚ ਖੋਲ੍ਹਣ ਲਈ ਟੈਪ ਕਰੋ",
    nichtMehrDa: "ਸੁਨੇਹਾ ਹੁਣ ਉਪਲਬਧ ਨਹੀਂ",
    sprachnachricht: "ਵੌਇਸ ਸੁਨੇਹਾ",
    foto: "ਫ਼ੋਟੋ",
    aufnahmeFehler: "ਰਿਕਾਰਡਿੰਗ ਸੰਭਵ ਨਹੀਂ: ",
    ohneMikro: "ਮਾਈਕ੍ਰੋਫ਼ੋਨ ਦੀ ਇਜਾਜ਼ਤ ਤੋਂ ਬਿਨਾਂ ਸੰਭਵ ਨਹੀਂ।",
    android13: "ਵੌਇਸ ਸੁਨੇਹਿਆਂ ਲਈ Android 13 ਜਾਂ ਨਵਾਂ ਚਾਹੀਦਾ ਹੈ।",
    kanal: "ਸੁਨੇਹੇ",
    aboTitel: "ਹੋਰ ਅਨੁਵਾਦ",
    aboText: "Google Play ਰਾਹੀਂ ਬਿੱਲ ਕੀਤਾ ਜਾਂਦਾ ਹੈ। Play Store ਵਿੱਚ ਕਦੇ ਵੀ ਰੱਦ ਕਰੋ।",
    aboStand: "ਇਹ ਚੈਟ: ਇਸ ਮਹੀਨੇ {g} ਵਿੱਚੋਂ {b} ਅਨੁਵਾਦ।",
    aboAktiv: "ਇਸ ਚੈਟ ਵਿੱਚ Diralo {p} ਹੈ।",
    plusName: "Plus",
    plusText: "ਮਹੀਨੇ ਦੇ 1,500 ਅਨੁਵਾਦ, 3 ਚੈਟਾਂ ਤੱਕ",
    familieName: "Family",
    familieText: "ਮਹੀਨੇ ਦੇ 5,000 ਅਨੁਵਾਦ, 10 ਚੈਟਾਂ ਤੱਕ",
    monat: "ਪ੍ਰਤੀ ਮਹੀਨਾ",
    jahr: "ਪ੍ਰਤੀ ਸਾਲ",
    aboNichtDa: "ਸਬਸਕ੍ਰਿਪਸ਼ਨ ਹੁਣੇ ਉਪਲਬਧ ਨਹੀਂ ਹਨ। ਕਿਰਪਾ ਕਰਕੇ ਬਾਅਦ ਵਿੱਚ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    aboDanke: "ਧੰਨਵਾਦ! ਇਹ ਚੈਟ ਹੁਣ ਅਨਲੌਕ ਹੋ ਗਈ ਹੈ।",
    aboWartet: "ਭੁਗਤਾਨ ਦੀ ਹਾਲੇ ਪੁਸ਼ਟੀ ਹੋ ਰਹੀ ਹੈ। ਇਸ ਵਿੱਚ ਕੁਝ ਮਿੰਟ ਲੱਗ ਸਕਦੇ ਹਨ।",
    aboFehler: "ਖ਼ਰੀਦ ਪੂਰੀ ਨਹੀਂ ਹੋ ਸਕੀ।",
    schliessen: "ਬੰਦ ਕਰੋ",
    heute: "ਅੱਜ",
    gestern: "ਕੱਲ੍ਹ",
    ausblenden: "ਹਟਾਉਣ ਲਈ ਟੈਪ ਕਰੋ",
  },
  ne: {
    videoAufnehmen: "भिडियो रेकर्ड गर्नुहोस्",
    videoVorbereiten: "भिडियो तयार हुँदैछ …",
    bonusHinweis: "🎁 तपाईंको व्यक्तिले पनि लेखेपछि, तपाईं दुवैले १ महिना Diralo Plus निःशुल्क पाउनुहुन्छ।",
    bonusDa: "🎁 भयो! यो च्याटका लागि तपाईं दुवैले १ महिना Diralo Plus निःशुल्क पाउनुभयो।",
    anrufMinutenLeer: "यस महिनाको लाइभ सबटाइटल मिनेट सकियो। कल सबटाइटलबिना जारी रहन्छ – Diralo Plus ले तपाईंलाई थप दिन्छ।",
    anrufMinutenRest: "लाइभ सबटाइटल: यस महिना {n} मिनेट बाँकी।",
    anrufen: "कल",
    anrufSprache: "📞 भ्वाइस कल",
    anrufVideo: "🎥 भिडियो कल",
    anrufKommt: "कल गर्दै हुनुहुन्छ …",
    anrufVideoKommt: "भिडियो कल …",
    anrufUntertitelHinweis: "लाइभ सबटाइटलसहित: भनिएको कुरा तपाईं आफ्नै भाषामा पढ्नुहुन्छ।",
    anrufFehler: "अहिले कल लागेन।",
    anrufWartet: "जवाफको प्रतीक्षा गर्दै …",
    anrufKlingelt: "घण्टी बज्दैछ …",
    anrufVorbei: "कल समाप्त भयो",
    anrufAbgelehnt: "जवाफ दिनुभएन",
    updTitel: "नयाँ संस्करण उपलब्ध छ",
    updText: "Diralo सुधारिएको छ। “अपडेट” मा ट्याप गर्नुहोस् – केही क्षण मात्र लाग्छ।",
    updKnopf: "अपडेट",
    updSpaeter: "पछि",
    updPflicht: "Diralo चलिरहन यो अपडेट आवश्यक छ।",
    autoAn: "अब नयाँ सन्देशहरू ठूलो स्वरमा पढिनेछन्।",
    autoAus: "स्वचालित रूपमा पढ्ने सुविधा बन्द छ।",
    keineStimme: "यो भाषाका लागि कुनै आवाज इन्स्टल गरिएको छैन। Android सेटिङ → Text-to-speech output → आवाज डेटा इन्स्टल गर्नुहोस्।",
    imChat: "च्याटमा",
    einlTitel: "के तपाईंलाई निमन्त्रणा आएको छ?",
    einlText: "लिङ्कबाट च्याट कोड हाल्नुहोस्, अनि तपाईं आफ्नो व्यक्तिकै च्याटमा जोडिनुहुन्छ।",
    neuTitel: "कसैलाई निम्त्याउन चाहनुहुन्छ?",
    neuText: "यसले नयाँ, खाली च्याट सुरु गर्छ। त्यसपछि आफ्नो व्यक्तिलाई लिङ्क पठाउनुहोस्।",
    leerTitel: "यो च्याट नयाँ हो",
    leerText2: "यहाँ अहिलेसम्म कोही छैन। आफ्नो व्यक्तिलाई लिङ्क पठाउनुहोस् ताकि उहाँ जोडिन सक्नुहोस्।",
    falschHier: "के तपाईंलाई आफैँ निमन्त्रणा आएको हो? त्यसो भए तपाईं गलत ठाउँमा हुनुहुन्छ।",
    codeEingeben: "फर्केर कोड हाल्नुहोस्",
    umbenennen: "यो च्याटको नाम",
    chatNameBsp: "जस्तै: मारिया 💕",
    lernenTitel: "सिक्नुहोस्",
    lernenMerken: "⭐ सिक्नका लागि सुरक्षित गर्नुहोस्",
    lernenGemerkt: "सुरक्षित भयो – 🎓 मा भेटिन्छ",
    lernenSchon: "यो वाक्य पहिले नै सुरक्षित छ।",
    lernenNichtMoeglich: "यो वाक्यको अझै अनुवाद छैन।",
    lernenKeinPartner: "कसैले अर्को भाषामा लेख्नेबित्तिकै तपाईं यहाँ आफ्नै वाक्यहरूबाट उसको भाषा सिक्न सक्नुहुन्छ।",
    lernenGelernt: "{n} वाक्य सिकियो",
    lernenSerie: "लगातार {n} दिन",
    lernenWie: "{lang} मा यसलाई के भनिन्छ?",
    lernenAufdecken: "देखाउनुहोस्",
    lernenWusste: "मलाई थाहा थियो",
    lernenNochmal: "फेरि",
    lernenFertig: "आजको सबै सकियो! भोलि फेरि।",
    lernenLeer: "अझै कुनै कार्ड छैन। तलको सुझावमा ट्याप गर्नुहोस् वा कुनै सन्देश थिचिराख्नुहोस् → “सिक्नका लागि सुरक्षित गर्नुहोस्”।",
    lernenVorschlaege: "तपाईंहरूको च्याटबाट सुझाव",
    lernenGratis: "आज {n} निःशुल्क कार्ड बाँकी",
    lernenPlus: "आजको सकियो! Diralo सदस्यतासँग असीमित सिक्नुहोस्।",
    lernenPlusKnopf: "योजना हेर्नुहोस्",
    lernenKarten: "{n} कार्ड सुरक्षित",
    lernenPakete: "सुरुवाती प्याक",
    lernenPaketPaar: "जोडी र परिवार",
    lernenPaketArbeit: "काम (निर्माण, खेत, ग्रिनहाउस)",
    lernenPaketAlltag: "दैनिक जीवन, डाक्टर र कार्यालय",
    lernenPaketDazu: "{n} कार्ड थपियो",
    lernenPaketLaedt: "तयार हुँदैछ …",
    lernenTaeglich: "हरेक बिहान ९ बजे एउटा वाक्य",
    lernenAusblenden: "सिक्ने लुकाउनुहोस्",
    lernenAusgeblendet: "सिक्ने लुकाइयो। फेरि खोल्न: च्याटको माथि 👥।",
    lernenEinblenden: "सिक्ने फेरि देखाउनुहोस्",
    lernenEingeblendet: "सिक्ने फर्कियो",
    gruppeErstellen: "मेरो टोलीका लागि समूह बनाउनुहोस्",
    gruppeTipp: "लिङ्कबाट आफ्नो टोलीलाई बोलाउनुहोस् – सबैले आफ्नै भाषामा लेख्छन् र पढ्छन्।",
    aboKnopf: "Diralo Plus & Family",
    anheften: "📌 सबैका लागि पिन गर्नुहोस्",
    losloesen: "पिन हटाउनुहोस्",
    durchsage: "📌 सूचना",
    nurTeamPlus: "पिन गरिएका सूचनाहरू Diralo Team Plus मा पाइन्छ।",
    teamName: "Diralo Team",
    teamText: "व्यवसायका लागि: २० जनासम्म, ३ समूह, महिनामा ५,००० अनुवाद",
    teamplusName: "Diralo Team Plus",
    teamplusText: "ठूला व्यवसायका लागि: ६० जनासम्म, १० समूह, महिनामा १२,००० अनुवाद",
    teamFreischalten: "🏢 व्यवसायका लागि सक्रिय गर्नुहोस्",
    teamVoll: "यो समूह भरियो – Team योजनामा ठाउँ बाँकी छैन। एडमिनलाई भन्नुहोस्।",
    kontingentTeam: "तपाईंहरूको Team योजनाका यो महिनाका {n} अनुवाद सकिए। सन्देशहरू आइरहन्छन्, तर अनुवाद हुँदैनन्।",
    gruppe: "समूह",
    gruppeName: "समूहको नाम",
    gruppeNameBsp: "जस्तै: Estufa Silva – टिम",
    gruppeChef: "👑 एडमिन",
    gruppeDuChef: "तपाईं यो समूहको एडमिन हुनुहुन्छ।",
    gruppeNurChef: "समूहको एडमिनले मात्र यो बदल्न सक्छ।",
    gruppeMitglieder: "{n} सदस्य",
    gruppeEntfernen: "हटाउनुहोस्",
    gruppeEntfernenFrage: "{name} लाई समूहबाट हटाउने? उहाँले यो च्याट फेरि खोल्न सक्नुहुने छैन।",
    gruppeEntferntDu: "तपाईंलाई यो समूहबाट हटाइएको छ।",
    gruppeOnline: "अनलाइन",
    gruppeZuletzt: "पछिल्लो पटक",
    gruppeGelesen: "पढ्नेहरू",
    gruppeUngelesen: "अहिलेसम्म पढेको छैन",
    gruppeHinweis: "च्याटलाई नाम दिनुहोस् – यो सदस्य सूची र “कसले पढ्यो” भएको समूह बन्छ। जसले पहिले नाम दिन्छ, उही समूहको एडमिन हुन्छ।",
    speichern: "सेभ गर्नुहोस्",
    fuerMich: "🙈 मेरा लागि मेटाउनुहोस्",
    geteiltTitel: "सेयर गरिएको – अनुवादित",
    geteiltLaedt: "अनुवाद हुँदैछ …",
    dateiTitel: "फाइल सेयर गर्नुहोस्",
    video: "भिडियो",
    datei: "फाइल",
    dateiGross: "फाइल धेरै ठूलो छ (अधिकतम २५ MB)।",
    dateiFehler: "फाइल पठाउन सकिएन।",
    dateiOeffnen: "खोल्न ट्याप गर्नुहोस्",
    abbrechen2: "रद्द गर्नुहोस्",
    dateiKeinChat: "तपाईंसँग अहिलेसम्म कुनै च्याट छैन। पहिले च्याट सुरु गरेर आफ्नो व्यक्तिलाई निम्त्याउनुहोस्।",
    gifSuchen: "GIF खोज्नुहोस्",
    gifAus: "अहिले GIF उपलब्ध छैनन्।",
    gifFehler: "GIF पठाउन सकिएन।",
    linkTitel: "लिङ्क सेयर गर्नुहोस्",
    linkWelcher: "कुन च्याट?",
    linkKeinChat: "तपाईंसँग अहिलेसम्म कुनै च्याट छैन। पहिले च्याट सुरु गरेर आफ्नो व्यक्तिलाई निम्त्याउनुहोस्।",
    dolmetscher: "🎙\nदोभाषे",
    fotoKnopf: "📷\nफोटो अनुवाद",
    dolmInfo: "फोनलाई तपाईंहरूको बीचमा राख्नुहोस्। हरेक व्यक्तिले आफ्नो माइक्रोफोन ट्याप गरेर आफ्नै भाषामा बोल्नुहोस्।",
    tippenSprechen: "ट्याप गरेर बोल्नुहोस्",
    hoere: "सुन्दैछ …",
    andereSprache: "अर्को भाषा",
    fotoInfo: "मेनु, चिठी वा साइनबोर्डको फोटो खिच्नुहोस् – Diralo ले पाठ पढेर अनुवाद गर्छ।",
    erklaeren: "सजिलोसँग बुझाउनुहोस्",
    erklaerung: "व्याख्या",
    originalText: "मूल पाठ",
    keinText: "फोटोमा कुनै पाठ भेटिएन।",
    fotoLesen: "फोटो पढ्दैछ …",
    zurueck: "पछाडि",
    hilfeFehler: "त्यो भएन। कृपया फेरि प्रयास गर्नुहोस्।",
    vorschau: "यसरी पुग्नेछ:",
    vorschauAus: "पूर्वावलोकन बन्द",
    vorlesen: "🔊 पढेर सुनाउनुहोस्",
    langsam: "🐢 मूल बिस्तारै",
    aussprache: "🗣 उच्चारण",
    ausspracheFehler: "अहिले उच्चारण सहायता उपलब्ध छैन।",
    claim: "जुनसुकै भाषामा च्याट गर्नुहोस्। हरेक सन्देश स्वचालित रूपमा अनुवाद हुन्छ।",
    deinName: "तपाईंको नाम",
    nameBsp: "जस्तै: मारिया",
    deineSprache: "तपाईंको भाषा",
    neuerChat: "नयाँ च्याट सुरु गर्नुहोस्",
    oderBeitreten: "वा च्याटमा जोडिनुहोस्",
    chatCode: "च्याट कोड",
    beitreten: "जोडिनुहोस्",
    meineChats: "मेरा च्याटहरू",
    datenschutz: "अनुवादका लागि हरेक सन्देश सर्भरमा पठाइन्छ र त्यहाँ पढ्न सकिन्छ — WhatsApp जस्तो होइन। अरू कसैले हेर्न नहुने कुरा नलेख्नुहोस्। सबै कुरा ३० दिनपछि मेटाइन्छ।",
    ausListe: "सूचीबाट हटाउने?",
    abbrechen: "रद्द गर्नुहोस्",
    entfernen: "हटाउनुहोस्",
    nochKeine: "अहिलेसम्म प्रयोग भएको छैन।",
    kontingent: "यस महिनाका तपाईंका {n} निःशुल्क अनुवाद सकिए। सन्देशहरू अझै आउँछन्, मूल भाषामा। Diralo Plus ले महिनामा १,५०० दिन्छ।",
    kontingentPlus: "यस महिनाका तपाईंका {n} Diralo Plus अनुवाद सकिए। सन्देशहरू अझै आउँछन्, मूल भाषामा। महिनाको १ गते फेरि सुरु हुन्छ – वा Diralo Family मा जानुहोस्।",
    kontingentFamilie: "यस महिनाका तपाईंका {n} Diralo Family अनुवाद सकिए। सन्देशहरू अझै आउँछन्, मूल भाषामा। महिनाको १ गते फेरि सुरु हुन्छ।",
    uebersFehler: "अहिले अनुवाद सम्भव छैन। सन्देश मूल भाषामा देखाइएको छ।",
    zuVieleJoins: "जोडिने प्रयास धेरै भयो। कृपया केही क्षण पर्खनुहोस्।",
    langsamer: "बिस्तारै - छोटो समयमा धेरै सन्देश भए।",
    fremdGeraet: "यो सन्देश अर्को डिभाइसमा लेखिएको थियो र यहाँबाट मेटाउन सकिँदैन।",
    loeschenFehler: "अहिले मेटाउन सकिँदैन। कृपया पछि फेरि प्रयास गर्नुहोस्।",
    spracheLang: "भ्वाइस सन्देश धेरै लामो छ।",
    spracheFehler: "भ्वाइस सन्देश पठाउन सकिएन।",
    einladung: "Diralo मा मसँग च्याट गर्नुहोस् — हरेकले आफ्नै भाषामा:",
    fuerAlleFrage: "सबैका लागि मेटाउने?",
    verschwindet: "सन्देश अर्को व्यक्तिका लागि पनि हराउनेछ।",
    loeschen: "मेटाउनुहोस्",
    ohneKamera: "क्यामेरा अनुमतिबिना सम्भव छैन।",
    ohneFotos: "फोटोहरूको पहुँचबिना सम्भव छैन।",
    fotoGross: "फोटो धेरै ठूलो छ।",
    fotoFehler: "फोटो पठाउन सकिएन।",
    ohneStandort: "लोकेसन अनुमतिबिना सम्भव छैन।",
    standortFehler: "लोकेसन पत्ता लगाउन सकिएन।",
    senden: "पठाउनुहोस्",
    galerie: "ग्यालरीबाट फोटो",
    kamera: "क्यामेरा",
    standort: "लोकेसन",
    einladen: "निम्त्याउनुहोस्",
    verbunden: "जोडियो",
    verbinde: "जोडिँदैछ ...",
    du: "तपाईं",
    Du: "तपाईं",
    leer: "अहिलेसम्म कुनै सन्देश छैन। पहिलो लेख्नुहोस् - यो स्वचालित रूपमा अनुवाद हुनेछ।",
    antworten: "↩ जवाफ दिनुहोस्",
    fuerAlle: "🗑 सबैका लागि मेटाउनुहोस्",
    schreiben: "सन्देश",
    geloescht: "सन्देश मेटाइयो",
    kartenTipp: "नक्सामा खोल्न ट्याप गर्नुहोस्",
    nichtMehrDa: "सन्देश अब उपलब्ध छैन",
    sprachnachricht: "भ्वाइस सन्देश",
    foto: "फोटो",
    aufnahmeFehler: "रेकर्डिङ सम्भव छैन: ",
    ohneMikro: "माइक्रोफोन अनुमतिबिना सम्भव छैन।",
    android13: "भ्वाइस सन्देशका लागि Android 13 वा नयाँ चाहिन्छ।",
    kanal: "सन्देशहरू",
    aboTitel: "थप अनुवाद",
    aboText: "Google Play मार्फत बिल गरिन्छ। Play Store मा जुनसुकै बेला रद्द गर्नुहोस्।",
    aboStand: "यो च्याट: यस महिना {g} मध्ये {b} अनुवाद।",
    aboAktiv: "यो च्याटमा Diralo {p} छ।",
    plusName: "Plus",
    plusText: "महिनामा १,५०० अनुवाद, ३ च्याटसम्म",
    familieName: "Family",
    familieText: "महिनामा ५,००० अनुवाद, १० च्याटसम्म",
    monat: "प्रति महिना",
    jahr: "प्रति वर्ष",
    aboNichtDa: "अहिले सदस्यता उपलब्ध छैन। कृपया पछि फेरि प्रयास गर्नुहोस्।",
    aboDanke: "धन्यवाद! यो च्याट अब अनलक भयो।",
    aboWartet: "भुक्तानी अझै पुष्टि हुँदैछ। यसमा केही मिनेट लाग्न सक्छ।",
    aboFehler: "खरिद पूरा गर्न सकिएन।",
    schliessen: "बन्द गर्नुहोस्",
    heute: "आज",
    gestern: "हिजो",
    ausblenden: "हटाउन ट्याप गर्नुहोस्",
  },
};
let uiSprache = "de";
const uiCode = (code) => {
  const c = String(code || "").toLowerCase();
  const b = c.split("-")[0];
  return ["de", "pt", "es", "fr", "it", "ja", "hi", "ur", "bn", "pa", "ne"].includes(b) ? b : "en";
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

const LINK_RE = /https?:\/\/\S+/i;

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
async function chatBenennen(code, name) {
  const liste = await chatsLaden();
  const da = liste.find((c) => c.code === code);
  if (da) da.name = String(name || "").trim().slice(0, 40);
  try { await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(liste)); } catch {}
}
/* Gruppenname vom Server: als Chat-Name uebernehmen, solange man den Chat
   nicht selbst anders benannt hat. */
async function chatGruppeMerken(code, name) {
  const liste = await chatsLaden();
  const da = liste.find((c) => c.code === code);
  if (!da || da.gruppe === name) return;
  if (!da.name || da.name === da.gruppe) da.name = String(name || "").trim().slice(0, 40);
  da.gruppe = name;
  try { await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(liste)); } catch {}
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
  ja: "ja-JP", ko: "ko-KR", hi: "hi-IN", ur: "ur-PK", bn: "bn-BD", pa: "pa-IN", ne: "ne-NP", sv: "sv-SE", ro: "ro-RO", da: "da-DK",
  no: "nb-NO", fi: "fi-FI", cs: "cs-CZ", hu: "hu-HU", el: "el-GR", he: "he-IL",
  th: "th-TH", vi: "vi-VN", id: "id-ID", "es-419": "es-MX",
};
const erkennerSprache = (code) => REGION[code] || (code.includes("-") ? code : `${code}-${code.toUpperCase()}`);

const medienUrl = (id) => `${SERVER_URL}/medien/${encodeURIComponent(id)}`;

/* Datei oder Video unveraendert in einen Chat schicken - ohne Uebersetzung.
   Der Koerper ist die Datei selbst, Name und Art stehen in der Adresse. */
const DATEI_MAX_BYTES = 25_000_000;
async function dateiHochladen(datei, { raum, device, name, lang }) {
  const blob = await (await fetch(datei.uri)).blob();
  if (blob.size > DATEI_MAX_BYTES) throw Object.assign(new Error("gross"), { gross: true });
  const q = {
    room: raum, device, name, lang,
    mime: datei.mime || blob.type || "application/octet-stream",
    dateiname: datei.name || "Datei",
  };
  const adresse = `${SERVER_URL}/api/datei?` + Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ""))}`).join("&");
  const r = await fetch(adresse, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob,
  });
  if (r.status === 413) throw Object.assign(new Error("gross"), { gross: true });
  if (!r.ok) throw new Error("fehler");
}

/* Videos vor dem Senden verkleinern, wie WhatsApp: Handyvideos sind
   sonst nach wenigen Sekunden groesser als die 25 MB, die der Server
   annimmt. Klappt das Verkleinern nicht, geht das Original. */
/* Auf manchen Handys bleibt das Verkleinern ohne Fehler einfach stehen -
   dann hing "Video wird vorbereitet" fuer immer und nichts kam an. Nach
   spaetestens 2 Minuten (bzw. 25 s ohne jeden Fortschritt) geht deshalb
   das Original raus; ist es zu gross, sagt das der Hochladen-Schritt. */
async function videoKlein(uri, beiFortschritt) {
  let abbruch = null;
  try {
    const zeitUm = new Promise((fertig) => {
      const start = Date.now();
      let zuletzt = Date.now();
      const uhr = setInterval(() => {
        if (Date.now() - start > 120_000 || Date.now() - zuletzt > 25_000) { clearInterval(uhr); fertig(null); }
      }, 1000);
      abbruch = { uhr, weiter: () => { zuletzt = Date.now(); } };
    });
    const klein = VideoKompressor.compress(uri, { compressionMethod: "auto" }, (p) => {
      abbruch?.weiter();
      beiFortschritt?.(Math.round(Number(p || 0) * 100));
    }).catch(() => null);
    const neu = await Promise.race([klein, zeitUm]);
    return neu || uri;
  } catch {
    return uri;
  } finally {
    if (abbruch) clearInterval(abbruch.uhr);
  }
}

function groesseText(b) {
  if (!b) return "";
  return b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`;
}

/* Chat-Code wie auf der Web-Startseite: 10 Zeichen ohne i l o 0 1
   (die verwechselt man beim Vorlesen). */
function neuerCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/* Geheimer Geraete-Schluessel: Die Kennung unten ist oeffentlich (sie steht
   an jeder Nachricht). Nur wer diesen Schluessel hat, darf "als" dieses
   Geraet loeschen oder eine Gruppe verwalten. Bleibt auf dem Handy; der
   Server kennt nur einen Abdruck. Wird beim Start einmal geladen. */
let GEHEIM = null;
async function geheimLaden() {
  try {
    GEHEIM = await AsyncStorage.getItem("diralo_geheim");
    if (!GEHEIM) {
      let g = "";
      while (g.length < 48) g += Math.random().toString(36).slice(2);
      GEHEIM = (g + Date.now().toString(36)).slice(0, 56);
      await AsyncStorage.setItem("diralo_geheim", GEHEIM);
    }
  } catch {}
  return GEHEIM;
}

/* Bewertung im Play Store - ueber Googles eigenes Fenster (In-App Review).
   Gefragt wird nur, wer Diralo wirklich benutzt: mindestens 20 Nachrichten
   von anderen bekommen, die App seit 2 Tagen, und hoechstens alle 90 Tage.
   Ob das Fenster dann erscheint, entscheidet Google selbst (es hat eigene
   Grenzen); nie mit Belohnung, nie nur an Zufriedene - so will es Google. */
async function vielleichtBewerten() {
  try {
    const d = await jsonLaden("diralo_bewertung", {});
    d.n = (d.n || 0) + 1;
    d.erst = d.erst || Date.now();
    const tag = 24 * 60 * 60 * 1000;
    let fragen = d.n >= 20 && Date.now() - d.erst >= 2 * tag && (!d.zuletzt || Date.now() - d.zuletzt >= 90 * tag);
    if (fragen && !(await StoreReview.hasAction())) fragen = false;
    if (fragen) d.zuletzt = Date.now();
    await AsyncStorage.setItem("diralo_bewertung", JSON.stringify(d));
    if (fragen) setTimeout(() => StoreReview.requestReview().catch(() => {}), 2000);
  } catch {}
}

/* Dauerhafte Geraete-Kennung (fuer "meine" Nachrichten + Server-Limits). */
async function geraeteId() {
  try {
    let id = await AsyncStorage.getItem("diralo_device");
    if (!id) {
      /* Neue Installation: Die Android-ID bleibt fuer diese App auf diesem
         Handy gleich, auch nach Deinstallieren und Neuinstallieren. So
         bleiben eigene Nachrichten eigene (Haken, Loeschen). */
      let android = "";
      try { android = Platform.OS === "android" ? Application.getAndroidId() : ""; } catch {}
      id = android ? "and_" + android : "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  const [gruppeNeu, setGruppeNeu] = useState(false);   // neuer Chat soll gleich als Gruppe benannt werden
  const [ansicht, setAnsicht] = useState(null); // "dolmetsch" | "foto" | "geteilt" | null
  /* Teilen-Menue von Android: Text oder Bild aus einer anderen App. */
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ resetOnBackground: true });
  const [geteilt, setGeteilt] = useState(null);
  const [linkTeilen, setLinkTeilen] = useState(null);
  const [entwurf, setEntwurf] = useState("");
  const [dateiEntwurf, setDateiEntwurf] = useState(null);
  useEffect(() => {
    if (!hasShareIntent) return;
    const bild = (shareIntent.files || []).find((f) => String(f.mimeType || "").startsWith("image/"));
    const text = shareIntent.text || shareIntent.webUrl || "";
    /* Videos, PDFs usw.: unveraendert in einen Chat schicken. */
    const andere = (shareIntent.files || []).find((f) => !String(f.mimeType || "").startsWith("image/"));
    if (!bild && andere) {
      setLinkTeilen({
        datei: { uri: andere.path, name: andere.fileName || "Datei", mime: andere.mimeType || "", groesse: andere.size || 0 },
        nr: Date.now(),
      });
      setAnsicht("link");
      resetShareIntent();
      return;
    }
    /* Links (YouTube, Instagram, TikTok ...) nicht uebersetzen, sondern
       unveraendert in einen Chat schicken. */
    if (!bild && LINK_RE.test(text)) {
      setLinkTeilen({ text: text.trim(), nr: Date.now() });
      setAnsicht("link");
      resetShareIntent();
      return;
    }
    if (bild || text.trim()) {
      setGeteilt({ text: text.trim(), bild: bild?.path || null, nr: Date.now() });
      setAnsicht("geteilt");
    }
    resetShareIntent();
  }, [hasShareIntent]);

  useEffect(() => {
    (async () => {
      await geheimLaden();
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

  /* Einladungs-Link angetippt (diralo.app/#c=...): Android oeffnet die App
     statt des Browsers. Mit Namen geht es direkt in den Chat, sonst steht
     der Code auf der Startseite schon im Feld. */
  const [linkCode, setLinkCode] = useState(null);
  useEffect(() => {
    Linking.getInitialURL().then((u) => { const c = codeAusLink(u); if (c) setLinkCode(c); }).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => { const c = codeAusLink(url); if (c) setLinkCode(c); });
    return () => sub.remove();
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

  useEffect(() => {
    if (!bereit || !linkCode || !device) return;
    if (name.trim()) { setAnsicht(null); betreten(linkCode); setLinkCode(null); }
  }, [bereit, linkCode, device, name, betreten]);

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
        {ansicht === "link" && linkTeilen ? (
          <LinkTeilen
            daten={linkTeilen} unten={insets.bottom}
            onBack={() => { setAnsicht(null); setLinkTeilen(null); }}
            onWahl={(code) => {
              if (linkTeilen.datei) setDateiEntwurf(linkTeilen.datei);
              else setEntwurf(linkTeilen.text);
              setAnsicht(null); setLinkTeilen(null);
              if (name.trim()) betreten(code);
            }}
          />
        ) : ansicht === "geteilt" && geteilt ? (
          <Geteilt daten={geteilt} lang={lang} device={device} unten={insets.bottom} onBack={() => { setAnsicht(null); setGeteilt(null); }} />
        ) : ansicht === "dolmetsch" ? (
          <Dolmetscher lang={lang} device={device} unten={insets.bottom} onBack={() => setAnsicht(null)} />
        ) : ansicht === "foto" ? (
          <FotoUebersetzen lang={lang} device={device} unten={insets.bottom} onBack={() => setAnsicht(null)} />
        ) : raum ? (
          <Chat
            raum={raum} name={name.trim()} lang={lang} device={device}
            unten={insets.bottom} oben={insets.top}
            entwurf={entwurf} onEntwurfWeg={() => setEntwurf("")}
            dateiEntwurf={dateiEntwurf} onDateiWeg={() => setDateiEntwurf(null)}
            onBack={() => { setGruppeNeu(false); verlassen(); }}
            gruppeStart={gruppeNeu} onGruppeStartWeg={() => setGruppeNeu(false)}
          />
        ) : (
          <Home
            name={name} setName={setName}
            lang={lang} setLang={setLang}
            device={device}
            unten={insets.bottom}
            onStart={() => betreten(neuerCode())}
            onGruppe={() => { setGruppeNeu(true); betreten(neuerCode()); }}
            onJoin={betreten}
            vorCode={linkCode}
            onHilfe={setAnsicht}
          />
        )}
      </View>
    </View>
  );
}

/* ----------------------------- Startseite ------------------------- */
/* Update-Hinweis: Beim Start fragt die App den Server nach der neuesten
   Version. Ist die installierte aelter, bieten wir das Update an; unter
   der Mindestversion ist es Pflicht (Fenster laesst sich nicht schliessen). */
const PLAY_ID = Application.applicationId || "app.diralo.twa";
function playStoreOeffnen() {
  Linking.openURL(`market://details?id=${PLAY_ID}`)
    .catch(() => Linking.openURL(`https://play.google.com/store/apps/details?id=${PLAY_ID}`));
}
function useUpdateStand() {
  const [stand, setStand] = useState(null);   // null | "neu" | "pflicht"
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const meine = Number(Application.nativeBuildVersion || 0);
    if (!meine) return;
    fetch(`${SERVER_URL}/api/app-version`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (!v) return;
        if (meine < Number(v.minimum || 0)) setStand("pflicht");
        else if (meine < Number(v.aktuell || 0)) setStand("neu");
      })
      .catch(() => {});
  }, []);
  return [stand, setStand];
}

function UpdateHinweis() {
  const [stand, setStand] = useUpdateStand();
  if (!stand) return null;
  const pflicht = stand === "pflicht";
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!pflicht) setStand(null); }}>
      <View style={s.modalHinten} />
      <View style={s.benennenBox}>
        <Text style={s.modalTitel}>⬆️ {t("updTitel")}</Text>
        <Text style={[s.wegText, { marginTop: 8 }]}>{pflicht ? t("updPflicht") : t("updText")}</Text>
        <Pressable style={[s.btnPrimary, { marginTop: 14 }]} onPress={playStoreOeffnen}>
          <Text style={s.btnPrimaryTxt}>{t("updKnopf")}</Text>
        </Pressable>
        {!pflicht && (
          <Pressable style={{ marginTop: 12, alignSelf: "center", padding: 6 }} onPress={() => setStand(null)} hitSlop={8}>
            <Text style={{ color: FARBE.grau, fontSize: 15 }}>{t("updSpaeter")}</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

function Home({ name, setName, lang, setLang, device, unten, onStart, onGruppe, onJoin, onHilfe, vorCode = null }) {
  const [code, setCode] = useState("");
  /* Code aus einem Einladungs-Link schon eintragen (Name fehlt noch). */
  useEffect(() => { if (vorCode) setCode(vorCode); }, [vorCode]);
  const [chats, setChats] = useState([]);
  const [neues, setNeues] = useState({});
  const [sprachWahl, setSprachWahl] = useState(false);
  const [benennen, setBenennen] = useState(null);   // { code, name }
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

      {/* Zwei klar getrennte Wege: Wer eine Einladung bekommen hat, soll
          nicht aus Versehen einen neuen, leeren Chat starten. */}
      <View style={s.wegKarte}>
        <Text style={s.wegTitel}>{t("einlTitel")}</Text>
        <Text style={s.wegText}>{t("einlText")}</Text>
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
      </View>

      <View style={s.wegKarte}>
        <Text style={s.wegTitel}>{t("neuTitel")}</Text>
        <Text style={s.wegText}>{t("neuText")}</Text>
        <Pressable
          style={[s.btnPrimary, !kannLos && s.btnAus]}
          disabled={!kannLos} onPress={onStart}
        >
          <Text style={s.btnPrimaryTxt}>{t("neuerChat")}</Text>
        </Pressable>
        {/* Fuer Chefs: Gruppe anlegen, gleich benennen, dann einladen. */}
        <Pressable
          style={[s.btnGruppe, !kannLos && s.btnAus]}
          disabled={!kannLos} onPress={onGruppe}
        >
          <Text style={s.btnGruppeTxt}>👥 {t("gruppeErstellen")}</Text>
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
                  onLongPress={() => setBenennen({ code: c.code, name: c.name || "" })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.chatOffenTxt} numberOfLines={1}>{c.name || "#" + c.code}</Text>
                    {c.name ? <Text style={s.chatCodeKlein} numberOfLines={1}>#{c.code}</Text> : null}
                  </View>
                  {n > 0 && <View style={s.neu}><Text style={s.neuTxt}>{n > 99 ? "99+" : n}</Text></View>}
                </Pressable>
                <Pressable style={[s.input, s.chatWeg]} onPress={() => setBenennen({ code: c.code, name: c.name || "" })} hitSlop={4}>
                  <Text style={s.chatWegTxt}>✎</Text>
                </Pressable>
                <Pressable style={[s.input, s.chatWeg]} onPress={() => vergessen(c)} hitSlop={4}>
                  <Text style={s.chatWegTxt}>✕</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <View style={s.hilfeRow}>
        <Pressable style={s.hilfeKnopf} onPress={() => onHilfe("dolmetsch")}>
          <Text style={s.hilfeKnopfTxt}>{t("dolmetscher")}</Text>
        </Pressable>
        <Pressable style={s.hilfeKnopf} onPress={() => onHilfe("foto")}>
          <Text style={s.hilfeKnopfTxt}>{t("fotoKnopf")}</Text>
        </Pressable>
      </View>

      <Modal visible={Boolean(benennen)} transparent animationType="fade" onRequestClose={() => setBenennen(null)}>
        <Pressable style={s.modalHinten} onPress={() => setBenennen(null)} />
        <View style={s.benennenBox}>
          <Text style={s.modalTitel}>{t("umbenennen")}</Text>
          <Text style={s.chatCodeKlein}>#{benennen?.code}</Text>
          <TextInput
            style={[s.input, { marginTop: 10 }]} autoFocus maxLength={40}
            value={benennen?.name || ""} onChangeText={(v) => setBenennen((b) => ({ ...b, name: v }))}
            placeholder={t("chatNameBsp")} placeholderTextColor={FARBE.grau}
          />
          <Pressable
            style={[s.btnPrimary, { marginTop: 12 }]}
            onPress={async () => { await chatBenennen(benennen.code, benennen.name); setBenennen(null); laden(); }}
          >
            <Text style={s.btnPrimaryTxt}>{t("speichern")}</Text>
          </Pressable>
        </View>
      </Modal>

      <Text style={s.note}>
        {t("datenschutz")}
      </Text>
      <UpdateHinweis />
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

/* GIF-Suche (ueber unseren Server, der KLIPY fragt). Leeres Feld = Beliebte. */
function GifSuche({ lang, onGif }) {
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState(null);
  const [aus, setAus] = useState(false);
  useEffect(() => {
    let weg = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/gif/suche?q=${encodeURIComponent(q.trim())}&lang=${encodeURIComponent(lang)}`);
        if (!r.ok) throw new Error();
        const j = await r.json();
        if (!weg) { setGifs(j.gifs || []); setAus(false); }
      } catch {
        if (!weg) { setGifs([]); setAus(true); }
      }
    }, q ? 400 : 0);
    return () => { weg = true; clearTimeout(timer); };
  }, [q]);
  return (
    <View style={{ flex: 1 }}>
      <TextInput
        style={s.gifSuche} value={q} onChangeText={setQ}
        placeholder={t("gifSuchen")} placeholderTextColor={FARBE.grau}
      />
      {gifs === null ? <ActivityIndicator color={FARBE.navy} style={{ marginTop: 16 }} /> : null}
      {aus ? <Text style={s.leer}>{t("gifAus")}</Text> : null}
      <FlatList
        data={gifs || []} numColumns={3} keyExtractor={(g) => g.id}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ padding: 4 }}
        renderItem={({ item }) => (
          <Pressable style={s.gifZelle} onPress={() => onGif(item.gross)}>
            <GifBild source={{ uri: item.klein.url }} style={{ flex: 1, borderRadius: 6 }} contentFit="cover" autoplay />
          </Pressable>
        )}
        ListFooterComponent={gifs && gifs.length ? <Text style={s.gifQuelle}>Powered by KLIPY</Text> : null}
      />
    </View>
  );
}

function EmojiAuswahl({ zuletzt, onWahl, lang, onGif }) {
  const [gruppe, setGruppe] = useState(zuletzt.length ? 0 : 1);
  const istGif = gruppe === "gif";
  const zeichen = istGif ? [] : gruppe === 0 ? zuletzt : EMOJI[gruppe][1].split(" ");
  return (
    <View style={s.emojiPanel}>
      <View style={s.emojiTabs}>
        {EMOJI.map(([icon], i) => (
          <Pressable key={i} onPress={() => setGruppe(i)} style={[s.emojiTab, gruppe === i && s.emojiTabAn]}>
            <Text style={s.emojiTabTxt}>{icon}</Text>
          </Pressable>
        ))}
        {onGif ? (
          <Pressable onPress={() => setGruppe("gif")} style={[s.emojiTab, istGif && s.emojiTabAn]}>
            <Text style={s.gifTabTxt}>GIF</Text>
          </Pressable>
        ) : null}
      </View>
      {istGif ? <GifSuche lang={lang} onGif={onGif} /> : <ScrollView contentContainerStyle={s.emojiGrid} keyboardShouldPersistTaps="always">
        {zeichen.length === 0 && <Text style={s.leer}>{t("nochKeine")}</Text>}
        {zeichen.map((ch, i) => (
          <Pressable key={ch + i} onPress={() => onWahl(ch)} style={s.emojiZelle}>
            <Text style={s.emojiZeichen}>{ch}</Text>
          </Pressable>
        ))}
      </ScrollView>}
    </View>
  );
}

/* --------------------------- Dolmetscher ---------------------------
   Zwei Menschen, ein Handy: Die obere Haelfte steht auf dem Kopf, damit
   das Gegenueber sie lesen kann. Jeder tippt auf sein Mikrofon und
   spricht; die Uebersetzung erscheint bei der anderen Haelfte und wird
   in deren Sprache vorgelesen. */
function Dolmetscher({ lang, device, unten, onBack }) {
  const [andere, setAndere] = useState(lang.startsWith("pt") ? "de" : "pt-PT");
  const [wahl, setWahl] = useState(false);
  const [aktiv, setAktiv] = useState(null);        // "ich" | "du" | null
  const [zwischen, setZwischen] = useState("");
  const [ich, setIch] = useState({ gesagt: "", fuerMich: "" });
  const [du, setDu] = useState({ gesagt: "", fuerMich: "" });
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState(null);
  const seite = useRef(null);
  const text = useRef("");

  const sprachVon = (sd) => (sd === "ich" ? lang : andere);

  useSpeechRecognitionEvent("result", (ev) => {
    const tx = ev.results?.[0]?.transcript || "";
    text.current = tx;
    setZwischen(tx);
  });
  useSpeechRecognitionEvent("error", (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") setFehler(t("aufnahmeFehler") + (ev.message || ev.error));
  });
  useSpeechRecognitionEvent("end", async () => {
    const sd = seite.current;
    const gesagt = text.current.trim();
    seite.current = null; setAktiv(null); setZwischen("");
    if (!sd || !gesagt) return;
    const von = sprachVon(sd), nach = sd === "ich" ? andere : lang;
    if (sd === "ich") setIch((a) => ({ ...a, gesagt })); else setDu((a) => ({ ...a, gesagt }));
    setLaedt(true);
    try {
      const r = await fetch(`${SERVER_URL}/api/dolmetsch`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: gesagt, von, nach, device }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.uebersetzt) throw new Error();
      if (sd === "ich") setDu((a) => ({ ...a, fuerMich: j.uebersetzt }));
      else setIch((a) => ({ ...a, fuerMich: j.uebersetzt }));
      vorlesen(j.uebersetzt, nach);
    } catch {
      setFehler(t("hilfeFehler"));
    } finally {
      setLaedt(false);
    }
  });

  const sprechen = async (sd) => {
    setFehler(null);
    if (aktiv) { ExpoSpeechRecognitionModule.stop(); return; }
    const recht = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!recht.granted) { setFehler(t("ohneMikro")); return; }
    try { Speech.stop(); } catch {}
    seite.current = sd; text.current = ""; setAktiv(sd);
    ExpoSpeechRecognitionModule.start({ lang: erkennerSprache(sprachVon(sd)), interimResults: true, continuous: false });
  };

  const Haelfte = ({ sd, daten, oben }) => (
    <View style={[s.dolmHaelfte, oben && s.dolmOben]}>
      <Text style={s.dolmSprache}>{sprachName(sprachVon(sd))}</Text>
      <ScrollView style={{ flex: 1, alignSelf: "stretch" }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
        {daten.fuerMich ? <Text style={s.dolmGross}>{daten.fuerMich}</Text> : null}
        {aktiv === sd && zwischen ? <Text style={s.dolmKlein}>{zwischen}</Text>
          : daten.gesagt ? <Text style={s.dolmKlein}>„{daten.gesagt}“</Text> : null}
      </ScrollView>
      <Pressable
        style={[s.dolmMikro, aktiv === sd && s.aufnahmeAn, (laedt || (aktiv && aktiv !== sd)) && s.btnAus]}
        disabled={laedt || Boolean(aktiv && aktiv !== sd)}
        onPress={() => sprechen(sd)}
      >
        <Text style={s.dolmMikroTxt}>{aktiv === sd ? "■" : "🎤"}</Text>
      </Pressable>
      <Text style={s.dolmHinweis}>{aktiv === sd ? t("hoere") : t("tippenSprechen")}</Text>
    </View>
  );

  return (
    <View style={[s.full, { backgroundColor: FARBE.hell }]}>
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <Text style={[s.chatTitel, { flex: 1 }]}>{t("dolmetscher")}</Text>
        <Pressable onPress={() => setWahl(true)} style={s.einladen} hitSlop={8}>
          <Text style={s.einladenTxt}>{t("andereSprache")}</Text>
        </Pressable>
      </View>
      <Haelfte sd="du" daten={du} oben />
      <View style={s.dolmTrenner}>
        {laedt ? <ActivityIndicator color={FARBE.navy} /> : <Text style={s.dolmInfo}>{fehler || t("dolmInfo")}</Text>}
      </View>
      <View style={{ flex: 1, paddingBottom: unten }}>
        <Haelfte sd="ich" daten={ich} />
      </View>
      <Sprachauswahl
        offen={wahl} aktuell={andere}
        onWahl={(c) => { setAndere(c); setWahl(false); setDu({ gesagt: "", fuerMich: "" }); setIch({ gesagt: "", fuerMich: "" }); }}
        onZu={() => setWahl(false)}
      />
    </View>
  );
}

/* ----------------------------- Geteilt -----------------------------
   Was ueber "Teilen -> Diralo" aus einer anderen App kommt: Text wird
   uebersetzt und kurz erklaert, ein Bild wie bei "Foto uebersetzen" gelesen. */
/* Geteilter Link: Chat auswaehlen, der Link landet dort im Eingabefeld. */
function LinkTeilen({ daten, unten, onBack, onWahl }) {
  const [chats, setChats] = useState(null);
  useEffect(() => { chatsLaden().then(setChats); }, [daten.nr]);
  return (
    <View style={[s.full, { backgroundColor: FARBE.hell }]}>
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <Text style={[s.chatTitel, { flex: 1 }]}>{t(daten.datei ? "dateiTitel" : "linkTitel")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 + unten }}>
        <View style={s.fotoKarte}>
          <Text style={s.fotoKarteTxt} numberOfLines={4}>
            {daten.datei
              ? `${String(daten.datei.mime).startsWith("video/") ? "🎬" : "📎"} ${daten.datei.name}  ${groesseText(daten.datei.groesse)}`
              : `🔗 ${daten.text}`}
          </Text>
        </View>
        {chats === null ? <ActivityIndicator color={FARBE.navy} style={{ marginTop: 20 }} /> : null}
        {chats && chats.length === 0 ? <Text style={s.leer}>{t("linkKeinChat")}</Text> : null}
        {chats && chats.length > 0 ? <Text style={[s.label, { marginTop: 18 }]}>{t("linkWelcher")}</Text> : null}
        {(chats || []).map((c) => (
          <Pressable key={c.code} style={[s.input, s.chatOffen, { marginTop: 8 }]} onPress={() => onWahl(c.code)}>
            <View style={{ flex: 1 }}>
              <Text style={s.chatOffenTxt} numberOfLines={1}>{c.name || "#" + c.code}</Text>
              {c.name ? <Text style={s.chatCodeKlein} numberOfLines={1}>#{c.code}</Text> : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function Geteilt({ daten, lang, device, unten, onBack }) {
  const [laedt, setLaedt] = useState(true);
  const [ergebnis, setErgebnis] = useState(null);
  const [fehler, setFehler] = useState(null);

  useEffect(() => {
    let weg = false;
    (async () => {
      setLaedt(true); setFehler(null); setErgebnis(null);
      try {
        let r;
        if (daten.bild) {
          const klein = await manipulateAsync(daten.bild, [{ resize: { width: FOTO_MAX_BREITE } }], {
            compress: 0.8, format: SaveFormat.JPEG, base64: true,
          });
          r = await fetch(`${SERVER_URL}/api/foto-text`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bild: klein.base64, lang, erklaeren: true, device }),
          });
        } else {
          r = await fetch(`${SERVER_URL}/api/text-erklaeren`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: daten.text, lang, erklaeren: true, device }),
          });
        }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error();
        if (!weg) setErgebnis({ ...j, original: j.original || daten.text });
      } catch {
        if (!weg) setFehler(t("hilfeFehler"));
      } finally {
        if (!weg) setLaedt(false);
      }
    })();
    return () => { weg = true; };
  }, [daten.nr]);

  return (
    <View style={[s.full, { backgroundColor: FARBE.hell }]}>
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <Text style={[s.chatTitel, { flex: 1 }]}>{t("geteiltTitel")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 + unten }}>
        {laedt && (
          <View style={{ alignItems: "center", marginTop: 24 }}>
            <ActivityIndicator size="large" color={FARBE.navy} />
            <Text style={s.leer}>{daten.bild ? t("fotoLesen") : t("geteiltLaedt")}</Text>
          </View>
        )}
        {fehler && <Text style={s.aboFehler}>{fehler}</Text>}
        {ergebnis && !ergebnis.uebersetzt && <Text style={s.leer}>{t("keinText")}</Text>}
        {ergebnis?.uebersetzt ? (
          <View style={s.fotoKarte}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[s.fotoKarteTitel, { flex: 1 }]}>{sprachName(lang)}</Text>
              <Pressable onPress={() => vorlesen(ergebnis.uebersetzt, lang)} hitSlop={8}><Text style={s.vorschauKnopf}>🔊</Text></Pressable>
            </View>
            <Text style={s.fotoKarteTxt} selectable>{ergebnis.uebersetzt}</Text>
          </View>
        ) : null}
        {ergebnis?.erklaerung ? (
          <View style={s.fotoKarte}>
            <Text style={s.fotoKarteTitel}>{t("erklaerung")}</Text>
            <Text style={s.fotoKarteTxt}>{ergebnis.erklaerung}</Text>
          </View>
        ) : null}
        {ergebnis?.original ? (
          <View style={s.fotoKarte}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[s.fotoKarteTitel, { flex: 1 }]}>{t("originalText")}</Text>
              {ergebnis.sprache ? (
                <Pressable onPress={() => vorlesen(ergebnis.original, ergebnis.sprache)} hitSlop={8}><Text style={s.vorschauKnopf}>🔊</Text></Pressable>
              ) : null}
            </View>
            <Text style={[s.fotoKarteTxt, { color: FARBE.grau }]} selectable>{ergebnis.original}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* -------------------------- Foto uebersetzen -------------------------- */
function FotoUebersetzen({ lang, device, unten, onBack }) {
  const [erklaeren, setErklaeren] = useState(true);
  const [laedt, setLaedt] = useState(false);
  const [ergebnis, setErgebnis] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [zeigeOriginal, setZeigeOriginal] = useState(false);

  const los = async (quelle) => {
    setFehler(null);
    try {
      const recht = quelle === "kamera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!recht.granted) { setFehler(quelle === "kamera" ? t("ohneKamera") : t("ohneFotos")); return; }
      const opt = { mediaTypes: ["images"], quality: 1 };
      const wahl = quelle === "kamera" ? await ImagePicker.launchCameraAsync(opt) : await ImagePicker.launchImageLibraryAsync(opt);
      if (wahl.canceled || !wahl.assets?.length) return;
      setLaedt(true); setErgebnis(null); setZeigeOriginal(false);
      const a = wahl.assets[0];
      const resize = a.width > FOTO_MAX_BREITE ? [{ resize: { width: FOTO_MAX_BREITE } }] : [];
      const klein = await manipulateAsync(a.uri, resize, { compress: 0.8, format: SaveFormat.JPEG, base64: true });
      const r = await fetch(`${SERVER_URL}/api/foto-text`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bild: klein.base64, lang, erklaeren, device }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error();
      setErgebnis(j);
    } catch {
      setFehler(t("hilfeFehler"));
    } finally {
      setLaedt(false);
    }
  };

  return (
    <View style={[s.full, { backgroundColor: FARBE.hell }]}>
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <Text style={[s.chatTitel, { flex: 1 }]}>{t("fotoKnopf")}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 + unten }}>
        <Text style={s.claim}>{t("fotoInfo")}</Text>
        <View style={s.hilfeRow}>
          <Pressable style={[s.btnPrimary, { flex: 1 }, laedt && s.btnAus]} disabled={laedt} onPress={() => los("kamera")}>
            <Text style={s.btnPrimaryTxt}>📷 {t("kamera")}</Text>
          </Pressable>
          <Pressable style={[s.btnGold, { flex: 1, alignItems: "center", paddingVertical: 14 }, laedt && s.btnAus]} disabled={laedt} onPress={() => los("galerie")}>
            <Text style={s.btnGoldTxt}>🖼 {t("galerie")}</Text>
          </Pressable>
        </View>
        <Pressable style={s.schalterZeile} onPress={() => setErklaeren(!erklaeren)}>
          <Text style={s.schalterBox}>{erklaeren ? "☑" : "☐"}</Text>
          <Text style={s.schalterTxt}>{t("erklaeren")}</Text>
        </Pressable>
        {laedt && (
          <View style={{ alignItems: "center", marginTop: 24 }}>
            <ActivityIndicator size="large" color={FARBE.navy} />
            <Text style={s.leer}>{t("fotoLesen")}</Text>
          </View>
        )}
        {fehler && <Text style={s.aboFehler}>{fehler}</Text>}
        {ergebnis && !ergebnis.uebersetzt && <Text style={s.leer}>{t("keinText")}</Text>}
        {ergebnis?.erklaerung ? (
          <View style={s.fotoKarte}>
            <Text style={s.fotoKarteTitel}>{t("erklaerung")}</Text>
            <Text style={s.fotoKarteTxt}>{ergebnis.erklaerung}</Text>
          </View>
        ) : null}
        {ergebnis?.uebersetzt ? (
          <View style={s.fotoKarte}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={[s.fotoKarteTitel, { flex: 1 }]}>{sprachName(lang)}</Text>
              <Pressable onPress={() => vorlesen(ergebnis.uebersetzt, lang)} hitSlop={8}><Text style={s.vorschauKnopf}>🔊</Text></Pressable>
            </View>
            <Text style={s.fotoKarteTxt} selectable>{ergebnis.uebersetzt}</Text>
          </View>
        ) : null}
        {ergebnis?.original ? (
          <Pressable onPress={() => setZeigeOriginal(!zeigeOriginal)} style={s.fotoKarte}>
            <Text style={s.fotoKarteTitel}>{t("originalText")} {zeigeOriginal ? "▴" : "▾"}</Text>
            {zeigeOriginal && <Text style={[s.fotoKarteTxt, { color: FARBE.grau }]} selectable>{ergebnis.original}</Text>}
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* ------------------------------ Abo -------------------------------
   Kauf ueber Google Play. Der Kauf passiert im Geraet; den Beleg
   (purchaseToken) prueft der Server bei Google und schaltet dann den Chat
   frei (/api/play-kauf). Erst danach wird der Kauf hier abgeschlossen -
   sonst erstattet Google ihn nach drei Tagen.
   Die Produkt-IDs muessen genau so in der Play Console heissen. */
const PLAY_SKUS = ["diralo_plus_monat", "diralo_plus_jahr", "diralo_familie_monat", "diralo_familie_jahr",
  "diralo_team_monat", "diralo_team_jahr", "diralo_teamplus_monat", "diralo_teamplus_jahr"];
/* Welcher Tarif steckt hinter einem Produkt? */
const skuPlan = (id) => (id.includes("teamplus") ? "teamplus" : id.includes("team") ? "team" : id.includes("familie") ? "familie" : "plus");
const PLAN_NAME = { plus: "plusName", familie: "familieName", team: "teamName", teamplus: "teamplusName" };
const PLAN_TEXT = { plus: "plusText", familie: "familieText", team: "teamText", teamplus: "teamplusText" };

/* art: "privat" zeigt Plus/Family, "team" die Tarife fuer Betriebe. */
/* ------------------------------ Diralo Lernen ------------------------------
   Wie auf der Website (public/lernen.js): Die Sprache des anderen mit den
   eigenen Chat-Saetzen lernen. Jede Nachricht liegt ja in beiden Sprachen
   vor - daraus werden Lernkarten (vorne meine Sprache, hinten seine).
   Faecherprinzip, Vorschlaege aus dem Chat, Vorlesen, Tage in Folge.
   Gratis 5 Karten am Tag, mit Abo unbegrenzt. Nur auf diesem Geraet. */
const LERNEN_KEY = "diralo_lernen";
const LERN_STUFEN = [0, 1, 3, 7, 16, 35];
const LERN_GRATIS = 5;
const TAG_MS = 24 * 60 * 60 * 1000;
const lernTag = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const lernBasis = (l) => String(l || "").slice(0, 2);

async function lernenLaden() {
  const d = (await jsonLaden(LERNEN_KEY, {})) || {};
  d.karten = Array.isArray(d.karten) ? d.karten : [];
  d.serie = d.serie || { tag: null, n: 0 };
  d.heute = d.heute && d.heute.tag === lernTag() ? d.heute : { tag: lernTag(), n: 0 };
  return d;
}
async function lernenSichern(d) {
  try { await AsyncStorage.setItem(LERNEN_KEY, JSON.stringify(d)); } catch {}
}

function lernPartner(nachrichten, lang, device) {
  const n = {};
  for (const m of nachrichten) {
    if (m.deleted || !m.lang || m.device === device || lernBasis(m.lang) === lernBasis(lang)) continue;
    n[m.lang] = (n[m.lang] || 0) + 1;
  }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  for (const m of nachrichten) for (const l of Object.keys(m.tr || {})) if (lernBasis(l) !== lernBasis(lang)) return l;
  return null;
}

function lernText(m, l) {
  if (!m || m.deleted) return "";
  if (m.lang === l || (lernBasis(m.lang) === lernBasis(l) && !(m.tr || {})[l])) return String(m.text || "").trim();
  return String((m.tr || {})[l] || "").trim();
}

function lernKarte(m, zl, lang) {
  if (!m || m.deleted || m.ort || m.datei || m.gif || m.bild || m.audioSeconds) return null;
  const ziel = lernText(m, zl), mein = lernText(m, lang);
  if (!ziel || !mein || ziel === mein || ziel.length > 220 || !/\p{L}/u.test(ziel)) return null;
  return { id: m.id, ziel, mein, zl, ml: lang, fach: 0, faellig: 0, neu: Date.now() };
}

const lernSchonDa = (d, k) => d.karten.some((x) => x.id === k.id || (x.zl === k.zl && x.ziel.toLowerCase() === k.ziel.toLowerCase()));

function lernVorschlaege(d, nachrichten, zl, lang) {
  const zaehl = new Map();
  for (const m of nachrichten) {
    const k = lernKarte(m, zl, lang);
    if (!k || k.ziel.length < 2 || k.ziel.length > 70 || k.ziel.split(/\s+/).length > 9 || lernSchonDa(d, k)) continue;
    const key = k.ziel.toLowerCase().replace(/[!?.,…]+$/u, "").trim();
    const alt = zaehl.get(key);
    if (alt) alt.n += 1; else zaehl.set(key, { k, n: 1 });
  }
  return [...zaehl.values()]
    .sort((a, b) => b.n - a.n || a.k.ziel.length - b.k.ziel.length || String(b.k.id).localeCompare(String(a.k.id)))
    .slice(0, 6).map((x) => x.k);
}

/* Aus dem Nachrichten-Menue: eine Nachricht als Karte merken. */
async function lernenMerken(m, nachrichten, lang, device) {
  const zl = lernBasis(m.lang) !== lernBasis(lang) ? m.lang : lernPartner(nachrichten, lang, device);
  const k = zl && lernKarte(m, zl, lang);
  if (!k) return "lernenNichtMoeglich";
  const d = await lernenLaden();
  if (lernSchonDa(d, k)) return "lernenSchon";
  d.karten.push(k);
  await lernenSichern(d);
  return "lernenGemerkt";
}

const LERN_PAKETE = [
  { id: "paar", symbol: "❤️", text: "lernenPaketPaar" },
  { id: "arbeit", symbol: "👷", text: "lernenPaketArbeit" },
  { id: "alltag", symbol: "🏥", text: "lernenPaketAlltag" },
];
async function lernPaketHolen(paket, l) {
  const r = await fetch(`${SERVER_URL}/api/lernpaket?paket=${encodeURIComponent(paket)}&lang=${encodeURIComponent(l)}`);
  if (!r.ok) throw new Error("http " + r.status);
  return (await r.json()).saetze || [];
}
const LERN_PUSH_KEY = "diralo_lernen_push";
const LERN_AUS_KEY = "diralo_lernen_aus";

function LernenFenster({ offen, onZu, nachrichten, lang, device, raum, onAbo, onAusblenden }) {
  const [d, setD] = useState(null);
  const [reihe, setReihe] = useState([]);
  const [auf, setAuf] = useState(false);
  const [abo, setAbo] = useState(false);
  const [paketLaedt, setPaketLaedt] = useState(null);
  const [taeglich, setTaeglich] = useState(true);
  useEffect(() => { AsyncStorage.getItem(LERN_PUSH_KEY).then((v) => setTaeglich(v !== "0")).catch(() => {}); }, []);
  const zl = useMemo(() => lernPartner(nachrichten, lang, device), [nachrichten, lang, device]);

  useEffect(() => {
    if (!offen) return;
    let weg = false;
    (async () => {
      const dd = await lernenLaden();
      if (weg) return;
      setD(dd);
      setAuf(false);
      setReihe(dd.karten.filter((k) => k.zl === zl && k.ml === lang && k.faellig <= Date.now())
        .sort((a, b) => a.faellig - b.faellig).map((k) => k.id));
      try {
        const r = await fetch(`${SERVER_URL}/api/plan?room=${encodeURIComponent(raum)}`);
        const p = r.ok ? await r.json() : null;
        if (!weg) setAbo(!!(p && p.plan && p.plan !== "frei"));
      } catch {}
    })();
    return () => { weg = true; };
  }, [offen, zl, lang, raum]);

  if (!offen) return null;
  const n = (k, wert) => t(k).replace("{n}", String(wert));

  const meine = d ? d.karten.filter((x) => x.zl === zl && x.ml === lang) : [];
  const gelernt = d ? d.karten.filter((x) => x.fach >= 2).length : 0;
  const serie = d && (d.serie.tag === lernTag() || d.serie.tag === lernTag(new Date(Date.now() - TAG_MS))) ? d.serie.n : 0;
  const rest = d ? Math.max(0, LERN_GRATIS - d.heute.n) : LERN_GRATIS;
  const karte = d && reihe.length ? d.karten.find((k) => k.id === reihe[0]) : null;
  const vorschlaege = d && zl ? lernVorschlaege(d, nachrichten, zl, lang) : [];

  const bewerten = async (gewusst) => {
    const dd = await lernenLaden();
    const k = dd.karten.find((x) => x.id === karte.id);
    if (k) {
      if (gewusst) { k.fach = Math.min(LERN_STUFEN.length - 1, k.fach + 1); k.faellig = Date.now() + LERN_STUFEN[k.fach] * TAG_MS; }
      else { k.fach = 0; k.faellig = Date.now(); }
      dd.heute.n += 1;
      if (dd.serie.tag !== lernTag()) {
        dd.serie = { tag: lernTag(), n: dd.serie.tag === lernTag(new Date(Date.now() - TAG_MS)) ? dd.serie.n + 1 : 1 };
      }
      await lernenSichern(dd);
    }
    const neu = reihe.slice(1);
    if (!gewusst) neu.splice(Math.min(3, neu.length), 0, karte.id);
    setD(dd); setReihe(neu); setAuf(false);
  };

  const hinzu = async (v) => {
    const dd = await lernenLaden();
    if (!lernSchonDa(dd, v)) { dd.karten.push({ ...v, neu: Date.now() }); await lernenSichern(dd); }
    setD(dd); setReihe((r) => [...r, v.id]);
  };

  const aufdecken = () => { setAuf(true); vorlesen(karte.ziel, zl); };

  /* Startpaket in beiden Sprachen holen und zu Karten paaren. */
  const paketLaden = async (pk) => {
    setPaketLaedt(pk.id);
    try {
      const [ziel, mein] = await Promise.all([lernPaketHolen(pk.id, zl), lernPaketHolen(pk.id, lang)]);
      if (!ziel.length || ziel.length !== mein.length) throw new Error("leer");
      const dd = await lernenLaden();
      const neu = [];
      ziel.forEach((z, i) => {
        const k = { id: `p:${pk.id}:${zl}:${i}`, ziel: z, mein: mein[i], zl, ml: lang, fach: 0, faellig: 0, neu: Date.now() };
        if (!lernSchonDa(dd, k)) { dd.karten.push(k); neu.push(k.id); }
      });
      await lernenSichern(dd);
      setD(dd); setReihe((r) => [...r, ...neu]);
    } catch {}
    setPaketLaedt(null);
  };

  const taeglichUmschalten = () => {
    const an = !taeglich;
    setTaeglich(an);
    AsyncStorage.setItem(LERN_PUSH_KEY, an ? "1" : "0").catch(() => {});
    fetch(`${SERVER_URL}/api/lernen-push`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, an }),
    }).catch(() => {});
  };
  const offenePakete = d && zl ? LERN_PAKETE.filter((pk) => !d.karten.some((k) => k.zl === zl && String(k.id).startsWith(`p:${pk.id}:`))) : [];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onZu}>
      <Pressable style={s.modalHinten} onPress={onZu} />
      <View style={s.lernBox}>
        <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
          <Text style={s.lernTitel}>🎓 {t("lernenTitel")}{zl ? " · " + sprachName(zl) : ""}</Text>
          {!zl ? (
            <Text style={s.lernText}>{t("lernenKeinPartner")}</Text>
          ) : (
            <>
              <Text style={s.lernStand}>{n("lernenGelernt", gelernt)}{serie ? " · 🔥 " + n("lernenSerie", serie) : ""}</Text>
              {karte && !abo && rest === 0 ? (
                <View style={s.lernKarte}>
                  <Text style={s.lernText}>🎉 {t("lernenPlus")}</Text>
                  <Pressable style={[s.btnPrimary, { backgroundColor: FARBE.gold }]} onPress={() => { onZu(); onAbo(); }}>
                    <Text style={[s.btnPrimaryTxt, { color: FARBE.navy }]}>{t("lernenPlusKnopf")}</Text>
                  </Pressable>
                </View>
              ) : karte ? (
                <View style={s.lernKarte}>
                  <Text style={s.lernFrage}>{t("lernenWie").replace("{lang}", sprachName(zl))}</Text>
                  <Text style={s.lernVorne}>{karte.mein}</Text>
                  {auf ? (
                    <>
                      <Text style={s.lernHinten}>{karte.ziel}</Text>
                      <Pressable style={s.lernHoeren} onPress={() => vorlesen(karte.ziel, zl)}>
                        <Text style={s.aktionTxt}>🔊</Text>
                      </Pressable>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                        <Pressable style={[s.lernWahl, { backgroundColor: FARBE.weiss, borderWidth: 1, borderColor: FARBE.grauHell }]} onPress={() => bewerten(false)}>
                          <Text style={[s.lernWahlTxt, { color: FARBE.navy }]}>↺ {t("lernenNochmal")}</Text>
                        </Pressable>
                        <Pressable style={[s.lernWahl, { backgroundColor: "#2e9d5b" }]} onPress={() => bewerten(true)}>
                          <Text style={s.lernWahlTxt}>✓ {t("lernenWusste")}</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <Pressable style={s.btnPrimary} onPress={aufdecken}>
                      <Text style={s.btnPrimaryTxt}>{t("lernenAufdecken")}</Text>
                    </Pressable>
                  )}
                  {!abo ? <Text style={s.lernKlein}>{n("lernenGratis", rest)}</Text> : null}
                </View>
              ) : d ? (
                <Text style={s.lernText}>{meine.length ? "🎉 " + t("lernenFertig") : t("lernenLeer")}</Text>
              ) : null}

              {vorschlaege.length ? <Text style={s.lernAbschnitt}>💡 {t("lernenVorschlaege")}</Text> : null}
              {vorschlaege.map((v) => (
                <Pressable key={String(v.id)} style={s.lernVorschlag} onPress={() => hinzu(v)}>
                  <Text style={s.lernPlus}>+</Text>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={s.lernVsZiel}>{v.ziel}</Text>
                    <Text style={s.lernKlein2}>{v.mein}</Text>
                  </View>
                </Pressable>
              ))}
              {offenePakete.length ? <Text style={s.lernAbschnitt}>📦 {t("lernenPakete")}</Text> : null}
              {offenePakete.map((pk) => (
                <Pressable key={pk.id} style={s.lernVorschlag} onPress={() => !paketLaedt && paketLaden(pk)}>
                  <Text style={s.lernVsZiel}>{paketLaedt === pk.id ? t("lernenPaketLaedt") : `${pk.symbol} ${t(pk.text)}`}</Text>
                </Pressable>
              ))}
              <Pressable style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 }} onPress={taeglichUmschalten}>
                <View style={[s.lernHaken, taeglich && { backgroundColor: "#2e9d5b", borderColor: "#2e9d5b" }]}>
                  {taeglich ? <Text style={{ color: FARBE.weiss, fontWeight: "800" }}>✓</Text> : null}
                </View>
                <Text style={{ color: FARBE.text, fontSize: 14, flexShrink: 1 }}>🔔 {t("lernenTaeglich")}</Text>
              </Pressable>
              <Text style={s.lernKlein}>{n("lernenKarten", meine.length)}</Text>
              <Pressable onPress={() => { onZu(); onAusblenden(); }} style={{ alignSelf: "center", padding: 8, marginTop: 6 }} hitSlop={8}>
                <Text style={{ color: FARBE.grau, fontSize: 13.5 }}>🙈 {t("lernenAusblenden")}</Text>
              </Pressable>
            </>
          )}
          <Pressable onPress={onZu} style={{ alignSelf: "center", padding: 10 }} hitSlop={8}>
            <Text style={{ color: FARBE.grau, fontSize: 15 }}>{t("abbrechen")}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function AboFenster({ offen, raum, onZu, onHinweis, art = "privat" }) {
  const [produkte, setProdukte] = useState([]);
  const [plan, setPlan] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [kauftGerade, setKauftGerade] = useState(false);
  const raumRef = useRef(raum);
  raumRef.current = raum;

  /* Kauf-Ergebnisse kommen als Ereignis, auch wenn das Fenster schon zu ist. */
  useEffect(() => {
    const ok = purchaseUpdatedListener(async (kauf) => {
      const token = kauf?.purchaseToken || kauf?.purchaseTokenAndroid;
      if (!token) return;
      try {
        const r = await fetch(`${SERVER_URL}/api/play-kauf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: raumRef.current, token }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.fertig) {
          await finishTransaction({ purchase: kauf, isConsumable: false }).catch(() => {});
          onHinweis(t("aboDanke"));
          onZu();
        } else if (j.wartet) {
          onHinweis(t("aboWartet"));
        } else {
          onHinweis(t("aboFehler") + (j.error ? ` (${j.error})` : ""));
        }
      } catch {
        onHinweis(t("aboFehler"));
      } finally {
        setKauftGerade(false);
      }
    });
    const err = purchaseErrorListener((e) => {
      setKauftGerade(false);
      if (!isUserCancelledError(e)) onHinweis(t("aboFehler"));
    });
    return () => { ok.remove(); err.remove(); };
  }, []);

  useEffect(() => {
    if (!offen) return;
    let weg = false;
    setFehler(null);
    (async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/plan?room=${encodeURIComponent(raum)}`);
        if (r.ok && !weg) setPlan(await r.json());
      } catch {}
      try {
        await initConnection();
        const liste = await fetchProducts({ skus: PLAY_SKUS, type: "subs" });
        const sortiert = (liste || []).slice().sort((a, b) => PLAY_SKUS.indexOf(a.id) - PLAY_SKUS.indexOf(b.id));
        if (!weg) {
          setProdukte(sortiert);
          if (!sortiert.length) setFehler(t("aboNichtDa"));
        }
      } catch {
        if (!weg) setFehler(t("aboNichtDa"));
      }
    })();
    return () => { weg = true; };
  }, [offen, raum]);

  const kaufen = async (prod) => {
    const angebot = (prod.subscriptionOffers || []).find((o) => o.offerTokenAndroid);
    if (!angebot) { onHinweis(t("aboNichtDa")); return; }
    setKauftGerade(true);
    try {
      await requestPurchase({
        request: {
          google: {
            skus: [prod.id],
            subscriptionOffers: [{ sku: prod.id, offerToken: angebot.offerTokenAndroid }],
          },
        },
        type: "subs",
      });
    } catch (e) {
      setKauftGerade(false);
      if (!isUserCancelledError(e)) onHinweis(t("aboFehler"));
    }
  };

  const preis = (prod) => {
    const angebot = (prod.subscriptionOffers || []).find((o) => o.offerTokenAndroid);
    return angebot?.displayPrice || prod.displayPrice || "";
  };

  return (
    <Modal visible={offen} transparent animationType="slide" onRequestClose={onZu}>
      <Pressable style={s.modalHinten} onPress={onZu} />
      <View style={s.modalBox}>
        <Text style={s.modalTitel}>{t("aboTitel")}</Text>
        {plan && (
          <Text style={s.aboStand}>
            {plan.bezahlt
              ? t("aboAktiv").replace("{p}", t(PLAN_NAME[plan.plan] || "plusName"))
              : t("aboStand").replace("{b}", String(plan.benutzt ?? 0)).replace("{g}", String(plan.grenze ?? 0))}
          </Text>
        )}
        {fehler && <Text style={s.aboFehler}>{fehler}</Text>}
        {!fehler && produkte.length === 0 && <ActivityIndicator color={FARBE.navy} style={{ marginVertical: 20 }} />}
        <ScrollView style={{ maxHeight: 360 }}>
          {produkte.filter((prod) => (art === "team") === prod.id.includes("team")).map((prod) => {
            const p = skuPlan(prod.id);
            const jahr = prod.id.endsWith("jahr");
            return (
              <Pressable
                key={prod.id}
                style={[s.aboZeile, kauftGerade && s.btnAus]}
                disabled={kauftGerade}
                onPress={() => kaufen(prod)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.aboName}>{t(PLAN_NAME[p])}</Text>
                  <Text style={s.aboBeschr}>{t(PLAN_TEXT[p])}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={s.aboPreis}>{preis(prod)}</Text>
                  <Text style={s.aboBeschr}>{jahr ? t("jahr") : t("monat")}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        <Text style={s.aboHinweis}>{t("aboText")}</Text>
        <Pressable style={s.aboZu} onPress={onZu}>
          <Text style={s.aboZuTxt}>{t("schliessen")}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/* ------------------------------- Chat ----------------------------- */
function Chat({ raum, name, lang, device, unten, oben = 0, entwurf = "", onEntwurfWeg, dateiEntwurf = null, onDateiWeg, onBack, gruppeStart = false, onGruppeStartWeg }) {
  /* Offene Tastatur deckt die Navigationsleiste ab - dann braucht die
     Eingabezeile unten keinen eigenen Abstand mehr. */
  const tastatur = useTastaturOffen();
  const [nachrichten, setNachrichten] = useState([]);
  const [text, setText] = useState(entwurf || "");
  useEffect(() => { if (entwurf) onEntwurfWeg?.(); }, []);
  const [verbunden, setVerbunden] = useState(false);
  const [hinweis, setHinweis] = useState(null);
  const [laedt, setLaedt] = useState(false);          // Foto wird hochgeladen
  const [reagierenAuf, setReagierenAuf] = useState(null); // Nachricht fuer die Emoji-Leiste
  const [antwortAuf, setAntwortAuf] = useState(null);     // Zitat ueber dem Eingabefeld
  /* Vorschau beim Tippen: so kommt meine Nachricht beim anderen an. */
  const [vorschau, setVorschau] = useState(null);
  /* "Fuer mich loeschen": nur auf diesem Geraet ausgeblendet. */
  const [versteckt, setVersteckt] = useState([]);
  useEffect(() => {
    jsonLaden("diralo_versteckt", {}).then((v) => setVersteckt(Array.isArray(v[raum]) ? v[raum] : []));
  }, [raum]);
  const fuerMichLoeschen = async (m) => {
    const alle = await jsonLaden("diralo_versteckt", {});
    const liste = [...new Set([...(alle[raum] || []), m.id])].slice(-1000);
    alle[raum] = liste;
    AsyncStorage.setItem("diralo_versteckt", JSON.stringify(alle)).catch(() => {});
    setVersteckt(liste);
  };
  const sichtbar = versteckt.length ? nachrichten.filter((m) => !versteckt.includes(m.id)) : nachrichten;
  const umgedreht = useMemo(() => sichtbar.slice().reverse(), [sichtbar]);
  const [vorschauAus, setVorschauAus] = useState(false);
  const vorschauNr = useRef(0);
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
  /* Bis zu welchem Zeitpunkt das Gegenueber gelesen hat -> ✓✓ */
  const [gelesenBis, setGelesenBis] = useState(0);
  const [aboOffen, setAboOffen] = useState(false);
  const [aboArt, setAboArt] = useState("privat");
  const [lernenOffen, setLernenOffen] = useState(false);
  /* Gleiche Sprache: nichts zu lernen - dann kein 🎓 und kein "Merken". */
  const lernZielRoh = useMemo(() => lernPartner(nachrichten, lang, device), [nachrichten, lang, device]);
  /* "Lernen ausblenden" (nicht jeder will lernen): gilt fuer dieses Geraet. */
  const [lernAus, setLernAus] = useState(false);
  useEffect(() => { AsyncStorage.getItem(LERN_AUS_KEY).then((v) => setLernAus(v === "1")).catch(() => {}); }, []);
  const lernZiel = lernAus ? null : lernZielRoh;
  const lernAusSetzen = async (aus) => {
    setLernAus(aus);
    AsyncStorage.setItem(LERN_AUS_KEY, aus ? "1" : "0").catch(() => {});
    const taeglichAn = (await AsyncStorage.getItem(LERN_PUSH_KEY).catch(() => null)) !== "0";
    fetch(`${SERVER_URL}/api/lernen-push`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, an: aus ? false : taeglichAn }),
    }).catch(() => {});
    setHinweis(aus ? t("lernenAusgeblendet") : "🎓 " + t("lernenEingeblendet"));
  };
  const [anwesend, setAnwesend] = useState([]);
  /* Gruppe: Name, Chef, Mitglieder mit Lesestand (Server: gruppe.js) */
  const [gruppe, setGruppe] = useState({ name: "", admin: "", mitglieder: [], angeheftet: null });
  const [gruppeOffen, setGruppeOffen] = useState(false);
  /* Von "Gruppe fuer mein Team erstellen": gleich das Gruppen-Fenster zum Benennen. */
  useEffect(() => {
    if (!gruppeStart) return;
    setGruppeOffen(true);
    onGruppeStartWeg?.();
  }, [gruppeStart]);
  const [gruppeEntwurf, setGruppeEntwurf] = useState("");
  /* Anrufe: offen = ich bin im Anruf; klingelt = jemand ruft mich an. */
  const [anrufOffen, setAnrufOffen] = useState(false);
  const [anrufVideo, setAnrufVideo] = useState(false);
  const [klingelt, setKlingelt] = useState(null);   // { name, video }
  const anrufStarten = (video) => {
    if (!sockRef.current) return;
    sockRef.current.emit("anrufStart", { video });
    setAnrufVideo(video);
    setAnrufOffen(true);
  };
  const anrufWaehlen = async () => {
    /* Restliche Untertitel-Minuten mit anzeigen - Anrufe selbst sind frei. */
    let rest = "";
    try {
      const r = await fetch(`${SERVER_URL}/api/anruf/minuten?room=${encodeURIComponent(raum)}`);
      const j = await r.json();
      if (!j.unbegrenzt && typeof j.rest === "number") rest = "\n\n" + t("anrufMinutenRest").replace("{n}", String(j.rest));
    } catch {}
    anrufFrage(rest);
  };
  const anrufFrage = (rest) => Alert.alert(t("anrufen"), t("anrufUntertitelHinweis") + rest, [
    { text: t("anrufSprache"), onPress: () => anrufStarten(false) },
    { text: t("anrufVideo"), onPress: () => anrufStarten(true) },
    { text: t("abbrechen"), style: "cancel" },
  ]);
  const anrufAnnehmen = () => {
    const wer = klingelt;
    setKlingelt(null);
    sockRef.current?.emit("anrufAngenommen");
    setAnrufVideo(Boolean(wer?.video));
    setAnrufOffen(true);
  };
  const anrufAblehnen = () => {
    setKlingelt(null);
    sockRef.current?.emit("anrufEnde");
  };
  const anrufBeenden = () => {
    setAnrufOffen(false);
    sockRef.current?.emit("anrufEnde");
  };
  /* Neue Nachrichten automatisch vorlesen (Einstellung bleibt gespeichert). */
  const [autoVorlesen, setAutoVorlesen] = useState(false);
  const autoRef = useRef(false);
  const wartetAufVorlesen = useRef(new Set());
  useEffect(() => {
    jsonLaden("diralo_auto_vorlesen", false).then((v) => { setAutoVorlesen(Boolean(v)); autoRef.current = Boolean(v); });
  }, []);
  const autoUmschalten = () => {
    const neu = !autoRef.current;
    autoRef.current = neu;
    setAutoVorlesen(neu);
    AsyncStorage.setItem("diralo_auto_vorlesen", neu ? "true" : "false").catch(() => {});
    setHinweis(neu ? t("autoAn") : t("autoAus"));
  };
  /* Erst nach dem Verlauf wissen wir, ob der Chat wirklich leer ist. */
  const [geladen, setGeladen] = useState(false);   // Namen der anderen, die gerade im Chat sind
  const [chatName, setChatName] = useState("");
  useEffect(() => { chatsLaden().then((l) => setChatName(l.find((c) => c.code === raum)?.name || "")); }, [raum]);

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    /* Melden, dass ich bis jetzt alles gesehen habe - nur wenn die App
       wirklich vorne ist. Daraus werden beim Absender die Lese-Haken. */
    const gelesenMelden = () => {
      if (AppState.currentState === "active") socket.emit("gelesen", { bis: Date.now() });
    };
    sockRef.current = socket;

    socket.on("connect", () => {
      setVerbunden(true);
      socket.emit("join", { roomCode: raum, name, lang, device, geheim: GEHEIM, build: BUILD, speech: false });
    });
    socket.on("disconnect", () => setVerbunden(false));
    socket.on("anrufKommt", (wer) => setKlingelt(wer || null));
    socket.on("bonus", () => setHinweis(t("bonusDa")));
    socket.on("anrufEnde", () => setKlingelt(null));

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
      setGeladen(true);
      arr.forEach(frageWennNoetig);
      scrollUnten();
      gelesenMelden();
    });
    socket.on("message", (msg) => {
      const m = normMsg(msg);
      setNachrichten((alt) => [...alt, m]);
      frageWennNoetig(m);
      if (m.device === device) amEnde.current = true;   // eigene Nachricht: immer runter
      if (amEnde.current) scrollUnten();
      if (m.device !== device) gelesenMelden();
      if (m.device !== device && m.device !== "demo") vielleichtBewerten();
      /* Sprachnachricht ohne Mitschrift: Der Server schreibt nach und
         uebersetzt - dann ("translated") vorlesen. */
      if (m.device !== device && autoRef.current && !m.text && m.audioSeconds && AppState.currentState === "active") {
        wartetAufVorlesen.current.add(m.id);
      }
      if (m.device !== device && autoRef.current && m.text && AppState.currentState === "active") {
        const gleich = String(m.lang || "").split("-")[0] === String(lang).split("-")[0];
        if (gleich || !/\p{L}/u.test(m.text)) vorlesen(m.text, lang);
        else wartetAufVorlesen.current.add(m.id);
      }
    });
    socket.on("gelesen", ({ device: von, bis }) => {
      if (von === device) return;
      const b = Number(bis);
      if (Number.isFinite(b)) setGelesenBis((alt) => Math.max(alt, b));
      if (von && Number.isFinite(b)) setGruppe((g) => ({ ...g, mitglieder: g.mitglieder.map((m) =>
        (m.device === von ? { ...m, bis: Math.max(m.bis || 0, b) } : m)) }));
    });
    socket.on("gruppe", (g) => {
      if (!g || typeof g !== "object") return;
      setGruppe({ name: g.name || "", admin: g.admin || "", mitglieder: Array.isArray(g.mitglieder) ? g.mitglieder : [],
                  angeheftet: g.angeheftet && g.angeheftet.id ? g.angeheftet : null });
      if (g.name) chatGruppeMerken(raum, g.name).catch(() => {});
    });
    socket.on("gruppeFehler", (e) => {
      if (e?.grund === "nurTeamPlus") { setHinweis(t("nurTeamPlus")); setAboArt("team"); setAboOffen(true); }
      else setHinweis(t("gruppeNurChef"));
    });
    /* Zurueck in die App, waehrend der Chat offen ist: jetzt gelesen. */
    socket.on("anwesend", (liste) => {
      setAnwesend((Array.isArray(liste) ? liste : []).filter((w) => w.device !== device).map((w) => w.name));
    });
    /* Im Hintergrund gilt man nicht als "im Chat" - Verbindung trennen,
       beim Zurueckkommen neu verbinden (meldet sich dabei neu an). */
    const appSub = AppState.addEventListener("change", (st) => {
      if (st === "active") { if (!socket.connected) socket.connect(); gelesenMelden(); }
      else if (st === "background") socket.disconnect();
    });
    /* Uebersetzung fuer EINE Sprache trifft nach ein paar Sekunden ein. */
    socket.on("translated", ({ id, lang: zl, text: t }) => {
      setNachrichten((alt) => alt.map((m) =>
        m.id === id ? { ...m, tr: { ...m.tr, [zl]: t } } : m));
      if (zl === lang && wartetAufVorlesen.current.has(id)) {
        wartetAufVorlesen.current.delete(id);
        if (autoRef.current) vorlesen(t, lang);
      }
    });
    socket.on("vorschauFertig", (d) => {
      if (d && d.nr === vorschauNr.current && d.uebersetzt) setVorschau(d);
    });
    socket.on("ausspracheFertig", ({ id, text: lt }) => {
      if (lt) setHinweis("🗣 " + lt);
    });
    socket.on("ausspracheFehler", () => setHinweis(t("ausspracheFehler")));
    socket.on("lang", ({ id, lang: dl }) => {
      setNachrichten((alt) => alt.map((m) =>
        m.id === id ? { ...m, detected: dl } : m));
    });
    socket.on("quotaReached", (ev) => {
      /* Der Server sagt, welcher Tarif aufgebraucht ist und wie gross er war. */
      const plan = ev?.plan || "frei";
      const schluessel = plan === "plus" ? "kontingentPlus" : plan === "familie" ? "kontingentFamilie"
        : plan === "team" || plan === "teamplus" ? "kontingentTeam" : "kontingent";
      const n = Number(ev?.grenze) || (plan === "plus" ? 1500 : plan === "familie" ? 5000 : 200);
      let zahl = String(n);
      try { zahl = n.toLocaleString(lang); } catch {}
      setHinweis(t(schluessel).replace("{n}", zahl));
      /* Family und Team Plus sind die groessten Tarife - da gibt es nichts mehr
         anzubieten. Bei Team wird der groessere Team-Tarif gezeigt. */
      if (plan === "team") { setAboArt("team"); setAboOffen(true); }
      else if (!["familie", "firma", "teamplus"].includes(plan)) { setAboArt("privat"); setAboOffen(true); }
    });
    socket.on("translationError", () => {
      setHinweis(t("uebersFehler"));
    });
    socket.on("system", (ev) => {
      if (ev?.type === "tooManyJoins") setHinweis(t("zuVieleJoins"));
      /* Aus der Gruppe entfernt: Chat aus der Liste nehmen und zurueck. */
      if (ev?.type === "teamVoll") {
        Alert.alert(t("gruppe"), t("teamVoll"));
        onBack();
      }
      if (ev?.type === "entfernt") {
        chatVergessen(raum).catch(() => {});
        Alert.alert(t("gruppe"), t("gruppeEntferntDu"));
        onBack();
      }
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

    return () => { appSub.remove(); socket.removeAllListeners(); socket.close(); };
  }, [raum, name, lang, device]);

  /* Die Liste ist umgedreht (inverted): ganz unten heisst Versatz 0. */
  const scrollUnten = () => {
    setTimeout(() => { try { listRef.current?.scrollToOffset({ offset: 0, animated: true }); } catch {} }, 60);
  };

  /* Sprache des Gegenuebers: aus seiner letzten Nachricht. */
  const partnerSprache = (() => {
    for (let i = nachrichten.length - 1; i >= 0; i--) {
      const m = nachrichten[i];
      if (m.device !== device && !m.deleted && (m.detected || m.lang)) return m.detected || m.lang;
    }
    return null;
  })();
  const gleicheSprache = (a, b) => String(a || "").split("-")[0] === String(b || "").split("-")[0];

  useEffect(() => {
    jsonLaden("diralo_vorschau_aus", false).then((v) => setVorschauAus(Boolean(v)));
  }, []);

  useEffect(() => {
    const roh = text.trim();
    vorschauNr.current += 1;
    const nr = vorschauNr.current;
    if (vorschauAus || roh.length < 3 || !partnerSprache || gleicheSprache(partnerSprache, lang)) {
      setVorschau(null);
      return;
    }
    const tm = setTimeout(() => {
      sockRef.current?.emit("vorschau", { text: roh, ziel: partnerSprache, nr });
    }, 1100);
    return () => clearTimeout(tm);
  }, [text, partnerSprache, lang, vorschauAus]);

  /* GIF: geht unuebersetzt raus, wie bei WhatsApp. */
  const gifSenden = async (gif) => {
    setEmojiAuf(false);
    try {
      const r = await fetch(`${SERVER_URL}/api/gif`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: raum, device, name, lang, gif, replyTo: antwortAuf?.id || null }),
      });
      if (!r.ok) throw new Error();
      setAntwortAuf(null);
    } catch {
      setHinweis(t("gifFehler"));
    }
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
    /* Solange noch niemand anderes geschrieben hat: an den Bonus erinnern. */
    if (!nachrichten.some((m) => m.device !== device)) setHinweis(t("bonusHinweis"));
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

  /* Video oder Datei: geht unuebersetzt raus. */
  const dateiSenden = async (datei) => {
    setLaedt(true);
    try {
      await dateiHochladen(datei, { raum, device, name, lang });
    } catch (e) {
      setHinweis(e?.gross ? t("dateiGross") : t("dateiFehler"));
    } finally {
      setLaedt(false);
    }
  };

  /* Aus dem Teilen-Menue einer anderen App: gleich beim Oeffnen senden. */
  useEffect(() => {
    if (!dateiEntwurf) return;
    const d = dateiEntwurf;
    onDateiWeg?.();
    dateiSenden(d);
  }, []);

  const videoWaehlen = async () => {
    try {
      const recht = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!recht.granted) { setHinweis(t("ohneFotos")); return; }
      const wahl = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["videos"] });
      if (wahl.canceled || !wahl.assets?.length) return;
      await videoVerschicken(wahl.assets[0]);
    } catch {
      setHinweis(t("dateiFehler"));
    }
  };

  /* Video direkt mit der Handykamera aufnehmen (hoechstens 3 Minuten). */
  const videoAufnehmen = async () => {
    try {
      const recht = await ImagePicker.requestCameraPermissionsAsync();
      if (!recht.granted) { setHinweis(t("ohneKamera")); return; }
      const wahl = await ImagePicker.launchCameraAsync({ mediaTypes: ["videos"], videoMaxDuration: 180 });
      if (wahl.canceled || !wahl.assets?.length) return;
      await videoVerschicken(wahl.assets[0]);
    } catch {
      setHinweis(t("dateiFehler"));
    }
  };

  const videoVerschicken = async (a) => {
    setLaedt(true);
    setHinweis(t("videoVorbereiten"));
    let uri = a.uri;
    try {
      uri = await videoKlein(a.uri, (pz) => setHinweis(`${t("videoVorbereiten")} ${pz} %`));
    } finally { setLaedt(false); }
    const name = (a.fileName || "video.mp4").replace(/\.[^.]+$/, "") + ".mp4";
    /* Hinweis weg - sonst stand "wird vorbereitet" auch nach dem Senden noch da. */
    setHinweis(null);
    await dateiSenden({ uri, name, mime: "video/mp4" });
  };

  const dateiWaehlen = async () => {
    try {
      const wahl = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
      if (wahl.canceled || !wahl.assets?.length) return;
      const a = wahl.assets[0];
      if (a.size && a.size > DATEI_MAX_BYTES) { setHinweis(t("dateiGross")); return; }
      await dateiSenden({ uri: a.uri, name: a.name || "Datei", mime: a.mimeType || "" });
    } catch {
      setHinweis(t("dateiFehler"));
    }
  };

  /* Eigenes Auswahlfenster: Androids Dialog kann nur drei Knoepfe. */
  const [menueAuf, setMenueAuf] = useState(false);
  const anhangMenue = () => {
    Keyboard.dismiss();
    setMenueAuf(true);
  };
  const anhangPunkte = [
    ["🖼️", t("galerie"), () => fotoSenden("galerie")],
    ["📷", t("kamera"), () => fotoSenden("kamera")],
    ["🎥", t("videoAufnehmen"), videoAufnehmen],
    ["🎬", t("video"), videoWaehlen],
    ["📎", t("datei"), dateiWaehlen],
    ["📍", t("standort"), standortSenden],
  ];

  /* Gleiche Reaktion nochmal = zuruecknehmen (wie in der Web-App). */
  const reagieren = (emoji) => {
    const m = reagierenAuf;
    setReagierenAuf(null);
    if (!m || !sockRef.current) return;
    const aktuell = m.reaktionen?.[device];
    sockRef.current.emit("reagieren", { id: m.id, emoji: aktuell === emoji ? "" : emoji });
  };

  /* "Gelesen von 3/5" - nur in Gruppen (Name gesetzt oder mehr als zwei Leute). */
  const andereMitglieder = gruppe.mitglieder.filter((m) => m.device !== device);
  const istGruppe = Boolean(gruppe.name) || andereMitglieder.length >= 2;
  const lesestand = (m) => ({
    ja: andereMitglieder.filter((x) => (x.bis || 0) >= m.at),
    nein: andereMitglieder.filter((x) => (x.bis || 0) < m.at),
  });

  return (
    /* "padding" auch auf Android: edge-to-edge schaltet das automatische
       Verkleinern des Fensters ab, sonst laege die Tastatur ueber dem Feld. */
    <KeyboardAvoidingView
      style={s.full} behavior="padding"
      /* Der Chat sitzt unter der Statusleiste (paddingTop im Elternteil).
         Ohne diesen Ausgleich rechnet die Tastatur-Hoehe genau um die
         Statusleiste zu kurz, und die Eingabezeile rutscht halb darunter. */
      keyboardVerticalOffset={oben}
    >
      {/* Kopfzeile */}
      <View style={s.chatHead}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹</Text></Pressable>
        <Pressable
          style={{ flex: 1, minWidth: 60 }}
          onPress={() => { setGruppeEntwurf(gruppe.name || chatName || ""); setGruppeOffen(true); sockRef.current?.emit("gruppeInfo"); }}
        >
          <Text style={s.chatTitel} numberOfLines={1}>{gruppe.name ? "👥 " + gruppe.name : (chatName || "Chat " + raum)}</Text>
        </Pressable>
        <Pressable
          onPress={() => { setGruppeEntwurf(gruppe.name || chatName || ""); setGruppeOffen(true); sockRef.current?.emit("gruppeInfo"); }}
          style={s.kopfKnopf} hitSlop={6}
        >
          <Text style={s.plusKnopfTxt}>👥</Text>
        </Pressable>
        <Pressable onPress={anrufWaehlen} style={s.kopfKnopf} hitSlop={6}>
          <Text style={s.plusKnopfTxt}>📞</Text>
        </Pressable>
        <Pressable onPress={autoUmschalten} style={[s.kopfKnopf, autoVorlesen && s.autoAn]} hitSlop={6}>
          <Text style={s.plusKnopfTxt}>{autoVorlesen ? "🔊" : "🔈"}</Text>
        </Pressable>
        {lernZiel ? (
          <Pressable onPress={() => setLernenOffen(true)} style={s.kopfKnopf} hitSlop={6}>
            <Text style={s.plusKnopfTxt}>🎓</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={einladen} style={s.einladen} hitSlop={8}>
          <Text style={s.einladenTxt} numberOfLines={1}>{t("einladen")}</Text>
        </Pressable>
      </View>
      {/* Status (online / verbinde) in eigener Zeile unter der Kopfzeile:
         oben ist mit den Knoepfen kein Platz mehr, so bleibt er immer lesbar. */}
      <View style={s.chatStatus}>
        <Text style={s.chatSub} numberOfLines={1}>
          {gruppe.name ? t("gruppeMitglieder").replace("{n}", String(gruppe.mitglieder.length)) + " · " : ""}
          {!verbunden ? t("verbinde")
            : anwesend.length ? `🟢 ${[...new Set(anwesend)].join(", ")} · ${t("imChat")}`
            : `${t("verbunden")} · ${t("du")}: ${name}`}
        </Text>
      </View>

      {/* Durchsage: vom Chef oben angeheftet, jeder liest sie in seiner Sprache */}
      {gruppe.angeheftet && (() => {
        const a = nachrichten.find((m) => m.id === gruppe.angeheftet.id) || gruppe.angeheftet;
        const text = (a.device !== device && a.tr && a.tr[lang]) || a.text || "";
        const st = istGruppe ? lesestand(a) : null;
        return (
          <Pressable
            style={s.durchsage}
            onPress={() => Alert.alert(t("durchsage"),
              `${a.name}: ${text}` + (st ? `\n\n✓✓ ${st.ja.length}/${st.ja.length + st.nein.length}` : ""),
              gruppe.admin === device
                ? [{ text: t("losloesen"), style: "destructive", onPress: () => sockRef.current?.emit("gruppeAnheften", { id: null }) },
                   { text: "OK" }]
                : [{ text: "OK" }])}
          >
            <Text style={s.durchsageTitel}>{t("durchsage")}{st ? `  ·  ✓✓ ${st.ja.length}/${st.ja.length + st.nein.length}` : ""}</Text>
            <Text style={s.durchsageText} numberOfLines={2}>{text}</Text>
          </Pressable>
        );
      })()}

      <Klingeln wer={klingelt} t={t} onAnnehmen={anrufAnnehmen} onAblehnen={anrufAblehnen} />

      {/* Gruppe: Name (nur der Chef), Mitglieder, Entfernen */}
      <Modal visible={gruppeOffen} transparent animationType="fade" onRequestClose={() => setGruppeOffen(false)}>
        <Pressable style={s.modalHinten} onPress={() => setGruppeOffen(false)} />
        <View style={[s.benennenBox, { top: "10%", maxHeight: "80%" }]}>
          <Text style={[s.modalTitel, { paddingHorizontal: 0 }]}>👥 {t("gruppe")}</Text>
          {!gruppe.admin || gruppe.admin === device ? (
            <>
              <TextInput
                style={[s.input, { marginTop: 6 }]} maxLength={50}
                value={gruppeEntwurf} onChangeText={setGruppeEntwurf}
                placeholder={t("gruppeNameBsp")} placeholderTextColor={FARBE.grau}
              />
              <Pressable
                style={[s.btnPrimary, { marginTop: 10 }]}
                onPress={() => {
                  if (!gruppeEntwurf.trim()) return;
                  sockRef.current?.emit("gruppeName", { name: gruppeEntwurf.trim() });
                  setGruppeOffen(false);
                }}
              >
                <Text style={s.btnPrimaryTxt}>{t("speichern")}</Text>
              </Pressable>
              <Text style={s.gruppeHinweis}>{gruppe.admin ? t("gruppeDuChef") : t("gruppeHinweis")}</Text>
              <Text style={s.gruppeHinweis}>{t("gruppeTipp")}</Text>
              <Pressable style={[s.btnGruppe, { marginTop: 8 }]} onPress={() => { setGruppeOffen(false); einladen(); }}>
                <Text style={s.btnGruppeTxt}>{t("einladen")}</Text>
              </Pressable>
              {gruppe.admin === device ? (
                <Pressable
                  style={[s.btnPrimary, { marginTop: 10, backgroundColor: FARBE.gold }]}
                  onPress={() => { setGruppeOffen(false); setAboArt("team"); setAboOffen(true); }}
                >
                  <Text style={[s.btnPrimaryTxt, { color: FARBE.navy }]}>{t("teamFreischalten")}</Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <Text style={s.gruppeNameGross}>{gruppe.name}</Text>
          )}
          <Text style={[s.gruppeHinweis, { fontWeight: "800", color: FARBE.navy, marginTop: 14 }]}>
            {t("gruppeMitglieder").replace("{n}", String(gruppe.mitglieder.length))}
          </Text>
          <ScrollView style={{ marginTop: 4 }}>
            {gruppe.mitglieder.map((m) => (
              <View key={m.device} style={s.mitglied}>
                <View style={{ flex: 1 }}>
                  <Text style={s.mitgliedName} numberOfLines={1}>
                    {m.name}{m.device === device ? ` (${t("du")})` : ""}{m.device === gruppe.admin ? "  " + t("gruppeChef") : ""}
                  </Text>
                  <Text style={s.mitgliedSub} numberOfLines={1}>
                    {sprachName(m.lang)} · {m.online ? "🟢 " + t("gruppeOnline") : `${t("gruppeZuletzt")} ${tagText(m.zuletzt)} ${uhrzeit(m.zuletzt)}`}
                  </Text>
                </View>
                {gruppe.admin === device && m.device !== device ? (
                  <Pressable
                    hitSlop={6} style={s.mitgliedWeg}
                    onPress={() => Alert.alert(t("gruppeEntfernen"), t("gruppeEntfernenFrage").replace("{name}", m.name), [
                      { text: t("abbrechen"), style: "cancel" },
                      { text: t("gruppeEntfernen"), style: "destructive", onPress: () => sockRef.current?.emit("gruppeEntfernen", { device: m.device }) },
                    ])}
                  >
                    <Text style={s.mitgliedWegTxt}>{t("gruppeEntfernen")}</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            <Pressable style={[s.lernVorschlag, { marginTop: 12 }]} onPress={() => { setGruppeOffen(false); setAboArt("privat"); setAboOffen(true); }}>
              <Text style={s.lernVsZiel}>★ {t("aboKnopf")}</Text>
            </Pressable>
            {lernAus && lernZielRoh ? (
              <Pressable style={[s.lernVorschlag, { marginTop: 12 }]} onPress={() => { setGruppeOffen(false); lernAusSetzen(false); }}>
                <Text style={s.lernVsZiel}>🎓 {t("lernenEinblenden")}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
      <Anruf
        offen={anrufOffen} server={SERVER_URL} raum={raum} device={device} name={name} lang={lang}
        video={anrufVideo} t={t} onEnde={anrufBeenden}
      />

      {hinweis && (
        <Pressable onPress={() => setHinweis(null)} style={s.hinweis}>
          <Text style={s.hinweisTxt}>{hinweis}  ({t("ausblenden")})</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        /* Umgedrehte Liste wie bei WhatsApp: die neueste Nachricht steht
           von selbst unten. Kein Nachscrollen per Code mehr - das liess
           lange Chats beim Nachladen hoch und runter springen. */
        inverted
        data={umgedreht}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.liste}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        renderItem={({ item, index }) => (
          <>
          {(index === umgedreht.length - 1 || !gleicherTag(umgedreht[index + 1].at, item.at)) && (
            <View style={s.tagWrap}><Text style={s.tag}>{tagText(item.at)}</Text></View>
          )}
          <Bubble
            msg={item} lang={lang} device={device} gelesenBis={gelesenBis}
            gelesenVon={istGruppe && item.device === device ? lesestand(item) : null}
            onKeineStimme={() => setHinweis(t("keineStimme"))}
            zitat={item.replyTo ? nachrichten.find((m) => m.id === item.replyTo) || { fehlt: true } : null}
            onLangDruck={() => setReagierenAuf(item)}
          />
          </>
        )}
        onScroll={(e) => { amEnde.current = e.nativeEvent.contentOffset.y < 150; }}
        scrollEventThrottle={100}
        ListEmptyComponent={
          !geladen ? (
            <ActivityIndicator color={FARBE.navy} style={{ marginVertical: 40 }} />
          ) : (
          /* Die umgedrehte Liste dreht auf Android auch diesen Inhalt um
             180 Grad - hier zurueckdrehen, sonst steht er gespiegelt da. */
          <View style={[s.leerBox, { transform: [{ rotate: "180deg" }] }]}>
            <Text style={s.leerTitel}>{t("leerTitel")}</Text>
            <Text style={s.leerText}>{t("leerText2")}</Text>
            <Pressable style={[s.btnPrimary, { alignSelf: "stretch", marginTop: 14 }]} onPress={einladen}>
              <Text style={s.btnPrimaryTxt}>{t("einladen")}</Text>
            </Pressable>
            <Text style={[s.leerText, { marginTop: 22 }]}>{t("falschHier")}</Text>
            <Pressable style={s.leerZurueck} onPress={onBack}>
              <Text style={s.leerZurueckTxt}>‹ {t("codeEingeben")}</Text>
            </Pressable>
          </View>
          )
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
          {reagierenAuf.text && !reagierenAuf.deleted && reagierenAuf.device !== device && (
            <Pressable
              style={s.aktion}
              onPress={() => vorlesen(reagierenAuf.text, reagierenAuf.detected || reagierenAuf.lang, true, () => setHinweis(t("keineStimme")))}
            >
              <Text style={s.aktionTxt}>{t("langsam")}</Text>
            </Pressable>
          )}
          {reagierenAuf.text && !reagierenAuf.deleted && reagierenAuf.device !== device && (
            <Pressable
              style={s.aktion}
              onPress={() => {
                const m = reagierenAuf; setReagierenAuf(null);
                sockRef.current?.emit("aussprache", { id: m.id, lang });
              }}
            >
              <Text style={s.aktionTxt}>{t("aussprache")}</Text>
            </Pressable>
          )}
          {lernZiel && reagierenAuf.text && !reagierenAuf.deleted && !reagierenAuf.audioSeconds && (
            <Pressable
              style={s.aktion}
              onPress={() => {
                const m = reagierenAuf; setReagierenAuf(null);
                lernenMerken(m, nachrichten, lang, device).then((k) => setHinweis((k === "lernenGemerkt" ? "⭐ " : "") + t(k)));
              }}
            >
              <Text style={s.aktionTxt}>{t("lernenMerken")}</Text>
            </Pressable>
          )}
          <Pressable
            style={s.aktion}
            onPress={() => { const m = reagierenAuf; setReagierenAuf(null); fuerMichLoeschen(m); }}
          >
            <Text style={s.aktionTxt}>{t("fuerMich")}</Text>
          </Pressable>
          {istGruppe && gruppe.admin === device && !reagierenAuf.deleted && (
            <Pressable
              style={s.aktion}
              onPress={() => { const m = reagierenAuf; setReagierenAuf(null); sockRef.current?.emit("gruppeAnheften", { id: m.id }); }}
            >
              <Text style={s.aktionTxt}>{t("anheften")}</Text>
            </Pressable>
          )}
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

      {vorschau && text.trim() ? (
        <View style={s.vorschauBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.vorschauTitel}>{t("vorschau")}</Text>
            <Text style={s.vorschauText}>{vorschau.uebersetzt}</Text>
            {vorschau.zurueck ? <Text style={s.vorschauZurueck}>↩ {vorschau.zurueck}</Text> : null}
          </View>
          <View style={{ gap: 10, alignItems: "center" }}>
            <Pressable onPress={() => vorlesen(vorschau.uebersetzt, partnerSprache)} hitSlop={8}>
              <Text style={s.vorschauKnopf}>🔊</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setVorschauAus(true); setVorschau(null);
                AsyncStorage.setItem("diralo_vorschau_aus", "true").catch(() => {});
              }}
              hitSlop={8} accessibilityLabel={t("vorschauAus")}
            >
              <Text style={s.reaktZu}>✕</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {emojiAuf && <EmojiAuswahl zuletzt={zuletztEmoji} onWahl={emojiEinfuegen} lang={lang} onGif={gifSenden} />}

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
          <Pressable style={s.senden} onPress={senden} accessibilityLabel={t("senden")}>
            <Text style={s.sendenPfeil}>➤</Text>
          </Pressable>
        ) : aufnahme.laeuft ? (
          <View style={s.aufnahmeRow}>
            <Pressable onPress={aufnahme.abbrechen} hitSlop={8}><Text style={s.reaktZu}>✕</Text></Pressable>
            <Pressable style={[s.senden, s.aufnahmeAn, s.aufnahmeBreit]} onPress={aufnahme.stopp}>
              <Text style={s.sendenTxt}>● {aufnahme.sekunden}s ➤</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={[s.senden, laedt && s.btnAus]} disabled={laedt} onPress={aufnahme.start}>
            <Text style={s.sendenTxt}>🎤</Text>
          </Pressable>
        )}
      </View>
      <AboFenster offen={aboOffen} art={aboArt} raum={raum} onZu={() => setAboOffen(false)} onHinweis={setHinweis} />
      <LernenFenster
        offen={lernenOffen} onZu={() => setLernenOffen(false)}
        nachrichten={nachrichten} lang={lang} device={device} raum={raum}
        onAbo={() => { setAboArt("privat"); setAboOffen(true); }}
        onAusblenden={() => lernAusSetzen(true)}
      />
      <Modal visible={menueAuf} transparent animationType="slide" onRequestClose={() => setMenueAuf(false)}>
        <Pressable style={s.modalHinten} onPress={() => setMenueAuf(false)} />
        <View style={[s.modalBox, { paddingBottom: 16 + unten }]}>
          <Text style={s.modalTitel}>{t("senden")}</Text>
          {anhangPunkte.map(([symbol, label, los]) => (
            <Pressable key={label} style={s.sprachZeile} onPress={() => { setMenueAuf(false); los(); }}>
              <Text style={s.sprachZeileTxt}>{symbol}  {label}</Text>
            </Pressable>
          ))}
          <Pressable style={s.sprachZeile} onPress={() => setMenueAuf(false)}>
            <Text style={[s.sprachZeileTxt, { color: FARBE.grau }]}>{t("abbrechen2")}</Text>
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/* Text mit antippbaren Links (YouTube, Instagram, TikTok ...). */
function LinkText({ text, style, onLongPress }) {
  const teile = String(text).split(/(https?:\/\/[^\s]+)/gi);
  return (
    <Text style={style} onLongPress={onLongPress}>
      {teile.map((teil, i) => /^https?:\/\//i.test(teil) ? (
        <Text key={i} style={s.link} onPress={() => Linking.openURL(teil).catch(() => {})}>{teil}</Text>
      ) : teil)}
    </Text>
  );
}

/* Eine Sprechblase. Zeigt die Nachricht in MEINER Sprache (sonst Original).
   Langes Druecken oeffnet die Emoji-Leiste. */
function Bubble({ msg, lang, device, zitat, onLangDruck, gelesenBis, gelesenVon, onKeineStimme }) {
  const meins = msg.device === device;
  /* Foto oder Video direkt in der App zeigen (wie WhatsApp) statt im Browser. */
  const [ansicht, setAnsicht] = useState(null);   // null | "bild" | "video"
  const hatLink = LINK_RE.test(msg.text || "");
  const uebersetzt = !meins && !hatLink && msg.tr && msg.tr[lang];
  const anzeige = meins ? msg.text : (uebersetzt || msg.text);
  const original = !meins && uebersetzt && msg.text && msg.text !== uebersetzt;
  const txtStil = [s.bubbleTxt, meins && s.bubbleTxtMeins];

  if (msg.deleted) {
    return (
      <View style={[s.bubbleWrap, meins ? s.wrapMeins : s.wrapFremd]}>
        <View style={[s.bubble, meins ? s.bubbleMeins : s.bubbleFremd]}>
          <Text style={[txtStil, s.geloescht]}>{t("geloescht")}</Text>
        </View>
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
          <Pressable onPress={() => setAnsicht("bild")} onLongPress={onLangDruck}>
            <Image source={{ uri: medienUrl(msg.id) }} style={s.foto} resizeMode="cover" />
          </Pressable>
        ) : null}
        {msg.audioSeconds ? <Sprachnachricht id={msg.id} sekunden={msg.audioSeconds} meins={meins} onLangDruck={onLangDruck} /> : null}
        {/* Fremde Sprachnachricht: die Uebersetzung anhören, in meiner Sprache. */}
        {msg.audioSeconds && !meins && uebersetzt ? (
          <Pressable onPress={() => vorlesen(uebersetzt, lang, false, onKeineStimme)} onLongPress={onLangDruck} style={s.uebHoeren} hitSlop={6}>
            <Text style={s.uebHoerenTxt}>🔊 {sprachName(lang)}</Text>
          </Pressable>
        ) : null}
        {msg.gif ? (
          <Pressable onLongPress={onLangDruck}>
            <GifBild
              source={{ uri: msg.gif.url }} autoplay contentFit="cover"
              style={[s.gifBlase, msg.gif.b && msg.gif.h ? { height: Math.min(300, Math.round(220 * msg.gif.h / msg.gif.b)) } : null]}
            />
          </Pressable>
        ) : null}
        {msg.datei ? (
          <Pressable
            style={s.dateiKarte}
            onPress={() => (String(msg.datei.mime || "").startsWith("video/") ? setAnsicht("video") : Linking.openURL(medienUrl(msg.id)))}
            onLongPress={onLangDruck}
          >
            <Text style={s.dateiSymbol}>{String(msg.datei.mime || "").startsWith("video/") ? "🎬" : "📄"}</Text>
            <View style={{ flexShrink: 1 }}>
              <Text style={txtStil} numberOfLines={2}>{msg.datei.name}</Text>
              <Text style={[s.bubbleOrig, meins && s.bubbleOrigMeins]}>
                {groesseText(msg.datei.groesse)} · {t("dateiOeffnen")}
              </Text>
            </View>
          </Pressable>
        ) : null}
        {anzeige ? (hatLink ? <LinkText text={anzeige} style={txtStil} onLongPress={onLangDruck} /> : <Text style={txtStil}>{anzeige}</Text>) : null}
        {!anzeige && !msg.bild && !msg.audioSeconds && !msg.datei && !msg.gif ? <Text style={txtStil}>...</Text> : null}
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
      {ansicht ? <MedienAnsicht id={msg.id} art={ansicht} onZu={() => setAnsicht(null)} /> : null}
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
        <View style={s.meta}>
          {!meins && msg.text ? (
            <Pressable
              onPress={() => (uebersetzt ? vorlesen(uebersetzt, lang, false, onKeineStimme) : vorlesen(msg.text, msg.detected || msg.lang, false, onKeineStimme))}
              hitSlop={10} style={{ marginRight: "auto" }}
            >
              <Text style={s.lautKnopf}>🔊</Text>
            </Pressable>
          ) : null}
          <Text style={[s.metaZeit, meins && s.bubbleOrigMeins]}>{uhrzeit(msg.at)}</Text>
          {meins && gelesenVon ? (
            <Pressable
              hitSlop={8}
              onPress={() => Alert.alert(t("gruppeGelesen"),
                [gelesenVon.ja.length ? gelesenVon.ja.map((x) => "✓✓ " + x.name).join("\n") : "–",
                 gelesenVon.nein.length ? `${t("gruppeUngelesen")}:\n` + gelesenVon.nein.map((x) => "⏳ " + x.name).join("\n") : ""]
                  .filter(Boolean).join("\n\n"))}
            >
              <Text style={[s.haken, gelesenVon.nein.length === 0 && s.hakenGelesen]}>
                ✓✓ {gelesenVon.ja.length}/{gelesenVon.ja.length + gelesenVon.nein.length}
              </Text>
            </Pressable>
          ) : meins && (
            <Text style={[s.haken, msg.at <= gelesenBis && s.hakenGelesen]}>
              {msg.at <= gelesenBis ? "✓✓" : "✓"}
            </Text>
          )}
        </View>
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
/* Vollbild fuer Foto oder Video, wie bei WhatsApp: schwarzer Hintergrund,
   Video spielt sofort mit den Android-Steuerelementen (Pause, Spulen,
   Vollbild). Zurueck-Taste oder ✕ schliesst; ⤓ oeffnet die Datei im
   Browser, um sie zu speichern oder weiterzugeben. */
function MedienAnsicht({ id, art, onZu }) {
  const url = medienUrl(id);
  return (
    <Modal visible animationType="fade" onRequestClose={onZu} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "#000", justifyContent: "center" }}>
        {art === "video" ? <VideoVoll url={url} /> : (
          <GifBild source={{ uri: url }} style={{ width: "100%", height: "100%" }} contentFit="contain" />
        )}
        <View style={{ position: "absolute", top: 40, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16 }}>
          <Pressable onPress={onZu} hitSlop={12} style={s.medienKnopf}>
            <Text style={s.medienKnopfTxt}>✕</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL(url)} hitSlop={12} style={s.medienKnopf}>
            <Text style={s.medienKnopfTxt}>⤓</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function VideoVoll({ url }) {
  const player = useVideoPlayer(url, (p) => { p.loop = false; p.play(); });
  return <VideoView player={player} style={{ width: "100%", height: "100%" }} contentFit="contain" nativeControls allowsFullscreen />;
}

/* onLangDruck: Der Abspielknopf fuellt fast die ganze Blase und faengt
   die Beruehrung ab - ohne eigenes onLongPress kaeme man bei einer
   Sprachnachricht nie ans Menue (Loeschen, Antworten). */
function Sprachnachricht({ id, sekunden, meins, onLangDruck }) {
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
    <Pressable onPress={umschalten} onLongPress={onLangDruck} delayLongPress={350} style={s.sprache} hitSlop={6}>
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

/* Datumstrenner im Chat: "Heute", "Gestern" oder das Datum. */
function gleicherTag(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function tagText(at) {
  const jetzt = Date.now();
  if (gleicherTag(at, jetzt)) return t("heute");
  if (gleicherTag(at, jetzt - 86400000)) return t("gestern");
  const d = new Date(at);
  const loc = { de: "de-DE", pt: "pt-PT", es: "es-ES", fr: "fr-FR", it: "it-IT", ja: "ja-JP", hi: "hi-IN", ur: "ur-PK", bn: "bn-BD", pa: "pa-IN", ne: "ne-NP" }[uiSprache] || "en-GB";
  try {
    return d.toLocaleDateString(loc, {
      weekday: "long", day: "numeric", month: "long",
      ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    });
  } catch {
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  }
}

/* Vorlesen mit den Stimmen des Handys - kostenlos, ohne Server. */
/* Beste installierte Stimme fuer eine Sprache: genaue Region vor gleicher
   Sprache, "Enhanced" vor normal, lokal vor Netz. Ohne passende Stimme
   wuerde Android mit einer fremden Stimme lesen - das klingt furchtbar. */
let stimmenListe = null;
async function stimmeFuer(code) {
  try {
    if (!stimmenListe) stimmenListe = await Speech.getAvailableVoicesAsync();
  } catch { stimmenListe = []; }
  const ziel = erkennerSprache(code || "en").toLowerCase().replace("_", "-");
  const basis = ziel.split("-")[0];
  const passend = (stimmenListe || []).filter((v) =>
    String(v.language || "").toLowerCase().replace("_", "-").split("-")[0] === basis);
  if (!passend.length) return null;
  const punkte = (v) => {
    const l = String(v.language || "").toLowerCase().replace("_", "-");
    const id = String(v.identifier || "").toLowerCase();
    return (l === ziel ? 4 : 0) + (v.quality === "Enhanced" ? 2 : 0) + (id.includes("network") ? 0 : 1);
  };
  return passend.sort((a, b) => punkte(b) - punkte(a))[0];
}

/* Vorlesen: zuerst die natuerliche Stimme vom Server (Google, klingt wie
   ein Mensch). Klappt das nicht - kein Netz, Server voll -, die Stimme
   des Handys als Rueckfall. */
let profiPlayer = null;
async function profiVorlesen(text, code, langsam) {
  const r = await fetch(`${SERVER_URL}/api/sprechen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text).slice(0, 600), lang: code, langsam }),
  });
  if (!r.ok) throw new Error("http " + r.status);
  const { id } = await r.json();
  const url = `${SERVER_URL}/api/sprechen/${encodeURIComponent(id)}`;
  if (!profiPlayer) profiPlayer = createAudioPlayer(url);
  else profiPlayer.replace(url);
  profiPlayer.play();
}

async function vorlesen(text, code, langsam = false, onKeineStimme = null) {
  if (!text) return;
  try { Speech.stop(); } catch {}
  try { profiPlayer?.pause(); } catch {}
  try {
    await profiVorlesen(text, code || "en", langsam);
    return;
  } catch {}
  try {
    const stimme = await stimmeFuer(code);
    if (!stimme && onKeineStimme) { onKeineStimme(); return; }
    Speech.speak(text, {
      language: erkennerSprache(code || "en"),
      ...(stimme ? { voice: stimme.identifier } : {}),
      rate: langsam ? 0.55 : 0.95,
    });
  } catch {}
}

/* "14:05" aus dem Zeitstempel. */
function uhrzeit(at) {
  const d = new Date(at || Date.now());
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Eine Zeile fuer Zitate: Text in meiner Sprache, sonst was die Nachricht ist. */
function kurzText(m, lang, device) {
  if (m.deleted) return t("geloescht");
  const zeile = m.device !== device && m.tr?.[lang] ? m.tr[lang] : m.text;
  if (zeile) return zeile;
  if (m.gif) return "GIF";
  if (m.datei) return (String(m.datei.mime || "").startsWith("video/") ? "🎬 " : "📎 ") + (m.datei.name || t("datei"));
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
    datei: m.datei || null,
    gif: m.gif || null,
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
  chatHead: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: FARBE.navy, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  chatStatus: { backgroundColor: FARBE.navy, paddingHorizontal: 14, paddingBottom: 8 },
  kopfKnopf: { borderWidth: 1, borderColor: FARBE.gold, borderRadius: 16, paddingHorizontal: 7, paddingVertical: 5 },
  back: { color: FARBE.weiss, fontSize: 34, lineHeight: 34, paddingRight: 6, marginTop: -4 },
  chatTitel: { color: FARBE.weiss, fontSize: 17, fontWeight: "800" },
  chatSub: { color: "#aeb9cc", fontSize: 12.5 },
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
  tagWrap: { alignItems: "center", marginVertical: 8 },
  tag: { backgroundColor: FARBE.grauHell, color: FARBE.text, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, overflow: "hidden" },
  vorschauBox: { flexDirection: "row", gap: 10, backgroundColor: "#eef4ff", borderTopWidth: 1, borderTopColor: FARBE.grauHell, paddingHorizontal: 14, paddingVertical: 8 },
  vorschauTitel: { fontSize: 11.5, color: FARBE.grau, fontWeight: "700" },
  vorschauText: { fontSize: 15, color: FARBE.text, marginTop: 2 },
  vorschauZurueck: { fontSize: 12.5, color: FARBE.grau, fontStyle: "italic", marginTop: 3 },
  vorschauKnopf: { fontSize: 20 },
  lautKnopf: { fontSize: 15 },
  hilfeRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  hilfeKnopf: { flex: 1, borderWidth: 1, borderColor: FARBE.navy, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", backgroundColor: FARBE.weiss },
  hilfeKnopfTxt: { color: FARBE.navy, fontWeight: "700", fontSize: 14.5, textAlign: "center" },
  dolmHaelfte: { flex: 1, alignItems: "center", paddingHorizontal: 18, paddingVertical: 12 },
  dolmOben: { transform: [{ rotate: "180deg" }], backgroundColor: "#eef4ff" },
  dolmSprache: { fontSize: 13, color: FARBE.grau, fontWeight: "700" },
  dolmGross: { fontSize: 24, color: FARBE.text, textAlign: "center", fontWeight: "600" },
  dolmKlein: { fontSize: 14, color: FARBE.grau, textAlign: "center", marginTop: 8, fontStyle: "italic" },
  dolmMikro: { width: 72, height: 72, borderRadius: 36, backgroundColor: FARBE.gold, alignItems: "center", justifyContent: "center", marginTop: 8 },
  dolmMikroTxt: { fontSize: 30, color: FARBE.navy },
  dolmHinweis: { fontSize: 12.5, color: FARBE.grau, marginTop: 6 },
  dolmTrenner: { minHeight: 44, borderTopWidth: 1, borderBottomWidth: 1, borderColor: FARBE.grauHell, backgroundColor: FARBE.weiss, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  dolmInfo: { fontSize: 12.5, color: FARBE.grau, textAlign: "center" },
  schalterZeile: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  schalterBox: { fontSize: 22, color: FARBE.navy },
  schalterTxt: { fontSize: 15, color: FARBE.text },
  fotoKarte: { backgroundColor: FARBE.weiss, borderRadius: 14, padding: 14, marginTop: 14, borderWidth: 1, borderColor: FARBE.grauHell },
  fotoKarteTitel: { fontSize: 12.5, color: FARBE.grau, fontWeight: "800", marginBottom: 6 },
  fotoKarteTxt: { fontSize: 16, color: FARBE.text, lineHeight: 23 },
  wegKarte: { backgroundColor: FARBE.weiss, borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: FARBE.grauHell },
  wegTitel: { fontSize: 16.5, fontWeight: "800", color: FARBE.navy },
  wegText: { fontSize: 13.5, color: FARBE.grau, marginTop: 4, marginBottom: 12, lineHeight: 19 },
  chatCodeKlein: { fontSize: 12, color: FARBE.grau, marginTop: 1 },
  durchsage: { backgroundColor: "#FFF6DD", borderBottomWidth: 1, borderBottomColor: "#E3B23C", paddingHorizontal: 14, paddingVertical: 8 },
  durchsageTitel: { fontSize: 12, fontWeight: "800", color: "#8A6A12" },
  durchsageText: { fontSize: 14, color: "#14213D", marginTop: 2 },
  gruppeHinweis: { fontSize: 13, color: FARBE.grau, marginTop: 10, lineHeight: 18 },
  gruppeNameGross: { fontSize: 20, fontWeight: "800", color: FARBE.navy, marginTop: 4 },
  mitglied: { flexDirection: "row", alignItems: "center", paddingVertical: 9, borderTopWidth: 1, borderTopColor: "#E7EAF2" },
  mitgliedName: { fontSize: 15, fontWeight: "700", color: FARBE.navy },
  mitgliedSub: { fontSize: 12, color: FARBE.grau, marginTop: 2 },
  mitgliedWeg: { borderWidth: 1, borderColor: "#D64545", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginLeft: 8 },
  mitgliedWegTxt: { color: "#D64545", fontSize: 13, fontWeight: "700" },
  benennenBox: { position: "absolute", left: 20, right: 20, top: "25%", backgroundColor: FARBE.weiss, borderRadius: 18, padding: 18 },
  leerBox: { alignItems: "center", paddingHorizontal: 24, paddingVertical: 30 },
  leerTitel: { fontSize: 20, fontWeight: "800", color: FARBE.navy, textAlign: "center" },
  leerText: { fontSize: 14.5, color: FARBE.grau, textAlign: "center", marginTop: 8, lineHeight: 21 },
  leerZurueck: { marginTop: 10, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: FARBE.navy },
  leerZurueckTxt: { color: FARBE.navy, fontWeight: "700", fontSize: 14.5 },
  meta: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 4, marginTop: 3 },
  metaZeit: { fontSize: 11, color: FARBE.grau },
  haken: { fontSize: 12, color: "#aeb9cc", fontWeight: "700", letterSpacing: -2 },
  hakenGelesen: { color: "#5ec8ff" },
  bubbleOrigMeins: { color: "#aeb9cc" },
  geloescht: { fontStyle: "italic", opacity: 0.6 },
  foto: { width: 230, height: 230, borderRadius: 10, marginBottom: 6, backgroundColor: FARBE.grauHell },
  dateiKarte: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4, maxWidth: 250 },
  dateiSymbol: { fontSize: 30 },
  gifBlase: { width: 220, height: 180, borderRadius: 10, marginBottom: 4, backgroundColor: FARBE.grauHell },
  gifSuche: { margin: 6, marginBottom: 2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, backgroundColor: FARBE.hell, color: FARBE.navy, fontSize: 15 },
  gifZelle: { flex: 1 / 3, aspectRatio: 1, padding: 2 },
  gifTabTxt: { fontSize: 13, fontWeight: "800", color: FARBE.navy, paddingVertical: 4 },
  gifQuelle: { textAlign: "center", color: FARBE.grau, fontSize: 11, paddingVertical: 6 },
  sprache: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4, marginBottom: 4 },
  medienKnopf: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  medienKnopfTxt: { color: "#fff", fontSize: 22, fontWeight: "700" },
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
  autoAn: { backgroundColor: FARBE.gold },
  plusKnopf: { borderWidth: 1, borderColor: FARBE.gold, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5 },
  plusKnopfTxt: { color: FARBE.gold, fontWeight: "800", fontSize: 14 },
  aboStand: { color: FARBE.text, fontSize: 14, marginBottom: 10 },
  aboFehler: { color: "#9B2C25", fontSize: 14, marginVertical: 10 },
  aboZeile: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: FARBE.grauHell, borderRadius: 14, padding: 14, marginBottom: 10, backgroundColor: FARBE.weiss },
  aboName: { fontSize: 16, fontWeight: "800", color: FARBE.navy },
  aboBeschr: { fontSize: 12.5, color: FARBE.grau, marginTop: 2 },
  aboPreis: { fontSize: 16, fontWeight: "800", color: FARBE.text },
  aboHinweis: { fontSize: 12, color: FARBE.grau, marginTop: 4, textAlign: "center" },
  aboZu: { alignSelf: "center", marginTop: 12, paddingVertical: 8, paddingHorizontal: 18 },
  aboZuTxt: { color: FARBE.navy, fontWeight: "700", fontSize: 15 },
  einladen: { backgroundColor: FARBE.gold, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  einladenTxt: { color: FARBE.navy, fontWeight: "800", fontSize: 13 },
  aktionLeiste: { flexDirection: "row", flexWrap: "wrap", gap: 10, backgroundColor: FARBE.weiss, paddingHorizontal: 12, paddingBottom: 8 },
  aktion: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: FARBE.hell },
  lernBox: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "88%", backgroundColor: FARBE.weiss, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
  lernTitel: { fontSize: 18, fontWeight: "800", color: FARBE.navy },
  lernStand: { color: FARBE.grau, fontSize: 14, marginTop: 2, marginBottom: 12 },
  lernText: { fontSize: 15, color: FARBE.text, lineHeight: 21, marginVertical: 10 },
  lernKarte: { backgroundColor: FARBE.hell, borderRadius: 16, padding: 16, marginBottom: 8, alignItems: "stretch" },
  lernFrage: { color: FARBE.grau, fontSize: 13, textAlign: "center", marginBottom: 8 },
  lernVorne: { fontSize: 19, fontWeight: "600", color: FARBE.text, textAlign: "center", marginBottom: 10 },
  lernHinten: { fontSize: 23, fontWeight: "800", color: FARBE.navy, textAlign: "center", marginVertical: 6 },
  lernHoeren: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 18, borderRadius: 12, backgroundColor: FARBE.weiss, marginVertical: 4 },
  lernWahl: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  lernWahlTxt: { color: FARBE.weiss, fontWeight: "800", fontSize: 16 },
  lernKlein: { color: FARBE.grau, fontSize: 12.5, textAlign: "center", marginTop: 8 },
  lernKlein2: { color: FARBE.grau, fontSize: 13, marginTop: 2 },
  lernAbschnitt: { fontWeight: "700", fontSize: 14, color: FARBE.navy, marginTop: 16, marginBottom: 6 },
  lernVorschlag: { flexDirection: "row", gap: 10, borderWidth: 1, borderColor: FARBE.grauHell, borderRadius: 12, padding: 12, marginBottom: 6 },
  lernPlus: { fontWeight: "800", fontSize: 18, color: FARBE.navy },
  uebHoeren: { alignSelf: "flex-start", backgroundColor: FARBE.hell, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 6 },
  uebHoerenTxt: { color: FARBE.navy, fontWeight: "700", fontSize: 13 },
  btnGruppe: { borderWidth: 2, borderColor: FARBE.navy, borderRadius: 14, paddingVertical: 13, alignItems: "center", marginTop: 10 },
  btnGruppeTxt: { color: FARBE.navy, fontSize: 16, fontWeight: "800" },
  lernHaken: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: FARBE.grau, alignItems: "center", justifyContent: "center" },
  lernVsZiel: { fontWeight: "600", fontSize: 15, color: FARBE.text },
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
  link: { textDecorationLine: "underline" },
  bubbleOrig: { color: FARBE.grau, fontSize: 12, marginTop: 5, fontStyle: "italic" },

  eingabe: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 10, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell },
  eingabeInput: { flex: 1, maxHeight: 120, backgroundColor: FARBE.hell, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, color: FARBE.text },
  senden: { width: 44, height: 44, borderRadius: 22, backgroundColor: FARBE.gold, alignItems: "center", justifyContent: "center" },
  sendenPfeil: { color: FARBE.navy, fontSize: 20, marginLeft: 3 },
  aufnahmeBreit: { width: undefined, paddingHorizontal: 14 },
  sendenTxt: { color: FARBE.navy, fontWeight: "800" },
});
