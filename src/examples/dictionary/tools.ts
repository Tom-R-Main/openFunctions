/**
 * Dictionary — Example Tool Domain (API Wrapper Pattern)
 *
 * This is an API-wrapper pattern — no persistence, just bridging AI to external APIs.
 * Unlike other examples that use createStore for state, this domain is fully stateless:
 * every call hits the Free Dictionary API and returns the result.
 *
 * Shows how to use fetch(), handle HTTP errors, and parse API responses
 * into clean typed objects that an AI agent can reason about.
 *
 * Uses a free API that requires no setup:
 *   https://api.dictionaryapi.dev/api/v2/entries/en/{word}
 *   - No auth required, no API key, no rate limits
 *   - Returns 404 if word not found
 *   - Returns JSON array of word entries with meanings, phonetics, synonyms
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface WordDefinition {
  word: string;
  phonetic?: string;
  meanings: Array<{
    partOfSpeech: string;
    definitions: Array<{
      definition: string;
      example?: string;
    }>;
  }>;
}

/** Parameter types — match these to your inputSchema */
interface DefineWordParams { word: string }
interface FindSynonymsParams { word: string }

// ─── Helpers ────────────────────────────────────────────────────────────────

const API_BASE = "https://api.dictionaryapi.dev/api/v2/entries/en";

async function fetchWord(word: string): Promise<{ data?: any; error?: string }> {
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(word)}`);

    if (response.status === 404) {
      return { error: `Word not found: "${word}"` };
    }

    if (!response.ok) {
      return { error: `API error: ${response.status} ${response.statusText}` };
    }

    const data = await response.json();
    return { data };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `Network error: ${message}` };
  }
}

function parseDefinition(apiEntry: any): WordDefinition {
  return {
    word: apiEntry.word,
    phonetic: apiEntry.phonetic ?? apiEntry.phonetics?.[0]?.text,
    meanings: (apiEntry.meanings ?? []).map((m: any) => ({
      partOfSpeech: m.partOfSpeech,
      definitions: (m.definitions ?? []).map((d: any) => ({
        definition: d.definition,
        ...(d.example ? { example: d.example } : {}),
      })),
    })),
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export const defineWord = defineTool<DefineWordParams>({
  name: "define_word",
  description:
    "Look up a word's definition, phonetic pronunciation, and meanings. " +
    "Use this when the user asks what a word means or wants a dictionary lookup.",
  inputSchema: {
    type: "object",
    properties: {
      word: {
        type: "string",
        description: "The English word to look up (e.g. 'ephemeral', 'synergy')",
      },
    },
    required: ["word"],
  },
  tags: ["reference", "language"],
  examples: [
    {
      description: "Look up a word definition",
      input: { word: "hello" },
      output: {
        success: true,
        data: {
          word: "hello",
          phonetic: "/h\u025b\u02c8lo\u028a/",
          meanings: [
            {
              partOfSpeech: "noun",
              definitions: [
                { definition: "An utterance of 'hello'; a greeting." },
              ],
            },
          ],
        },
      },
    },
  ],
  handler: async ({ word }) => {
    const { data, error } = await fetchWord(word);

    if (error) {
      return err(error);
    }

    const entry = Array.isArray(data) ? data[0] : data;
    const definition = parseDefinition(entry);

    const meaningCount = definition.meanings.length;
    return ok(
      definition,
      `Found definition for "${definition.word}" with ${meaningCount} meaning${meaningCount === 1 ? "" : "s"}`,
    );
  },
});

export const findSynonyms = defineTool<FindSynonymsParams>({
  name: "find_synonyms",
  description:
    "Find synonyms for a word. Extracts all synonyms from the dictionary entry. " +
    "Use this when the user wants alternative words or is looking for a thesaurus-style lookup.",
  inputSchema: {
    type: "object",
    properties: {
      word: {
        type: "string",
        description: "The English word to find synonyms for (e.g. 'happy', 'fast')",
      },
    },
    required: ["word"],
  },
  tags: ["reference", "language"],
  examples: [
    {
      description: "Find synonyms for a word",
      input: { word: "happy" },
      output: {
        success: true,
        data: {
          word: "happy",
          synonyms: ["content", "pleased", "glad", "joyful"],
        },
      },
    },
  ],
  handler: async ({ word }) => {
    const { data, error } = await fetchWord(word);

    if (error) {
      return err(error);
    }

    const entry = Array.isArray(data) ? data[0] : data;

    // Collect synonyms from all meanings and all definitions, then deduplicate
    const synonymSet = new Set<string>();

    for (const meaning of entry.meanings ?? []) {
      for (const syn of meaning.synonyms ?? []) {
        synonymSet.add(syn);
      }
      for (const def of meaning.definitions ?? []) {
        for (const syn of def.synonyms ?? []) {
          synonymSet.add(syn);
        }
      }
    }

    const synonyms = [...synonymSet];

    if (synonyms.length === 0) {
      return ok(
        { word: entry.word, synonyms: [] },
        `No synonyms found for "${entry.word}"`,
      );
    }

    return ok(
      { word: entry.word, synonyms },
      `Found ${synonyms.length} synonym${synonyms.length === 1 ? "" : "s"} for "${entry.word}"`,
    );
  },
});

/** All dictionary tools — register these with the registry */
export const dictionaryTools = [defineWord, findSynonyms];
