import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTwoFilesPatch } from "diff";
import { minimatch } from "minimatch";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definitions
export const ReadFileArgsSchema = z.object({
	path: z.string(),
});

export const ReadMultipleFilesArgsSchema = z.object({
	paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});

export const EditOperation = z.object({
	oldText: z.string().describe("Text to search for - must match exactly"),
	newText: z.string().describe("Text to replace with"),
});

export const EditFileArgsSchema = z.object({
	path: z.string(),
	edits: z.array(EditOperation),
	dryRun: z
		.boolean()
		.default(false)
		.describe("Preview changes using git-style diff format"),
});

export const CreateDirectoryArgsSchema = z.object({
	path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
	path: z.string(),
});

export const MoveFileArgsSchema = z.object({
	source: z.string(),
	destination: z.string(),
});

export const SearchFilesArgsSchema = z.object({
	path: z.string(),
	pattern: z.string(),
	excludePatterns: z.array(z.string()).optional().default([]),
});

export const GetFileInfoArgsSchema = z.object({
	path: z.string(),
});

export interface FileInfo {
	size: number;
	created: Date;
	modified: Date;
	accessed: Date;
	isDirectory: boolean;
	isFile: boolean;
	permissions: string;
}

// Utility functions
export function normalizePath(p: string): string {
	return path.normalize(p).toLowerCase();
}

export function expandHome(filepath: string): string {
	if (filepath.startsWith("~/") || filepath === "~") {
		return path.join(os.homedir(), filepath.slice(1));
	}
	return filepath;
}

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

// Core filesystem functions
export async function validatePath(
	requestedPath: string,
	allowedDirectories: string[],
): Promise<string> {
	const expandedPath = expandHome(requestedPath);
	const absolute = path.isAbsolute(expandedPath)
		? path.resolve(expandedPath)
		: path.resolve(process.cwd(), expandedPath);

	const normalizedRequested = normalizePath(absolute);

	const isAllowed = allowedDirectories.some((dir) =>
		normalizedRequested.startsWith(dir),
	);
	if (!isAllowed) {
		throw new Error(
			`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(", ")}`,
		);
	}

	try {
		const realPath = await realpath(absolute);
		const normalizedReal = normalizePath(realPath);
		const isRealPathAllowed = allowedDirectories.some((dir) =>
			normalizedReal.startsWith(dir),
		);
		if (!isRealPathAllowed) {
			throw new Error(
				"Access denied - symlink target outside allowed directories",
			);
		}
		return realPath;
	} catch (error) {
		const parentDir = path.dirname(absolute);
		try {
			const realParentPath = await realpath(parentDir);
			const normalizedParent = normalizePath(realParentPath);
			const isParentAllowed = allowedDirectories.some((dir) =>
				normalizedParent.startsWith(dir),
			);
			if (!isParentAllowed) {
				throw new Error(
					"Access denied - parent directory outside allowed directories",
				);
			}
			return absolute;
		} catch {
			throw new Error(`Parent directory does not exist: ${parentDir}`);
		}
	}
}

export async function getFileStats(filePath: string): Promise<FileInfo> {
	const stats = await stat(filePath);
	return {
		size: stats.size,
		created: stats.birthtime,
		modified: stats.mtime,
		accessed: stats.atime,
		isDirectory: stats.isDirectory(),
		isFile: stats.isFile(),
		permissions: stats.mode.toString(8).slice(-3),
	};
}

export async function searchFiles(
	rootPath: string,
	pattern: string,
	allowedDirectories: string[],
	excludePatterns: string[] = [],
): Promise<string[]> {
	const results: string[] = [];

	async function search(currentPath: string) {
		const entries = await readdir(currentPath);
		if (!entries) return;

		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry);

			try {
				await validatePath(fullPath, allowedDirectories);

				const relativePath = path.relative(rootPath, fullPath);
				const shouldExclude = excludePatterns.some((pattern) => {
					const globPattern = pattern.includes("*")
						? pattern
						: `**/${pattern}/**`;
					return minimatch(relativePath, globPattern, { dot: true });
				});

				if (shouldExclude) return;

				if (entry.toLowerCase().includes(pattern.toLowerCase())) {
					results.push(fullPath);
				}

				const stats = await stat(fullPath);
				if (stats.isDirectory()) {
					await search(fullPath);
				}
			} catch {
				return;
			}
		}
	}

	await search(rootPath);
	return results;
}

