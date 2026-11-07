// The frame runtime as source text, for inlining into the visual's srcdoc: the
// shared guard first (it defines `axFrameGuard`), then the visual's own
// runtime (it defines `axVisualRuntime`, which starts the guard before it does
// anything else). They go out as one <script>, so the guard is in place before
// any agent markup parses.
//
// The guard text comes in as a raw string through the package's
// `./frame-guard.js` export, never through its main entry: that one reads the
// file with Node's fs and has no business in the browser bundle.
import guardSource from '@ax/frame-guard/frame-guard.js?raw';
import visualRuntimeSource from './frame-runtime.js?raw';

export const FRAME_RUNTIME_SOURCE: string = `${guardSource}\n${visualRuntimeSource}`;
