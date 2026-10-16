const fs = require("node:fs/promises");
const path = require("node:path");
const { withAndroidStyles, withDangerousMod } = require("expo/config-plugins");

function ensureColor(xml, name, value) {
  const color = new RegExp(`<color\\s+name=["']${name}["'][^>]*>[\\s\\S]*?<\\/color>`);
  if (color.test(xml)) {
    return xml.replace(color, `<color name="${name}">${value}</color>`);
  }
  return xml.replace("</resources>", `  <color name="${name}">${value}</color>\n</resources>`);
}

function ensureThemeItem(xml, themeName, itemName, value) {
  const style = new RegExp(`<style\\s+name=["']${themeName}["'][^>]*>[\\s\\S]*?<\\/style>`);
  const match = xml.match(style);
  if (!match) {
    return xml.replace(
      "</resources>",
      `  <style name="${themeName}" parent="Theme.AppCompat.DayNight.NoActionBar">\n` +
        `    <item name="${itemName}">${value}</item>\n` +
        "  </style>\n</resources>",
    );
  }
  const item = new RegExp(`<item\\s+name=["']${itemName}["'][^>]*>[^<]*<\\/item>`);
  const updatedStyle = item.test(match[0])
    ? match[0].replace(item, `<item name="${itemName}">${value}</item>`)
    : match[0].replace("</style>", `    <item name="${itemName}">${value}</item>\n  </style>`);
  return xml.replace(style, updatedStyle);
}

async function updateColors(file, colors) {
  let xml;
  try {
    xml = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    xml = "<resources>\n</resources>\n";
  }
  for (const [name, value] of Object.entries(colors)) {
    xml = ensureColor(xml, name, value);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, xml);
}

async function updateTheme(file, itemName, value) {
  let xml;
  try {
    xml = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    xml = "<resources>\n</resources>\n";
  }
  xml = ensureThemeItem(xml, "AppTheme", itemName, value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, xml);
}

function adaptiveIconXml(night = false) {
  const foreground = night
    ? "@drawable/ic_launcher_foreground_night"
    : "@mipmap/ic_launcher_foreground";
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/iconBackground"/>
    <foreground android:drawable="${foreground}"/>
</adaptive-icon>
`;
}

function withPaseoAdaptiveIconTheme(config) {
  config = withAndroidStyles(config, (modConfig) => {
    const appTheme = modConfig.modResults.resources.style?.find(
      (style) => style.$.name === "AppTheme",
    );
    if (!appTheme) throw new Error("Could not find AppTheme in Android styles");
    appTheme.item ??= [];
    const upsert = (name, value) => {
      const item = appTheme.item.find((entry) => entry.$.name === name);
      if (item) item._ = value;
      else appTheme.item.push({ $: { name }, _: value });
    };
    upsert("android:statusBarColor", "#ffffff");
    upsert("android:windowLightStatusBar", "true");
    return modConfig;
  });
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const res = path.join(modConfig.modRequest.platformProjectRoot, "app/src/main/res");
      await updateColors(path.join(res, "values/colors.xml"), {
        iconBackground: "#ffffff",
      });
      await updateColors(path.join(res, "values-night/colors.xml"), {
        iconBackground: "#000000",
      });
      await updateTheme(
        path.join(res, "values/styles.xml"),
        "android:windowLightStatusBar",
        "true",
      );
      await updateTheme(
        path.join(res, "values-night/styles.xml"),
        "android:windowLightStatusBar",
        "false",
      );

      await fs.rm(path.join(res, "drawable/ic_launcher_foreground_tinted.xml"), { force: true });
      const nightForeground = path.join(res, "drawable-nodpi/ic_launcher_foreground_night.png");
      await fs.mkdir(path.dirname(nightForeground), { recursive: true });
      await fs.copyFile(
        path.join(modConfig.modRequest.projectRoot, "assets/images/android-icon-foreground.png"),
        nightForeground,
      );

      const icons = path.join(res, "mipmap-anydpi-v26");
      await fs.mkdir(icons, { recursive: true });
      for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
        await fs.writeFile(path.join(icons, name), adaptiveIconXml(false));
      }
      const nightIcons = path.join(res, "mipmap-night-anydpi-v26");
      await fs.mkdir(nightIcons, { recursive: true });
      for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
        await fs.writeFile(path.join(nightIcons, name), adaptiveIconXml(true));
      }
      return modConfig;
    },
  ]);
}

module.exports = withPaseoAdaptiveIconTheme;
