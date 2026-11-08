/** Minimal client for OpenAI's Decisions API (POST {base}/decisions). */
export interface DecisionsQuestion {
  name: string;
  type: "predicate" | "choice";
  instructions: string;
  choices?: Array<{ value: string; description?: string }>;
}

export type DecisionsAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string };

export interface DecisionsClient {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

/** Converts a TypeSafe criteria map into a Decisions choices list with the same values. */
export function criteriaToChoices(criteria: Record<string, string>): DecisionsQuestion["choices"] {
  return Object.entries(criteria).map(([value, description]) => ({ value, description }));
}

/**
 * Throws on HTTP errors, refusals, and missing or malformed answers, so a
 * caller can fail over. Answers come back in question order.
 */
export async function requestDecisions(
  client: DecisionsClient,
  data: Record<string, unknown>,
  questions: DecisionsQuestion[],
  signal: AbortSignal,
): Promise<DecisionsAnswer[]> {
  const response = await (client.fetch ?? fetch)(`${client.baseUrl.replace(/\/+$/, "")}/decisions`, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${client.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: client.model,
      input: [{ role: "user", content: [{ type: "input_json", data }] }],
      questions,
    }),
  });
  if (!response.ok) throw new Error(`Decisions judge HTTP ${response.status}`);
  const { answers } = await response.json() as { answers?: unknown };
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new Error("Decisions judge returned an incomplete answer set");
  }
  return questions.map((question, i) => {
    const answer = answers[i] as Record<string, unknown> | null;
    if (!answer || answer["name"] !== question.name) throw new Error(`Decisions judge answer ${i} is out of order`);
    if (answer["type"] === "refusal") throw new Error(`Decisions judge refused ${question.name}`);
    if (answer["type"] !== question.type) throw new Error(`Decisions judge answer ${question.name} has the wrong type`);
    if (question.type === "predicate") {
      const probability = answer["probability"];
      if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error(`Decisions judge answer ${question.name} has no valid probability`);
      }
      return { type: "predicate", name: question.name, probability };
    }
    const choice = answer["choice"];
    if (typeof choice !== "string" || !question.choices?.some(c => c.value === choice)) {
      throw new Error(`Decisions judge answer ${question.name} has no valid choice`);
    }
    return { type: "choice", name: question.name, choice };
  });
}
