/**
 * Utilities — Stateless Tool Domain
 *
 * Pure utility functions: calculations, unit conversions, date formatting.
 * No persistence, no external APIs — just input in, result out.
 *
 * This demonstrates that not every tool needs a store or API call.
 * Sometimes the AI just needs help with math or formatting, and
 * pure functions are the cleanest way to provide that.
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Param Types ────────────────────────────────────────────────────────────

interface CalculateParams {
  a: number;
  b: number;
  operator: "add" | "subtract" | "multiply" | "divide";
}

interface ConvertUnitsParams {
  value: number;
  from_unit: string;
  to_unit: string;
}

interface FormatDateParams {
  date: string;
  format: "iso" | "long" | "short" | "relative";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Parse a date string in common formats:
 *   YYYY-MM-DD, MM/DD/YYYY, "March 24, 2026", ISO strings
 * Returns a Date or null if unparseable.
 */
function parseDate(input: string): Date | null {
  const trimmed = input.trim();

  // YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const d = new Date(
      parseInt(isoMatch[1]),
      parseInt(isoMatch[2]) - 1,
      parseInt(isoMatch[3]),
    );
    if (!isNaN(d.getTime())) return d;
  }

  // MM/DD/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const d = new Date(
      parseInt(slashMatch[3]),
      parseInt(slashMatch[1]) - 1,
      parseInt(slashMatch[2]),
    );
    if (!isNaN(d.getTime())) return d;
  }

  // "March 24, 2026" style
  const longMatch = trimmed.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/,
  );
  if (longMatch) {
    const monthIdx = MONTH_NAMES.findIndex(
      (m) => m.toLowerCase() === longMatch[1].toLowerCase(),
    );
    if (monthIdx !== -1) {
      const d = new Date(
        parseInt(longMatch[3]),
        monthIdx,
        parseInt(longMatch[2]),
      );
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Fallback: let Date.parse try (handles full ISO strings like 2026-03-24T12:00:00Z)
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback;

  return null;
}

/** Format a relative time string like "3 days ago" or "in 5 days". */
function relativeTime(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffMs = startOfTarget.getTime() - startOfToday.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "in 1 day";
  if (diffDays === -1) return "1 day ago";
  if (diffDays > 0) return `in ${diffDays} days`;
  return `${Math.abs(diffDays)} days ago`;
}

// ─── Conversion table ───────────────────────────────────────────────────────

type ConversionFn = (v: number) => number;

const CONVERSIONS: Record<string, { fn: ConversionFn; formula: string }> = {
  "km->mi":  { fn: (v) => v * 0.621371,        formula: "km * 0.621371" },
  "mi->km":  { fn: (v) => v / 0.621371,        formula: "mi / 0.621371" },
  "kg->lb":  { fn: (v) => v * 2.20462,         formula: "kg * 2.20462" },
  "lb->kg":  { fn: (v) => v / 2.20462,         formula: "lb / 2.20462" },
  "C->F":    { fn: (v) => v * 9 / 5 + 32,      formula: "C * 9/5 + 32" },
  "F->C":    { fn: (v) => (v - 32) * 5 / 9,    formula: "(F - 32) * 5/9" },
  "cm->in":  { fn: (v) => v * 0.393701,        formula: "cm * 0.393701" },
  "in->cm":  { fn: (v) => v / 0.393701,        formula: "in / 0.393701" },
  "L->gal":  { fn: (v) => v * 0.264172,        formula: "L * 0.264172" },
  "gal->L":  { fn: (v) => v / 0.264172,        formula: "gal / 0.264172" },
};

const SUPPORTED_UNITS = "km, mi, kg, lb, C, F, cm, in, L, gal";

// ─── Tools ──────────────────────────────────────────────────────────────────

const OPERATOR_SYMBOLS: Record<string, string> = {
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
};

export const calculate = defineTool<CalculateParams>({
  name: "calculate",
  description:
    "Perform basic arithmetic on two numbers. " +
    "Use this when the user needs a quick calculation.",
  inputSchema: {
    type: "object",
    properties: {
      a: {
        type: "number",
        description: "The first number",
      },
      b: {
        type: "number",
        description: "The second number",
      },
      operator: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
        description: "The arithmetic operation to perform",
      },
    },
    required: ["a", "b", "operator"],
  },
  tags: ["utility", "math"],
  tests: [
    {
      name: "adds two numbers",
      input: { a: 5, b: 3, operator: "add" },
      expect: { success: true, data: { expression: "5 + 3", result: 8 } },
    },
    {
      name: "multiplies two numbers",
      input: { a: 7, b: 6, operator: "multiply" },
      expect: { success: true, data: { result: 42 } },
    },
    {
      name: "rejects division by zero",
      input: { a: 10, b: 0, operator: "divide" },
      expect: { success: false, errorContains: "Division by zero" },
    },
  ],
  handler: async ({ a, b, operator }) => {
    if (operator === "divide" && b === 0) {
      return err("Division by zero is not allowed");
    }

    const ops: Record<string, (x: number, y: number) => number> = {
      add: (x, y) => x + y,
      subtract: (x, y) => x - y,
      multiply: (x, y) => x * y,
      divide: (x, y) => x / y,
    };

    const result = ops[operator](a, b);
    const symbol = OPERATOR_SYMBOLS[operator];
    const expression = `${a} ${symbol} ${b}`;

    return ok({ expression, result }, `${expression} = ${result}`);
  },
});