export async function applyFileEdits(
	filePath: string,
	edits: Array<{ oldText: string; newText: string }>,
	dryRun = false,
): Promise<string> {
	const content = normalizeLineEndings(await Bun.file(filePath).text());

	let modifiedContent = content;
	for (const edit of edits) {
		const normalizedOld = normalizeLineEndings(edit.oldText);
		const normalizedNew = normalizeLineEndings(edit.newText);

		if (modifiedContent.includes(normalizedOld)) {
			modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
			continue;
		}

		const oldLines = normalizedOld.split("\n");
		const contentLines = modifiedContent.split("\n");
		let matchFound = false;

		for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
			const potentialMatch = contentLines.slice(i, i + oldLines.length);

			const isMatch = oldLines.every((oldLine, j) => {
				const contentLine = potentialMatch[j];
				return oldLine.trim() === contentLine.trim();
			});

			if (isMatch) {
				const originalIndent = contentLines[i].match(/^\s*/)?.[0] || "";
				const newLines = normalizedNew.split("\n").map((line, j) => {
					if (j === 0) return originalIndent + line.trimStart();
					const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || "";
					const newIndent = line.match(/^\s*/)?.[0] || "";
					if (oldIndent && newIndent) {
						const relativeIndent = newIndent.length - oldIndent.length;
						return (
							originalIndent +
							" ".repeat(Math.max(0, relativeIndent)) +
							line.trimStart()
						);
					}
					return line;
				});

				contentLines.splice(i, oldLines.length, ...newLines);
				modifiedContent = contentLines.join("\n");
				matchFound = true;
				break;
			}
		}

		if (!matchFound) {
			throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
		}
	}

	if (!dryRun) {
		await Bun.write(filePath, modifiedContent);
	}

	return modifiedContent;
}

