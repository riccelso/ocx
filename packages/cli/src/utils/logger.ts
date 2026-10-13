/**
 * Logger utility with quiet/verbose modes
 * Inspired by ShadCN's logger pattern
 */

import kleur from "kleur"
import { supportsColor } from "./env"

// Disable colors if not supported
if (!supportsColor) {
	kleur.enabled = false
}

export interface LoggerOptions {
	quiet?: boolean
	verbose?: boolean
}

let options: LoggerOptions = {}

export function setLoggerOptions(opts: LoggerOptions): void {
	options = opts
}

export const logger = {
	info(...args: unknown[]): void {
		if (options.quiet) return
		console.log(kleur.blue("info"), ...args)
	},

	success(...args: unknown[]): void {
		if (options.quiet) return
		console.log(kleur.green("✓"), ...args)
	},

	warn(...args: unknown[]): void {
		if (options.quiet) return
		console.warn(kleur.yellow("warn"), ...args)
	},

	/**
	 * Warning that must reach the user even in quiet mode (piped consumers
	 * expect a clean stdout stream; stderr never pollutes it).
	 */
	warnAlways(...args: unknown[]): void {
		console.warn(kleur.yellow("warn"), ...args)
	},

	error(...args: unknown[]): void {
		// Errors are always shown
		console.error(kleur.red("error"), ...args)
	},

	debug(...args: unknown[]): void {
		if (!options.verbose) return
		console.log(kleur.gray("debug"), ...args)
	},

	log(...args: unknown[]): void {
		if (options.quiet) return
		console.log(...args)
	},

	/** Print a blank line */
	break(): void {
		if (options.quiet) return
		console.log("")
	},
}

/** Highlight text with color */
export const highlight = {
	component: (text: string) => kleur.cyan(text),
	path: (text: string) => kleur.green(text),
	command: (text: string) => kleur.yellow(text),
	url: (text: string) => kleur.blue().underline(text),
	error: (text: string) => kleur.red(text),
	dim: (text: string) => kleur.gray(text),
	bold: (text: string) => kleur.bold(text),
}
