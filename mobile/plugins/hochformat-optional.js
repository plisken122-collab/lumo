/* Diralo ist auf Hochformat gestellt (orientation: portrait). Google Play
   leitet daraus das Geraete-Merkmal android.hardware.screen.portrait als
   PFLICHT ab und warnt bei jeder Einreichung, dass Geraete wegfallen
   koennten. Hier steht ausdruecklich: nicht noetig. */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function hochformatOptional(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    manifest.$["xmlns:tools"] = manifest.$["xmlns:tools"] || "http://schemas.android.com/tools";
    const features = manifest["uses-feature"] || [];
    const name = "android.hardware.screen.portrait";
    const da = features.find((f) => f.$ && f.$["android:name"] === name);
    if (da) {
      da.$["android:required"] = "false";
      da.$["tools:replace"] = "android:required";
    } else {
      features.push({ $: { "android:name": name, "android:required": "false" } });
    }
    manifest["uses-feature"] = features;
    return cfg;
  });
};
