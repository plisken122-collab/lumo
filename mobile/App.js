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
  ScrollView, Modal, Share, Platform, AppState,
  KeyboardAvoidingView, Keyboard, StyleSheet, StatusBar, ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { File } from "expo-file-system";
import * as Notifications from "expo-notifications";
import * as Speech from "expo-speech";
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
    dolmetscher: "🎙 Dolmetscher",
    fotoKnopf: "📷 Foto übersetzen",
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
    langsam: "🐢 Langsam",
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
    dolmetscher: "🎙 Intérprete",
    fotoKnopf: "📷 Traduzir foto",
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
    langsam: "🐢 Devagar",
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
    dolmetscher: "🎙 Interpreter",
    fotoKnopf: "📷 Translate photo",
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
    langsam: "🐢 Slowly",
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
    dolmetscher: "🎙 Intérprete",
    fotoKnopf: "📷 Traducir foto",
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
    langsam: "🐢 Despacio",
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
    kontingent: "Se ha agotado el cupo gratuito de traducciones. Con Diralo Plus sigues sin límites.",
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
    dolmetscher: "🎙 Interprète",
    fotoKnopf: "📷 Traduire une photo",
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
    langsam: "🐢 Lentement",
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
    kontingent: "Le quota gratuit de traductions est épuisé. Avec Diralo Plus, c'est illimité.",
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
    dolmetscher: "🎙 Interprete",
    fotoKnopf: "📷 Traduci foto",
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
    langsam: "🐢 Lentamente",
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
    kontingent: "La quota gratuita di traduzioni è esaurita. Con Diralo Plus continui senza limiti.",
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
};
let uiSprache = "de";
const uiCode = (code) => {
  const c = String(code || "").toLowerCase();
  const b = c.split("-")[0];
  return ["de", "pt", "es", "fr", "it"].includes(b) ? b : "en";
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
  const [ansicht, setAnsicht] = useState(null); // "dolmetsch" | "foto" | null

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
        {ansicht === "dolmetsch" ? (
          <Dolmetscher lang={lang} device={device} unten={insets.bottom} onBack={() => setAnsicht(null)} />
        ) : ansicht === "foto" ? (
          <FotoUebersetzen lang={lang} device={device} unten={insets.bottom} onBack={() => setAnsicht(null)} />
        ) : raum ? (
          <Chat
            raum={raum} name={name.trim()} lang={lang} device={device}
            unten={insets.bottom} oben={insets.top}
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
            onHilfe={setAnsicht}
          />
        )}
      </View>
    </View>
  );
}

