#!/usr/bin/env node
/**
 * AgentsGate — Extended Filesystem MCP Server
 *
 * A self-contained port of @modelcontextprotocol/server-filesystem with an
 * additional `delete_file` tool that moves files to a .trash/ folder instead
 * of permanently deleting them.
 *
 * All utility functions (normalizePath, expandHome, validatePath, applyFileEdits,
 * etc.) are inlined here so the file has zero dependency on node_modules internals.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { minimatch } from 'minimatch';
import { createTwoFilesPatch } from 'diff';

// ---------------------------------------------------------------------------
// Path utilities (ported from path-utils.js)
// ---------------------------------------------------------------------------

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function convertToWindowsPath(p: string): string {
  if (p.startsWith('/mnt/')) {
    return p;
  }
  if (p.match(/^\/[a-zA-Z]\//) && process.platform === 'win32') {
    const driveLetter = p.charAt(1).toUpperCase();
    const pathPart = p.slice(2).replace(/\//g, '\\');
    return `${driveLetter}:${pathPart}`;
  }
  if (p.match(/^[a-zA-Z]:/)) {
    return p.replace(/\//g, '\\');
  }
  return p;
}

function normalizePath(p: string): string {
  p = p.trim().replace(/^["']|["']$/g, '');

  const isUnixPath =
    p.startsWith('/') &&
    (p.match(/^\/mnt\/[a-z]\//i) ||
      process.platform !== 'win32' ||
      (process.platform === 'win32' && !p.match(/^\/[a-zA-Z]\//)));

  if (isUnixPath) {
    return p.replace(/\/+/g, '/').replace(/(?<!^)\/$/, '');
  }

  p = convertToWindowsPath(p);

  if (p.startsWith('\\\\')) {
    p = p.replace(/^\\{2,}/, '\\\\');
    const restOfPath = p.substring(2).replace(/\\\\/g, '\\');
    p = '\\\\' + restOfPath;
  } else {
    p = p.replace(/\\\\/g, '\\');
  }

  let normalized = path.normalize(p);

  if (p.startsWith('\\\\') && !normalized.startsWith('\\\\')) {
    normalized = '\\' + normalized;
  }

  if (normalized.match(/^[a-zA-Z]:/)) {
    let result = normalized.replace(/\//g, '\\');
    if (/^[a-z]:/.test(result)) {
      result = result.charAt(0).toUpperCase() + result.slice(1);
    }
    return result;
  }

  if (process.platform === 'win32') {
    return normalized.replace(/\//g, '\\');
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Path validation (ported from path-validation.js)
// ---------------------------------------------------------------------------

function isPathWithinAllowedDirectories(
  absolutePath: string,
  allowedDirs: string[],
): boolean {
  if (typeof absolutePath !== 'string' || !Array.isArray(allowedDirs)) return false;
  if (!absolutePath || allowedDirs.length === 0) return false;
  if (absolutePath.includes('\x00')) return false;

  let normalizedPath: string;
  try {
    normalizedPath = path.resolve(path.normalize(absolutePath));
  } catch {
    return false;
  }

  if (!path.isAbsolute(normalizedPath)) {
    throw new Error('Path must be absolute after normalization');
  }

  return allowedDirs.some((dir) => {
    if (typeof dir !== 'string' || !dir) return false;
    if (dir.includes('\x00')) return false;

    let normalizedDir: string;
    try {
      normalizedDir = path.resolve(path.normalize(dir));
    } catch {
      return false;
    }

    if (!path.isAbsolute(normalizedDir)) {
      throw new Error('Allowed directories must be absolute paths after normalization');
    }

    if (normalizedPath === normalizedDir) return true;

    if (normalizedDir === path.sep) {
      return normalizedPath.startsWith(path.sep);
    }

    if (path.sep === '\\' && normalizedDir.match(/^[A-Za-z]:\\?$/)) {
      const dirDrive = normalizedDir.charAt(0).toLowerCase();
      const pathDrive = normalizedPath.charAt(0).toLowerCase();
      return pathDrive === dirDrive && normalizedPath.startsWith(normalizedDir.replace(/\\?$/, '\\'));
    }

    return normalizedPath.startsWith(normalizedDir + path.sep);
  });
}

// ---------------------------------------------------------------------------
// Allowed directories — mutable global, updated at startup and via MCP Roots
// ---------------------------------------------------------------------------

let allowedDirectories: string[] = [];

// ---------------------------------------------------------------------------
// Path validation function (ported from lib.js)
// ---------------------------------------------------------------------------

async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, allowedDirectories);
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`,
    );
  }

  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    if (!isPathWithinAllowedDirectories(normalizedReal, allowedDirectories)) {
      throw new Error(
        `Access denied - symlink target outside allowed directories: ${realPath} not in ${allowedDirectories.join(', ')}`,
      );
    }
    return realPath;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      const parentDir = path.dirname(absolute);
      try {
        const realParentPath = await fs.realpath(parentDir);
        const normalizedParent = normalizePath(realParentPath);
        if (!isPathWithinAllowedDirectories(normalizedParent, allowedDirectories)) {
          throw new Error(
            `Access denied - parent directory outside allowed directories: ${realParentPath} not in ${allowedDirectories.join(', ')}`,
          );
        }
        return absolute;
      } catch {
        throw new Error(`Parent directory does not exist: ${parentDir}`);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (ported from lib.js)
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i < 0 || i === 0) return `${bytes} ${units[0]}`;
  const unitIndex = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(
  originalContent: string,
  newContent: string,
  filepath = 'file',
): string {
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);
  return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}

// ---------------------------------------------------------------------------
// File operations (ported from lib.js)
// ---------------------------------------------------------------------------

async function getFileStats(filePath: string) {
  const stats = await fs.stat(filePath);
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

async function readFileContent(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
  return await fs.readFile(filePath, encoding);
}

async function writeFileContent(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, filePath);
      } catch (renameError) {
        try {
          await fs.unlink(tempPath);
        } catch {
          // ignore cleanup error
        }
        throw renameError;
      }
    } else {
      throw error;
    }
  }
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{ oldText: string; newText: string }>,
  dryRun = false,
): Promise<string> {
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
  let modifiedContent = content;

  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j] ?? '';
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        const originalIndent = (contentLines[i] ?? '').match(/^\s*/)?.[0] ?? '';
        const newLines = normalizeLineEndings(edit.newText).split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] ?? '';
          const newIndent = line.match(/^\s*/)?.[0] ?? '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });
        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, modifiedContent, 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // ignore cleanup error
      }
      throw error;
    }
  }

  return formattedDiff;
}

