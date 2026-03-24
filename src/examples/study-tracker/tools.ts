/**
 * Study Tracker — Example Tool Domain
 *
 * A simple task tracker for study assignments.
 * Uses in-memory storage (no database needed).
 *
 * This demonstrates the core pattern:
 *   1. Define your data structure
 *   2. Define tools that manipulate it
 *   3. Export the tools array
 *
 * In a real app, you'd replace the in-memory Map with a database.
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  subject: string;
  due?: string;
  completed: boolean;
  createdAt: string;
}

/** Parameter types — match these to your inputSchema */
interface CreateTaskParams { title: string; subject: string; due?: string }
interface ListTasksParams { subject?: string; completed?: boolean }
interface CompleteTaskParams { id: string }

/** In-memory store — resets when the server restarts */
const tasks = new Map<string, Task>();
let nextId = 1;

// ─── Tools ─────────────────────────────────────────────────────────────────

export const createTask = defineTool<CreateTaskParams>({
  name: "create_task",
  description:
    "Create a new study task. Use this when the user wants to add something to their study to-do list.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "What needs to be done (e.g. 'Read chapter 5 of Biology')",
      },
      subject: {
        type: "string",
        description: "The subject or course (e.g. 'Biology', 'CS 301')",
      },
      due: {
        type: "string",
        description: "Due date in YYYY-MM-DD format (optional)",
      },
    },
    required: ["title", "subject"],
  },
  tags: ["productivity", "study"],
  examples: [
    {
      description: "Create a simple study task",
      input: { title: "Read chapter 5", subject: "Biology" },
      output: {
        success: true,
        data: {
          id: "1",
          title: "Read chapter 5",
          subject: "Biology",
          completed: false,
        },
      },
    },
  ],
  handler: async ({ title, subject, due }) => {
    const id = String(nextId++);
    const task: Task = {
      id,
      title,
      subject,
      due,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    tasks.set(id, task);
    return ok(task, `Created task: "${task.title}" for ${task.subject}`);
  },
});

export const listTasks = defineTool<ListTasksParams>({
  name: "list_tasks",
  description:
    "List all study tasks. Can filter by subject or completion status. " +
    "Use this when the user asks what they need to study or what's on their plate.",
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Filter by subject (optional)",
      },
      completed: {
        type: "boolean",
        description: "Filter by completion status (optional)",
      },
    },
  },
  tags: ["productivity", "study"],
  handler: async ({ subject, completed }) => {
    let result = Array.from(tasks.values());

    if (subject) {
      result = result.filter(
        (t) => t.subject.toLowerCase() === subject.toLowerCase(),
      );
    }
    if (completed !== undefined) {
      result = result.filter((t) => t.completed === completed);
    }

    return ok(
      { tasks: result, total: result.length },
      `Found ${result.length} task${result.length === 1 ? "" : "s"}`,
    );
  },
});

export const completeTask = defineTool<CompleteTaskParams>({
  name: "complete_task",
  description:
    "Mark a study task as completed. Use the task ID from list_tasks.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task ID to mark as completed",
      },
    },
    required: ["id"],
  },
  tags: ["productivity", "study"],
  handler: async ({ id }) => {
    const task = tasks.get(id);
    if (!task) {
      return err(`No task found with ID "${id}"`);
    }
    task.completed = true;
    return ok(task, `Completed: "${task.title}"`);
  },
});

/** All study tracker tools — register these with the registry */
export const studyTrackerTools = [createTask, listTasks, completeTask];
