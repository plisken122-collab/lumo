/* --------------------------------------------------------------------
   npm run vapid

   Erzeugt das Schluesselpaar fuer Web Push. Einmal ausfuehren, die zwei
   Werte bei Render als Umgebungsvariablen eintragen, fertig.

   Der private Schluessel gehoert nirgendwo hin ausser in die
   Umgebungsvariablen. Nicht ins Repo, nicht in einen Chat.
-------------------------------------------------------------------- */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("\n  VAPID-Schluessel erzeugt.");
console.log("  Diese beiden Zeilen bei Render unter Environment eintragen:\n");
console.log(`  VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`  VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`  VAPID_CONTACT=mailto:deine@mailadresse.pt`);
console.log("\n  Fuers lokale Testen dieselben Zeilen in die .env kopieren.\n");
