import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { resolveComponentTargetRoot } from "./component-root-resolution"
import { ValidationError } from "./errors"
import { PathValidationError, validatePath } from "./path-security"

/**
 * Returns the effective current working directory.
 *
 * When OCX is launched via a wrapper script that uses `bun --cwd` (or `cd`)
 * to run from the OCX source directory, `process.cwd()` returns the OCX
 * source path instead of the user's actual working directory.
 *
 * The wrapper script (`~/.local/bin/ocx`) saves the user's original cwd
 * in the `OCX_ORIGINAL_CWD` environment variable before changing directories.
 * This function prefers that variable when set, falling back to `process.cwd()`.
 */
export function getEffectiveCwd(): string {
	return process.env.OCX_ORIGINAL_CWD ?? process.cwd()
}

const LOCAL_CONFIG_ROOT = ".opencode"
const LOCAL_CONFIG_PREFIX = `${LOCAL_CONFIG_ROOT}/`

/**
 * Strip a single leading .opencode/ prefix so local targets can be
 * normalized and re-anchored without duplicating the directory.
 */
function stripLocalPrefix(target: string): string {
	const unifiedSeparators = target.replace(/\\/g, "/")

	if (unifiedSeparators === LOCAL_CONFIG_ROOT) {
		return "."
	}

	if (unifiedSeparators.startsWith(LOCAL_CONFIG_PREFIX)) {
		return unifiedSeparators.slice(LOCAL_CONFIG_PREFIX.length)
	}

	return target
}

/**
 * Returns the global OpenCode config directory path.
 * Uses XDG_CONFIG_HOME if set and absolute, otherwise ~/.config/opencode
 */
export function getGlobalConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME
	const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config")
	return join(base, "opencode")
}

/**
 * Checks if the global OpenCode config directory exists.
 * Returns true if ~/.config/opencode/ (or XDG equivalent) is a directory.
 */
export async function globalDirectoryExists(): Promise<boolean> {
	try {
		const info = await stat(getGlobalConfigPath())
		return info.isDirectory()
	} catch {
		return false
	}
}

/**
 * Resolves a component target path for install location.
 *
 * Targets in registries are root-relative (e.g., "plugins/foo.ts").
 * - Flattened modes (global/profile) install at root-relative paths.
 * - Local mode installs under .opencode/.
 *
 * @param target - Root-relative target path from registry (e.g., "plugins/foo.ts")
 * @param isFlattened - Whether install mode is flattened (global/profile)
 * @param installRoot - Absolute install root for adaptive root resolution
 * @returns Resolved install path for the active mode
 */
export function resolveTargetPath(
	target: string,
	isFlattened: boolean,
	installRoot?: string,
): string {
	if (isFlattened) {
		if (!installRoot) {
			return target
		}

		return resolveComponentTargetRoot(target, installRoot)
	}

	const localRelativeTarget = stripLocalPrefix(target)
	const installRootAbsolute = installRoot ? resolve(installRoot) : process.cwd()
	const localRootAbsolute = resolve(installRootAbsolute, LOCAL_CONFIG_ROOT)

	let safeAbsoluteTarget: string
	try {
		safeAbsoluteTarget = validatePath(localRootAbsolute, localRelativeTarget)
	} catch (error) {
		if (error instanceof PathValidationError) {
			throw new ValidationError(`Invalid local target "${target}": ${error.message}`)
		}
		throw error
	}

	const normalizedRelativeTarget = relative(localRootAbsolute, safeAbsoluteTarget).replace(
		/\\/g,
		"/",
	)

	if (normalizedRelativeTarget === "." || normalizedRelativeTarget === "") {
		return LOCAL_CONFIG_ROOT
	}

	const adaptiveLocalTarget = installRoot
		? resolveComponentTargetRoot(normalizedRelativeTarget, localRootAbsolute)
		: normalizedRelativeTarget

	return `${LOCAL_CONFIG_PREFIX}${adaptiveLocalTarget}`
}
