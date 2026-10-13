/**
 * ConfigResolver Unit Tests
 *
 * Tests for profile resolution and config merging.
 * Uses the tmpdir fixture for isolated temporary directories.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigResolver } from "../../src/config/resolver"
import { getLocalProfileDir } from "../../src/profile/paths"
import {
	ConfigError,
	ProfileNotFoundError,
	ProfilesNotInitializedError,
} from "../../src/utils/errors"
import { tmpdir } from "../fixture"

// =============================================================================
// PROFILE RESOLUTION TESTS
// =============================================================================

describe("ConfigResolver", () => {
	describe("profile resolution", () => {
		let originalXdgConfigHome: string | undefined
		let originalOcxProfile: string | undefined
		let xdgDir: string

		beforeEach(async () => {
			// Create isolated XDG directory
			xdgDir = path.join(os.tmpdir(), `ocx-test-xdg-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(xdgDir, { recursive: true })

			// Save and override XDG_CONFIG_HOME
			originalXdgConfigHome = process.env.XDG_CONFIG_HOME
			originalOcxProfile = process.env.OCX_PROFILE
			process.env.XDG_CONFIG_HOME = xdgDir
		})

		afterEach(async () => {
			// Restore environment
			if (originalXdgConfigHome === undefined) {
				delete process.env.XDG_CONFIG_HOME
			} else {
				process.env.XDG_CONFIG_HOME = originalXdgConfigHome
			}
			if (originalOcxProfile === undefined) {
				delete process.env.OCX_PROFILE
			} else {
				process.env.OCX_PROFILE = originalOcxProfile
			}
			// Cleanup XDG directory
			await fs.rm(xdgDir, { recursive: true, force: true })
		})

		it("resolves profile from explicit option (highest priority)", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "work", ocxConfig: { registries: {} } },
			})

			// Also create a "personal" profile
			const personalDir = path.join(xdgDir, "opencode", "profiles", "personal")
			await fs.mkdir(personalDir, { recursive: true })
			await Bun.write(path.join(personalDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			// Set env to personal, but pass work as explicit option
			process.env.OCX_PROFILE = "personal"

			const resolver = await ConfigResolver.create(tmp.path, { profile: "work" })
			const config = resolver.resolve()

			expect(config.profileName).toBe("work") // NOT "personal"
		})

		it("short-circuits to CLI profile and ignores invalid OCX_PROFILE", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "work", ocxConfig: { registries: {} } },
			})

			process.env.OCX_PROFILE = "does-not-exist"

			const resolver = await ConfigResolver.create(tmp.path, { profile: "work" })
			const config = resolver.resolve()

			expect(config.profileName).toBe("work")
		})

		it("short-circuits to CLI profile and ignores invalid lower-priority sources", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "cli-wins", ocxConfig: { registries: {} } },
				ocxConfig: { profile: "does-not-exist" },
			})

			process.env.OCX_PROFILE = "also-missing"

			const resolver = await ConfigResolver.create(tmp.path, { profile: "cli-wins" })
			const config = resolver.resolve()

			expect(config.profileName).toBe("cli-wins")
		})

		it("resolves profile from OCX_PROFILE env when no explicit option", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "personal", ocxConfig: { registries: {} } },
			})

			// Also create default profile
			const defaultDir = path.join(xdgDir, "opencode", "profiles", "default")
			await fs.mkdir(defaultDir, { recursive: true })
			await Bun.write(path.join(defaultDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			process.env.OCX_PROFILE = "personal"

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBe("personal") // NOT "default"
		})

		it("resolves profile from local config when no CLI flag", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "local-pick", ocxConfig: { registries: {} } },
				ocxConfig: { profile: "local-pick" },
			})

			process.env.OCX_PROFILE = "does-not-exist"

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBe("local-pick")
		})

		it("falls back to 'default' profile when no option or env", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			// Also create another profile to prove we're not just picking first
			const workDir = path.join(xdgDir, "opencode", "profiles", "work")
			await fs.mkdir(workDir, { recursive: true })
			await Bun.write(path.join(workDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			delete process.env.OCX_PROFILE

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBe("default")
		})

		it("returns null profileName when no profiles exist", async () => {
			await using tmp = await tmpdir({ git: true })

			delete process.env.OCX_PROFILE

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			expect(config.profileName).toBeNull()
		})

		it("fails fast for explicit CLI profile when profile does not exist", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			await expect(ConfigResolver.create(tmp.path, { profile: "missing" })).rejects.toBeInstanceOf(
				ProfileNotFoundError,
			)
		})

		it("fails fast for explicit CLI profile when value is an empty string", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			process.env.OCX_PROFILE = "default"

			await expect(ConfigResolver.create(tmp.path, { profile: "" })).rejects.toBeInstanceOf(
				ConfigError,
			)
		})

		it("fails fast for explicit OCX_PROFILE when profile does not exist", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			process.env.OCX_PROFILE = "missing"

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ProfileNotFoundError)
		})

		it("fails fast for explicit OCX_PROFILE when value is whitespace-only", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			process.env.OCX_PROFILE = "   "

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ConfigError)
		})

		it("fails fast for explicit local profile in .opencode/ocx.jsonc", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
				ocxConfig: { profile: "missing" },
			})

			process.env.OCX_PROFILE = "default"

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ProfileNotFoundError)
		})

		it("fails fast for empty local profile value in .opencode/ocx.jsonc", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
				ocxConfig: { profile: "" },
			})

			process.env.OCX_PROFILE = "default"

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ConfigError)
		})

		it("fails fast when local .opencode/ocx.jsonc is malformed (no fallback)", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			const localConfigDir = path.join(tmp.path, ".opencode")
			await fs.mkdir(localConfigDir, { recursive: true })
			await Bun.write(path.join(localConfigDir, "ocx.jsonc"), '{ "profile": "default"')

			process.env.OCX_PROFILE = "default"

			await expect(ConfigResolver.create(tmp.path, { profile: "default" })).rejects.toBeInstanceOf(
				ConfigError,
			)
		})

		it("fails fast when local .opencode/ocx.jsonc has invalid profile type", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			const localConfigDir = path.join(tmp.path, ".opencode")
			await fs.mkdir(localConfigDir, { recursive: true })
			await Bun.write(path.join(localConfigDir, "ocx.jsonc"), JSON.stringify({ profile: 123 }))

			process.env.OCX_PROFILE = "default"

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ConfigError)
		})

		it("fails fast when local .opencode/opencode.jsonc is malformed", async () => {
			await using tmp = await tmpdir({ git: true })

			const localConfigDir = path.join(tmp.path, ".opencode")
			await fs.mkdir(localConfigDir, { recursive: true })
			await Bun.write(path.join(localConfigDir, "opencode.jsonc"), '{ "model": "gpt-5"')
			delete process.env.OCX_PROFILE

			const resolver = await ConfigResolver.create(tmp.path)
			expect(() => resolver.resolve()).toThrow(ConfigError)
		})

		// =============================================================================
		// PHASE 1 RED: Local profile directory presence must trigger hard error
		// =============================================================================

		it("hard errors when local .opencode/profiles/<name> directory exists", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "work", ocxConfig: { registries: {} } },
			})

			// Create a LOCAL profile directory — this should be unsupported and cause a hard error
			const localProfileDir = getLocalProfileDir("work", tmp.path)
			await fs.mkdir(localProfileDir, { recursive: true })
			await Bun.write(path.join(localProfileDir, "ocx.jsonc"), JSON.stringify({ registries: {} }))

			// ConfigResolver.create should throw because local profiles are unsupported
			await expect(ConfigResolver.create(tmp.path, { profile: "work" })).rejects.toThrow(
				/local.*profile.*unsupported|local.*profile.*not.*allowed/i,
			)
		})

		it("does not swallow corrupted implicit default profile", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: { name: "default", ocxConfig: { registries: {} } },
			})

			const defaultProfilePath = path.join(xdgDir, "opencode", "profiles", "default", "ocx.jsonc")
			await Bun.write(defaultProfilePath, '{ "registries": {}')

			delete process.env.OCX_PROFILE

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(ConfigError)
		})

		it("throws ProfilesNotInitializedError for explicit env profile when profiles are uninitialized", async () => {
			await using tmp = await tmpdir({ git: true })

			process.env.OCX_PROFILE = "work"

			await expect(ConfigResolver.create(tmp.path)).rejects.toBeInstanceOf(
				ProfilesNotInitializedError,
			)
		})
	})

	// =============================================================================
	// CONFIG MERGING TESTS
	// =============================================================================

	describe("config merging", () => {
		let originalXdgConfigHome: string | undefined
		let originalOcxProfile: string | undefined
		let xdgDir: string

		beforeEach(async () => {
			xdgDir = path.join(os.tmpdir(), `ocx-test-xdg-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(xdgDir, { recursive: true })

			originalXdgConfigHome = process.env.XDG_CONFIG_HOME
			originalOcxProfile = process.env.OCX_PROFILE
			process.env.XDG_CONFIG_HOME = xdgDir
			delete process.env.OCX_PROFILE
		})

		afterEach(async () => {
			if (originalXdgConfigHome === undefined) {
				delete process.env.XDG_CONFIG_HOME
			} else {
				process.env.XDG_CONFIG_HOME = originalXdgConfigHome
			}
			if (originalOcxProfile === undefined) {
				delete process.env.OCX_PROFILE
			} else {
				process.env.OCX_PROFILE = originalOcxProfile
			}
			await fs.rm(xdgDir, { recursive: true, force: true })
		})

		it("deep merges nested objects (local overrides profile)", async () => {
			await using tmp = await tmpdir({
				git: true,
				profile: {
					name: "default",
					ocxConfig: { registries: {}, exclude: [], include: [] },
					opencodeConfig: {
						nested: { fromProfile: "yes", shared: "profile-value" },
						topLevel: "profile",
					},
				},
				opencodeConfig: {
					nested: { fromLocal: "yes", shared: "local-value" },
					topLevel: "local",
				},
			})

			const resolver = await ConfigResolver.create(tmp.path)
			const config = resolver.resolve()

			// Deep merge: all nested keys preserved, local wins on conflicts
			const nested = config.opencode.nested as Record<string, unknown>
			expect(nested.fromProfile).toBe("yes")
			expect(nested.fromLocal).toBe("yes")
			expect(nested.shared).toBe("local-value") // Local wins
			expect(config.opencode.topLevel).toBe("local") // Local wins
		})
	})
})
