// ai.js
// Turns a note's plain text into an AI-generated study set (Pro feature) via
// Anthropic's Messages API, using node's built-in fetch - no npm dependency,
// matching the zero-dependency approach stripe.js/email.js use for their own
// third-party HTTP APIs.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Overridable so a deployment can trade quality for cost (e.g. a cheaper
// Haiku model) without a code change - see the README for details.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Lets this project's own test suite (and anyone developing locally before
// they've set up billing/an API key) exercise the whole generate -> store ->
// view pipeline without spending real API calls or needing a key at all.
// Real deployments should never set this - see the README's Pro-tier setup
// section for the one env var that actually matters, ANTHROPIC_API_KEY.
const MOCK_MODE = process.env.AI_MOCK_MODE === '1';

function aiConfigured() {
  return MOCK_MODE || Boolean(ANTHROPIC_API_KEY);
}

const SET_TYPES = ['flashcards', 'true_false', 'multiple_choice'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const SET_TYPE_LABELS = {
  flashcards: 'flashcards',
  true_false: 'true/false statements',
  multiple_choice: 'multiple-choice practice test questions',
};

const DIFFICULTY_GUIDANCE = {
  easy: 'Easy: stick to direct recall of facts, terms, and definitions stated explicitly in the notes. Straightforward wording, no trick questions.',
  medium: 'Medium: mostly recall, but some items should require connecting two related pieces of information from the notes rather than quoting a single sentence back.',
  hard: 'Hard: favor application and inference - ask the student to reason about *why* or *how* something in the notes works, or to apply a concept from the notes to a new but closely related situation. Still must be answerable from the notes alone; never invent facts the notes don\'t support.',
};

// ---------------- Item schemas (one per study-set type) ----------------
// Sent as an Anthropic tool definition and forced via tool_choice, so the
// model's reply comes back as an already-parsed JS object matching this
// shape instead of free-form text we'd have to hope was valid JSON.
function itemSchemaFor(setType) {
  if (setType === 'flashcards') {
    return {
      type: 'object',
      properties: {
        front: { type: 'string', description: 'The term, question, or prompt side of the card.' },
        back: { type: 'string', description: 'The answer/definition side of the card.' },
      },
      required: ['front', 'back'],
    };
  }
  if (setType === 'true_false') {
    return {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'A single statement the student judges true or false.' },
        answer: { type: 'boolean', description: 'Whether the statement is actually true.' },
        explanation: { type: 'string', description: 'One or two sentences, grounded in the notes, explaining why the statement is true or false.' },
      },
      required: ['statement', 'answer', 'explanation'],
    };
  }
  // multiple_choice
  return {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: {
        type: 'array',
        items: { type: 'string' },
        minItems: 4,
        maxItems: 4,
        description: 'Exactly 4 answer options, in the order they should be shown.',
      },
      correctIndex: { type: 'integer', minimum: 0, maximum: 3, description: 'Index (0-3) into options of the correct answer.' },
      explanation: { type: 'string', description: 'One or two sentences, grounded in the notes, explaining the correct answer.' },
    },
    required: ['question', 'options', 'correctIndex', 'explanation'],
  };
}

function buildTool(setType) {
  return {
    name: 'submit_study_set',
    description: `Submits the generated ${SET_TYPE_LABELS[setType]} study set.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short, descriptive title for this study set (a few words).' },
        items: { type: 'array', items: itemSchemaFor(setType) },
      },
      required: ['title', 'items'],
    },
  };
}

function buildPrompt({ noteTitle, noteText, setType, difficulty, length }) {
  return [
    `You are helping a student turn their class notes into a ${SET_TYPE_LABELS[setType]} study set.`,
    ``,
    `Note title: ${noteTitle || 'Untitled note'}`,
    `Notes content:`,
    '"""',
    noteText,
    '"""',
    ``,
    `Difficulty: ${DIFFICULTY_GUIDANCE[difficulty] || DIFFICULTY_GUIDANCE.medium}`,
    ``,
    `Generate ${length} items if the notes have enough distinct material to support that many good, non-repetitive items. If they don't, generate fewer rather than padding with filler, near-duplicates, or facts not actually in the notes - quality and grounding in the actual notes matter more than hitting the exact count.`,
    `Base every item strictly on the content of the notes above. Do not introduce outside facts the notes don't state or clearly imply.`,
    `Call the submit_study_set tool with the result - do not respond with anything else.`,
  ].join('\n');
}