export const convertUnits = defineTool<ConvertUnitsParams>({
  name: "convert_units",
  description:
    "Convert a value between common units. " +
    "Supports: km/mi, kg/lb, C/F, cm/in, L/gal.",
  inputSchema: {
    type: "object",
    properties: {
      value: {
        type: "number",
        description: "The numeric value to convert",
      },
      from_unit: {
        type: "string",
        description: "The unit to convert from (e.g. 'km', 'lb', 'C')",
      },
      to_unit: {
        type: "string",
        description: "The unit to convert to (e.g. 'mi', 'kg', 'F')",
      },
    },
    required: ["value", "from_unit", "to_unit"],
  },
  tags: ["utility", "conversion"],
  tests: [
    {
      name: "converts km to mi",
      input: { value: 100, from_unit: "km", to_unit: "mi" },
      expect: { success: true, data: { result: 62.1371 } },
    },
    {
      name: "converts C to F",
      input: { value: 0, from_unit: "C", to_unit: "F" },
      expect: { success: true, data: { result: 32 } },
    },
    {
      name: "rejects unsupported conversion",
      input: { value: 5, from_unit: "km", to_unit: "lb" },
      expect: { success: false },
    },
  ],
  handler: async ({ value, from_unit, to_unit }) => {
    const key = `${from_unit}->${to_unit}`;
    const conversion = CONVERSIONS[key];

    if (!conversion) {
      return err(
        `Unsupported conversion: ${from_unit} to ${to_unit}. ` +
        `Supported units: ${SUPPORTED_UNITS}. ` +
        `Valid pairs: km<->mi, kg<->lb, C<->F, cm<->in, L<->gal.`,
      );
    }

    const result = Math.round(conversion.fn(value) * 10000) / 10000;

    return ok(
      { value, from_unit, to_unit, result, formula: conversion.formula },
      `${value} ${from_unit} = ${result} ${to_unit}`,
    );
  },
});

export const formatDate = defineTool<FormatDateParams>({
  name: "format_date",
  description:
    "Parse a date string and reformat it. " +
    "Accepts YYYY-MM-DD, MM/DD/YYYY, 'March 24, 2026', or ISO strings. " +
    "Output as iso, long, short, or relative format.",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description:
          "The date to parse (e.g. '2026-03-24', '3/24/2026', 'March 24, 2026')",
      },
      format: {
        type: "string",
        enum: ["iso", "long", "short", "relative"],
        description:
          "Output format: 'iso' (2026-03-24), 'long' (March 24, 2026), " +
          "'short' (3/24/2026), 'relative' (3 days ago / in 5 days)",
      },
    },
    required: ["date", "format"],
  },
  tags: ["utility", "date"],
  tests: [
    {
      name: "formats as long date",
      input: { date: "2026-03-24", format: "long" },
      expect: { success: true, data: { result: "March 24, 2026" } },
    },
    {
      name: "formats as ISO",
      input: { date: "3/24/2026", format: "iso" },
      expect: { success: true, data: { result: "2026-03-24" } },
    },
    {
      name: "rejects invalid date",
      input: { date: "not-a-date", format: "iso" },
      expect: { success: false, errorContains: "parse" },
    },
  ],
  handler: async ({ date, format }) => {
    const parsed = parseDate(date);
    if (!parsed) {
      return err(
        `Could not parse date: "${date}". ` +
        `Try formats like YYYY-MM-DD, MM/DD/YYYY, or "March 24, 2026".`,
      );
    }

    const year = parsed.getFullYear();
    const month = parsed.getMonth();
    const day = parsed.getDate();

    let result: string;

    switch (format) {
      case "iso": {
        const mm = String(month + 1).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        result = `${year}-${mm}-${dd}`;
        break;
      }
      case "long":
        result = `${MONTH_NAMES[month]} ${day}, ${year}`;
        break;
      case "short":
        result = `${month + 1}/${day}/${year}`;
        break;
      case "relative":
        result = relativeTime(parsed);
        break;
      default:
        return err(`Unknown format: "${format}". Use iso, long, short, or relative.`);
    }

    return ok(
      { input: date, format, result },
      result,
    );
  },
});

/** All utility tools — register these with the registry */
export const utilityTools = [calculate, convertUnits, formatDate];
