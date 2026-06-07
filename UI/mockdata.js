//placeholder until the extention can fetch all cells from backend
const mockAllCells = [
  {
    cellId: 1,
    cellLabel: "Import libraries",
    cellDescription:
      "Imports pandas, numpy, and matplotlib for data manipulation and visualization.",
    cellIcon: "table",
    cellContent:
      "import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt",
    type: "code",
  },
  {
    cellId: 2,
    cellLabel: "Load dataset",
    cellDescription:
      "Loads the training dataset from a CSV file and prints basic info.",
    cellIcon: "upload",
    cellContent: "data = pd.read_csv('train.csv')\ndata.info()",
    type: "code",
  },
  {
    cellId: 3,
    cellLabel: "Explore data",
    cellDescription:
      "Displays the first rows and summary statistics of the dataset.",
    cellIcon: "datapie",
    cellContent: "data.head()\ndata.describe()",
    type: "code",
  },
  {
    cellId: 4,
    cellLabel: "Handle missing values",
    cellDescription:
      "Drops rows with missing values and verifies no nulls remain.",
    cellIcon: "clean",
    cellContent: "data = data.dropna()\nprint(data.isnull().sum())",
    type: "code",
  },
  {
    cellId: 5,
    cellLabel: "Preprocessing overview",
    cellDescription:
      "Markdown cell explaining the preprocessing pipeline including normalization steps.",
    cellIcon: "upload",
    cellContent:
      "# Data Preprocessing\nWe will normalize the data using StandardScaler...",
    type: "markdown",
  },
  {
    cellId: 6,
    cellLabel: "Normalize features manually",
    cellDescription:
      "Applies manual normalization using mean and standard deviation. Transforms data to zero mean and unit variance.",
    cellIcon: "datapie",
    cellContent:
      "# Manual normalization\ndata_normalized = (data - data.mean()) / data.std()",
    type: "code",
  },
  {
    cellId: 7,
    cellLabel: "Import StandardScaler",
    cellDescription: "Imports sklearn's StandardScaler for data normalization.",
    cellIcon: "table",
    cellContent:
      "from sklearn.preprocessing import StandardScaler\nscaler = StandardScaler()",
    type: "code",
  },
  {
    cellId: 8,
    cellLabel: "Apply StandardScaler",
    cellDescription:
      "Fits and transforms the feature matrix using StandardScaler.",
    cellIcon: "clean",
    cellContent: "X_scaled = scaler.fit_transform(X)\nprint(X_scaled[:5])",
    type: "code",
  },
];

// Mock data — replace with API response in Week 2
const mockSearchResults = {
  searchBar: "how did I normalize the data",
  queryCellsList: [
    { ...mockAllCells[5], score: 0.95 },
    { ...mockAllCells[6], score: 0.72 },
    { ...mockAllCells[4], score: 0.68 },
  ],
  otherCellsList: [
    { ...mockAllCells[0], score: 0.45 },
    { ...mockAllCells[1], score: 0.38 },
  ],
};