async function tailFile(filePath: string, numLines: number): Promise<string> {
  const CHUNK_SIZE = 1024;
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;
  if (fileSize === 0) return '';

  const fileHandle = await fs.open(filePath, 'r');
  try {
    const lines: string[] = [];
    let position = fileSize;
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let linesFound = 0;
    let remainingText = '';

    while (position > 0 && linesFound < numLines) {
      const size = Math.min(CHUNK_SIZE, position);
      position -= size;
      const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
      if (!bytesRead) break;

      const readData = chunk.slice(0, bytesRead).toString('utf-8');
      const chunkText = readData + remainingText;
      const chunkLines = normalizeLineEndings(chunkText).split('\n');

      if (position > 0) {
        remainingText = chunkLines[0] ?? '';
        chunkLines.shift();
      }

      for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
        lines.unshift(chunkLines[i] ?? '');
        linesFound++;
      }
    }

    return lines.join('\n');
  } finally {
    await fileHandle.close();
  }
}

async function headFile(filePath: string, numLines: number): Promise<string> {
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const lines: string[] = [];
    let buffer = '';
    let bytesRead = 0;
    const chunk = Buffer.alloc(1024);

    while (lines.length < numLines) {
      const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      buffer += chunk.slice(0, result.bytesRead).toString('utf-8');

      const newLineIndex = buffer.lastIndexOf('\n');
      if (newLineIndex !== -1) {
        const completeLines = buffer.slice(0, newLineIndex).split('\n');
        buffer = buffer.slice(newLineIndex + 1);
        for (const line of completeLines) {
          lines.push(line);
          if (lines.length >= numLines) break;
        }
      }
    }

    if (buffer.length > 0 && lines.length < numLines) {
      lines.push(buffer);
    }

    return lines.join('\n');
  } finally {
    await fileHandle.close();
  }
}

