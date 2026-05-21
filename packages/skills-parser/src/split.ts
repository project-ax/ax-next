// SKILL.md splitter
//
// Expects: ---\n<frontmatter>\n---\n<body> (body optional).
// Returns null if the fence pair is absent.

export function splitSkillMd(
  skillMd: string,
): { manifestYaml: string; bodyMd: string } | null {
  // Accept both LF and CRLF line endings on every fence boundary so a
  // SKILL.md authored / copy-pasted on Windows does not 400 here.
  const re = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*)|$)/;
  const m = re.exec(skillMd);
  if (m === null) return null;
  return { manifestYaml: m[1] ?? '', bodyMd: m[2] ?? '' };
}
