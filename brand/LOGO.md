# lumo — Logo und Farben

## Die Idee

Eine Sprechblase, nicht zwei. Ein Gespräch, kein Nebeneinander. Die diagonale Naht ist die Stelle, an der die Übersetzung passiert — links die eine Sprache, rechts die andere, und dazwischen fällt Licht durch. Daher der Name.

Die Naht liegt bewusst schräg und nicht mittig: ein Gespräch ist keine saubere Halbierung.

## Dateien

| Datei | Wofür |
|---|---|
| `public/brand/logo-horizontal.svg` | Standard. Website, Briefkopf, Präsentationen |
| `public/brand/logo-mark.svg` | Nur die Blase. Profilbilder, Favicon, enge Stellen |
| `public/brand/logo-mark-mono.svg` | Einfarbig, nimmt die Textfarbe an. Stempel, Gravur, einfarbiger Druck |
| `public/brand/logo-wordmark.svg` | Nur der Schriftzug |
| `brand/export/*.png` | Dieselben als PNG für Social Media und Print |
| `brand/render.py` | Erzeugt alle PNG neu, falls Größen fehlen |

SVG bevorzugen, wo es geht — bleibt in jeder Größe scharf.

## Farben

| Farbe | Hex | Wofür |
|---|---|---|
| Indigo | `#384C9E` | Linke Hälfte, eigene Nachrichten, Knöpfe |
| Grün | `#1E6F58` | Rechte Hälfte, zweite Person |
| Tinte | `#20222B` | Schriftzug und Fließtext |
| Grundton | `#E4E5E9` | Hintergrund der App |
| Linie | `#D2D4DB` | Rahmen und Trenner |

## Regeln

Freiraum rundherum mindestens so breit wie der Blasenschwanz hoch ist.

Nicht verzerren, nicht drehen, die Naht nicht begradigen, keine Schatten oder Verläufe.

Auf farbigem Grund die einfarbige Variante nehmen, nicht die zweifarbige.

Kleinste sinnvolle Größe der Blase: 24 px. Darunter verschwindet die Naht.

## Schriftzug

Der Schriftzug ist gezeichnet, keine Schriftart — er sieht deshalb überall gleich aus, ohne dass eine Schriftdatei mitgeliefert werden muss. Raster: Strichstärke 16, x-Höhe 60, Innenräume durchgehend 28, runde Enden. Für Fließtext daneben wird DM Sans verwendet.
