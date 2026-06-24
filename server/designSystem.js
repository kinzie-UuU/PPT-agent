import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themeSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "themes.json"), "utf8"));
const layoutSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "layouts.json"), "utf8"));
const skillRuleSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "skill-rules.json"), "utf8"));
const aestheticRecipeSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "aesthetic-recipes.json"), "utf8"));
const REMOVED_RULE_GROUPS = new Set(["oldDeck", "templateReuse", "templatePacks"]);
const removedTemplatePack = {
  slug: "skill-first-no-legacy-template",
  name: "双技能工作流",
  scenario: "当前只使用 codex-ppt 和 image-to-editable-ppt 工作流输入。",
  coreLayouts: [],
  preferredSequence: [],
  weakSequence: [],
  avoid: []
};

function getSkillFirstRules() {
  return Object.fromEntries(
    Object.entries(skillRuleSystem.rules || {}).filter(([group]) => !REMOVED_RULE_GROUPS.has(group))
  );
}

export function getDesignSystem() {
  return {
    themes: themeSystem.themes,
    layouts: layoutSystem.layouts,
    skillRules: getSkillFirstRules(),
    aestheticRecipes: aestheticRecipeSystem
  };
}

export function getThemeRecord(style = "") {
  return themeSystem.themes.find((item) => item.name === style || item.slug === style) || themeSystem.themes[0];
}

export function getLayoutRecords() {
  return layoutSystem.layouts;
}

export function getTemplatePack(style = "") {
  return {
    ...removedTemplatePack,
    requestedStyle: style || ""
  };
}
export function getTemplatePackPrompt(style = "") {
  return "";
}

export function getSkillRulePrompt() {
  return Object.entries(getSkillFirstRules())
    .map(([group, items]) => `${group}: ${items.join("；")}`)
    .join("\n");
}
