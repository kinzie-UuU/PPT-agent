import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themeSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "themes.json"), "utf8"));
const layoutSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "layouts.json"), "utf8"));
const skillRuleSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "skill-rules.json"), "utf8"));
const templatePackSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "template-packs.json"), "utf8"));

export function getDesignSystem() {
  return {
    themes: themeSystem.themes,
    layouts: layoutSystem.layouts,
    skillRules: skillRuleSystem.rules,
    templatePacks: templatePackSystem.templatePacks
  };
}

export function getThemeRecord(style = "") {
  return themeSystem.themes.find((item) => item.name === style || item.slug === style) || themeSystem.themes[0];
}

export function getLayoutRecords() {
  return layoutSystem.layouts;
}

export function getTemplatePack(style = "") {
  const theme = getThemeRecord(style);
  return templatePackSystem.templatePacks.find((item) => item.themeName === style || item.themeSlug === theme.slug || item.slug === style) || templatePackSystem.templatePacks[0];
}

export function getTemplatePackPrompt(style = "") {
  const pack = getTemplatePack(style);
  return [
    `模板包：${pack.name}`,
    `适用场景：${pack.scenario}`,
    `核心版式：${pack.coreLayouts.join(" / ")}`,
    `推荐页面顺序：${pack.preferredSequence.join(" > ")}`,
    `弱资料顺序：${pack.weakSequence.join(" > ")}`,
    `标题语气：${pack.titleVoice}`,
    `图片规则：${pack.imageRule}`,
    `价格规则：${pack.priceRule}`,
    `产品页规则：${pack.productRule}`,
    `对比页规则：${pack.compareRule}`,
    `收尾规则：${pack.closingRule}`,
    `弱资料规则：${pack.weakInputRule}`,
    `禁用风格：${pack.avoid.join("；")}`
  ].join("\n");
}

export function getSkillRulePrompt() {
  return Object.entries(skillRuleSystem.rules || {})
    .map(([group, items]) => `${group}: ${items.join("；")}`)
    .join("\n");
}
