/**
 * Recipe Keeper — Example Tool Domain
 *
 * Save, search, and randomly pick recipes. A personal cookbook
 * the AI can build up and query on behalf of the user.
 *
 * This demonstrates:
 *   - Rich nested data (multiple array fields: ingredients, instructions, tags)
 *   - Multi-field search with composable filters
 *   - Random selection from a filtered set
 */

import { defineTool, ok, err, createStore } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Recipe {
  id: string;
  title: string;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  prepTime?: number;
  servings?: number;
  createdAt: string;
}

/** Parameter types — match these to your inputSchema */
interface SaveRecipeParams {
  title: string;
  ingredients: string[];
  instructions: string[];
  tags?: string[];
  prep_time?: number;
  servings?: number;
}
interface SearchRecipesParams { query?: string; tag?: string; ingredient?: string }
interface GetRandomParams { tag?: string }

/** Persistent store — data saved to .data/recipes.json, survives restarts */
const recipes = createStore<Recipe>("recipes");
let nextId = recipes.size + 1;

// ─── Tools ─────────────────────────────────────────────────────────────────

export const saveRecipe = defineTool<SaveRecipeParams>({
  name: "save_recipe",
  description:
    "Save a recipe with ingredients, instructions, and optional metadata. " +
    "Use this when the user wants to store a recipe for later.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Name of the recipe",
      },
      ingredients: {
        type: "array",
        items: { type: "string" },
        description: "List of ingredients (e.g. ['2 cups flour', '1 egg'])",
      },
      instructions: {
        type: "array",
        items: { type: "string" },
        description: "Step-by-step instructions in order",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for categorization (e.g. ['dinner', 'vegetarian'])",
      },
      prep_time: {
        type: "number",
        description: "Preparation time in minutes",
      },
      servings: {
        type: "number",
        description: "Number of servings the recipe makes",
      },
    },
    required: ["title", "ingredients", "instructions"],
  },
  tags: ["cooking", "recipes"],
  handler: async ({ title, ingredients, instructions, tags, prep_time, servings }) => {
    const id = String(nextId++);
    const recipe: Recipe = {
      id,
      title,
      ingredients,
      instructions,
      tags: tags ?? [],
      prepTime: prep_time,
      servings,
      createdAt: new Date().toISOString(),
    };
    recipes.set(id, recipe);
    return ok(recipe, `Saved: "${recipe.title}"`);
  },
});

export const searchRecipes = defineTool<SearchRecipesParams>({
  name: "search_recipes",
  description:
    "Search saved recipes by keyword, tag, or ingredient. " +
    "All filters are optional but at least one should be provided. Filters compose together.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — matches against recipe title",
      },
      tag: {
        type: "string",
        description: "Filter by a specific tag (e.g. 'vegetarian')",
      },
      ingredient: {
        type: "string",
        description: "Filter by an ingredient (e.g. 'chicken')",
      },
    },
    required: [],
  },
  tags: ["cooking", "recipes"],
  handler: async ({ query, tag, ingredient }) => {
    let results = recipes.getAll();

    if (query) {
      const q = query.toLowerCase();
      results = results.filter((r) =>
        r.title.toLowerCase().includes(q),
      );
    }

    if (tag) {
      const t = tag.toLowerCase();
      results = results.filter((r) =>
        r.tags.some((rt) => rt.toLowerCase().includes(t)),
      );
    }

    if (ingredient) {
      const ing = ingredient.toLowerCase();
      results = results.filter((r) =>
        r.ingredients.some((i) => i.toLowerCase().includes(ing)),
      );
    }

    return ok(
      { recipes: results, total: results.length },
      `Found ${results.length} recipe${results.length === 1 ? "" : "s"}`,
    );
  },
});

export const getRandom = defineTool<GetRandomParams>({
  name: "get_random",
  description:
    "Get a random recipe. Optionally filter by tag first. " +
    "Great for when the user can't decide what to cook.",
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        description: "Optional tag to filter by before picking a random recipe",
      },
    },
    required: [],
  },
  tags: ["cooking", "recipes"],
  handler: async ({ tag }) => {
    let candidates = recipes.getAll();

    if (tag) {
      const t = tag.toLowerCase();
      candidates = candidates.filter((r) =>
        r.tags.some((rt) => rt.toLowerCase().includes(t)),
      );
    }

    if (candidates.length === 0) {
      return err(
        tag
          ? `No recipes found with tag "${tag}"`
          : "No recipes saved yet",
      );
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return ok(pick, `Random pick: "${pick.title}"`);
  },
});

export const recipeKeeperTools = [saveRecipe, searchRecipes, getRandom];
