import * as http from "http";
import type { AddressInfo } from "net";

/**
 * A minimal stand-in for the real FastAPI backend, used only by the
 * VS Code integration tests in this directory.
 *
 * `backendClient.ts` hardcodes `BACKEND_URL = "http://127.0.0.1:8000"`, so
 * this server binds to that exact host/port -- no source changes needed to
 * point the extension at it during tests. It implements just enough of
 * each endpoint's response *shape* (see CLAUDE.md's "Endpoints" section and
 * `extension/src/types.ts`) to keep the extension's request/response
 * plumbing happy, and records every request it receives so tests can
 * assert on what the extension actually sent -- e.g. "a cell move must
 * never produce a DELETE /cells/{id} call" or "PATCH /notebooks/reorder
 * must fire with this exact cell order".
 *
 * This is deliberately not a reimplementation of the real backend's
 * semantics (no real embeddings, no real dead/stale analysis) -- the
 * backend's *own* logic is already covered by the Python test suite in
 * backend/tests/. This double only needs to be a faithful enough HTTP
 * peer that the extension's request-construction and response-handling
 * code exercises real code paths.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export class FakeBackend {
  private server: http.Server | undefined;
  private requestLog: RecordedRequest[] = [];

  async start(port = 8000): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsedBody: unknown = undefined;
        if (rawBody.length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = rawBody;
          }
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/__test__/")) {
          this.requestLog.push({
            method: req.method ?? "GET",
            path: url.pathname,
            body: parsedBody,
          });
        }

        this.handle(req.method ?? "GET", url, parsedBody, res);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  port(): number {
    const address = this.server?.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  /** All requests received since the server started (or last `reset()`). */
  getRequestLog(): RecordedRequest[] {
    return [...this.requestLog];
  }

  reset(): void {
    this.requestLog = [];
  }

  private handle(
    method: string,
    url: URL,
    body: unknown,
    res: http.ServerResponse,
  ): void {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    // Introspection routes, used only by the test suite. The suite runs
    // inside the VS Code Extension Host, a *separate process* from the one
    // that constructed this FakeBackend instance, so tests can't just call
    // getRequestLog()/reset() directly -- they go over HTTP instead, the
    // same way the real extension code talks to this server.
    if (method === "GET" && url.pathname === "/__test__/requests") {
      json(200, this.getRequestLog());
      return;
    }
    if (method === "POST" && url.pathname === "/__test__/reset") {
      this.reset();
      json(200, { status: "reset" });
      return;
    }

    const b = (body ?? {}) as Record<string, unknown>;

    // POST /notebooks -- full re-index. Body shape: { notebook_id, content:
    // { nbformat, nbformat_minor, metadata, cells: JupyterCellContent[] } }.
    if (method === "POST" && url.pathname === "/notebooks") {
      const content = (b.content as Record<string, unknown>) ?? {};
      const cells = (content.cells as Array<Record<string, unknown>>) ?? [];
      const results = cells.map((cell, index) => this.cellResult(cell, index));
      json(200, results);
      return;
    }

    // POST /cells -- single cell update. Body shape: { notebook_id,
    // content: JupyterCellContent, cell_index }.
    if (method === "POST" && url.pathname === "/cells") {
      const cell = (b.content as Record<string, unknown>) ?? {};
      json(200, this.cellResult(cell, (b.cell_index as number) ?? 0));
      return;
    }

    // DELETE /cells/{cellId}
    if (method === "DELETE" && url.pathname.startsWith("/cells/")) {
      json(200, { status: "deleted" });
      return;
    }

    // PATCH /notebooks/reorder
    if (method === "PATCH" && url.pathname === "/notebooks/reorder") {
      json(200, { status: "reordered" });
      return;
    }

    // POST /search
    if (method === "POST" && url.pathname === "/search") {
      json(200, { results: [] });
      return;
    }

    // POST /cells/duplicates
    if (method === "POST" && url.pathname === "/cells/duplicates") {
      json(200, { duplicates: [] });
      return;
    }

    // POST /notebooks/dead-cells
    if (method === "POST" && url.pathname === "/notebooks/dead-cells") {
      json(200, { cells: [] });
      return;
    }

    // POST /notebooks/stale-cells
    if (method === "POST" && url.pathname === "/notebooks/stale-cells") {
      json(200, { cells: [] });
      return;
    }

    // POST /cells/summary
    if (method === "POST" && url.pathname === "/cells/summary") {
      const now = new Date().toISOString();
      json(200, {
        notebook_id: b.notebook_id,
        cell_id: b.cell_id,
        ai_label: null,
        ai_summary: null,
        user_label: b.label ?? null,
        user_summary: b.summary ?? null,
        source_hash: null,
        display_label: b.label ?? null,
        display_summary: b.summary ?? null,
        created_at: now,
        updated_at: now,
      });
      return;
    }

    // GET /cells/summary
    if (method === "GET" && url.pathname === "/cells/summary") {
      json(404, { detail: "not found" });
      return;
    }

    // POST /cells/summary/suggestion
    if (method === "POST" && url.pathname === "/cells/summary/suggestion") {
      json(200, { label: "Suggested label", summary: "Suggested summary." });
      return;
    }

    // POST /notebooks/summaries
    if (method === "POST" && url.pathname === "/notebooks/summaries") {
      const cells = (b.cells as Array<Record<string, unknown>>) ?? [];
      json(
        200,
        cells.map((cell) => ({
          cell_id: cell.cell_id,
          ai_label: "Label",
          ai_summary: "Summary.",
          user_label: null,
          user_summary: null,
          display_label: "Label",
          display_summary: "Summary.",
        })),
      );
      return;
    }

    json(404, { detail: `no fake route for ${method} ${url.pathname}` });
  }

  /**
   * Builds a `BackendCellResponse`-shaped object from one
   * `JupyterCellContent` (the shape both `POST /notebooks`'s
   * `content.cells[]` and `POST /cells`'s `content` use -- see
   * `extension/src/types.ts`): `id`, `cell_type`, `source`.
   */
  private cellResult(
    cell: Record<string, unknown>,
    index: number,
  ): Record<string, unknown> {
    const cellType = (cell.cell_type as string) ?? "code";
    const content = (cell.source as string) ?? "";
    return {
      cell_id: (cell.id as string) ?? `fake-cell-${index}`,
      cell_type: cellType,
      content,
      label: cellType === "code" ? `Label ${index}` : null,
      summary: cellType === "code" ? `Summary for cell ${index}.` : null,
    };
  }
}
