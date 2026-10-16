# Mermaid Live Studio

A modern split-screen web app: type Mermaid (`.mmd`) on the left, watch the rendered diagram update live on the right. Fully client-side — no backend.

## Features (covers every phase of `plan.md`)

- **Core editor + live preview** — CodeMirror 6 editor, `mermaid.render()` with a fresh ID per render, 400 ms debounce (800 ms for large docs)
- **Error handling** — try/catch around render, last good diagram stays visible, error banner with line number
- **Viewable preview** — draggable resizable panes, zoom (buttons/scroll), pan (drag), Fit/reset, maximize editor or preview, mobile switches to Code | Preview tabs
- **Quality of life** — 8 sample templates (flowchart, sequence, class, state, ER, Gantt, mindmap, pie), diagram themes (default/dark/forest/neutral) + light/dark UI, autosave to localStorage, open/save `.mmd` files, keyword autocomplete + syntax highlighting
- **Export & sharing** — download SVG, download PNG (3× canvas for crisp output), copy SVG/PNG to clipboard, shareable `#c=` URL hash (pako-compressed, no server)
- **Polish** — `Ctrl+S` save, `Ctrl+Enter` force render, render spinner, status bar with parse state

## Run it

```bash
npm install
npm run dev      # dev server, default http://localhost:5173
npm run build    # typecheck + production bundle in dist/
npm run preview  # serve the production bundle
```

## Deploy

The `dist/` folder is a static site — drop it on Vercel, Netlify, or GitHub Pages.

## Stack

Vite + React + TypeScript · Mermaid v11 · CodeMirror 6 (`@uiw/react-codemirror`) · `react-resizable-panels` · `react-zoom-pan-pinch` · `pako` · `lucide-react`