/* ----------------------------- Startseite ------------------------- */
function Home({ name, setName, lang, setLang, device, unten, onStart, onJoin, onHilfe }) {
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

      <View style={s.hilfeRow}>
        <Pressable style={s.hilfeKnopf} onPress={() => onHilfe("dolmetsch")}>
          <Text style={s.hilfeKnopfTxt}>{t("dolmetscher")}</Text>
        </Pressable>
        <Pressable style={s.hilfeKnopf} onPress={() => onHilfe("foto")}>
          <Text style={s.hilfeKnopfTxt}>{t("fotoKnopf")}</Text>
        </Pressable>
      </View>

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
const PLAY_SKUS = ["diralo_plus_monat", "diralo_plus_jahr", "diralo_familie_monat", "diralo_familie_jahr"];

function AboFenster({ offen, raum, onZu, onHinweis }) {
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
              ? t("aboAktiv").replace("{p}", plan.plan === "familie" ? t("familieName") : t("plusName"))
              : t("aboStand").replace("{b}", String(plan.benutzt ?? 0)).replace("{g}", String(plan.grenze ?? 0))}
          </Text>
        )}
        {fehler && <Text style={s.aboFehler}>{fehler}</Text>}
        {!fehler && produkte.length === 0 && <ActivityIndicator color={FARBE.navy} style={{ marginVertical: 20 }} />}
        <ScrollView style={{ maxHeight: 360 }}>
          {produkte.map((prod) => {
            const familie = prod.id.includes("familie");
            const jahr = prod.id.endsWith("jahr");
            return (
              <Pressable
                key={prod.id}
                style={[s.aboZeile, kauftGerade && s.btnAus]}
                disabled={kauftGerade}
                onPress={() => kaufen(prod)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.aboName}>{familie ? t("familieName") : t("plusName")}</Text>
                  <Text style={s.aboBeschr}>{familie ? t("familieText") : t("plusText")}</Text>
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
function Chat({ raum, name, lang, device, unten, oben = 0, onBack }) {
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
  /* Vorschau beim Tippen: so kommt meine Nachricht beim anderen an. */
  const [vorschau, setVorschau] = useState(null);
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
      gelesenMelden();
    });
    socket.on("message", (msg) => {
      const m = normMsg(msg);
      setNachrichten((alt) => [...alt, m]);
      frageWennNoetig(m);
      if (m.device === device) amEnde.current = true;   // eigene Nachricht: immer runter
      if (amEnde.current) scrollUnten();
      if (m.device !== device) gelesenMelden();
    });
    socket.on("gelesen", ({ device: von, bis }) => {
      if (von === device) return;
      const b = Number(bis);
      if (Number.isFinite(b)) setGelesenBis((alt) => Math.max(alt, b));
    });
    /* Zurueck in die App, waehrend der Chat offen ist: jetzt gelesen. */
    const appSub = AppState.addEventListener("change", (st) => { if (st === "active") gelesenMelden(); });
    /* Uebersetzung fuer EINE Sprache trifft nach ein paar Sekunden ein. */
    socket.on("translated", ({ id, lang: zl, text: t }) => {
      setNachrichten((alt) => alt.map((m) =>
        m.id === id ? { ...m, tr: { ...m.tr, [zl]: t } } : m));
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
    socket.on("quotaReached", () => {
      setHinweis(t("kontingent"));
      setAboOffen(true);
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

    return () => { appSub.remove(); socket.removeAllListeners(); socket.close(); };
  }, [raum, name, lang, device]);

  const scrollUnten = () => {
    setTimeout(() => { try { listRef.current?.scrollToEnd({ animated: true }); } catch {} }, 80);
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
        <View style={{ flex: 1 }}>
          <Text style={s.chatTitel}>Chat {raum}</Text>
          <Text style={s.chatSub}>{verbunden ? t("verbunden") : t("verbinde")} · {t("du")}: {name} ({lang})</Text>
        </View>
        <Pressable onPress={() => setAboOffen(true)} style={s.plusKnopf} hitSlop={8}>
          <Text style={s.plusKnopfTxt}>★</Text>
        </Pressable>
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
        renderItem={({ item, index }) => (
          <>
          {(index === 0 || !gleicherTag(nachrichten[index - 1].at, item.at)) && (
            <View style={s.tagWrap}><Text style={s.tag}>{tagText(item.at)}</Text></View>
          )}
          <Bubble
            msg={item} lang={lang} device={device} gelesenBis={gelesenBis}
            zitat={item.replyTo ? nachrichten.find((m) => m.id === item.replyTo) || { fehlt: true } : null}
            onLangDruck={() => setReagierenAuf(item)}
          />
          </>
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
          {reagierenAuf.text && !reagierenAuf.deleted && reagierenAuf.device !== device && (
            <Pressable
              style={s.aktion}
              onPress={() => vorlesen(reagierenAuf.text, reagierenAuf.detected || reagierenAuf.lang, true)}
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
      <AboFenster offen={aboOffen} raum={raum} onZu={() => setAboOffen(false)} onHinweis={setHinweis} />
    </KeyboardAvoidingView>
  );
}

/* Eine Sprechblase. Zeigt die Nachricht in MEINER Sprache (sonst Original).
   Langes Druecken oeffnet die Emoji-Leiste. */
function Bubble({ msg, lang, device, zitat, onLangDruck, gelesenBis }) {
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
        <View style={s.meta}>
          {!meins && msg.text ? (
            <Pressable onPress={() => vorlesen(msg.text, msg.detected || msg.lang)} hitSlop={10} style={{ marginRight: "auto" }}>
              <Text style={s.lautKnopf}>🔊</Text>
            </Pressable>
          ) : null}
          <Text style={[s.metaZeit, meins && s.bubbleOrigMeins]}>{uhrzeit(msg.at)}</Text>
          {meins && (
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
  const loc = { de: "de-DE", pt: "pt-PT", es: "es-ES", fr: "fr-FR", it: "it-IT" }[uiSprache] || "en-GB";
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
function vorlesen(text, code, langsam = false) {
  if (!text) return;
  try {
    Speech.stop();
    Speech.speak(text, { language: erkennerSprache(code || "en"), rate: langsam ? 0.55 : 0.95 });
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
  tagWrap: { alignItems: "center", marginVertical: 8 },
  tag: { backgroundColor: FARBE.grauHell, color: FARBE.text, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, overflow: "hidden" },
  vorschauBox: { flexDirection: "row", gap: 10, backgroundColor: "#eef4ff", borderTopWidth: 1, borderTopColor: FARBE.grauHell, paddingHorizontal: 14, paddingVertical: 8 },
  vorschauTitel: { fontSize: 11.5, color: FARBE.grau, fontWeight: "700" },
  vorschauText: { fontSize: 15, color: FARBE.text, marginTop: 2 },
  vorschauZurueck: { fontSize: 12.5, color: FARBE.grau, fontStyle: "italic", marginTop: 3 },
  vorschauKnopf: { fontSize: 20 },
  lautKnopf: { fontSize: 15 },
  hilfeRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  hilfeKnopf: { flex: 1, borderWidth: 1, borderColor: FARBE.navy, borderRadius: 14, paddingVertical: 12, alignItems: "center", backgroundColor: FARBE.weiss },
  hilfeKnopfTxt: { color: FARBE.navy, fontWeight: "700", fontSize: 14.5 },
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
  meta: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 4, marginTop: 3 },
  metaZeit: { fontSize: 11, color: FARBE.grau },
  haken: { fontSize: 12, color: "#aeb9cc", fontWeight: "700", letterSpacing: -2 },
  hakenGelesen: { color: "#5ec8ff" },
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

  eingabe: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 10, backgroundColor: FARBE.weiss, borderTopWidth: 1, borderTopColor: FARBE.grauHell },
  eingabeInput: { flex: 1, maxHeight: 120, backgroundColor: FARBE.hell, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, color: FARBE.text },
  senden: { width: 44, height: 44, borderRadius: 22, backgroundColor: FARBE.gold, alignItems: "center", justifyContent: "center" },
  sendenPfeil: { color: FARBE.navy, fontSize: 20, marginLeft: 3 },
  aufnahmeBreit: { width: undefined, paddingHorizontal: 14 },
  sendenTxt: { color: FARBE.navy, fontWeight: "800" },
});
