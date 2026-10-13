import { describe, expect, it } from "bun:test"
import { getEffectiveCwd } from "../src/utils/paths"

const CLI_DIR = "/home/user/git/prod/ocx/packages/cli"
const MAIN = `${CLI_DIR}/src/index.ts`
const USER_PROJECT = "/home/user/projects/my-app"

describe("getEffectiveCwd", () => {
	it("returns cwd when OCX_ORIGINAL_CWD is unset", () => {
		expect(getEffectiveCwd({ env: {}, cwd: USER_PROJECT, mainPath: MAIN })).toBe(USER_PROJECT)
	})

	it("honors OCX_ORIGINAL_CWD when the wrapper relocated into the CLI source tree", () => {
		// Wrapper: exec bun --cwd <cli-dir> src/index.ts  (cwd === CLI dir)
		expect(
			getEffectiveCwd({ env: { OCX_ORIGINAL_CWD: USER_PROJECT }, cwd: CLI_DIR, mainPath: MAIN }),
		).toBe(USER_PROJECT)
	})

	it("ignores stale OCX_ORIGINAL_CWD inherited by child processes", () => {
		// Shell/agent spawned inside an ocx-launched session: env var leaks in,
		// but cwd is the real working directory outside the source tree.
		expect(
			getEffectiveCwd({
				env: { OCX_ORIGINAL_CWD: "/home/ricelso/git/prod/ocx" },
				cwd: "/tmp/opencode/init-repro",
				mainPath: MAIN,
			}),
		).toBe("/tmp/opencode/init-repro")
	})

	it("ignores stale OCX_ORIGINAL_CWD when mainPath is unavailable", () => {
		expect(getEffectiveCwd({ env: { OCX_ORIGINAL_CWD: USER_PROJECT }, cwd: USER_PROJECT })).toBe(
			USER_PROJECT,
		)
	})

	it("does not treat cwd=/ as the source tree", () => {
		expect(
			getEffectiveCwd({ env: { OCX_ORIGINAL_CWD: USER_PROJECT }, cwd: "/", mainPath: MAIN }),
		).toBe("/")
	})

	it("empty OCX_ORIGINAL_CWD falls back to cwd", () => {
		expect(
			getEffectiveCwd({ env: { OCX_ORIGINAL_CWD: "" }, cwd: USER_PROJECT, mainPath: MAIN }),
		).toBe(USER_PROJECT)
	})
})
