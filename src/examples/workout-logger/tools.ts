/**
 * Workout Logger — Example Tool Domain
 *
 * A workout tracking and recommendation system.
 * Uses persistent JSON storage (no database needed).
 *
 * This demonstrates:
 *   1. Date-based filtering and aggregation
 *   2. Enum parameters (type, intensity)
 *   3. Recommendation logic based on history
 *
 * In a real app, you'd replace the JSON store with a database.
 */

import { defineTool, ok, err, createStore } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Workout {
  id: string;
  exercise: string;
  type: "cardio" | "strength" | "flexibility" | "sport";
  duration: number;
  intensity: "low" | "medium" | "high";
  date: string;
  notes?: string;
  createdAt: string;
}

/** Parameter types — match these to your inputSchema */
interface LogWorkoutParams {
  exercise: string;
  type: "cardio" | "strength" | "flexibility" | "sport";
  duration: number;
  intensity: "low" | "medium" | "high";
  date?: string;
  notes?: string;
}
interface GetStatsParams { days?: number }
interface SuggestWorkoutParams {}

/** Persistent store — data saved to .data/workouts.json, survives restarts */
const workouts = createStore<Workout>("workouts");
let nextId = workouts.size + 1;

// ─── Helpers ──────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export const logWorkout = defineTool<LogWorkoutParams>({
  name: "log_workout",
  description:
    "Record a workout session. Use this when the user wants to log an exercise they completed.",
  inputSchema: {
    type: "object",
    properties: {
      exercise: {
        type: "string",
        description: "Name of the exercise (e.g. 'Running', 'Bench Press', 'Yoga')",
      },
      type: {
        type: "string",
        enum: ["cardio", "strength", "flexibility", "sport"],
        description: "Category of workout",
      },
      duration: {
        type: "number",
        description: "Duration in minutes",
      },
      intensity: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Workout intensity level",
      },
      date: {
        type: "string",
        description: "Date in YYYY-MM-DD format (defaults to today)",
      },
      notes: {
        type: "string",
        description: "Optional notes about the session",
      },
    },
    required: ["exercise", "type", "duration", "intensity"],
  },
  tags: ["fitness", "health"],
  examples: [
    {
      description: "Log a morning run",
      input: { exercise: "Running", type: "cardio", duration: 30, intensity: "medium" },
      output: {
        success: true,
        data: {
          id: "1",
          exercise: "Running",
          type: "cardio",
          duration: 30,
          intensity: "medium",
        },
      },
    },
  ],
  handler: async ({ exercise, type, duration, intensity, date, notes }) => {
    const id = String(nextId++);
    const workout: Workout = {
      id,
      exercise,
      type,
      duration,
      intensity,
      date: date ?? todayString(),
      notes,
      createdAt: new Date().toISOString(),
    };
    workouts.set(id, workout);
    return ok(workout, `Logged ${duration}-minute ${type} workout: "${exercise}"`);
  },
});

export const getStats = defineTool<GetStatsParams>({
  name: "get_stats",
  description:
    "Get workout statistics for a time period. " +
    "Use this when the user wants a summary of their recent activity.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Number of days to look back (default 7)",
      },
    },
  },
  tags: ["fitness", "health"],
  handler: async ({ days }) => {
    const lookback = days ?? 7;
    const cutoff = daysAgo(lookback);

    const recent = workouts
      .getAll()
      .filter((w) => new Date(w.date) >= cutoff);

    if (recent.length === 0) {
      return ok(
        {
          totalWorkouts: 0,
          totalMinutes: 0,
          byType: { cardio: 0, strength: 0, flexibility: 0, sport: 0 },
          mostFrequentExercise: null,
          averageDuration: 0,
        },
        `No workouts recorded in the last ${lookback} days. Time to get moving!`,
      );
    }

    const totalMinutes = recent.reduce((sum, w) => sum + w.duration, 0);

    const byType: Record<string, number> = { cardio: 0, strength: 0, flexibility: 0, sport: 0 };
    for (const w of recent) {
      byType[w.type]++;
    }

    const exerciseCounts: Record<string, number> = {};
    for (const w of recent) {
      exerciseCounts[w.exercise] = (exerciseCounts[w.exercise] ?? 0) + 1;
    }
    const mostFrequentExercise = Object.entries(exerciseCounts).sort(
      (a, b) => b[1] - a[1],
    )[0][0];

    const averageDuration = Math.round(totalMinutes / recent.length);

    return ok(
      {
        totalWorkouts: recent.length,
        totalMinutes,
        byType,
        mostFrequentExercise,
        averageDuration,
      },
      `${recent.length} workout${recent.length === 1 ? "" : "s"} in the last ${lookback} days, totalling ${totalMinutes} minutes`,
    );
  },
});

export const suggestWorkout = defineTool<SuggestWorkoutParams>({
  name: "suggest_workout",
  description:
    "Recommend a workout based on recent history. " +
    "Suggests the most neglected workout type to keep training balanced.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  tags: ["fitness", "health"],
  handler: async () => {
    const cutoff = daysAgo(7);
    const recent = workouts
      .getAll()
      .filter((w) => new Date(w.date) >= cutoff);

    if (recent.length === 0) {
      return ok(
        {
          suggestedType: "cardio",
          suggestedExercise: "Walking",
          duration: 30,
          reason: "No recent workouts found. A 30-minute walk is a great way to start!",
        },
        "No recent history — try a 30-minute walk to get started",
      );
    }

    const typeCounts: Record<string, number> = {
      cardio: 0,
      strength: 0,
      flexibility: 0,
      sport: 0,
    };
    for (const w of recent) {
      typeCounts[w.type]++;
    }

    const neglectedType = Object.entries(typeCounts).sort(
      (a, b) => a[1] - b[1],
    )[0][0] as Workout["type"];

    const exercisesByType: Record<string, string[]> = {
      cardio: ["Running", "Cycling", "Jump Rope", "Swimming", "Rowing"],
      strength: ["Push-ups", "Squats", "Deadlifts", "Pull-ups", "Bench Press"],
      flexibility: ["Yoga", "Stretching", "Pilates", "Foam Rolling", "Tai Chi"],
      sport: ["Basketball", "Tennis", "Soccer", "Volleyball", "Badminton"],
    };

    const options = exercisesByType[neglectedType];
    const suggestedExercise = options[Math.floor(Math.random() * options.length)];

    return ok(
      {
        suggestedType: neglectedType,
        suggestedExercise,
        duration: 30,
        reason: `You've done ${typeCounts[neglectedType]} ${neglectedType} workout${typeCounts[neglectedType] === 1 ? "" : "s"} this week — least of all types.`,
      },
      `Try ${suggestedExercise} (${neglectedType}) — your most neglected type this week`,
    );
  },
});

/** All workout logger tools — register these with the registry */
export const workoutLoggerTools = [logWorkout, getStats, suggestWorkout];
