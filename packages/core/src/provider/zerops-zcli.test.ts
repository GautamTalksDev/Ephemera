import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runZcli } from "./zerops-zcli.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);

afterEach(() => {
  execFileMock.mockReset();
});

describe("runZcli", () => {
  it("invokes execFile with an argument array (never a shell string)", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      const done = cb as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      done(null, "ok", "");
      return {} as ReturnType<typeof execFile>;
    });

    await runZcli(["service", "push", "pr1api", "-P", "proj"]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileMock.mock.calls[0]!;
    expect(file).toBe("zcli");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(["service", "push", "pr1api", "-P", "proj"]);
    expect(typeof args).not.toBe("string");
    expect(opts).toEqual(
      expect.objectContaining({
        timeout: expect.any(Number),
      }),
    );
    expect(
      (opts as { shell?: boolean } | undefined)?.shell,
    ).not.toBe(true);
  });
});
