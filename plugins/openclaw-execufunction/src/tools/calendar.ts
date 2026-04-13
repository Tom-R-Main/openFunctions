import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const ListEventsSchema = Type.Object(
  {
    startDate: Type.String({ description: "Start date in YYYY-MM-DD format." }),
    endDate: Type.String({ description: "End date in YYYY-MM-DD format." }),
    limit: Type.Optional(
      Type.Number({ description: "Max events to return.", minimum: 1, maximum: 100 }),
    ),
  },
  { additionalProperties: false },
);

const CreateEventSchema = Type.Object(
  {
    title: Type.String({ description: "Event title." }),
    startTime: Type.String({ description: "Start time in ISO 8601 format." }),
    endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format." })),
    description: Type.Optional(Type.String({ description: "Event description." })),
    location: Type.Optional(Type.String({ description: "Event location." })),
    allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event." })),
  },
  { additionalProperties: false },
);

const UpdateEventSchema = Type.Object(
  {
    eventId: Type.String({ description: "ID of the event to update." }),
    title: Type.Optional(Type.String({ description: "New title." })),
    startTime: Type.Optional(Type.String({ description: "New start time in ISO 8601 format." })),
    endTime: Type.Optional(Type.String({ description: "New end time in ISO 8601 format." })),
    description: Type.Optional(Type.String({ description: "New description." })),
    location: Type.Optional(Type.String({ description: "New location." })),
  },
  { additionalProperties: false },
);

export function registerCalendarTools(client: ExfClient) {
  return [
    {
      name: "exf_calendar_list",
      label: "ExecuFunction: List Events",
      description:
        "List calendar events from ExecuFunction for a date range. " +
        "Returns event titles, times, locations, and descriptions.",
      parameters: ListEventsSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const startDate = readStringParam(rawParams, "startDate", { required: true });
        const endDate = readStringParam(rawParams, "endDate", { required: true });
        const limit = readNumberParam(rawParams, "limit", { integer: true });
        return jsonResult(await client.listEvents({ startDate, endDate, limit }));
      },
    },
    {
      name: "exf_calendar_create",
      label: "ExecuFunction: Create Event",
      description: "Create a new calendar event in ExecuFunction.",
      parameters: CreateEventSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const title = readStringParam(rawParams, "title", { required: true });
        const startTime = readStringParam(rawParams, "startTime", { required: true });
        const endTime = readStringParam(rawParams, "endTime");
        const description = readStringParam(rawParams, "description");
        const location = readStringParam(rawParams, "location");
        const allDay = rawParams.allDay === true;
        return jsonResult(
          await client.createEvent({ title, startTime, endTime, description, location, allDay }),
        );
      },
    },
    {
      name: "exf_calendar_update",
      label: "ExecuFunction: Update Event",
      description: "Update an existing calendar event's title, time, description, or location.",
      parameters: UpdateEventSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const eventId = readStringParam(rawParams, "eventId", { required: true });
        const updates: Record<string, unknown> = {};
        for (const key of ["title", "startTime", "endTime", "description", "location"]) {
          const val = readStringParam(rawParams, key);
          if (val) updates[key] = val;
        }
        return jsonResult(await client.updateEvent(eventId, updates));
      },
    },
  ];
}
