import type { Transcript } from "./types.js";

export function formatMarkdown(t: Transcript): string {
  const lines: string[] = [];
  lines.push(`# ${t.title}`);
  lines.push("");
  lines.push(`**Language**: ${t.language} | **Duration**: ${t.duration} | **Speakers**: ${t.speakers.join(", ")}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(t.summary);
  lines.push("");
  if (t.topics.length > 0) {
    lines.push("## Topics");
    lines.push("");
    t.topics.forEach(topic => lines.push(`- ${topic}`));
    lines.push("");
  }
  if (t.knowledge && t.knowledge.length > 0) {
    lines.push("## Knowledge Items");
    lines.push("");
    const byType = new Map<string, typeof t.knowledge>();
    for (const item of t.knowledge) {
      const list = byType.get(item.type) ?? [];
      list.push(item);
      byType.set(item.type, list);
    }
    for (const [type, items] of byType) {
      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
      lines.push("");
      for (const item of items) {
        lines.push(`- **[${item.timestamp}]** ${item.statement} _(${item.topic}; ${item.speakers.join(", ")})_`);
      }
      lines.push("");
    }
  }

  lines.push("## Transcript");
  lines.push("");
  lines.push(t.transcript);
  return lines.join("\n");
}
