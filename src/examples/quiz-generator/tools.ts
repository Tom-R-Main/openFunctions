/**
 * Quiz Generator — Example Tool Domain
 *
 * Create quizzes, answer questions, and track scores.
 * This is the most "fun" example — it feels like a game.
 *
 * This demonstrates:
 *   - Stateful interactions (quiz state machine)
 *   - Richer return data (questions with options)
 *   - Using the AI as a quiz master
 */

import { defineTool, ok, err } from "../../framework/index.js";

// ─── Data ──────────────────────────────────────────────────────────────────

interface Question {
  id: number;
  question: string;
  options: string[];
  correctIndex: number;
}

interface Quiz {
  id: string;
  topic: string;
  questions: Question[];
  answers: Map<number, number>; // questionId → selected option index
  createdAt: string;
}

/** Parameter types — match these to your inputSchema */
interface CreateQuizParams { topic: string; questions: Array<{ question: string; options: string[]; correctIndex: number }> }
interface AnswerQuestionParams { quiz_id: string; question_id: number; answer_index: number }
interface GetScoreParams { quiz_id: string }

const quizzes = new Map<string, Quiz>();
let nextId = 1;

// ─── Tools ─────────────────────────────────────────────────────────────────

export const createQuiz = defineTool<CreateQuizParams>({
  name: "create_quiz",
  description:
    "Create a new quiz on a topic. Provide the questions, answer options, " +
    "and which option is correct. The AI can generate these from study material.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The quiz topic (e.g. 'Photosynthesis')",
      },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question text" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Answer options (2-5 choices)",
            },
            correctIndex: {
              type: "integer",
              description: "Zero-based index of the correct option",
            },
          },
          required: ["question", "options", "correctIndex"],
        },
        description: "Array of quiz questions",
      },
    },
    required: ["topic", "questions"],
  },
  tags: ["education", "quiz"],
  handler: async ({ topic, questions }) => {
    const id = String(nextId++);
    const parsedQuestions = questions.map((q, i) => ({
      id: i,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
    }));

    const quiz: Quiz = {
      id,
      topic: topic as string,
      questions: parsedQuestions,
      answers: new Map(),
      createdAt: new Date().toISOString(),
    };
    quizzes.set(id, quiz);

    // Return questions WITHOUT the correct answer (no cheating!)
    const safeQuestions = parsedQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
    }));

    return ok(
      { quizId: id, topic: topic, questionCount: parsedQuestions.length, questions: safeQuestions },
      `Created quiz "${topic}" with ${parsedQuestions.length} questions. Use answer_question to submit answers.`,
    );
  },
});

export const answerQuestion = defineTool<AnswerQuestionParams>({
  name: "answer_question",
  description:
    "Submit an answer to a quiz question. Returns whether the answer " +
    "is correct and what the right answer was.",
  inputSchema: {
    type: "object",
    properties: {
      quiz_id: {
        type: "string",
        description: "The quiz ID from create_quiz",
      },
      question_id: {
        type: "integer",
        description: "The question ID (zero-based index)",
      },
      answer_index: {
        type: "integer",
        description: "The index of the selected answer option",
      },
    },
    required: ["quiz_id", "question_id", "answer_index"],
  },
  tags: ["education", "quiz"],
  handler: async ({ quiz_id, question_id, answer_index }) => {
    const quiz = quizzes.get(quiz_id);
    if (!quiz) return err(`No quiz found with ID "${quiz_id}"`);

    const question = quiz.questions[question_id];
    if (!question) return err(`No question #${question_id} in this quiz`);

    quiz.answers.set(question.id, answer_index);

    const correct = answer_index === question.correctIndex;
    const correctAnswer = question.options[question.correctIndex];

    return ok(
      {
        correct,
        selectedAnswer: question.options[answer_index],
        correctAnswer,
        question: question.question,
      },
      correct
        ? `Correct! The answer is "${correctAnswer}".`
        : `Incorrect. You chose "${question.options[answer_index]}" — the correct answer is "${correctAnswer}".`,
    );
  },
});

export const getScore = defineTool<GetScoreParams>({
  name: "get_score",
  description:
    "Get the current score for a quiz. Shows how many questions were " +
    "answered correctly out of total answered.",
  inputSchema: {
    type: "object",
    properties: {
      quiz_id: {
        type: "string",
        description: "The quiz ID",
      },
    },
    required: ["quiz_id"],
  },
  tags: ["education", "quiz"],
  handler: async ({ quiz_id }) => {
    const quiz = quizzes.get(quiz_id);
    if (!quiz) return err(`No quiz found with ID "${quiz_id}"`);

    let correctCount = 0;
    for (const [qId, answerIdx] of quiz.answers.entries()) {
      if (quiz.questions[qId].correctIndex === answerIdx) {
        correctCount++;
      }
    }

    const total = quiz.questions.length;
    const answered = quiz.answers.size;
    const percentage = answered > 0 ? Math.round((correctCount / answered) * 100) : 0;

    return ok(
      {
        topic: quiz.topic,
        correct: correctCount,
        answered,
        total,
        percentage,
        remaining: total - answered,
      },
      `Score: ${correctCount}/${answered} (${percentage}%) — ${total - answered} questions remaining`,
    );
  },
});

export const quizGeneratorTools = [createQuiz, answerQuestion, getScore];
