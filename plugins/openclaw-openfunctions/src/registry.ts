/**
 * Self-contained sample registry for the openFunctions → openclaw demo.
 *
 * In a real plugin you'd import an existing ToolRegistry from your
 * application code (or from the openFunctions framework once it's
 * published as @openfunctions/framework). Here we build a small
 * registry inline so the demo doesn't need any framework imports
 * beyond the bridge function it's showcasing.
 */

import {
  ToolRegistry,
  defineTool,
  ok,
  err,
} from "../../../src/framework/index.js";

export function buildSampleRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    defineTool<{ a: number; b: number; operator: string }>({
      name: "of_calculate",
      description:
        "Add, subtract, multiply, or divide two numbers. operator must be " +
        "one of: add, subtract, multiply, divide.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
          operator: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
            description: "Operation to perform",
          },
        },
        required: ["a", "b", "operator"],
      },
      handler: async ({ a, b, operator }) => {
        switch (operator) {
          case "add":
            return ok({ result: a + b });
          case "subtract":
            return ok({ result: a - b });
          case "multiply":
            return ok({ result: a * b });
          case "divide":
            if (b === 0) return err("division by zero");
            return ok({ result: a / b });
          default:
            return err(`unknown operator: ${operator}`);
        }
      },
    }),
  );

  registry.register(
    defineTool<{ value: number; from_unit: string; to_unit: string }>({
      name: "of_convert_units",
      description:
        "Convert between common units. Supported pairs: km↔mi, c↔f, kg↔lb.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number", description: "Value to convert" },
          from_unit: { type: "string", description: "Source unit (km, mi, c, f, kg, lb)" },
          to_unit: { type: "string", description: "Target unit (km, mi, c, f, kg, lb)" },
        },
        required: ["value", "from_unit", "to_unit"],
      },
      handler: async ({ value, from_unit, to_unit }) => {
        const key = `${from_unit.toLowerCase()}->${to_unit.toLowerCase()}`;
        const conversions: Record<string, (v: number) => number> = {
          "km->mi": (v) => v * 0.621371,
          "mi->km": (v) => v / 0.621371,
          "c->f": (v) => (v * 9) / 5 + 32,
          "f->c": (v) => ((v - 32) * 5) / 9,
          "kg->lb": (v) => v * 2.20462,
          "lb->kg": (v) => v / 2.20462,
        };
        const fn = conversions[key];
        if (!fn) return err(`unsupported conversion: ${from_unit} → ${to_unit}`);
        return ok({ result: fn(value), from_unit, to_unit });
      },
    }),
  );

  return registry;
}
