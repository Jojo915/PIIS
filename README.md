incomplete documentation, just an initial draft

# Computational Notebook Extension

Repository for Intelligent Interactive Systems practica at LMU
end-goal: AI-powered semantic search for Jupyter notebooks, built as a VS Code extension.

## Architecture

```
VS Code Extension
│
├── Webview                ← HTML/CSS/JS panel inside VS Code
│   └── communicates via postMessage events
│
└── Extension Host         ← TypeScript, reads notebooks, routes messages
    │
    └── Flask API          ← Python, semantic search via embeddings
```

The webview sends events to the extension host, which calls the Flask API and posts results back to the webview.

## Repository Structure

```
/
├── webview/          # Webview UI prototype
│   ├── index.html
│   ├── styles.css -- hard coded for now, will utilize VS colors when         integrated in vs
│   ├── script.js
│   └── mockdata.js
├── icons/
├── extension/
├── backend/
└── package.json
```

---

## API Contract

### Cell Data Model

```js
{
  cellId: number,
  cellLabel: string,        // AI-generated title
  cellDescription: string,  // AI-generated summary
  cellIcon: string,
  cellColor: string,
  cellContent: string,      // Raw source code of the cell
  score: number,            // Semantic relevance score
  type: "code" | "markdown"
}
```

### Search Response

```js
{
  searchBar: string,        // Original query echoed back
  queryCellsList: Cell[],   // Cells above relevance threshold >=50%
  otherCellsList: Cell[]    // Cells below relevance threshold <50%
}
```

### Webview Events (webview → extension host)

```js
{ type: "search", query: string }
{ type: "jumpToCell", cellId: number }
```

### Cell Create / Edit Endpoint

```
POST /cell
Body:    { notebookId, cellId, cellContent }
Returns: { cellLabel, cellDescription }
```

---

## UI — Webview (`/webview`)

### File Structure

| File | Purpose |
|------|---------|
| `index.html` | Layout and DOM structure |
| `styles.css` | All styling, VS Code dark theme variables |
| `script.js` | Event handling, rendering logic, navigation state |
| `mockdata.js` | Hardcoded cells and search response simulating the Flask API |

### Features

| Feature | Description |
|---------|-------------|
| Default view | All notebook cells listed in `cellId` order, no scores or relevance coloring |
| Search bar | Text input, triggered by Enter key or search icon; hides default view on submit |
| Loading state | Spinner shown during search, hidden on result display |
| Top Matches | Cards for cells in `queryCellsList` |
| Other Cells | Collapsible section for cells in `otherCellsList` |
| Result card | Shows `cellIcon`, `cellId`, `score`, `cellLabel`; dropdown reveals `cellDescription` |
| Relevance coloring | Green ≥ 80%, Orange ≥ 50%, Brown < 50% (left border + gradient) |
| Cell navigation | Click card → `vscode.postMessage({ type: "jumpToCell", cellId })` |
| Close button | Appears inside search bar when input has text; clears the query and restores the default view |
| Back button | Tracks navigation history; inactive at opacity 0.35 until first navigation |

### Color System

Three grays used throughout:

`--vscode-editor-foreground` | `#d4d4d4` | Primary text, cell labels
`--icon-foreground` | `#B0B0B0` | All SVG icons, cell count
`--vscode-description-foreground` | `#999999` | Secondary text, metadata, placeholders

Hover color: `--hover-foreground: #d4d4d4`. All interactive hover states use `brightness(1.2)` filter for icons.

### Navigation State

```
navigationStack: number[]   — cellId stack, push on navigate, pop on back
backButton.active class     — added when stack is non-empty
```

---

## VS Code Extension (`/extension`)

TBD — Person 2

---

## Backend — Flask API (`/backend`)

TBD — Person 1
