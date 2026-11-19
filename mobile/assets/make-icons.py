"""Erzeugt die App-Symbole aus dem Diralo-Logo (brand/export/diralo-marke.png).
Vorher lagen hier noch die Platzhalter aus der Expo-Vorlage (blaues "A")."""
from pathlib import Path
from PIL import Image

HIER = Path(__file__).parent
MARKE = Image.open(HIER.parent.parent / "brand" / "export" / "diralo-marke.png").convert("RGBA")
# Leerraum um die Blase abschneiden
MARKE = MARKE.crop(MARKE.getbbox())


def mitte(groesse, anteil, grund):
    """Blase mittig auf eine Flaeche setzen, Breite = anteil * groesse."""
    c = Image.new("RGBA", (groesse, groesse), grund)
    b = int(groesse * anteil)
    h = int(MARKE.height * b / MARKE.width)
    m = MARKE.resize((b, h), Image.LANCZOS)
    c.alpha_composite(m, ((groesse - b) // 2, (groesse - h) // 2))
    return c


WEISS = (255, 255, 255, 255)
LEER = (0, 0, 0, 0)

# Klassisches Symbol (iOS / Fallback): weisser Grund wie im Play Store
mitte(1024, 0.62, WEISS).convert("RGB").save(HIER / "icon.png")
# Adaptives Android-Symbol: Vordergrund nur im sicheren Kreis (~66 %)
mitte(1024, 0.50, LEER).save(HIER / "android-icon-foreground.png")
Image.new("RGB", (1024, 1024), (255, 255, 255)).save(HIER / "android-icon-background.png")
# Einfarbig (Themen-Symbole, Benachrichtigungen): weisse Silhouette
mono = mitte(1024, 0.50, LEER)
weiss = Image.new("RGBA", mono.size, WEISS)
weiss.putalpha(mono.getchannel("A"))
weiss.save(HIER / "android-icon-monochrome.png")
# Startbildschirm und Web-Favicon
mitte(1024, 0.55, LEER).save(HIER / "splash-icon.png")
mitte(48, 0.9, LEER).save(HIER / "favicon.png")
print("ok")
