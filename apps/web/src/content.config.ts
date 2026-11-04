// Content collection for blog posts.
//
// Posts live under src/content/blog/*.md (or .mdx). Frontmatter shape
// validated by the schema below — Astro errors at build if a post is
// missing required fields, which is the cheapest way to avoid drafts
// shipping with broken metadata.

import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(120),
    description: z.string().max(280),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    author: z.string().default("openma"),
    /**
     * Post language. English posts live at src/content/blog/<slug>.md and are
     * served at /blog/<slug>/. Chinese posts live at src/content/blog/zh/<slug>.md
     * and are served at /zh/blog/<slug>/. Same <slug> = translations of each other.
     */
    lang: z.enum(["en", "zh"]).default("en"),
    tags: z.array(z.string()).default([]),
    /** Optional FAQ pairs rendered in the post; also emitted as FAQPage JSON-LD. */
    faq: z
      .array(z.object({ question: z.string(), answer: z.string() }))
      .optional(),
    /** Hide from /blog index. Useful for unlisted posts shared via direct link. */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
