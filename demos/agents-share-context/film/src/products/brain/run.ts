// The real run the film recreates (demos/agents-share-context/run/transcript.md, 2026-11-10).
// Prompts are what was sent. Replies and tool results are copied from the agents' output;
// the only trims are noted in the transcript. Kettlebird Coffee is invented. Plain data, no React.

export const BRAIN_NAME = "Kettlebird";

export const CLAUDE_RUN = {
  prompt: "Let's lock the Kettlebird subscription: $18 a bag, ships every two weeks, launches March 3. Remember that in the brain.",
  tool: "remember",
  // the tool returned mode "commit" on page wiki/index.md
  toolResult: "Committed to wiki/index.md",
  // first paragraph of Claude's reply
  reply: "Saved to the Kettlebird brain: $18 a bag, ships every two weeks, launches March 3.",
};

// The page as Claude's commit left it (a new page, so nothing above the heading).
export const NOTE = {
  page: "wiki/index.md",
  before: [] as { kind: string; text: string }[],
  heading: "## Subscription",
  added: "The Kettlebird subscription is locked: $18 per bag, ships every two weeks, and launches March 3.",
};

export const CHATGPT_RUN = {
  prompt: "Write a short launch email for the Kettlebird coffee subscription. Use what's in our brain.",
  tool: "search",
  // the search for "launch" returned 1 claim, on wiki/index.md line 3
  toolResult: "Found it in wiki/index.md",
  subject: "Coffee, every two weeks",
  // the email as written, minus its Sources list
  body: [
    "Hi,",
    "The Kettlebird coffee subscription launches March 3.",
    "It’s $18 per bag, shipped every two weeks. We roast on Tuesdays and ship on Wednesdays.",
    "Join us for your next cup.",
    "The Kettlebird team",
  ],
  // the facts that came from Claude's note; the film marks them with the highlighter
  facts: ["$18", "every", "two", "weeks", "March", "3"],
};
