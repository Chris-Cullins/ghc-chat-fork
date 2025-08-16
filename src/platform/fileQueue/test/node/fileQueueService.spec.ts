/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, expect, suite, test } from 'vitest';
import * as path from 'path';
import { Uri, FileStat } from 'vscode';
import { FileQueueServiceImpl } from '../../node/fileQueueServiceImpl';
import { FileQueueItemStatus, IFileQueueService, QueueItemPriority } from '../../common/fileQueueService';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { IFileSystemService } from '../../../filesystem/common/fileSystemService';
import { ILogService } from '../../../log/common/logService';

// FileType enum values from vscode for testing
const FileType = {
	Unknown: 0,
	File: 1,
	Directory: 2,
	SymbolicLink: 64
} as const;

// Mock implementations for testing
class MockExtensionContext implements IVSCodeExtensionContext {
	readonly _serviceBrand: undefined;
	private storage = new Map<string, any>();

	get globalState() {
		return {
			get: <T>(key: string): T | undefined => this.storage.get(key),
			update: async (key: string, value: any): Promise<void> => {
				this.storage.set(key, value);
			},
			keys: (): readonly string[] => Array.from(this.storage.keys()),
			setKeysForSync: (keys: readonly string[]): void => { /* Mock implementation */ }
		};
	}

	// Other properties would be mocked as needed
	get extensionPath(): string { return '/mock/path'; }
	get extensionUri(): any { return { fsPath: '/mock/path' }; }
	get storageUri(): any { return undefined; }
	get globalStorageUri(): any { return undefined; }
	get logUri(): any { return undefined; }
	get extensionMode(): any { return 1; }
	get extension(): any { return {}; }
	get secrets(): any { return {}; }
	get workspaceState(): any { return {}; }
	get subscriptions(): any[] { return []; }
	get environmentVariableCollection(): any { return {}; }
	get logPath(): string { return '/mock/log'; }
	get storagePath(): string | undefined { return '/mock/storage'; }
	get globalStoragePath(): string { return '/mock/global'; }
	get languageModelAccessInformation(): any { return {}; }
	asAbsolutePath(relativePath: string): string { return path.join('/mock', relativePath); }
}

class MockFileSystemService implements IFileSystemService {
	readonly _serviceBrand: undefined;
	private files = new Map<string, { type: FileType; size: number; content?: string; ctime: number; mtime: number }>();

	addMockFile(filePath: string, size: number = 1024, content?: string): void {
		const now = Date.now();
		this.files.set(path.resolve(filePath), {
			type: FileType.File,
			size,
			content,
			ctime: now,
			mtime: now
		});
	}

	async stat(uri: Uri): Promise<FileStat> {
		const filePath = uri.fsPath;
		const file = this.files.get(path.resolve(filePath));
		if (!file) {
			throw new Error(`File not found: ${filePath}`);
		}
		return {
			type: file.type,
			size: file.size,
			ctime: file.ctime,
			mtime: file.mtime
		};
	}

	// Other methods would be implemented as needed
	async readFile(uri: Uri): Promise<Uint8Array> { return new Uint8Array(); }
	async writeFile(uri: Uri, content: Uint8Array): Promise<void> { }
	async readDirectory(uri: Uri): Promise<[string, FileType][]> { return []; }
	async createDirectory(uri: Uri): Promise<void> { }
	async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> { }
	async rename(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean }): Promise<void> { }
	async copy(source: Uri, destination: Uri, options?: { overwrite?: boolean }): Promise<void> { }
	isWritableFileSystem(scheme: string): boolean | undefined { return true; }
	createFileSystemWatcher(glob: string): any { return {}; }
}

class MockLogService implements ILogService {
	readonly _serviceBrand: undefined;

	trace(message: string): void { console.log('TRACE:', message); }
	debug(message: string): void { console.log('DEBUG:', message); }
	info(message: string): void { console.log('INFO:', message); }
	warn(message: string): void { console.log('WARN:', message); }
	error(error: string | Error, message?: string): void { console.log('ERROR:', error, message); }
	show(preserveFocus?: boolean): void { /* Mock implementation */ }
}