// ---------------- Deterministic mock (AI_MOCK_MODE=1) ----------------
function buildMockStudySet({ noteTitle, setType, difficulty, length }) {
  const n = Math.max(1, Math.min(length || 10, 50));
  const items = Array.from({ length: n }, (_, i) => {
    const idx = i + 1;
    if (setType === 'flashcards') {
      return { front: `[Mock] Term ${idx} from "${noteTitle}"`, back: `[Mock] Definition ${idx} (${difficulty} difficulty).` };
    }
    if (setType === 'true_false') {
      return {
        statement: `[Mock] Statement ${idx} about "${noteTitle}".`,
        answer: idx % 2 === 0,
        explanation: `[Mock] Explanation for statement ${idx}.`,
      };
    }
    return {
      question: `[Mock] Question ${idx} about "${noteTitle}"?`,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctIndex: idx % 4,
      explanation: `[Mock] Explanation for question ${idx}.`,
    };
  });
  return { title: `${noteTitle || 'Untitled note'} - ${SET_TYPE_LABELS[setType]}`, items };
}

// ---------------- Real API call ----------------
async function callAnthropic({ noteTitle, noteText, setType, difficulty, length }) {
  const tool = buildTool(setType);
  const prompt = buildPrompt({ noteTitle, noteText, setType, difficulty, length });

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        tools: [tool],
        tool_choice: { type: 'tool', name: 'submit_study_set' },
      }),
    });
  } catch (e) {
    const err = new Error('Could not reach the AI service right now. Please try again in a moment.');
    err.status = 502;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `AI request failed (${res.status}).`;
    const err = new Error(message);
    err.status = 502;
    throw err;
  }

  const toolUse = (data.content || []).find((block) => block.type === 'tool_use' && block.name === 'submit_study_set');
  if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.items) || toolUse.input.items.length === 0) {
    const err = new Error('The AI did not return a usable study set. Please try again.');
    err.status = 502;
    throw err;
  }
  return { title: toolUse.input.title || noteTitle || 'Untitled study set', items: toolUse.input.items };
}

// generateStudySet({ noteTitle, noteText, setType, difficulty, length }) ->
// { title, items }. Throws an Error with .status/.code on any problem the
// caller should turn into a clean HTTP response.
async function generateStudySet({ noteTitle, noteText, setType, difficulty, length }) {
  if (!SET_TYPES.includes(setType)) {
    const err = new Error('Choose a study set type.');
    err.status = 400;
    throw err;
  }
  const safeDifficulty = DIFFICULTIES.includes(difficulty) ? difficulty : 'medium';
  const safeLength = Math.max(5, Math.min(50, Number(length) || 10));

  if (!aiConfigured()) {
    const err = new Error('AI study-set generation is not set up yet on this server. Set ANTHROPIC_API_KEY to enable it.');
    err.status = 503;
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  if (!noteText || !noteText.trim()) {
    const err = new Error("This note doesn't have enough written content yet to generate a study set from.");
    err.status = 400;
    err.code = 'NOTE_EMPTY';
    throw err;
  }

  if (MOCK_MODE) {
    return buildMockStudySet({ noteTitle, setType, difficulty: safeDifficulty, length: safeLength });
  }
  return callAnthropic({ noteTitle, noteText, setType, difficulty: safeDifficulty, length: safeLength });
}

module.exports = { generateStudySet, aiConfigured, SET_TYPES, DIFFICULTIES };
