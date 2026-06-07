from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional


app = FastAPI()


# Allow VS Code extension / webview to call backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Data Types ----------

class NotebookCellInput(BaseModel):
    notebookId: str
    cellId: int
    cellContent: str
    cellType: str


class IndexNotebookRequest(BaseModel):
    notebookId: str
    cells: List[NotebookCellInput]


class IndexNotebookResponse(BaseModel):
    cellLabels: List[str]
    cellDescriptions: List[str]


class UpdateCellRequest(BaseModel):
    notebookId: str
    cellId: int
    cellContent: str
    cellType: str


class UpdateCellResponse(BaseModel):
    cellLabel: str
    cellDescription: str


class BackendSearchRequest(BaseModel):
    questionId: int
    question: str


class CellData(BaseModel):
    cellId: int
    cellLabel: str
    cellDescription: str
    cellColor: Optional[str] = None
    cellIcon: Optional[str] = None
    createTime: Optional[str] = None
    updateTime: Optional[List[str]] = None


class BackendSearchResponse(BaseModel):
    queryCellsList: List[CellData]
    otherCellsList: List[CellData]
    tuple: None = None


# Temporary in-memory storage
notebook_cells: List[NotebookCellInput] = []


# ---------- Helper Functions ----------

def generate_cell_label(cell: NotebookCellInput) -> str:
        # TODO: Replace this simple rule-based label with AI-generated label
    text = cell.cellContent.strip()

    if not text:
        return "Empty Cell"

    first_line = text.splitlines()[0]

    if len(first_line) > 30:
        first_line = first_line[:30] + "..."

    if cell.cellType == "code":
        return f"Code: {first_line}"

    return f"Markdown: {first_line}"


def generate_cell_description(cell: NotebookCellInput) -> str:
    text = cell.cellContent.strip()

    if not text:
        return "This cell is empty."

    short_text = text.replace("\n", " ")

    if len(short_text) > 120:
        short_text = short_text[:120] + "..."

    return f"This cell contains {cell.cellType} content: {short_text}"


# ---------- Routes ----------

@app.get("/")
def health_check():
    return {
        "message": "Semantic Canvas backend is running"
    }


@app.post("/notebook/index", response_model=IndexNotebookResponse)
def index_notebook(request: IndexNotebookRequest):
    global notebook_cells
    notebook_cells = request.cells

    labels = []
    descriptions = []

    for cell in request.cells:
        labels.append(generate_cell_label(cell))
        descriptions.append(generate_cell_description(cell))

    return IndexNotebookResponse(
        cellLabels=labels,
        cellDescriptions=descriptions
    )


@app.post("/cell/update", response_model=UpdateCellResponse)
def update_cell(request: UpdateCellRequest):
    temp_cell = NotebookCellInput(
        notebookId=request.notebookId,
        cellId=request.cellId,
        cellContent=request.cellContent,
        cellType=request.cellType
    )

    return UpdateCellResponse(
        cellLabel=generate_cell_label(temp_cell),
        cellDescription=generate_cell_description(temp_cell)
    )


@app.post("/search", response_model=BackendSearchResponse)
def search_cells(request: BackendSearchRequest):
    query = request.question.lower()

    query_cells_list = []
    other_cells_list = []

    for cell in notebook_cells:
        label = generate_cell_label(cell)
        description = generate_cell_description(cell)

        cell_data = CellData(
            cellId=cell.cellId,
            cellLabel=label,
            cellDescription=description,
            cellColor="#D6EAF8",
            cellIcon=None,
            createTime=None,
            updateTime=None
        )

        if query and query in cell.cellContent.lower():
            query_cells_list.append(cell_data)
        else:
            other_cells_list.append(cell_data)

    return BackendSearchResponse(
        queryCellsList=query_cells_list,
        otherCellsList=other_cells_list,
        tuple=None
    )