async function searchFilesWithValidation(
  rootPath: string,
  pattern: string,
  allowedDirs: string[],
  options: { excludePatterns?: string[] } = {},
): Promise<string[]> {
  const { excludePatterns = [] } = options;
  const results: string[] = [];

  async function search(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      try {
        await validatePath(fullPath);
        const relativePath = path.relative(rootPath, fullPath);
        const shouldExclude = excludePatterns.some((ep) =>
          minimatch(relativePath, ep, { dot: true }),
        );
        if (shouldExclude) continue;

        if (minimatch(relativePath, pattern, { dot: true })) {
          results.push(fullPath);
        }
        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

// ---------------------------------------------------------------------------
// Roots utilities (ported from roots-utils.js)
// ---------------------------------------------------------------------------

async function parseRootUri(rootUri: string): Promise<string | null> {
  try {
    const rawPath = rootUri.startsWith('file://') ? rootUri.slice(7) : rootUri;
    const expandedPath =
      rawPath.startsWith('~/') || rawPath === '~'
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;
    const absolutePath = path.resolve(expandedPath);
    const resolvedPath = await fs.realpath(absolutePath);
    return normalizePath(resolvedPath);
  } catch {
    return null;
  }
}

async function getValidRootDirectories(
  requestedRoots: Array<{ uri: string; name?: string }>,
): Promise<string[]> {
  const validatedDirectories: string[] = [];
  for (const requestedRoot of requestedRoots) {
    const resolvedPath = await parseRootUri(requestedRoot.uri);
    if (!resolvedPath) {
      console.error(`Skipping invalid path or inaccessible: ${requestedRoot.uri}`);
      continue;
    }
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isDirectory()) {
        validatedDirectories.push(resolvedPath);
      } else {
        console.error(`Skipping non-directory root: ${resolvedPath}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Skipping invalid directory: ${resolvedPath} due to error: ${msg}`);
    }
  }
  return validatedDirectories;
}

// ---------------------------------------------------------------------------
// Read media file as base64
// ---------------------------------------------------------------------------

async function readFileAsBase64Stream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString('base64'));
    });
    stream.on('error', (err: Error) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// Startup — parse args and resolve allowed directories
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: mcp-server-filesystem [allowed-directory] [additional-directories...]');
  console.error('Note: Allowed directories can be provided via:');
  console.error('  1. Command-line arguments (shown above)');
  console.error('  2. MCP roots protocol (if client supports it)');
  console.error('At least one directory must be provided by EITHER method for the server to operate.');
}

allowedDirectories = await Promise.all(
  args.map(async (dir) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    try {
      const resolved = await fs.realpath(absolute);
      return normalizePath(resolved);
    } catch {
      return normalizePath(absolute);
    }
  }),
);

// Validate directories exist and are accessible
await Promise.all(
  allowedDirectories.map(async (dir) => {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
      process.exit(1);
    }
  }),
);

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'secure-filesystem-server',
  version: '0.2.0',
});

// ---------------------------------------------------------------------------
// Tool: read_file (deprecated alias) and read_text_file
// ---------------------------------------------------------------------------

const readTextFileHandler = async (args: { path: string; tail?: number; head?: number }) => {
  const validPath = await validatePath(args.path);
  if (args.head && args.tail) {
    throw new Error('Cannot specify both head and tail parameters simultaneously');
  }
  let content: string;
  if (args.tail) {
    content = await tailFile(validPath, args.tail);
  } else if (args.head) {
    content = await headFile(validPath, args.head);
  } else {
    content = await readFileContent(validPath);
  }
  return {
    content: [{ type: 'text' as const, text: content }],
    structuredContent: { content },
  };
};

