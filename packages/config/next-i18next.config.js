const i18n = require("../../i18n.json");

const DEFAULT_LOCALE = "vi";
const locales = Array.from(new Set([DEFAULT_LOCALE, ...i18n.locale.targets, i18n.locale.source]));

/** @type {import("next-i18next").UserConfig} */
const config = {
  i18n: {
    defaultLocale: DEFAULT_LOCALE,
    locales,
  },
  fallbackLng: {
    default: ["en"],
    zh: ["zh-CN"],
  },
  reloadOnPrerender: process.env.NODE_ENV !== "production",
};

module.exports = config;
