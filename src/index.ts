import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "./fs";

const CONFIG_DIR = path.join(os.homedir(), ".config", "semantic-fs");
const CONFIG_FILE = path.join(CONFIG_DIR, "approved.json");

import {
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
// Initialize config directory and file if they don't exist
async function initializeConfig() {
	try {
		try {
			await readFile(CONFIG_FILE, "utf-8");
		} catch {
			await writeFile(
				CONFIG_FILE,
				JSON.stringify({ allowedDirectories: [] }, null, 2),
			);
		}
	} catch {
		await mkdir(CONFIG_DIR, { recursive: true });
		await writeFile(
			CONFIG_FILE,
			JSON.stringify({ allowedDirectories: [] }, null, 2),
		);
	}
}

// Load allowed directories from config
async function loadAllowedDirectories(): Promise<string[]> {
	await initializeConfig();
	const configData = await readFile(CONFIG_FILE, "utf-8");
	const config = JSON.parse(configData);
	return config.allowedDirectories.map((dir: string) =>
		fs.normalizePath(path.resolve(fs.expandHome(dir))),
	);
}

// Add new directories to config
async function addAllowedDirectories(directories: string[]) {
	const configData = await readFile(CONFIG_FILE, "utf-8");
	const config = JSON.parse(configData);
	const normalizedNew = directories.map((dir) =>
		fs.normalizePath(path.resolve(fs.expandHome(dir))),
	);

	config.allowedDirectories = [
		...new Set([...config.allowedDirectories, ...normalizedNew]),
	];

	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
	return config.allowedDirectories;
}

// Server setup
const server = new Server(
	{
		name: "secure-filesystem-server",
		version: "0.2.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: fs.tools,
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const { name, arguments: args } = request.params;
		const allowedDirectories = await loadAllowedDirectories();

		// Add command line arguments to allowed directories if provided
		if (process.argv.length > 2) {
			await addAllowedDirectories(process.argv.slice(2));
		}

		// Handle filesystem tools
		if (name.startsWith("fs:")) {
			const result = await fs.handleTool(name, args, allowedDirectories);
			if (result) return result;
		}

		throw new Error(`Unknown tool: ${name}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Error: ${errorMessage}` }],
			isError: true,
		};
	}
});

// Start server
async function runServer() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Secure MCP Filesystem Server running on stdio");

	const allowedDirectories = await loadAllowedDirectories();
	if (process.argv.length > 2) {
		await addAllowedDirectories(process.argv.slice(2));
	}

	console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
	console.error("Fatal error running server:", error);
	process.exit(1);
});