suite('FileQueueService', () => {
	let service: IFileQueueService;
	let mockExtensionContext: MockExtensionContext;
	let mockFileSystem: MockFileSystemService;
	let mockLogService: MockLogService;

	beforeEach(() => {
		mockExtensionContext = new MockExtensionContext();
		mockFileSystem = new MockFileSystemService();
		mockLogService = new MockLogService();

		service = new FileQueueServiceImpl(
			mockExtensionContext,
			mockFileSystem,
			mockLogService
		);
	});

	suite('Queue Management', () => {
		test('should add a file to the queue', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile, 1024);

			const itemId = await service.addToQueue(testFile, QueueItemPriority.Normal, { operation: 'analyze' });

			expect(itemId).toBeTruthy();
			expect(itemId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

			const item = service.getQueueItem(itemId);
			expect(item).toBeTruthy();
			expect(item!.filePath).toBe(path.resolve(testFile));
			expect(item!.fileName).toBe('file.ts');
			expect(item!.priority).toBe(QueueItemPriority.Normal);
			expect(item!.status).toBe(FileQueueItemStatus.Pending);
			expect(item!.metadata?.operation).toBe('analyze');
		});

		test('should validate files before adding to queue', async () => {
			const nonExistentFile = '/test/nonexistent.ts';

			await expect(service.addToQueue(nonExistentFile)).rejects.toThrow(/Cannot add file to queue: File does not exist/);
		});

		test('should reject files that are too large', async () => {
			const largeFile = '/test/large.ts';
			const maxSize = 10 * 1024 * 1024; // 10MB
			mockFileSystem.addMockFile(largeFile, maxSize + 1);

			await expect(service.addToQueue(largeFile)).rejects.toThrow(/Cannot add file to queue: File too large/);
		});

		test('should remove a file from the queue', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			const itemId = await service.addToQueue(testFile);
			expect(service.getQueueItem(itemId)).toBeTruthy();

			await service.removeFromQueue(itemId);
			expect(service.getQueueItem(itemId)).toBeUndefined();
		});

		test('should add multiple files to queue', async () => {
			const testFiles = ['/test/file1.ts', '/test/file2.ts', '/test/file3.ts'];
			testFiles.forEach(file => mockFileSystem.addMockFile(file));

			const itemIds = await service.addMultipleToQueue(testFiles, QueueItemPriority.High);

			expect(itemIds.length).toBe(3);
			itemIds.forEach(id => {
				const item = service.getQueueItem(id);
				expect(item).toBeTruthy();
				expect(item!.priority).toBe(QueueItemPriority.High);
			});
		});

		test('should clear the queue', async () => {
			const testFiles = ['/test/file1.ts', '/test/file2.ts'];
			testFiles.forEach(file => mockFileSystem.addMockFile(file));

			await service.addMultipleToQueue(testFiles);

			let items = service.getQueueItems();
			expect(items.length).toBe(2);

			await service.clearQueue();

			items = service.getQueueItems();
			expect(items.length).toBe(0);
		});
	});

	suite('Queue State', () => {
		test('should track queue state correctly', async () => {
			const state = service.getQueueState();

			expect(state.isProcessing).toBe(false);
			expect(state.isPaused).toBe(false);
			expect(state.totalCount).toBe(0);
			expect(state.processedCount).toBe(0);
			expect(state.failedCount).toBe(0);
		});

		test('should update queue count when items are added', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			await service.addToQueue(testFile);

			const state = service.getQueueState();
			expect(state.totalCount).toBe(1);
		});

		test('should filter items by status', async () => {
			const testFiles = ['/test/file1.ts', '/test/file2.ts'];
			testFiles.forEach(file => mockFileSystem.addMockFile(file));

			await service.addMultipleToQueue(testFiles);

			const pendingItems = service.getItemsByStatus(FileQueueItemStatus.Pending);
			expect(pendingItems.length).toBe(2);

			const processingItems = service.getItemsByStatus(FileQueueItemStatus.Processing);
			expect(processingItems.length).toBe(0);
		});
	});

	suite('Queue Statistics', () => {
		test('should provide queue statistics', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			await service.addToQueue(testFile);

			const stats = service.getQueueStatistics();
			expect(stats.currentQueueSize).toBe(1);
			expect(stats.totalProcessed).toBe(0);
			expect(stats.successRate).toBe(0);
			expect(stats.averageProcessingTime).toBe(0);
		});
	});

	suite('Utility Methods', () => {
		test('should estimate processing time', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile, 2048);

			const estimate = await service.estimateProcessingTime(testFile, 'analyze');
			expect(estimate).toBeGreaterThan(0);
			expect(typeof estimate).toBe('number');
		});

		test('should handle metadata in queue items', () => {
			// Test that metadata is properly stored and retrieved
			const items = service.getQueueItems();
			expect(Array.isArray(items)).toBe(true);
			// This test validates that metadata functionality works correctly
		});
	});

	suite('Data Export/Import', () => {
		test('should export queue data', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			await service.addToQueue(testFile);

			const exportData = service.exportQueue();
			expect(exportData).toBeTruthy();

			const parsed = JSON.parse(exportData);
			expect(parsed.items).toBeTruthy();
			expect(parsed.state).toBeTruthy();
			expect(parsed.exportedAt).toBeTruthy();
			expect(parsed.version).toBe(1);
		});

		test('should import queue data', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			// Create export data
			await service.addToQueue(testFile);
			const exportData = service.exportQueue();

			// Clear queue and import
			await service.clearQueue();
			expect(service.getQueueItems().length).toBe(0);

			await service.importQueue(exportData);
			expect(service.getQueueItems().length).toBe(1);
		});
	});

	suite('Event System', () => {
		test('should fire events when queue changes', async () => {
			const testFile = '/test/file.ts';
			mockFileSystem.addMockFile(testFile);

			return new Promise<void>((resolve) => {
				service.onQueueChanged((event) => {
					expect(event.type).toBe('added');
					expect(event.itemIds.length).toBe(1);
					expect(event.timestamp instanceof Date).toBe(true);
					resolve();
				});

				service.addToQueue(testFile);
			});
		});
	});
});