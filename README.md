# PIIS
Backend works

The FastAPI backend can run successfully:

cd D:\LMU\SS26\piis\PIIS\backend\src
uvicorn main:app --reload --port 8000

Browser test:

http://127.0.0.1:8000

Expected result:

{
  "message": "Semantic Canvas backend is running"
}
Extension command works

The command:

Semantic Canvas: Index Notebook

can successfully read the notebook and send data to the backend.

Successful message:

Notebook indexed: 6 cells

This means the following pipeline already works:

Notebook cells
→ notebookReader.ts
→ backendClient.ts
→ FastAPI backend
→ response back to VS Code


Open VS Code directly at:

D:\LMU\SS26\piis\PIIS\backend

Then run:

npm run compile

Then press:

F5


