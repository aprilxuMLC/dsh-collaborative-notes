# Changelog

## 0.1.1

- Improved exact Return-to-source behavior across structural rendered
  boundaries, including selected-visible-text separators.
- Capture and re-entry now share the accepted selected-visible-text semantics;
  native `Range.toString()` is not treated as universal source truth.
- Improved exact cue presentation for long or initially off-screen messages.
- Added bounded handling for relevant collapsed DSH turn-process presentation
  without persisting host collapse state.
- Retained truthful duplicate-match and no-match behavior without historical
  occurrence guessing or Source rewriting.
- Aligned public installation, restart, support-boundary, and DSH integration
  wording with the currently validated behavior.

Historical currently-unmaterialized Source loading remains an explicit
qualification and is not claimed as solved by this release.
