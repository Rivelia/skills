# Agent prompts

Every prompt a workflow script sends to an agent, and every SKILL.md, REPORT.md or other instruction file an agent reads, is as short as its meaning allows. Each line keeps the agent on its goal:

- The goal and the condition that says the work is done.
- What the agent cannot find by looking: an unwritten convention, the reason behind a choice, a gotcha.
- A hard guardrail, where a mistake would break something.

A line earns its place only when it changes what a capable agent does by default. A rare edge case an agent handles sensibly on its own stays out, and so does anything obvious. Each rule lives in one place: a shared constant every prompt that needs it uses, never a restatement.

When a review finds a gap, close it in the script's code when code can enforce it; prompt text is for the judgement code cannot make.
