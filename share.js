/* --------------------------------------------------------------------
   npm run share

   Startet den Server und legt eine oeffentliche Adresse darueber.
   Damit kannst du den Link per WhatsApp verschicken - die andere Person
   braucht kein WLAN bei dir und keine Installation.

   Die Adresse lebt nur, solange dieses Fenster offen ist.
   Fuer eine feste Adresse: auf Render deployen, siehe README.
-------------------------------------------------------------------- */
import "dotenv/config";
import { spawn } from "child_process";
import localtunnel from "localtunnel";
import qr from "qrcode-terminal";

const PORT = process.env.PORT || 3000;

console.log("\n  Server wird gestartet ...\n");
const server = spawn(process.execPath, ["server.js"], { stdio: "inherit" });

const stop = () => {
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/* Kurz warten, bis der Server horcht, dann den Tunnel aufbauen. */
setTimeout(async () => {
  try {
    const tunnel = await localtunnel({ port: Number(PORT) });

    console.log("\n" + "=".repeat(58));
    console.log("\n  Oeffentliche Adresse:\n");
    console.log(`  ${tunnel.url}\n`);
    qr.generate(tunnel.url, { small: true });
    console.log("  Diesen Link kannst du per WhatsApp verschicken.");
    console.log("  Er funktioniert auf jedem Handy, weltweit.\n");
    console.log("  Beim ersten Aufruf fragt eine Zwischenseite nach einem");
    console.log("  Passwort. Das ist deine oeffentliche IP-Adresse:");
    console.log("  https://loca.lt/mytunnelpassword\n");
    console.log("  Adresse gilt nur, solange dieses Fenster offen ist.");
    console.log("\n" + "=".repeat(58) + "\n");

    tunnel.on("close", () => {
      console.log("\n  Verbindung beendet.\n");
      stop();
    });
  } catch (err) {
    console.error("\n  Tunnel fehlgeschlagen:", err.message);
    console.error("  Der Server laeuft trotzdem lokal weiter.");
    console.error("  Fuer eine feste Adresse: auf Render deployen, siehe README.\n");
  }
}, 2500);
