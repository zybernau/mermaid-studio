## Goal
A split-screen web app: type Mermaid (`.mmd`) code on the left, and the rendered diagram updates live on the right.

## Recommended stack
- **Build**: Vite plus React (or plain JS if you want it tiny)
- **Rendering**: `mermaid` npm package (v11)
- **Editor**: CodeMirror 6 (light) or Monaco (heavier, VS Code feel)
- **Split pane**: `react-resizable-panels` or `allotment`
- **Zoom/pan**: `svg-pan-zoom` or `react-zoom-pan-pinch`
- **Hosting**: Vercel, Netlify, or GitHub Pages (it's fully client-side, so no backend)

## Phases

**1. Core editor and live preview (MVP)**
- Two-pane layout: editor on the left, preview on the right
- Initialize with `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })`
- On each edit, **debounce 300-500 ms**, then call `await mermaid.render(uniqueId, code)` and inject the returned SVG into the right pane
- Use a fresh ID for each render call, or Mermaid will clash with earlier renders

**2. Error handling**
- Wrap the render call in try/catch
- Keep the **last good diagram** visible and show a small error banner with the message and line number
- Use `mermaid.parse(code)` first to validate cheaply

**3. Making the right pane properly viewable**
- Draggable divider to resize the panes
- Zoom (scroll or buttons), pan (drag), and a "Fit to screen" / reset button
- Toggle to collapse or maximize the preview
- On mobile, switch to tabs (Code | Preview) instead of side by side

**4. Quality-of-life features**
- Sample templates (flowchart, sequence, ER, Gantt, class, state)
- Theme switcher (default, dark, forest, neutral) and light/dark UI
- Auto-save to localStorage, plus open/save `.mmd` files
- Syntax highlighting and, optionally, autocomplete for diagram keywords

**5. Export and sharing**
- Download SVG
- Download PNG (draw the SVG onto a canvas)
- Copy SVG or PNG to clipboard
- Shareable link: compress the code with `pako` and put it in the URL hash, so no server is needed

**6. Polish and deploy**
- Keyboard shortcuts (Ctrl+S to save, Ctrl+Enter to force render)
- Performance check on large diagrams (consider a web worker or a longer debounce)
- Deploy to a static host

## Suggested layout
```
┌──────────── toolbar: Templates | Theme | Export | Share ────────────┐
│  Editor (CodeMirror)       ║   Preview (SVG, zoom/pan)              │
│                            ║                                        │
│                            ║                                        │
├────────────────────────────┴────────────────────────────────────────┤
│  status bar: parse OK / error at line N                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Common pitfalls
- Reusing the same element ID across renders breaks the output
- Rendering on every keystroke without debouncing makes the UI laggy
- Clearing the preview on every syntax error is jarring, so keep the last good render
- Exported PNGs look blurry unless you scale the canvas (2x-3x)
- Fonts can be missing in the PNG export unless the SVG's styles are inlined

## Timeline (rough)
- MVP (phases 1-2): a few hours
- Zoom/pan and resizable panes: about half a day
- Export, sharing, and polish: about 1 day

I can build the MVP now as a single-file HTML app that runs right here in chat, or scaffold the full Vite project for Claude Code if you'd rather develop it locally. Which would you prefer?