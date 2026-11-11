/**
 * Prompt-injection detection for seller content.
 *
 * This is the *visible* layer. The guarantee does not depend on it: seller text
 * only ever reaches the model as data for extraction, the model has no tools,
 * and only the buyer can change the contract. Detection exists to explain and
 * surface attacks, not to be the last line of defence.
 */

export type InjectionSeverity = "none" | "medium" | "high";

export interface InjectionFinding {
  rule: string;
  description: string;
  excerpt: string;
  location: "hidden" | "visible";
  severity: Exclude<InjectionSeverity, "none">;
}

export interface InjectionReport {
  severity: InjectionSeverity;
  findings: InjectionFinding[];
  /** Set when the optional LLM classifier contributed. */
  classifier?: { label: "injection" | "benign"; reason: string };
}

const DIRECTIVES: { rule: string; description: string; re: RegExp }[] = [
  {
    rule: "override-instructions",
    description: "Tries to override the agent's instructions",
    re: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your|the user'?s?)\b[^.]{0,20}\b(instructions?|rules|constraints|guidelines|prompt)\b/i,
  },
  {
    rule: "budget-manipulation",
    description: "Tries to change the buyer's budget or limits",
    re: /\b(increase|raise|expand|extend|ignore|remove|bypass)\b[^.]{0,30}\b(budget|spending limit|price limit|max(imum)? price|limit)\b/i,
  },
  {
    rule: "forced-purchase",
    description: "Pushes the agent to buy immediately",
    re: /\b(purchase|buy|checkout|order|pay for)\b[^.]{0,20}\b(immediately|right now|now|right away|without (asking|confirmation|checking))\b/i,
  },
  {
    rule: "fake-approval",
    description: "Claims the purchase is already approved",
    re: /\b(pre-?approved|already approved|has been approved|is approved|verified by paypal|approved by (the )?(user|buyer|paypal|pact))\b/i,
  },
  {
    rule: "agent-addressing",
    description: "Addresses AI agents directly",
    re: /\b(ai|shopping|llm|autonomous)\s+(agent|assistant|model)s?\b\s*[:,-]|\b(note|attention|message) (to|for) (ai|agents?|assistants?|llms?)\b/i,
  },
  {
    rule: "system-impersonation",
    description: "Impersonates system or developer messages",
    re: /\b(system|developer)\s+(prompt|message|instruction|override)\b|<\/?(system|instructions?)>|\[\s*(system|inst)\s*\]/i,
  },
  {
    rule: "concealment",
    description: "Asks the agent to hide information from the buyer",
    re: /\bdo not (tell|inform|show|mention|reveal|disclose)\b[^.]{0,20}\b(user|buyer|customer|human)\b/i,
  },
];

const HIDDEN_BLOCK =
  /<([a-z0-9]+)\b[^>]*\b(style\s*=\s*"[^"]*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)[^"]*"|hidden\b|aria-hidden\s*=\s*"true")[^>]*>([\s\S]*?)<\/\1>/gi;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;

const stripTags = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Text a human buyer would actually see on the page. */
export function visibleText(html: string): string {
  return stripTags(html.replace(HIDDEN_BLOCK, " ").replace(HTML_COMMENT, " "));
}

/** Text present in the page but hidden from humans. */
export function hiddenSegments(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HIDDEN_BLOCK)) {
    const t = stripTags(m[4] ?? "");
    if (t) out.push(t);
  }
  for (const m of html.matchAll(HTML_COMMENT)) {
    const t = stripTags(m[1] ?? "");
    if (t) out.push(t);
  }
  return out;
}

function excerptAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + len + 60);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

function scan(text: string, location: "hidden" | "visible"): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const d of DIRECTIVES) {
    const m = d.re.exec(text);
    if (m) {
      findings.push({
        rule: d.rule,
        description: d.description,
        excerpt: excerptAround(text, m.index, m[0].length),
        location,
        severity: "high",
      });
    }
  }
  return findings;
}

export function detectInjection(html: string): InjectionReport {
  return detectInjectionInText(visibleText(html), hiddenSegments(html));
}

/**
 * Same checks for plain catalog text: `visible` is everything a buyer sees
 * (title, description, features, attributes); `hidden` is text buyers can't see.
 * An optional model-detected instruction quote escalates to high.
 */
export function detectInjectionInText(visible: string, hidden: string[], modelQuote: string | null = null): InjectionReport {
  const report = scanAll(visible, hidden);
  if (modelQuote && report.severity !== "high") {
    return {
      severity: "high",
      findings: [
        ...report.findings,
        {
          rule: "model-detected-instruction",
          description: "Text addressed to AI agents (found while reading the listing)",
          excerpt: modelQuote.slice(0, 200),
          location: hidden.some((h) => h.includes(modelQuote)) ? "hidden" : "visible",
          severity: "high",
        },
      ],
    };
  }
  return report;
}

function scanAll(visible: string, hidden: string[]): InjectionReport {
  const findings: InjectionFinding[] = [
    ...scan(visible, "visible"),
    ...hidden.flatMap((h) => scan(h, "hidden")),
  ];

  // Hidden text with no directive is suspicious but not proof of an attack.
  if (findings.length === 0 && hidden.some((h) => h.length > 20)) {
    findings.push({
      rule: "hidden-content",
      description: "Page contains text hidden from human buyers",
      excerpt: hidden.find((h) => h.length > 20)!.slice(0, 160),
      location: "hidden",
      severity: "medium",
    });
  }

  const severity: InjectionSeverity = findings.some((f) => f.severity === "high")
    ? "high"
    : findings.length
      ? "medium"
      : "none";
  return { severity, findings };
}

/** Fold an optional LLM classifier result into the rule-based report. Rules can only be escalated, never downgraded. */
export function mergeClassifier(
  report: InjectionReport,
  classifier: { label: "injection" | "benign"; reason: string } | null,
): InjectionReport {
  if (!classifier) return report;
  if (classifier.label === "injection" && report.severity === "none") {
    return {
      severity: "medium",
      classifier,
      findings: [
        {
          rule: "llm-classifier",
          description: "AI classifier judged the content as an injection attempt",
          excerpt: classifier.reason,
          location: "visible",
          severity: "medium",
        },
      ],
    };
  }
  return { ...report, classifier };
}
