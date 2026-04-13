import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const SearchPeopleSchema = Type.Object(
  {
    search: Type.String({
      description: "Search query for people by name, role, or organization.",
    }),
  },
  { additionalProperties: false },
);

const CreatePersonSchema = Type.Object(
  {
    name: Type.String({ description: "Full name of the person." }),
    email: Type.Optional(Type.String({ description: "Email address." })),
    phone: Type.Optional(Type.String({ description: "Phone number." })),
    relationship: Type.Optional(
      Type.String({
        description: 'Relationship type: "friend", "colleague", "contact", "client", etc.',
      }),
    ),
    organizationId: Type.Optional(Type.String({ description: "Organization ID to associate with." })),
    notes: Type.Optional(Type.String({ description: "Notes about this person." })),
  },
  { additionalProperties: false },
);

const SearchOrgsSchema = Type.Object(
  {
    search: Type.String({
      description: "Search query for organizations by name or domain.",
    }),
  },
  { additionalProperties: false },
);

export function registerPeopleTools(client: ExfClient) {
  return [
    {
      name: "exf_people_search",
      label: "ExecuFunction: Search People",
      description:
        "Search contacts in ExecuFunction CRM by name, role, or organization. " +
        "Returns names, emails, relationships, and organization associations.",
      parameters: SearchPeopleSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const search = readStringParam(rawParams, "search", { required: true });
        return jsonResult(await client.searchPeople(search));
      },
    },
    {
      name: "exf_person_create",
      label: "ExecuFunction: Create Person",
      description: "Create a new contact in ExecuFunction CRM with name, email, phone, and relationship.",
      parameters: CreatePersonSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const name = readStringParam(rawParams, "name", { required: true });
        const email = readStringParam(rawParams, "email");
        const phone = readStringParam(rawParams, "phone");
        const relationship = readStringParam(rawParams, "relationship");
        const organizationId = readStringParam(rawParams, "organizationId");
        const notes = readStringParam(rawParams, "notes");
        return jsonResult(
          await client.createPerson({ name, email, phone, relationship, organizationId, notes }),
        );
      },
    },
    {
      name: "exf_org_search",
      label: "ExecuFunction: Search Organizations",
      description: "Search organizations in ExecuFunction CRM by name or domain.",
      parameters: SearchOrgsSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const search = readStringParam(rawParams, "search", { required: true });
        return jsonResult(await client.searchOrganizations(search));
      },
    },
  ];
}
