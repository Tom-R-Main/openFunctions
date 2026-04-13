import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const SearchNotesSchema = Type.Object(
  {
    query: Type.String({ description: "Semantic search query across the knowledge base." }),
    limit: Type.Optional(
      Type.Number({ description: "Max notes to return (default 10).", minimum: 1, maximum: 50 }),
    ),
  },
  { additionalProperties: false },
);

const CreateNoteSchema = Type.Object(
  {
    title: Type.String({ description: "Note title." }),
    content: Type.String({ description: "Note content in markdown." }),
    noteType: Type.Optional(
      Type.String({
        description: 'Note type: "note", "reference", "decision", "meeting", or "journal".',
      }),
    ),
    projectId: Type.Optional(Type.String({ description: "Project to associate this note with." })),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: "Tags for categorization." }),
    ),
  },
  { additionalProperties: false },
);

const GetNoteSchema = Type.Object(
  {
    noteId: Type.String({ description: "ID of the note to retrieve." }),
  },
  { additionalProperties: false },
);

export function registerKnowledgeTools(client: ExfClient) {
  return [
    {
      name: "exf_notes_search",
      label: "ExecuFunction: Search Notes",
      description:
        "Semantic search across the ExecuFunction knowledge base. " +
        "Finds notes, decisions, meeting notes, and references by meaning, not just keywords.",
      parameters: SearchNotesSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const query = readStringParam(rawParams, "query", { required: true });
        const limit = readNumberParam(rawParams, "limit", { integer: true });
        return jsonResult(await client.searchNotes(query, limit));
      },
    },
    {
      name: "exf_notes_create",
      label: "ExecuFunction: Create Note",
      description:
        "Create a new note in the ExecuFunction knowledge base. " +
        "Supports markdown content, note types, project association, and tags.",
      parameters: CreateNoteSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const title = readStringParam(rawParams, "title", { required: true });
        const content = readStringParam(rawParams, "content", { required: true });
        const noteType = readStringParam(rawParams, "noteType");
        const projectId = readStringParam(rawParams, "projectId");
        const tagsRaw = rawParams.tags;
        const tags = Array.isArray(tagsRaw) ? (tagsRaw as string[]).filter(Boolean) : undefined;
        return jsonResult(await client.createNote({ title, content, noteType, projectId, tags }));
      },
    },
    {
      name: "exf_notes_get",
      label: "ExecuFunction: Get Note",
      description: "Retrieve the full content of a specific note by ID.",
      parameters: GetNoteSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const noteId = readStringParam(rawParams, "noteId", { required: true });
        return jsonResult(await client.getNote(noteId));
      },
    },
  ];
}
