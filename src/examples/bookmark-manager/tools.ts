/**
 * Bookmark Manager — Example Tool Domain
 *
 * Save, search, and tag links. Think of it as a personal
 * knowledge base the AI can read and write to.
 *
 * This demonstrates:
 *   - Array-type parameters (tags)
 *   - Search/filter logic in a handler
 *   - Building something an AI can use as "memory"
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Bookmark {
  id: string;
  url: string;
  title: string;
  tags: string[];
  note?: string;
  savedAt: string;
}

/** Parameter types — match these to your inputSchema */
interface SaveLinkParams { url: string; title: string; tags?: string[]; note?: string }
interface SearchLinksParams { query: string; tag?: string }
interface TagLinkParams { id: string; tags: string[] }

const bookmarks = new Map<string, Bookmark>();
let nextId = 1;

// ─── Tools ─────────────────────────────────────────────────────────────────

export const saveLink = defineTool<SaveLinkParams>({
  name: "save_link",
  description:
    "Save a URL as a bookmark with a title and optional tags. " +
    "Use this when the user wants to save a link for later.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to save",
      },
      title: {
        type: "string",
        description: "A descriptive title for the bookmark",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for categorization (e.g. ['python', 'tutorial'])",
      },
      note: {
        type: "string",
        description: "Optional note about why this link is useful",
      },
    },
    required: ["url", "title"],
  },
  tags: ["knowledge", "bookmarks"],
  handler: async ({ url, title, tags, note }) => {
    const id = String(nextId++);
    const bookmark: Bookmark = {
      id,
      url,
      title,
      tags: tags ?? [],
      note,
      savedAt: new Date().toISOString(),
    };
    bookmarks.set(id, bookmark);
    return ok(bookmark, `Saved: "${bookmark.title}"`);
  },
});

export const searchLinks = defineTool<SearchLinksParams>({
  name: "search_links",
  description:
    "Search saved bookmarks by keyword or tag. " +
    "Searches across titles, tags, notes, and URLs.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — matches against title, URL, tags, and notes",
      },
      tag: {
        type: "string",
        description: "Filter by a specific tag (optional)",
      },
    },
    required: ["query"],
  },
  tags: ["knowledge", "bookmarks"],
  handler: async ({ query, tag }) => {
    const q = query.toLowerCase();
    let results = Array.from(bookmarks.values()).filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.url.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q)) ||
        (b.note && b.note.toLowerCase().includes(q)),
    );

    if (tag) {
      results = results.filter((b) =>
        b.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
      );
    }

    return ok(
      { bookmarks: results, total: results.length },
      `Found ${results.length} bookmark${results.length === 1 ? "" : "s"} matching "${query}"`,
    );
  },
});

export const tagLink = defineTool<TagLinkParams>({
  name: "tag_link",
  description: "Add tags to an existing bookmark.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Bookmark ID",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags to add",
      },
    },
    required: ["id", "tags"],
  },
  tags: ["knowledge", "bookmarks"],
  handler: async ({ id, tags }) => {
    const bookmark = bookmarks.get(id);
    if (!bookmark) return err(`No bookmark found with ID "${id}"`);

    const newTags = tags.filter(
      (t) => !bookmark.tags.includes(t),
    );
    bookmark.tags.push(...newTags);

    return ok(
      bookmark,
      `Added ${newTags.length} tag${newTags.length === 1 ? "" : "s"} to "${bookmark.title}"`,
    );
  },
});

export const bookmarkManagerTools = [saveLink, searchLinks, tagLink];
