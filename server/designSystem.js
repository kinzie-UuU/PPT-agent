import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themeSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "themes.json"), "utf8"));
const layoutSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "layouts.json"), "utf8"));

export function getDesignSystem() {
  return {
    themes: themeSystem.themes,
    layouts: layoutSystem.layouts
  };
}

export function getThemeRecord(style = "") {
  return themeSystem.themes.find((item) => item.name === style || item.slug === style) || themeSystem.themes[0];
}

export function getLayoutRecords() {
  return layoutSystem.layouts;
}
