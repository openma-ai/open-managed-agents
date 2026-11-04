// Minimal blog i18n. English is the default locale and lives at /blog/<slug>/.
// Chinese posts sit in src/content/blog/zh/ and are served at /zh/blog/<slug>/.
// Posts sharing a <slug> across locales are translations of each other.
import type { CollectionEntry } from "astro:content";

export type BlogLang = "en" | "zh";

export const HREFLANG: Record<BlogLang, string> = { en: "en", zh: "zh-Hans" };

export const UI: Record<BlogLang, Record<string, string>> = {
  en: {
    home: "Home", blog: "Blog", related: "Related posts", all: "← All posts",
    rss: "Subscribe via RSS", read: "min read", updated: "updated",
    switchTo: "Read in English", locale: "en-US",
  },
  zh: {
    home: "首页", blog: "博客", related: "相关文章", all: "← 所有文章",
    rss: "RSS 订阅", read: "分钟阅读", updated: "更新于",
    switchTo: "阅读中文版", locale: "zh-CN",
  },
};

export function postSlug(post: CollectionEntry<"blog">): string {
  return post.id.replace(/^zh\//, "");
}

export function blogBase(lang: BlogLang): string {
  return lang === "en" ? "/blog/" : `/${lang}/blog/`;
}

export function postPath(post: CollectionEntry<"blog">): string {
  return `${blogBase(post.data.lang)}${postSlug(post)}/`;
}
