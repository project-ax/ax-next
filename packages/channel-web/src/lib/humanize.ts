/**
 * humanize — turn a machine identifier into words a person can read.
 *
 * The UX audit (2026-09-06) found the same defect on six surfaces: we render a
 * raw identifier where a label belongs. `api_key` as a form label,
 * `ANTHROPIC_API_KEY` as a dialog heading, `linear-issues` as a card title. The
 * id is correct, and to the person being asked to hand over a secret it is
 * noise at exactly the moment they most need a plain sentence.
 *
 * So: one shared humanizer, used by the permission card (TASK-334) and by the
 * credential + connector surfaces (TASK-344). It lives in `lib/` rather than
 * inside a component because two cards need it — the same reason
 * `lib/tool-name.ts` and `lib/tool-phrase.ts` sit here.
 *
 * What this is NOT: a source of truth. It is a display-time guess at how a
 * human would say an id, and nothing may key a decision off it. If a producer
 * ever ships a real human label alongside the id, that label wins and this is
 * the fallback. (Audit open question 1 — whether manifests should carry labels
 * and "where do I get this key" URLs — is deliberately still open; humanizing
 * client-side does not foreclose it.)
 *
 * We also never *invent* information. An id we cannot read is shown as
 * readable-as-possible text, never as an empty string, and never as a confident
 * label we made up.
 */

/**
 * Tokens that get cased the way the world cases them, not the way English
 * sentence rules would. Two kinds live here, and they behave identically:
 * acronyms that should stay shouted (`api` → `API`) and brands that case
 * themselves (`openai` → `OpenAI`, and `ax`, which is lowercase on purpose).
 *
 * A token in this table is NEVER re-cased — not even when it leads a label.
 *
 * A `Map`, not an object, and that is load-bearing rather than stylistic. An
 * agent can author a skill, so the ids that reach this table are untrusted: an
 * id containing the token `constructor`, `valueOf` or `toString` would resolve
 * through `Object.prototype` on a plain-object lookup, hand back a FUNCTION
 * where a string was expected, and throw while rendering — killing the one card
 * whose entire job is to be the trustworthy moment. `Object.entries` keeps the
 * table readable and takes only own keys.
 */
const BRANDS_AND_ACRONYMS = new Map<string, string>(Object.entries({
  // Acronyms.
  api: 'API',
  url: 'URL',
  uri: 'URI',
  id: 'ID',
  ip: 'IP',
  ssl: 'SSL',
  tls: 'TLS',
  jwt: 'JWT',
  pat: 'PAT',
  sdk: 'SDK',
  http: 'HTTP',
  https: 'HTTPS',
  smtp: 'SMTP',
  dsn: 'DSN',
  arn: 'ARN',
  oauth: 'OAuth',
  oidc: 'OIDC',
  // Brands, cased as they brand themselves.
  ax: 'ax',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  google: 'Google',
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  slack: 'Slack',
  notion: 'Notion',
  stripe: 'Stripe',
  jira: 'Jira',
  atlassian: 'Atlassian',
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  perplexity: 'Perplexity',
  ollama: 'Ollama',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
}));

/**
 * Ordinary English words that machine ids habitually SHOUT (`ANTHROPIC_API_KEY`
 * is three tokens, and only two of them are acronyms). Without this set the
 * all-caps rule below would keep `KEY` shouting and we would render
 * "Anthropic API KEY".
 *
 * These lowercase, and sentence-case only when they lead the label.
 */
const COMMON_WORDS = new Set([
  'key',
  'secret',
  'token',
  'password',
  'pass',
  'host',
  'hostname',
  'user',
  'username',
  'name',
  'email',
  'account',
  'client',
  'server',
  'region',
  'project',
  'org',
  'organization',
  'workspace',
  'team',
  'webhook',
  'endpoint',
  'base',
  'version',
  'model',
  'path',
  'port',
  'domain',
  'zone',
  'prefix',
  'access',
  'refresh',
  'auth',
  'login',
  'signing',
  'private',
  'public',
]);

/**
 * Split an id on every separator convention we actually see: snake_case,
 * kebab-case, dotted.paths, and camelCase. Anything that is not a letter or a
 * digit is a separator, so a slot id may be punctuated however its producer
 * likes and still comes apart correctly.
 */
function tokenize(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Map one token to its display form, WITHOUT sentence-casing — the caller does
 * that once, to whichever token ends up leading the finished label.
 */
function mapToken(token: string): string {
  const lower = token.toLowerCase();
  const known = BRANDS_AND_ACRONYMS.get(lower);
  if (known !== undefined) return known;
  if (COMMON_WORDS.has(lower)) return lower;
  // An all-caps token we don't recognise is ambiguous: producers shout both
  // acronyms (`SMTP`, `DSN`) and ordinary names (`GDRIVE`, `SENDGRID`). Length
  // separates them well in practice — acronyms are short. Guessing wrong is
  // cheap either way, and both guesses beat the status quo of printing the
  // whole id verbatim.
  if (token.length > 1 && token === token.toUpperCase()) {
    return token.length <= 5 ? token : token.charAt(0) + lower.slice(1);
  }
  return lower;
}

/** Join mapped tokens, sentence-casing the leading one if it is plain lowercase. */
function joinTokens(tokens: string[]): string {
  return tokens
    .map((t, i) =>
      i === 0 && t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t,
    )
    .join(' ');
}

/**
 * Render an identifier as a human label: `ANTHROPIC_API_KEY` → "Anthropic API
 * key", `linear-issues` → "Linear issues", `anthropic` → "Anthropic".
 *
 * Works the same on slot ids, service slugs and skill/connector ids — they are
 * all the same shape of thing, so they share one implementation rather than
 * three that drift.
 *
 * An id with nothing readable in it (empty, or pure punctuation) comes back
 * unchanged. Better to show the raw id than to show nothing at all.
 */
export function humanizeId(id: string): string {
  const tokens = tokenize(id).map(mapToken);
  if (tokens.length === 0) return id;
  return joinTokens(tokens);
}

/**
 * Label a credential slot, naming the service it belongs to when we know it:
 * slot `api_key` on service `anthropic` is an "Anthropic API key".
 *
 * Slot ids very often already carry the service (`ANTHROPIC_API_KEY`), so we
 * check before prefixing — "Anthropic Anthropic API key" is the kind of thing
 * that makes a product feel unfinished.
 */
export function humanizeSlotLabel(slot: string, service?: string): string {
  const slotTokens = tokenize(slot).map(mapToken);
  if (slotTokens.length === 0) return humanizeId(slot);

  const serviceTokens =
    service !== undefined && service.length > 0 ? tokenize(service).map(mapToken) : [];
  if (serviceTokens.length === 0) return joinTokens(slotTokens);

  const alreadyNamed = serviceTokens.every(
    (t, i) => slotTokens[i]?.toLowerCase() === t.toLowerCase(),
  );
  return joinTokens(alreadyNamed ? slotTokens : [...serviceTokens, ...slotTokens]);
}