server.registerTool(
  'read_file',
  {
    title: 'Read File (Deprecated)',
    description: 'Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.',
    inputSchema: {
      path: z.string(),
      tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
      head: z.number().optional().describe('If provided, returns only the first N lines of the file'),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  readTextFileHandler,
);

server.registerTool(
  'read_text_file',
  {
    title: 'Read Text File',
    description:
      'Read the complete contents of a file from the file system as text. ' +
      'Handles various text encodings and provides detailed error messages ' +
      'if the file cannot be read. Use this tool when you need to examine ' +
      'the contents of a single file. Use the \'head\' parameter to read only ' +
      'the first N lines of a file, or the \'tail\' parameter to read only ' +
      'the last N lines of a file. Operates on the file as text regardless of extension. ' +
      'Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
      tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
      head: z.number().optional().describe('If provided, returns only the first N lines of the file'),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  readTextFileHandler,
);

// ---------------------------------------------------------------------------
// Tool: read_media_file
// ---------------------------------------------------------------------------

server.registerTool(
  'read_media_file',
  {
    title: 'Read Media File',
    description:
      'Read an image or audio file. Returns the base64 encoded data and MIME type. ' +
      'Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
    },
    outputSchema: {
      content: z.array(
        z.object({
          type: z.enum(['image', 'audio', 'blob']),
          data: z.string(),
          mimeType: z.string(),
        }),
      ),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string }) => {
    const validPath = await validatePath(args.path);
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
    };
    const mimeType = mimeTypes[extension] ?? 'application/octet-stream';
    const data = await readFileAsBase64Stream(validPath);
    if (mimeType.startsWith('image/')) {
      const contentItem = { type: 'image' as const, data, mimeType };
      return {
        content: [contentItem],
        structuredContent: { content: [contentItem] },
      };
    } else if (mimeType.startsWith('audio/')) {
      const contentItem = { type: 'audio' as const, data, mimeType };
      return {
        content: [contentItem],
        structuredContent: { content: [contentItem] },
      };
    } else {
      // Fallback for other binary types — return as blob resource
      const text = `[Binary file: ${path.basename(validPath)}, mimeType: ${mimeType}, size: ${data.length} base64 chars]`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { content: text },
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: read_multiple_files
// ---------------------------------------------------------------------------

server.registerTool(
  'read_multiple_files',
  {
    title: 'Read Multiple Files',
    description:
      'Read the contents of multiple files simultaneously. This is more ' +
      'efficient than reading files one by one when you need to analyze ' +
      'or compare multiple files. Each file\'s content is returned with its ' +
      'path as a reference. Failed reads for individual files won\'t stop ' +
      'the entire operation. Only works within allowed directories.',
    inputSchema: {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories.',
        ),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { paths: string[] }) => {
    const results = await Promise.all(
      args.paths.map(async (filePath) => {
        try {
          const validPath = await validatePath(filePath);
          const content = await readFileContent(validPath);
          return `${filePath}:\n${content}\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return `${filePath}: Error - ${errorMessage}`;
        }
      }),
    );
    const text = results.join('\n---\n');
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: write_file
// ---------------------------------------------------------------------------

server.registerTool(
  'write_file',
  {
    title: 'Write File',
    description:
      'Create a new file or completely overwrite an existing file with new content. ' +
      'Use with caution as it will overwrite existing files without warning. ' +
      'Handles text content with proper encoding. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
      content: z.string(),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
  },
  async (args: { path: string; content: string }) => {
    const validPath = await validatePath(args.path);
    await writeFileContent(validPath, args.content);
    const text = `Successfully wrote to ${args.path}`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: edit_file
// ---------------------------------------------------------------------------

server.registerTool(
  'edit_file',
  {
    title: 'Edit File',
    description:
      'Make line-based edits to a text file. Each edit replaces exact line sequences ' +
      'with new content. Returns a git-style diff showing the changes made. ' +
      'Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
      edits: z.array(
        z.object({
          oldText: z.string().describe('Text to search for - must match exactly'),
          newText: z.string().describe('Text to replace with'),
        }),
      ),
      dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format'),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  },
  async (args: { path: string; edits: Array<{ oldText: string; newText: string }>; dryRun: boolean }) => {
    const validPath = await validatePath(args.path);
    const result = await applyFileEdits(validPath, args.edits, args.dryRun);
    return {
      content: [{ type: 'text' as const, text: result }],
      structuredContent: { content: result },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: create_directory
// ---------------------------------------------------------------------------

server.registerTool(
  'create_directory',
  {
    title: 'Create Directory',
    description:
      'Create a new directory or ensure a directory exists. Can create multiple ' +
      'nested directories in one operation. If the directory already exists, ' +
      'this operation will succeed silently. Perfect for setting up directory ' +
      'structures for projects or ensuring required paths exist. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
  },
  async (args: { path: string }) => {
    const validPath = await validatePath(args.path);
    await fs.mkdir(validPath, { recursive: true });
    const text = `Successfully created directory ${args.path}`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_directory
// ---------------------------------------------------------------------------

server.registerTool(
  'list_directory',
  {
    title: 'List Directory',
    description:
      'Get a detailed listing of all files and directories in a specified path. ' +
      'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
      'prefixes. This tool is essential for understanding directory structure and ' +
      'finding specific files within a directory. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string }) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const formatted = entries
      .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
      .join('\n');
    return {
      content: [{ type: 'text' as const, text: formatted }],
      structuredContent: { content: formatted },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_directory_with_sizes
// ---------------------------------------------------------------------------

server.registerTool(
  'list_directory_with_sizes',
  {
    title: 'List Directory with Sizes',
    description:
      'Get a detailed listing of all files and directories in a specified path, including sizes. ' +
      'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
      'prefixes. This tool is useful for understanding directory structure and ' +
      'finding specific files within a directory. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
      sortBy: z.enum(['name', 'size']).optional().default('name').describe('Sort entries by name or size'),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string; sortBy?: 'name' | 'size' }) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });

    const detailedEntries = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(validPath, entry.name);
        try {
          const stats = await fs.stat(entryPath);
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            mtime: stats.mtime,
          };
        } catch {
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: 0,
            mtime: new Date(0),
          };
        }
      }),
    );

    const sortedEntries = [...detailedEntries].sort((a, b) => {
      if (args.sortBy === 'size') return b.size - a.size;
      return a.name.localeCompare(b.name);
    });

    const formattedEntries = sortedEntries.map(
      (entry) =>
        `${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name.padEnd(30)} ${entry.isDirectory ? '' : formatSize(entry.size).padStart(10)}`,
    );

    const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
    const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
    const totalSize = detailedEntries.reduce(
      (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
      0,
    );
    const summary = [
      '',
      `Total: ${totalFiles} files, ${totalDirs} directories`,
      `Combined size: ${formatSize(totalSize)}`,
    ];

    const text = [...formattedEntries, ...summary].join('\n');
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: directory_tree
// ---------------------------------------------------------------------------

server.registerTool(
  'directory_tree',
  {
    title: 'Directory Tree',
    description:
      'Get a recursive tree view of files and directories as a JSON structure. ' +
      "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
      'Files have no children array, while directories always have a children array (which may be empty). ' +
      'The output is formatted with 2-space indentation for readability. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
      excludePatterns: z.array(z.string()).optional().default([]),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string; excludePatterns: string[] }) => {
    const rootPath = args.path;

    type TreeEntry = {
      name: string;
      type: 'file' | 'directory';
      children?: TreeEntry[];
    };

    async function buildTree(
      currentPath: string,
      excludePatterns: string[] = [],
    ): Promise<TreeEntry[]> {
      const validPath = await validatePath(currentPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const result: TreeEntry[] = [];

      for (const entry of entries) {
        const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
        const shouldExclude = excludePatterns.some((pattern) => {
          if (pattern.includes('*')) {
            return minimatch(relativePath, pattern, { dot: true });
          }
          return (
            minimatch(relativePath, pattern, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}/**`, { dot: true })
          );
        });
        if (shouldExclude) continue;

        const entryData: TreeEntry = {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        };

        if (entry.isDirectory()) {
          const subPath = path.join(currentPath, entry.name);
          entryData.children = await buildTree(subPath, excludePatterns);
        }

        result.push(entryData);
      }

      return result;
    }

    const treeData = await buildTree(rootPath, args.excludePatterns);
    const text = JSON.stringify(treeData, null, 2);
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: move_file
// ---------------------------------------------------------------------------

server.registerTool(
  'move_file',
  {
    title: 'Move File',
    description:
      'Move or rename files and directories. Can move files between directories ' +
      'and rename them in a single operation. If the destination exists, the ' +
      'operation will fail. Works across different directories and can be used ' +
      'for simple renaming within the same directory. Both source and destination must be within allowed directories.',
    inputSchema: {
      source: z.string(),
      destination: z.string(),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  },
  async (args: { source: string; destination: string }) => {
    const validSourcePath = await validatePath(args.source);
    const validDestPath = await validatePath(args.destination);
    // Honor the documented contract: fail rather than silently overwrite an
    // existing destination (fs.rename/POSIX rename replaces it by default).
    const destExists = await fs.access(validDestPath).then(() => true, () => false);
    if (destExists) {
      throw new Error(`Destination already exists: ${args.destination}`);
    }
    await fs.rename(validSourcePath, validDestPath);
    const text = `Successfully moved ${args.source} to ${args.destination}`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: search_files
// ---------------------------------------------------------------------------

server.registerTool(
  'search_files',
  {
    title: 'Search Files',
    description:
      'Recursively search for files and directories matching a pattern. ' +
      "The patterns should be glob-style patterns that match paths relative to the working directory. " +
      "Use pattern like '*.ext' to match files in current directory, and '**/*.ext' to match files in all subdirectories. " +
      'Returns full paths to all matching items. Great for finding files when you don\'t know their exact location. ' +
      'Only searches within allowed directories.',
    inputSchema: {
      path: z.string(),
      pattern: z.string(),
      excludePatterns: z.array(z.string()).optional().default([]),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string; pattern: string; excludePatterns: string[] }) => {
    const validPath = await validatePath(args.path);
    const results = await searchFilesWithValidation(validPath, args.pattern, allowedDirectories, {
      excludePatterns: args.excludePatterns,
    });
    const text = results.length > 0 ? results.join('\n') : 'No matches found';
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_file_info
// ---------------------------------------------------------------------------

server.registerTool(
  'get_file_info',
  {
    title: 'Get File Info',
    description:
      'Retrieve detailed metadata about a file or directory. Returns comprehensive ' +
      'information including size, creation time, last modified time, permissions, ' +
      'and type. This tool is perfect for understanding file characteristics ' +
      'without reading the actual content. Only works within allowed directories.',
    inputSchema: {
      path: z.string(),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: { path: string }) => {
    const validPath = await validatePath(args.path);
    const info = await getFileStats(validPath);
    const text = Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_allowed_directories
// ---------------------------------------------------------------------------

server.registerTool(
  'list_allowed_directories',
  {
    title: 'List Allowed Directories',
    description:
      'Returns the list of directories that this server is allowed to access. ' +
      'Subdirectories within these allowed directories are also accessible. ' +
      'Use this to understand which directories and their nested paths are available ' +
      'before trying to access files.',
    inputSchema: {},
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const text = `Allowed directories:\n${allowedDirectories.join('\n')}`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: delete_file (NEW — trash-based soft delete)
//
// Moves the file to <first-allowed-dir>/.trash/<ISO8601>_<original-name>
// The ISO8601 timestamp uses hyphens instead of colons to be filesystem-safe.
// Example: 2026-03-24T12-00-00-000Z_report.pdf
// ---------------------------------------------------------------------------

server.registerTool(
  'delete_file',
  {
    title: 'Delete File',
    description:
      'Delete a file by moving it to a trash folder (.trash) inside the allowed directory. ' +
      'The file can be recovered from the trash folder if needed. ' +
      'Only works within allowed directories.',
    inputSchema: {
      path: z.string().describe('Path to the file to delete'),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  },
  async (args: { path: string }) => {
    const validSourcePath = await validatePath(args.path);

    const trashBase = allowedDirectories.length > 0 ? (allowedDirectories[0] as string) : os.homedir();
    const trashDir = path.join(trashBase, '.trash');
    await fs.mkdir(trashDir, { recursive: true });

    // ISO 8601 timestamp with colons replaced by hyphens for filesystem safety
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashPath = path.join(trashDir, `${timestamp}_${path.basename(validSourcePath)}`);

    await fs.rename(validSourcePath, trashPath);

    const text = `Deleted (moved to trash): ${args.path}\nTrash location: ${trashPath}`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { content: text },
    };
  },
);

// ---------------------------------------------------------------------------
// MCP Roots — dynamic allowed directory updates
// ---------------------------------------------------------------------------

async function updateAllowedDirectoriesFromRoots(
  requestedRoots: Array<{ uri: string; name?: string }>,
): Promise<void> {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length > 0) {
    allowedDirectories = [...validatedRootDirs];
    console.error(
      `Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`,
    );
  } else {
    console.error('No valid root directories provided by client');
  }
}

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  try {
    const response = await server.server.listRoots();
    if (response && 'roots' in response) {
      await updateAllowedDirectoriesFromRoots(
        response.roots as Array<{ uri: string; name?: string }>,
      );
    }
  } catch (error) {
    console.error(
      'Failed to request roots from client:',
      error instanceof Error ? error.message : String(error),
    );
  }
});

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    try {
      const response = await server.server.listRoots();
      if (response && 'roots' in response) {
        await updateAllowedDirectoriesFromRoots(
          response.roots as Array<{ uri: string; name?: string }>,
        );
      } else {
        console.error('Client returned no roots set, keeping current settings');
      }
    } catch (error) {
      console.error(
        'Failed to request initial roots from client:',
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    if (allowedDirectories.length > 0) {
      console.error(
        'Client does not support MCP Roots, using allowed directories set from server args:',
        allowedDirectories,
      );
    } else {
      throw new Error(
        'Server cannot operate: No allowed directories available. ' +
          'Server was started without command-line directories and client either does not support ' +
          'MCP roots protocol or provided empty roots. Please either: ' +
          '1) Start server with directory arguments, or ' +
          '2) Use a client that supports MCP roots protocol and provides valid root directories.',
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Secure MCP Filesystem Server running on stdio');
  if (allowedDirectories.length === 0) {
    console.error(
      'Started without allowed directories - waiting for client to provide roots via MCP protocol',
    );
  }
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
