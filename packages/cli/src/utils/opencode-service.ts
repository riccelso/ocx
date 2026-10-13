/**
 * OpenCode v2 Background Server Detection & Fallback
 *
 * OpenCode v2 clients (TUI) normally connect to a shared background server.
 * When that server is not running, a plain TUI launch can hang or fail
 * depending on the environment. OCX probes `opencode service status` before
 * spawning and can fall back to `--standalone` (private server) or start the
 * shared service explicitly.
 *
 * All probes are fail-open: any error, timeout, or unrecognized output
 * resolves to "unknown" and never blocks the launch. OpenCode v1 (no
 * `service` subcommand) also resolves to "unknown" and launches unchanged.
 */

import type { ServerFallbackMode } from "../schemas/ocx"
import { ConfigError } from "./errors"
import { logger } from "./logger"

export type ServiceStatus = "running" | "stopped" | "unknown"

/** Default probe timeout for `opencode service status` (ms). */
export const SERVICE_STATUS_TIMEOUT_MS = 3000
/** Default timeout for `opencode service start` (ms). */
export const SERVICE_START_TIMEOUT_MS = 15000

export interface ServiceCommandResult {
	exitCode: number | null
	stdout: string
}

export type ServiceCommandRunner = (
	cmd: string[],
	timeoutMs: number,
) => Promise<ServiceCommandResult>

/**
 * Spawns a service subcommand, killing it after the timeout to avoid orphans.
 */
