import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const CodeSearchSchema = Type.Object(
  {
    query: Type.String({
      description: "Semantic search query across indexed codebases.",
    }),
    repositoryId: Type.Optional(
      Type.String({ description: "Limit search to a specific repository." }),
    ),
  },
  { additionalProperties: false },
);

const WhoKnowsSchema = Type.Object(
  {
    repositoryId: Type.String({ description: "Repository ID to query." }),
    area: Type.String({
      description:
        "Code area or topic to find experts for, e.g. 'authentication middleware' or 'database migrations'.",
    }),
  },
  { additionalProperties: false },
);

export function registerCodebaseTools(client: ExfClient) {
  return [
    {
      name: "exf_codebase_search",
      label: "ExecuFunction: Code Search",
      description:
        "Semantic search across indexed codebases in ExecuFunction. " +
        "Finds relevant code snippets, files, and functions by meaning.",
      parameters: CodeSearchSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const query = readStringParam(rawParams, "query", { required: true });
        const repositoryId = readStringParam(rawParams, "repositoryId");
        return jsonResult(await client.searchCode(query, repositoryId));
      },
    },
    {
      name: "exf_code_who_knows",
      label: "ExecuFunction: Who Knows",
      description:
        "Find who has expertise in a specific code area. " +
        "Returns developers ranked by their knowledge of the queried topic, based on commit history and code ownership.",
      parameters: WhoKnowsSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const repositoryId = readStringParam(rawParams, "repositoryId", { required: true });
        const area = readStringParam(rawParams, "area", { required: true });
        return jsonResult(await client.codeWhoKnows(repositoryId, area));
      },
    },
  ];
}
