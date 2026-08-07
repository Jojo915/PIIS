# Semantic Canvas

A VS Code extension with a FastAPI backend that turns a Jupyter notebook into a searchable, continuously-analyzed canvas. It indexes notebook cells into a local vector store, generates AI labels/summaries for code cells, and flags duplicate, dead, and stale cells as you work, all synced live with the notebook you have open.

The project has three parts, in three different runtimes:

| Component  | Location     | Runtime               | Role                                                          |
|------------|--------------|------------------------|----------------------------------------------------------------|
| Backend    | `backend/`   | Python / FastAPI       | Indexing, embeddings, LLM calls. Runs as a local HTTP server.  |
| Extension  | `extension/` | TypeScript / VS Code   | Watches the active notebook, talks to the backend, relays results to the webview. |
| Webview UI | `frontend/`  | Plain JS/HTML/CSS      | Renders the sidebar canvas inside VS Code. Loaded directly by the extension. |

You need the backend running *and* the extension loaded in VS Code for the tool to work end to end.

## Prerequisites

- **Python 3.12+**
- **[uv](https://docs.astral.sh/uv/)** — used to manage the backend's virtual environment and dependencies (a `uv.lock` is committed). Install with `curl -LsSf https://astral.sh/uv/install.sh | sh` or see the uv docs for your platform.
- **Node.js 18+** and **npm** (tested with Node 24)
- **VS Code** — needed to actually run/debug the extension (it launches a VS Code Extension Development Host)
- **A Gemini API key** *(optional but recommended)* — get one from [Google AI Studio](https://aistudio.google.com/apikey). Only needed for AI-generated cell labels/summaries; semantic search and the hygiene advisors (duplicate/dead/stale detection) run entirely on local embeddings and static analysis, no key required.

## 1. Clone the repo

```bash
git clone https://github.com/Jojo915/PIIS.git
cd PIIS
```

## 2. Backend setup

```bash
cd backend
uv sync
cp .env.example .env
```

`.env` expects:

```
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash
```

You can leave `GEMINI_API_KEY` blank and start the server anyway, the same key can also be entered later from the extension's AI Settings panel.

Start the server:

```bash
cd backend
uv run uvicorn app.app:app --reload --port 8000
```

Verify it's up by opening **http://127.0.0.1:8000/docs**

On first run, the backend creates `backend/chroma_db/` (the persistent vector store) and `backend/semantic_canvas.db` (SQLite store for summaries and AI settings) automatically. Keep the server running while you use the extension.

## 3. Extension setup

In a separate terminal:

```bash
cd extension
npm install
npm run compile
```

Then, with the whole `PIIS` folder open as a workspace in VS Code:

1. Open the **Run and Debug** panel (or press `F5`).
2. Select **"Run Semantic Canvas Extension"** (already configured in `.vscode/launch.json`; it recompiles automatically via the `npm: compile - extension` pre-launch task).
3. A new **Extension Development Host** VS Code window opens with the extension loaded.

## 4. Frontend (webview)

`frontend/` isn't a standalone app you run or build. Its `index.html`/`script.js`/`styles.css` are loaded directly into the VS Code webview by the extension at runtime, so there's no separate serve step. The only reason to `npm install` here is to run its test suite (see below):

```bash
cd frontend
npm install
```

## 5. Using it

With the backend running (step 2) and the extension loaded in the Extension Development Host (step 3):

1. Open any `.ipynb` notebook in that window.
2. Click the Semantic Canvas icon in the activity bar to open the sidebar. It auto-indexes the open notebook against the backend.
3. From there: search cells (semantic or keyword), read/edit AI-generated labels and summaries, switch between sidebar and inline view, and watch for duplicate/dead/stale-cell flags as you edit and run cells.
4. Expand **AI Settings** at the bottom of the sidebar to enter/change your Gemini API key, pick a model, or toggle the three advisor checks on/off.

## 6. Running the tests

Three independent suites, one per component:

```bash
# Backend (pytest)
cd backend
uv run pytest tests -q

# Webview (mocha + jsdom)
cd frontend
npm test

# Extension (real VS Code Extension Host via @vscode/test-electron)
cd extension
npm test
```

The extension test suite launches a real, separate VS Code instance headlessly. Thus it needs a display/X server available (or `xvfb-run npm test` in a headless CI/Linux environment) and will download a test copy of VS Code on first run.

## Troubleshooting

- **Port 8000 already in use**: pass a different port to uvicorn (`--port 8001`) and update `BACKEND_URL` in `extension/src/backendClient.ts` (currently hardcoded to `http://127.0.0.1:8000`) before recompiling the extension.
- **Extension shows no data / can't reach backend**: confirm the backend is running and reachable at `http://127.0.0.1:8000/docs` before opening a notebook. The extension doesn't retry indefinitely.
- **AI labels/summaries never appear, but search still works**: this is expected if no Gemini key is set. Add one via `.env` (requires a backend restart) or the AI Settings panel (no restart needed).
- **`uv sync` fails or `.venv` seems broken**: Delete `backend/.venv` and re-run `uv sync` from `backend/`.
- **Stale vector store / weird search results after heavy editing**: You can safely delete `backend/chroma_db/` while the backend is stopped. It will be rebuilt the next time you open a notebook.
