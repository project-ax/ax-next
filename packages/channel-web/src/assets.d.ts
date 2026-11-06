declare module '*.svg' {
  const src: string;
  export default src;
}

// Vite query imports used by the chat-visuals frame assets: `?raw` yields the
// file's text, `?inline` yields a base64 data URL.
declare module '*?raw' {
  const source: string;
  export default source;
}

declare module '*?inline' {
  const source: string;
  export default source;
}
