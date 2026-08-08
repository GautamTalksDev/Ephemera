import { describe, expect, it, vi } from "vitest";
import {
  EPHEMERA_COMMENT_MARKER,
  fetchBranchHeadSha,
  upsertPrComment,
} from "./client.js";

describe("fetchBranchHeadSha", () => {
  it("returns the commit sha for a branch", async () => {
    const sha = "a".repeat(40);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ sha }), { status: 200 }),
    );
    await expect(
      fetchBranchHeadSha("GautamTalksDev/ephemera-demo-app", "main", {
        token: "t",
        fetchImpl,
      }),
    ).resolves.toBe(sha);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/repos/GautamTalksDev/ephemera-demo-app/commits/main",
    );
  });
});

describe("upsertPrComment", () => {
  it("creates a comment when none with the marker exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1, body: "unrelated" }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 99, body: "created" }), {
          status: 201,
        }),
      );

    const result = await upsertPrComment(
      "acme/demo",
      7,
      "Preview is ready",
      { token: "t", fetchImpl },
    );

    expect(result).toEqual({ id: 99, created: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const createInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    const createdBody = JSON.parse(String(createInit.body)) as { body: string };
    expect(createdBody.body).toContain(EPHEMERA_COMMENT_MARKER);
    expect(createdBody.body).toContain("Preview is ready");
  });

  it("edits the existing marker comment and never creates a second", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 10, body: "hello" },
            { id: 11, body: `${EPHEMERA_COMMENT_MARKER}\nold` },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 11, body: "updated" }), {
          status: 200,
        }),
      );

    const result = await upsertPrComment("acme/demo", 7, "new status", {
      token: "t",
      fetchImpl,
    });

    expect(result).toEqual({ id: 11, created: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/issues/comments/11");
    expect(fetchImpl.mock.calls.some((c) => String(c[1]?.method) === "POST")).toBe(
      false,
    );
  });
});