async function spawnServiceCommand(
	cmd: string[],
	timeoutMs: number,
): Promise<ServiceCommandResult> {
	const proc = Bun.spawn({
		cmd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)
	try {
		const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
		return { exitCode, stdout }
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Races a promise against a timeout. The underlying spawn also self-kills at
 * the same deadline (see spawnServiceCommand), so no orphan processes remain.
 */
function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/**
 * Parses `opencode service status` output into a tri-state status.
 *
 * Observed outputs (v2.0.x): "running" | "stopped". "disabled" and
 * "not running" are accepted defensively. Anything else (or a non-zero
 * exit) is "unknown" so the launch proceeds unchanged.
 */
export function parseServiceStatusOutput(stdout: string, exitCode: number | null): ServiceStatus {
	if (exitCode !== 0) {
		return "unknown"
	}
	const token = stdout.trim().toLowerCase().split(/\s+/)[0] ?? ""
	if (token === "running") {
		return "running"
	}
	if (token === "stopped" || token === "disabled" || token === "not") {
		return "stopped"
	}
	return "unknown"
}

/**
 * True when the user already selected a server mode explicitly
 * (`--standalone` or `--server <url>` / `--server=<url>`).
 * Explicit intent always wins — OCX never re-probes or injects.
 */
export function argsHaveExplicitServerOption(args: string[]): boolean {
	return args.some(
		(arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="),
	)
}

/**
 * True when args look like a plain TUI launch (no args, or flags first).
 * Bare-word first args are treated as OpenCode subcommands (`serve`, `run`,
 * `mini`, ...) and are never touched by the fallback.
 */
export function isTuiStyleLaunch(args: string[]): boolean {
	if (args.length === 0) {
		return true
	}
	const first = args[0]
	return first?.startsWith("-") ?? false
}

/**
 * Resolves the effective fallback mode.
 *
 * Precedence: OCX_SERVER_FALLBACK env var (explicit override) > profile
 * ocx.jsonc `serverFallback` > "standalone" (default).
 *
 * Env values: "standalone" | "start" | "none" are literal modes;
 * "1"/"true"/"on" mean "use the profile config"; "0"/"false"/"off" disable
 * entirely. Invalid values fail fast (explicit sources must not be ignored).
 */
export function resolveServerFallbackMode(opts: {
	configValue?: ServerFallbackMode
	envValue?: string | undefined
}): ServerFallbackMode {
	const env = opts.envValue?.trim()
	if (env === undefined || env === "") {
		return opts.configValue ?? "standalone"
	}

	const normalized = env.toLowerCase()
	if (normalized === "0" || normalized === "false" || normalized === "off") {
		return "none"
	}
	if (normalized === "1" || normalized === "true" || normalized === "on") {
		return opts.configValue ?? "standalone"
	}
	if (normalized === "standalone" || normalized === "start" || normalized === "none") {
		return normalized
	}

	throw new ConfigError(
		`Invalid OCX_SERVER_FALLBACK value "${env}". Expected "standalone", "start", "none", "1"/"true" (use profile config), or "0"/"false" (disable).`,
	)
}

/**
 * Probes the OpenCode v2 background service status.
 * Never throws — failures resolve to "unknown" (fail-open).
 */
export async function detectOpencodeServiceStatus(
	bin: string,
	opts?: { timeoutMs?: number; runCommand?: ServiceCommandRunner },
): Promise<ServiceStatus> {
	const timeoutMs = opts?.timeoutMs ?? SERVICE_STATUS_TIMEOUT_MS
	const runCommand = opts?.runCommand ?? spawnServiceCommand
	try {
		const { exitCode, stdout } = await raceTimeout(
			runCommand([bin, "service", "status"], timeoutMs),
			timeoutMs,
			"opencode service status",
		)
		return parseServiceStatusOutput(stdout, exitCode)
	} catch {
		return "unknown"
	}
}

/**
 * Starts the shared background service via `opencode service start`.
 * Never throws — returns false on failure or timeout.
 */
export async function startOpencodeService(
	bin: string,
	opts?: { timeoutMs?: number; runCommand?: ServiceCommandRunner },
): Promise<boolean> {
	const timeoutMs = opts?.timeoutMs ?? SERVICE_START_TIMEOUT_MS
	const runCommand = opts?.runCommand ?? spawnServiceCommand
	try {
		const { exitCode } = await raceTimeout(
			runCommand([bin, "service", "start"], timeoutMs),
			timeoutMs,
			"opencode service start",
		)
		return exitCode === 0
	} catch {
		return false
	}
}

/**
 * Applies the fallback decision to the spawn args.
 *
 * - No probe (null status) → args unchanged.
 * - "running" → args unchanged.
 * - "unknown" → args unchanged (v1 binary, broken probe, race) — never blocks.
 * - "stopped" → depends on mode:
 *   - "standalone": prepend `--standalone` + warn on stderr.
 *   - "start": try `opencode service start`; on success launch unchanged,
 *     on failure prepend `--standalone` + warn on stderr.
 *
 * Warnings default to logger.warnAlways (stderr, survives quiet mode) so
 * piped stdout consumers (e.g. NDJSON) keep a clean stream.
 */
export async function resolveLaunchArgsForServerFallback(args: {
	args: string[]
	bin: string
	fallback: ServerFallbackMode
	serverStatus: Promise<ServiceStatus> | null
	warn?: (message: string) => void
	info?: (message: string) => void
	startService?: (bin: string) => Promise<boolean>
}): Promise<string[]> {
	if (!args.serverStatus) {
		return args.args
	}

	let status: ServiceStatus
	try {
		status = await args.serverStatus
	} catch {
		return args.args
	}

	if (status !== "stopped") {
		if (status === "unknown") {
			logger.debug("OpenCode background server status unknown — launching without fallback")
		}
		return args.args
	}

	const warn = args.warn ?? ((message: string) => logger.warnAlways(message))
	const info = args.info ?? ((message: string) => logger.info(message))

	if (args.fallback === "start") {
		const startService = args.startService ?? ((bin: string) => startOpencodeService(bin))
		const started = await startService(args.bin)
		if (started) {
			info("OpenCode background server was not running — started it via `opencode service start`")
			return args.args
		}
		warn("`opencode service start` failed — falling back to --standalone (private server)")
		return ["--standalone", ...args.args]
	}

	warn(
		'OpenCode background server not detected — launching with --standalone (private server). Start the shared server with `opencode service start`, or set serverFallback to "none" (profile ocx.jsonc) or OCX_SERVER_FALLBACK=0 to disable this fallback.',
	)
	return ["--standalone", ...args.args]
}