// Tool definitions
export const tools = [
	{
		name: "fs:read_file",
		description:
			"Read the complete contents of a file from the file system. " +
			"Handles various text encodings and provides detailed error messages " +
			"if the file cannot be read. Use this tool when you need to examine " +
			"the contents of a single file. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
	},
	{
		name: "fs:read_multiple_files",
		description:
			"Read the contents of multiple files simultaneously. This is more " +
			"efficient than reading files one by one when you need to analyze " +
			"or compare multiple files. Each file's content is returned with its " +
			"path as a reference. Failed reads for individual files won't stop " +
			"the entire operation. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
	},
	{
		name: "fs:write_file",
		description:
			"Create a new file or completely overwrite an existing file with new content. " +
			"Use with caution as it will overwrite existing files without warning. " +
			"Handles text content with proper encoding. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
	},
	{
		name: "fs:edit_file",
		description:
			"Make line-based edits to a text file. Each edit replaces exact line sequences " +
			"with new content. Returns a git-style diff showing the changes made. " +
			"Only works within allowed directories.",
		inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
	},
	{
		name: "fs:create_directory",
		description:
			"Create a new directory or ensure a directory exists. Can create multiple " +
			"nested directories in one operation. If the directory already exists, " +
			"this operation will succeed silently. Perfect for setting up directory " +
			"structures for projects or ensuring required paths exist. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
	},
	{
		name: "fs:list_directory",
		description:
			"Get a detailed listing of all files and directories in a specified path. " +
			"Results clearly distinguish between files and directories with [FILE] and [DIR] " +
			"prefixes. This tool is essential for understanding directory structure and " +
			"finding specific files within a directory. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
	},
	{
		name: "fs:move_file",
		description:
			"Move or rename files and directories. Can move files between directories " +
			"and rename them in a single operation. If the destination exists, the " +
			"operation will fail. Works across different directories and can be used " +
			"for simple renaming within the same directory. Both source and destination must be within allowed directories.",
		inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
	},
	{
		name: "fs:search_files",
		description:
			"Recursively search for files and directories matching a pattern. " +
			"Searches through all subdirectories from the starting path. The search " +
			"is case-insensitive and matches partial names. Returns full paths to all " +
			"matching items. Great for finding files when you don't know their exact location. " +
			"Only searches within allowed directories.",
		inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
	},
	{
		name: "fs:get_file_info",
		description:
			"Retrieve detailed metadata about a file or directory. Returns comprehensive " +
			"information including size, creation time, last modified time, permissions, " +
			"and type. This tool is perfect for understanding file characteristics " +
			"without reading the actual content. Only works within allowed directories.",
		inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
	},
	{
		name: "fs:list_allowed_directories",
		description:
			"Returns the list of directories that this server is allowed to access. " +
			"Use this to understand which directories are available before trying to access files.",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
];

// Tool handlers
export async function handleTool(
	name: string,
	args: Record<string, unknown> | undefined,
	allowedDirectories: string[],
) {
	switch (name) {
		case "fs:read_file": {
			const parsed = ReadFileArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			const content = await Bun.file(validPath).text();
			return {
				content: [{ type: "text", text: content }],
			};
		}

		case "fs:read_multiple_files": {
			const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(
					`Invalid arguments for read_multiple_files: ${parsed.error}`,
				);
			}
			const results = await Promise.all(
				parsed.data.paths.map(async (filePath: string) => {
					try {
						const validPath = await validatePath(filePath, allowedDirectories);
						const content = await Bun.file(validPath).text();
						return `${filePath}:\n${content}\n`;
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						return `${filePath}: Error - ${errorMessage}`;
					}
				}),
			);
			return {
				content: [{ type: "text", text: results.join("\n---\n") }],
			};
		}

		case "fs:write_file": {
			const parsed = WriteFileArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			await Bun.write(validPath, parsed.data.content);
			return {
				content: [
					{ type: "text", text: `Successfully wrote to ${parsed.data.path}` },
				],
			};
		}

		case "fs:edit_file": {
			const parsed = EditFileArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			const result = await applyFileEdits(
				validPath,
				parsed.data.edits,
				parsed.data.dryRun,
			);
			const diff = createTwoFilesPatch(
				parsed.data.path,
				parsed.data.path,
				await Bun.file(validPath).text(),
				result,
				"original",
				"modified",
			);
			return {
				content: [{ type: "text", text: diff }],
			};
		}

		case "fs:create_directory": {
			const parsed = CreateDirectoryArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(
					`Invalid arguments for create_directory: ${parsed.error}`,
				);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			await mkdir(validPath, { recursive: true });
			return {
				content: [
					{
						type: "text",
						text: `Successfully created directory ${parsed.data.path}`,
					},
				],
			};
		}

		case "fs:list_directory": {
			const parsed = ListDirectoryArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(
					`Invalid arguments for list_directory: ${parsed.error}`,
				);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			const entries = await readdir(validPath);
			if (!entries) {
				throw new Error(`Failed to read directory: ${parsed.data.path}`);
			}
			const formatted = await Promise.all(
				entries.map(async (entry) => {
					const stats = await stat(path.join(validPath, entry));
					return `${stats.isDirectory() ? "[DIR]" : "[FILE]"} ${entry}`;
				}),
			);
			return {
				content: [{ type: "text", text: formatted.join("\n") }],
			};
		}

		case "fs:move_file": {
			const parsed = MoveFileArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
			}
			const validSourcePath = await validatePath(
				parsed.data.source,
				allowedDirectories,
			);
			const validDestPath = await validatePath(
				parsed.data.destination,
				allowedDirectories,
			);
			const content = await Bun.file(validSourcePath).arrayBuffer();
			await Bun.write(validDestPath, content);
			await rm(validSourcePath);
			return {
				content: [
					{
						type: "text",
						text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}`,
					},
				],
			};
		}

		case "fs:search_files": {
			const parsed = SearchFilesArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			const results = await searchFiles(
				validPath,
				parsed.data.pattern,
				allowedDirectories,
				parsed.data.excludePatterns,
			);
			return {
				content: [
					{
						type: "text",
						text: results.length > 0 ? results.join("\n") : "No matches found",
					},
				],
			};
		}

		case "fs:get_file_info": {
			const parsed = GetFileInfoArgsSchema.safeParse(args);
			if (!parsed.success) {
				throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
			}
			const validPath = await validatePath(
				parsed.data.path,
				allowedDirectories,
			);
			const info = await getFileStats(validPath);
			return {
				content: [
					{
						type: "text",
						text: Object.entries(info)
							.map(([key, value]) => `${key}: ${value}`)
							.join("\n"),
					},
				],
			};
		}

		case "fs:list_allowed_directories": {
			return {
				content: [
					{
						type: "text",
						text: `Allowed directories:\n${allowedDirectories.join("\n")}`,
					},
				],
			};
		}

		default:
			return null;
	}
}
