/**
 * AI-Powered Tools — Example Tool Domain
 *
 * Tools that call an LLM (Gemini) internally.
 * This is the meta pattern: an AI calling a tool that calls an AI.
 *
 * This demonstrates:
 *   - Calling an external LLM API from within a tool handler
 *   - Using structured prompts to get formatted responses
 *   - Graceful degradation when API keys aren't set
 *   - The pattern behind every real agent system
 *
 * Requires: GEMINI_API_KEY environment variable
 * Get one free at: https://aistudio.google.com/apikey
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Gemini API Helper ─────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(prompt: string, systemInstruction?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey"
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.find(
    (p: { text?: string }) => p.text
  )?.text;

  if (!text) {
    throw new Error("No text response from Gemini");
  }

  return text;
}

// ─── Parameter Types ────────────────────────────────────────────────────────

interface SummarizeParams {
  text: string;
  max_sentences?: number;
}

interface FlashcardParams {
  material: string;
  count?: number;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export const summarizeText = defineTool<SummarizeParams>({
  name: "summarize_text",
  description:
    "Summarize a piece of text using AI. Useful when the user has a long " +
    "passage and wants a concise summary. Requires GEMINI_API_KEY.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to summarize",
      },
      max_sentences: {
        type: "integer",
        description: "Maximum number of sentences in the summary (default 3)",
      },
    },
    required: ["text"],
  },
  tags: ["ai", "text"],
  handler: async ({ text, max_sentences }) => {
    const sentences = max_sentences ?? 3;

    try {
      const summary = await callGemini(
        `Summarize the following text in ${sentences} sentences or fewer. ` +
          `Be concise and capture the key points.\n\n${text}`,
        "You are a concise summarizer. Return only the summary, no preamble."
      );

      return ok(
        { summary, originalLength: text.length, summaryLength: summary.length },
        `Summarized ${text.length} characters into ${summary.length} characters`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return err(message);
    }
  },
});

export const generateFlashcards = defineTool<FlashcardParams>({
  name: "generate_flashcards",
  description:
    "Generate study flashcards from text material using AI. The AI reads the " +
    "material and creates question/answer pairs. Requires GEMINI_API_KEY.",
  inputSchema: {
    type: "object",
    properties: {
      material: {
        type: "string",
        description: "The study material to create flashcards from",
      },
      count: {
        type: "integer",
        description: "Number of flashcards to generate (default 5)",
      },
    },
    required: ["material"],
  },
  tags: ["ai", "education"],
  handler: async ({ material, count }) => {
    const numCards = count ?? 5;

    try {
      const response = await callGemini(
        `Create exactly ${numCards} flashcards from this study material. ` +
          `Return ONLY a JSON array of objects with "question" and "answer" fields. ` +
          `No markdown, no explanation, just the JSON array.\n\n${material}`,
        "You are a study assistant. Return valid JSON only — an array of " +
          '{"question": "...", "answer": "..."} objects. No markdown code fences.'
      );

      // Parse the JSON response — Gemini might wrap it in code fences
      const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      let flashcards: Array<{ question: string; answer: string }>;

      try {
        flashcards = JSON.parse(cleaned);
      } catch {
        return err(
          "Failed to parse flashcard response as JSON. " +
            "This sometimes happens — try again."
        );
      }

      if (!Array.isArray(flashcards)) {
        return err("Expected an array of flashcards");
      }

      return ok(
        { flashcards, count: flashcards.length },
        `Generated ${flashcards.length} flashcards from study material`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return err(message);
    }
  },
});

/** AI-powered tools — require GEMINI_API_KEY environment variable */
export const aiTools = [summarizeText, generateFlashcards];
