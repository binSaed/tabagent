/**
 * Agent skills.
 *
 * A skill is a focused instruction block that activates when the user's request
 * matches a trigger, overriding the model's generic approach with a precise,
 * tested workflow. This keeps the base system prompt short while giving the
 * agent expert procedures for common high-value tasks.
 *
 * Activation is keyword-based against the latest user message. A skill fires at
 * most once per run (the instruction tells the model to follow the procedure
 * instead of improvising). Skills are additive: multiple can activate, though
 * in practice they rarely overlap.
 *
 * To add a skill: append to SKILLS below with { id, matches, instructions }.
 */

export interface Skill {
  /** Stable id; used for the "activated skills" log line. */
  id: string;
  /**
   * Returns true if this skill should activate for the given user message.
   * Keep matchers tight: prefer false negatives (no activation, model
   * improvises) over false positives (wrong procedure forced).
   */
  matches: (userText: string) => boolean;
  /** Instruction block appended to the system prompt when activated. */
  instructions: string;
}

// ---------------------------------------------------------------------------
// Translate-page skill
//
// The generic "change page content" hint in the base prompt is enough for a
// single element, but full-page translation benefits from a fixed procedure:
// snapshot in chunks, translate in batches, set_text in batches, and -- crucially
// -- skip non-translatable content (UI chrome, code, numbers, already-target-
// language text). Without this the model tends to translate one element per turn
// or re-snapshot constantly, blowing the step budget on a long page.
// ---------------------------------------------------------------------------

const LANG_KEYWORDS =
  /\b(arabic|chinese|french|german|spanish|italian|japanese|korean|portuguese|russian|hindi|hebrew|dutch|swedish|turkish|polish|english)\b/i;

const translatePageSkill: Skill = {
  id: "translate_page",
  matches: (text) => {
    const t = text.toLowerCase();
    const wantsTranslate =
      /\btranslate\b/.test(t) || (/\b(in ?to|into)\b/.test(t) && LANG_KEYWORDS.test(text));
    if (!wantsTranslate) return false;
    // "translate this page" / "translate the page" / "translate everything" /
    // "translate the whole page" -> page-level. "translate this [selection]"
    // without a page-scope word is handled by the selection menu, not this skill.
    return /\b(page|site|website|whole|entire|all|everything|this|the)\b/.test(t);
  },
  instructions: `
SKILL ACTIVATED: Translate page.
The user wants the page translated into another language. Follow this procedure EXACTLY instead of improvising. Do NOT translate one element per turn.

1. Identify the target language from the user's request. If none is stated, ask once.
2. Call \`snapshot\` to get refs for the page's text elements.
3. Determine the source language from the snapshot text. If the page is ALREADY in the target language, tell the user and stop.
4. Translate in BATCHES. For each batch:
   a. Pick up to ~6 text-bearing elements (headings, paragraphs, list items, table cells, buttons/links whose label should translate).
   b. Translate each element's text to the target language yourself, preserving meaning, tone, and any URLs/code/numbers/brand names verbatim.
   c. Call \`set_text\` once per element in the SAME turn, passing its ref and the translated text. Do not snapshot between set_text calls -- refs stay valid.
5. Skip content that must NOT be translated: code blocks, email addresses, URLs, phone numbers, prices/currency, person/place brand names, form input values, and any text already in the target language.
6. After the visible batch, \`scroll\` down to reveal more content, then \`snapshot\` again to get fresh refs and continue with the next batch.
7. Stop when you reach the bottom of the page. Summarize: "Translated the page to <language>." Do not ask for confirmation at the end.

Efficiency rules:
- Issue multiple \`set_text\` calls in one turn (the model can batch tool calls). This is the whole point -- one element per turn wastes the step budget.
- If a ref goes stale (element removed on scroll), skip it and continue.
- Do NOT call \`screenshot\` -- translation is text-only; snapshots are enough.
- Do NOT re-translate elements you already did. Track progress mentally by position on the page.`,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SKILLS: Skill[] = [translatePageSkill];

/**
 * Return the instruction blocks for all skills that match the latest user
 * message in the session history. Returns "" if none match (the base prompt
 * stands on its own).
 */
export function activatedSkillInstructions(latestUserText: string): string {
  if (!latestUserText) return "";
  const matched = SKILLS.filter((s) => {
    try {
      return s.matches(latestUserText);
    } catch {
      return false;
    }
  });
  if (matched.length === 0) return "";
  const header =
    matched.length === 1 ? `\n\n=== ACTIVE SKILL ===` : `\n\n=== ACTIVE SKILLS (${matched.length}) ===`;
  return header + matched.map((s) => `\n${s.instructions}`).join("");
}
