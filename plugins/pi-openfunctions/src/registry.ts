import { ToolRegistry } from "../../../src/framework/registry.js";
import { defineTool, err, ok } from "../../../src/framework/tool.js";

export function buildSampleRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    defineTool<{ a: number; b: number }>({
      name: "of_add",
      description: "Add two numbers and return their sum",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
        },
        required: ["a", "b"],
      },
      handler: async ({ a, b }) => ok({ result: a + b }),
    }),
  );

  registry.register(
    defineTool<{ value: number; from_unit: string; to_unit: string }>({
      name: "of_convert_distance",
      description: "Convert a distance between kilometers and miles",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number", description: "Distance to convert" },
          from_unit: { type: "string", enum: ["km", "mi"] },
          to_unit: { type: "string", enum: ["km", "mi"] },
        },
        required: ["value", "from_unit", "to_unit"],
      },
      handler: async ({ value, from_unit, to_unit }) => {
        if (from_unit === to_unit) return ok({ result: value, unit: to_unit });
        if (from_unit === "km" && to_unit === "mi") {
          return ok({ result: value * 0.621371, unit: "mi" });
        }
        if (from_unit === "mi" && to_unit === "km") {
          return ok({ result: value / 0.621371, unit: "km" });
        }
        return err("unsupported distance units");
      },
    }),
  );

  return registry;
}
