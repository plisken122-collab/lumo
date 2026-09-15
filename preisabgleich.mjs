/* Preisseite, AGB und der Code muessen dieselben Zahlen nennen. Weichen
   sie ab, steht auf der Rechnung etwas anderes als im Vertrag. */
import { readFileSync } from "node:fs";

const preise = readFileSync("public/preise.html", "utf8");
const agb = readFileSync("public/agb.html", "utf8");
const bez = readFileSync("bezahlung.js", "utf8");

let fehler = 0;
const pruefe = (name, ok, hinweis = "") => {
  if (!ok) fehler++;
  console.log(`${ok ? "ok  " : "FEHL"} ${name}${hinweis ? "  " + hinweis : ""}`);
};

/* 1. Betraege */
for (const betrag of ["4,99", "49,90", "9,99", "99,90"]) {
  pruefe(`Betrag ${betrag} in der Preisseite`, preise.includes(betrag));
  pruefe(`Betrag ${betrag} in den AGB`, agb.includes(betrag));
}
for (const betrag of ["€4.99", "€49.90", "€9.99", "€99.90"]) {
  pruefe(`Betrag ${betrag} in der englischen AGB-Fassung`, agb.includes(betrag));
}

/* 2. Kontingente - die stehen auch im Code */
const ausCode = Object.fromEntries(
  [...bez.matchAll(/KONTINGENT_(FREI|PLUS|FAMILIE)\s*\|\|\s*(\d+)/g)].map((m) => [m[1].toLowerCase(), m[2]])
);
for (const [plan, zahl] of Object.entries(ausCode)) {
  pruefe(`Kontingent ${plan} = ${zahl} in der Preisseite`, preise.includes(zahl));
  pruefe(`Kontingent ${plan} = ${zahl} in den AGB`, agb.includes(zahl));
}

/* 3. Mehrwertsteuer-Aussage in beiden */
pruefe("Preisseite sagt inklusive MwSt", /inklusive Mehrwertsteuer|IVA incluído|include VAT/.test(preise));
pruefe("AGB sagen inklusive MwSt", /inklusive Mehrwertsteuer|incluem IVA|include VAT/.test(agb));

/* 4. Kein Rest der alten Behauptung "derzeit kostenlos" */
pruefe("keine Aussage mehr, der Dienst sei durchweg kostenlos",
  !/Dienst ist derzeit kostenlos|serviço é gratuito;|service is free at the moment/.test(agb));

/* 5. Stripe in der Datenschutzerklaerung, in allen drei Sprachen */
const dat = readFileSync("public/datenschutz.html", "utf8");
pruefe("Stripe in allen drei Sprachfassungen genannt",
  (dat.match(/Stripe Payments Europe/g) || []).length === 3,
  `(${(dat.match(/Stripe Payments Europe/g) || []).length} Fundstellen)`);

console.log(fehler ? `\n${fehler} Abweichung(en).` : "\nPreisseite, AGB und Code sind sich einig.");
process.exit(fehler ? 1 : 0);
