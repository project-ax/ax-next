// The stretched click layer shared by ListRow's title control and FileTile's button. The control's ::after is
// absolutely positioned against the nearest positioned ancestor (the row or tile box, so the control itself must stay
// unpositioned), covers the whole box, and takes every click that doesn't land on a raised trailing control. Being
// the control's own pseudo-element, a hit on it IS a hit on the control. The focus ring is drawn on the layer, inset,
// so it outlines the whole box and a flush Card can't clip it. Callers add the layer's radius and their own text
// handling (truncation, underline on hover).
export const CLICK_LAYER =
  'ax-block ax-w-full ax-m-none ax-p-none ax-border-0 ax-bg-transparent ax-text-left ax-font-sans ax-text-fg ' +
  'ax-cursor-pointer focus-visible:ax-outline-none after:ax-absolute after:ax-inset-none after:ax-content-empty ' +
  'focus-visible:after:ax-outline focus-visible:after:ax-outline-2 focus-visible:after:ax-outline-line-ring focus-visible:after:ax-outline-offset-inset';
