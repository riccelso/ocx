import { afterEach, describe, expect, it, mock } from "bun:test"
import { profileOcxConfigSchema } from "../src/schemas/ocx"
import { ConfigError } from "../src/utils/errors"
import { logger, setLoggerOptions } from "../src/utils/logger"
import {
	argsHaveExplicitServerOption,
	detectOpencodeServiceStatus,
	isTuiStyleLaunch,
	parseServiceStatusOutput,
	resolveLaunchArgsForServerFallback,
	resolveServerFallbackMode,
	type ServiceCommandResult,
	startOpencodeService,
} from "../src/utils/opencode-service"

function runner(result: Partial<ServiceCommandResult>): {
	run: (cmd: string[], timeoutMs: number) => Promise<ServiceCommandResult>
	commands: string[][]
} {
	const commands: string[][] = []
	return {
		commands,
		run: async (cmd, _timeoutMs) => {
			commands.push(cmd)
			return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "" }
		},
	}
}

describe("parseServiceStatusOutput", () => {
	it("maps running output to running", () => {
		expect(parseServiceStatusOutput("running\n", 0)).toBe("running")
	})

	it("maps running output with details to running", () => {
		expect(parseServiceStatusOutput("running at http://127.0.0.1:4096", 0)).toBe("running")
	})

	it("maps stopped output to stopped", () => {
		expect(parseServiceStatusOutput("stopped\n", 0)).toBe("stopped")
	})

	it("maps disabled output to stopped", () => {
		expect(parseServiceStatusOutput("disabled", 0)).toBe("stopped")
	})

	it("maps 'not running' output to stopped", () => {
		expect(parseServiceStatusOutput("not running", 0)).toBe("stopped")
	})

	it("maps unrecognized output to unknown", () => {
		expect(parseServiceStatusOutput("", 0)).toBe("unknown")
		expect(parseServiceStatusOutput("something else", 0)).toBe("unknown")
	})

	it("maps non-zero exit to unknown (v1 binary, crash)", () => {
		expect(parseServiceStatusOutput("running", 1)).toBe("unknown")
		expect(parseServiceStatusOutput("stopped", null)).toBe("unknown")
	})
})

describe("argsHaveExplicitServerOption", () => {
	it("detects explicit --standalone", () => {
		expect(argsHaveExplicitServerOption(["--standalone"])).toBe(true)
	})

	it("detects explicit --server with value", () => {
		expect(argsHaveExplicitServerOption(["--server", "http://localhost:4096"])).toBe(true)
	})

	it("detects explicit --server with equals form", () => {
		expect(argsHaveExplicitServerOption(["--server=http://localhost:4096"])).toBe(true)
	})

	it("ignores unrelated flags and empty args", () => {
		expect(argsHaveExplicitServerOption([])).toBe(false)
		expect(argsHaveExplicitServerOption(["-p", "ws"])).toBe(false)
		expect(argsHaveExplicitServerOption(["--continue"])).toBe(false)
	})
})

describe("isTuiStyleLaunch", () => {
	it("treats empty args as TUI launch", () => {
		expect(isTuiStyleLaunch([])).toBe(true)
	})

	it("treats leading flags as TUI launch", () => {
		expect(isTuiStyleLaunch(["--continue"])).toBe(true)
		expect(isTuiStyleLaunch(["--print-logs", "."])).toBe(true)
	})

	it("treats bare first arg as subcommand (never touched)", () => {
		expect(isTuiStyleLaunch(["serve"])).toBe(false)
		expect(isTuiStyleLaunch(["run", "hello"])).toBe(false)
		expect(isTuiStyleLaunch([".", "--print-logs"])).toBe(false)
	})
})

describe("resolveServerFallbackMode", () => {
	it("defaults to standalone", () => {
		expect(resolveServerFallbackMode({})).toBe("standalone")
	})

	it("uses profile config value", () => {
		expect(resolveServerFallbackMode({ configValue: "start" })).toBe("start")
		expect(resolveServerFallbackMode({ configValue: "none" })).toBe("none")
	})

	it("env disables the fallback", () => {
		for (const value of ["0", "false", "off", "none"]) {
			expect(resolveServerFallbackMode({ configValue: "start", envValue: value })).toBe("none")
		}
	})

	it("env 1/true/on defers to config", () => {
		expect(resolveServerFallbackMode({ configValue: "start", envValue: "1" })).toBe("start")
		expect(resolveServerFallbackMode({ envValue: "true" })).toBe("standalone")
	})

	it("env sets explicit mode", () => {
		expect(resolveServerFallbackMode({ configValue: "standalone", envValue: "start" })).toBe(
			"start",
		)
	})

	it("invalid env value fails fast", () => {
		expect(() => resolveServerFallbackMode({ envValue: "banana" })).toThrow(ConfigError)
	})

	it("blank env value is ignored", () => {
		expect(resolveServerFallbackMode({ configValue: "start", envValue: "  " })).toBe("start")
	})
})

describe("detectOpencodeServiceStatus", () => {
	it("runs service status via the provided runner", async () => {
		const { run, commands } = runner({ stdout: "stopped\n", exitCode: 0 })
		const status = await detectOpencodeServiceStatus("/bin/opencode", { runCommand: run })
		expect(status).toBe("stopped")
		expect(commands).toEqual([["/bin/opencode", "service", "status"]])
	})

	it("maps non-zero exit to unknown", async () => {
		const { run } = runner({ stdout: "unknown command", exitCode: 1 })
		expect(await detectOpencodeServiceStatus("opencode", { runCommand: run })).toBe("unknown")
	})

	it("maps thrown errors to unknown", async () => {
		const run = async () => {
			throw new Error("spawn failed")
		}
		expect(await detectOpencodeServiceStatus("opencode", { runCommand: run })).toBe("unknown")
	})

	it("times out hanging probes to unknown", async () => {
		const run = () => new Promise<ServiceCommandResult>(() => {})
		const status = await detectOpencodeServiceStatus("opencode", {
			runCommand: run,
			timeoutMs: 30,
		})
		expect(status).toBe("unknown")
	})
})

describe("startOpencodeService", () => {
	it("returns true on exit code 0", async () => {
		const { run, commands } = runner({ exitCode: 0 })
		expect(await startOpencodeService("/bin/opencode", { runCommand: run })).toBe(true)
		expect(commands).toEqual([["/bin/opencode", "service", "start"]])
	})

	it("returns false on non-zero exit", async () => {
		const { run } = runner({ exitCode: 1 })
		expect(await startOpencodeService("opencode", { runCommand: run })).toBe(false)
	})

	it("returns false on timeout", async () => {
		const run = () => new Promise<ServiceCommandResult>(() => {})
		expect(await startOpencodeService("opencode", { runCommand: run, timeoutMs: 30 })).toBe(false)
	})
})

describe("resolveLaunchArgsForServerFallback", () => {
	it("returns args unchanged when no probe ran", async () => {
		const result = await resolveLaunchArgsForServerFallback({
			args: ["--continue"],
			bin: "opencode",
			fallback: "standalone",
			serverStatus: null,
		})
		expect(result).toEqual(["--continue"])
	})

	it("returns args unchanged when server is running", async () => {
		const warn = mock(() => {})
		const result = await resolveLaunchArgsForServerFallback({
			args: ["--continue"],
			bin: "opencode",
			fallback: "standalone",
			serverStatus: Promise.resolve("running"),
			warn,
		})
		expect(result).toEqual(["--continue"])
		expect(warn).not.toHaveBeenCalled()
	})

	it("returns args unchanged when status is unknown (fail-open)", async () => {
		const warn = mock(() => {})
		const result = await resolveLaunchArgsForServerFallback({
			args: [],
			bin: "opencode",
			fallback: "standalone",
			serverStatus: Promise.resolve("unknown"),
			warn,
		})
		expect(result).toEqual([])
		expect(warn).not.toHaveBeenCalled()
	})

	it("returns args unchanged when the probe rejects", async () => {
		const result = await resolveLaunchArgsForServerFallback({
			args: ["."],
			bin: "opencode",
			fallback: "standalone",
			serverStatus: Promise.reject(new Error("probe crashed")),
		})
		expect(result).toEqual(["."])
	})

	it("prepends --standalone with a warning when stopped (standalone mode)", async () => {
		const warn = mock(() => {})
		const result = await resolveLaunchArgsForServerFallback({
			args: ["--continue", "."],
			bin: "opencode",
			fallback: "standalone",
			serverStatus: Promise.resolve("stopped"),
			warn,
		})
		expect(result).toEqual(["--standalone", "--continue", "."])
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("start mode: launches unchanged after successful service start", async () => {
		const warn = mock(() => {})
		const info = mock(() => {})
		const startService = mock(async () => true)
		const result = await resolveLaunchArgsForServerFallback({
			args: ["."],
			bin: "opencode",
			fallback: "start",
			serverStatus: Promise.resolve("stopped"),
			warn,
			info,
			startService,
		})
		expect(result).toEqual(["."])
		expect(startService).toHaveBeenCalledWith("opencode")
		expect(info).toHaveBeenCalledTimes(1)
		expect(warn).not.toHaveBeenCalled()
	})

	it("start mode: falls back to standalone when start fails", async () => {
		const warn = mock(() => {})
		const startService = mock(async () => false)
		const result = await resolveLaunchArgsForServerFallback({
			args: ["."],
			bin: "opencode",
			fallback: "start",
			serverStatus: Promise.resolve("stopped"),
			warn,
			startService,
		})
		expect(result).toEqual(["--standalone", "."])
		expect(warn).toHaveBeenCalledTimes(1)
	})
})

describe("profileOcxConfigSchema serverFallback", () => {
	it("defaults to standalone", () => {
		const parsed = profileOcxConfigSchema.parse({})
		expect(parsed.serverFallback).toBe("standalone")
	})

	it("accepts all modes", () => {
		for (const value of ["standalone", "start", "none"] as const) {
			expect(profileOcxConfigSchema.parse({ serverFallback: value }).serverFallback).toBe(value)
		}
	})

	it("rejects invalid values", () => {
		expect(() => profileOcxConfigSchema.parse({ serverFallback: "banana" })).toThrow()
	})
})

describe("logger.warnAlways", () => {
	const originalWarn = console.warn
	const warnSpy = mock(() => {})

	afterEach(() => {
		console.warn = originalWarn
		setLoggerOptions({})
	})

	it("writes to stderr even in quiet mode", () => {
		console.warn = warnSpy as unknown as typeof console.warn
		setLoggerOptions({ quiet: true })

		logger.warn("suppressed")
		logger.warnAlways("visible")

		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(String(warnSpy.mock.calls[0])).toContain("visible")
	})
})
