/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { FileQueueWebviewProvider } from '../../webview/fileQueueWebviewProvider';
import { FileQueueServiceImpl } from '../../../../platform/fileQueue/node/fileQueueServiceImpl';
import { FileQueueItemStatus, IFileQueueService, QueueItemPriority } from '../../../../platform/fileQueue/common/fileQueueService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';

// Mock VSCode
const mockVSCode = vi.hoisted(() => {
	return {
		Uri: {
			joinPath: vi.fn((base, ...paths) => ({
				fsPath: `${base.fsPath}/${paths.join('/')}`,
				scheme: 'file',
				authority: '',
				path: `${base.fsPath}/${paths.join('/')}`,
				query: '',
				fragment: ''
			})),
			file: vi.fn((path) => ({
				fsPath: path,
				scheme: 'file',
				authority: '',
				path: path,
				query: '',
				fragment: ''
			}))
		},
		window: {
			showOpenDialog: vi.fn(),
			showQuickPick: vi.fn(),
			showInformationMessage: vi.fn(),
			showErrorMessage: vi.fn(),
		},
		CancellationToken: class {
			isCancellationRequested = false;
			onCancellationRequested = vi.fn();
		},
	};
});

vi.mock('vscode', () => mockVSCode);

// Integration test mocks that closely simulate real services
class IntegrationMockExtensionContext implements IVSCodeExtensionContext {
	readonly _serviceBrand: undefined;
	private storage = new Map<string, any>();

	extensionUri = { fsPath: '/test/extension', scheme: 'file', authority: '', path: '/test/extension', query: '', fragment: '' };

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

	// Required properties
	get extensionPath(): string { return '/test/extension'; }
	get storageUri(): any { return undefined; }
	get globalStorageUri(): any { return undefined; }
	get logUri(): any { return undefined; }
	get extensionMode(): any { return 1; }
	get extension(): any { return {}; }
	get secrets(): any { return {}; }
	get workspaceState(): any { return {}; }
	get subscriptions(): any[] { return []; }
	get environmentVariableCollection(): any { return {}; }
	get logPath(): string { return '/test/log'; }
	get storagePath(): string | undefined { return '/test/storage'; }
	get globalStoragePath(): string { return '/test/global'; }
	get languageModelAccessInformation(): any { return {}; }
	asAbsolutePath(relativePath: string): string { return `/test/extension/${relativePath}`; }
}

class IntegrationMockFileSystemService implements IFileSystemService {
	readonly _serviceBrand: undefined;
	private files = new Map<string, { type: number; size: number; ctime: number; mtime: number }>();

	constructor() {
		// Pre-populate with some test files
		this.addFile('/test/file1.ts', 1024);
		this.addFile('/test/file2.js', 2048);
		this.addFile('/test/large-file.ts', 15 * 1024 * 1024); // 15MB
	}

	addFile(path: string, size: number) {
		const now = Date.now();
		this.files.set(path, { type: 1, size, ctime: now, mtime: now }); // FileType.File = 1
	}

	async stat(uri: any): Promise<any> {
		const file = this.files.get(uri.fsPath);
		if (!file) {
			throw new Error(`File not found: ${uri.fsPath}`);
		}
		return file;
	}

	// Other required methods (minimal implementation)
	async readFile(uri: any): Promise<Uint8Array> { return new Uint8Array(); }
	async writeFile(uri: any, content: Uint8Array): Promise<void> { }
	async readDirectory(uri: any): Promise<[string, number][]> { return []; }
	async createDirectory(uri: any): Promise<void> { }
	async delete(uri: any, options?: any): Promise<void> { }
	async rename(oldUri: any, newUri: any, options?: any): Promise<void> { }
	async copy(source: any, destination: any, options?: any): Promise<void> { }
	isWritableFileSystem(scheme: string): boolean | undefined { return true; }
	createFileSystemWatcher(glob: string): any { return {}; }
}

class IntegrationMockLogService implements ILogService {
	readonly _serviceBrand: undefined;

	trace = vi.fn();
	debug = vi.fn();
	info = vi.fn();
	warn = vi.fn();
	error = vi.fn();
	show = vi.fn();
}

// Create a mock webview that can simulate real webview behavior
const createMockWebviewView = () => {
	const messageHandlers: Array<(message: any) => void> = [];

	const mockWebview = {
		html: '',
		options: {},
		asWebviewUri: vi.fn((uri) => ({
			toString: () => `vscode-webview://${uri.fsPath}`,
			fsPath: uri.fsPath
		})),
		postMessage: vi.fn(),
		onDidReceiveMessage: vi.fn((handler) => {
			messageHandlers.push(handler);
			return { dispose: vi.fn() };
		}),
		cspSource: 'vscode-webview:',

		// Helper method to simulate sending a message from webview to extension
		simulateMessage: (message: any) => {
			messageHandlers.forEach(handler => handler(message));
		}
	};

	return {
		webview: mockWebview,
		onDidDispose: vi.fn(),
		onDidChangeVisibility: vi.fn(),
		visible: true,
		title: 'File Queue',
		description: undefined,
		badge: undefined,
		show: vi.fn(),
	};
};

suite('FileQueue Integration Tests', () => {
	let webviewProvider: FileQueueWebviewProvider;
	let fileQueueService: IFileQueueService;
	let mockExtensionContext: IntegrationMockExtensionContext;
	let mockFileSystemService: IntegrationMockFileSystemService;
	let mockLogService: IntegrationMockLogService;
	let mockWebviewView: any;

	beforeEach(async () => {
		mockExtensionContext = new IntegrationMockExtensionContext();
		mockFileSystemService = new IntegrationMockFileSystemService();
		mockLogService = new IntegrationMockLogService();

		// Create a real file queue service for integration testing
		fileQueueService = new FileQueueServiceImpl(
			mockExtensionContext,
			mockFileSystemService,
			mockLogService
		);

		// Initialize the service
		await fileQueueService.loadState();

		webviewProvider = new FileQueueWebviewProvider(
			mockExtensionContext,
			fileQueueService,
			mockLogService
		);

		mockWebviewView = createMockWebviewView();
	});

	suite('End-to-End File Addition Workflow', () => {
		test('should complete full Add File button workflow', async () => {
			// Setup: Initialize the webview
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Mock user selections for file picker workflow
			mockVSCode.window.showOpenDialog.mockResolvedValue([
				{ fsPath: '/test/file1.ts' },
				{ fsPath: '/test/file2.js' }
			]);

			mockVSCode.window.showQuickPick
				.mockResolvedValueOnce({ label: 'High', value: QueueItemPriority.High }) // Priority selection
				.mockResolvedValueOnce({ label: 'Analyze', value: 'analyze' }); // Operation selection

			// Act: Simulate user clicking Add Files button
			mockWebviewView.webview.simulateMessage({
				type: 'showFilePicker',
				data: {}
			});

			// Wait for async operations to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			// Assert: Verify the workflow completed successfully
			expect(mockVSCode.window.showOpenDialog).toHaveBeenCalledWith({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select files to add to processing queue'
			});

			expect(mockVSCode.window.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining('Added 2 files to queue with high priority for analyze')
			);

			// Verify files were actually added to the service
			const items = fileQueueService.getQueueItems();
			expect(items.length).toBe(2);
			expect(items.every(item => item.priority === QueueItemPriority.High)).toBe(true);
			expect(items.every(item => item.operation === 'analyze')).toBe(true);
		});

		test('should handle drag and drop workflow end-to-end', async () => {
			// Setup: Initialize the webview
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Clear any initial webview messages
			mockWebviewView.webview.postMessage.mockClear();

			// Act: Simulate drag and drop of multiple files
			mockWebviewView.webview.simulateMessage({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.js'],
					priority: QueueItemPriority.Normal,
					operation: 'format'
				}
			});

			// Wait for async operations
			await new Promise(resolve => setTimeout(resolve, 50));

			// Assert: Verify files were added and webview was updated
			const items = fileQueueService.getQueueItems();
			expect(items.length).toBe(2);
			expect(items.every(item => item.priority === QueueItemPriority.Normal)).toBe(true);
			expect(items.every(item => item.operation === 'format')).toBe(true);

			// Check that success message was sent to webview
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'info',
				data: expect.objectContaining({
					message: 'Successfully added 2 files to queue',
					severity: 'info'
				})
			});

			// Check that webview was updated with new queue state
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'updateQueue',
				data: expect.objectContaining({
					state: expect.any(Object),
					items: expect.arrayContaining([
						expect.objectContaining({ filePath: expect.stringContaining('file1.ts') }),
						expect.objectContaining({ filePath: expect.stringContaining('file2.js') })
					]),
					statistics: expect.any(Object)
				})
			});
		});
	});

	suite('Queue Management Integration', () => {
		test('should handle complete queue lifecycle', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Add files
			mockWebviewView.webview.simulateMessage({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.js'],
					priority: QueueItemPriority.Normal
				}
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify files are added
			let items = fileQueueService.getQueueItems();
			expect(items.length).toBe(2);

			// Remove one file
			const itemToRemove = items[0];
			mockWebviewView.webview.simulateMessage({
				type: 'removeFile',
				data: { itemId: itemToRemove.id }
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify file was removed
			items = fileQueueService.getQueueItems();
			expect(items.length).toBe(1);
			expect(items.find(item => item.id === itemToRemove.id)).toBeUndefined();

			// Clear entire queue
			mockWebviewView.webview.simulateMessage({
				type: 'clearQueue',
				data: { includeProcessing: false }
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify queue is empty
			items = fileQueueService.getQueueItems();
			expect(items.length).toBe(0);
		});

		test('should handle processing control workflow', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Add files first
			mockWebviewView.webview.simulateMessage({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.js'],
					priority: QueueItemPriority.Normal
				}
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Start processing
			mockWebviewView.webview.simulateMessage({
				type: 'startProcessing',
				data: {
					options: {
						maxConcurrency: 1,
						continueOnError: true
					}
				}
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			let state = fileQueueService.getQueueState();
			expect(state.isProcessing).toBe(true);

			// Pause processing
			mockWebviewView.webview.simulateMessage({
				type: 'pauseProcessing'
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			state = fileQueueService.getQueueState();
			expect(state.isPaused).toBe(true);

			// Resume processing
			mockWebviewView.webview.simulateMessage({
				type: 'resumeProcessing'
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			state = fileQueueService.getQueueState();
			expect(state.isPaused).toBe(false);

			// Stop processing
			mockWebviewView.webview.simulateMessage({
				type: 'stopProcessing'
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			state = fileQueueService.getQueueState();
			expect(state.isProcessing).toBe(false);
		});
	});

	suite('Error Handling Integration', () => {
		test('should handle file validation errors end-to-end', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Clear any initial messages
			mockWebviewView.webview.postMessage.mockClear();

			// Try to add a non-existent file
			mockWebviewView.webview.simulateMessage({
				type: 'addFile',
				data: {
					filePath: '/nonexistent/file.ts',
					priority: QueueItemPriority.Normal
				}
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify error was sent to webview
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: expect.stringContaining('Cannot add file to queue'),
					severity: 'warning'
				})
			});

			// Verify file was not added to queue
			const items = fileQueueService.getQueueItems();
			expect(items.length).toBe(0);
		});

		test('should handle large file rejection', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			mockWebviewView.webview.postMessage.mockClear();

			// Try to add a file that's too large
			mockWebviewView.webview.simulateMessage({
				type: 'addFile',
				data: {
					filePath: '/test/large-file.ts', // 15MB file from our mock
					priority: QueueItemPriority.Normal
				}
			});

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify error was sent
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: expect.stringContaining('Cannot add file to queue'),
					severity: 'warning'
				})
			});
		});
	});

	suite('Real-time Updates Integration', () => {
		test('should receive real-time updates when queue changes', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Clear initial messages
			mockWebviewView.webview.postMessage.mockClear();

			// Add file directly through service (simulating external change)
			await fileQueueService.addToQueue('/test/file1.ts', QueueItemPriority.Normal, 'analyze');

			// Wait for event propagation
			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify webview received update
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'updateQueue',
				data: expect.objectContaining({
					state: expect.objectContaining({
						totalCount: 1
					}),
					items: expect.arrayContaining([
						expect.objectContaining({
							filePath: expect.stringContaining('file1.ts'),
							operation: 'analyze'
						})
					])
				})
			});
		});

		test('should update statistics in real-time', async () => {
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Add multiple files
			await fileQueueService.addMultipleToQueue([
				'/test/file1.ts',
				'/test/file2.js'
			], QueueItemPriority.Normal);

			await new Promise(resolve => setTimeout(resolve, 50));

			// Check that statistics are updated
			const lastUpdateCall = mockWebviewView.webview.postMessage.mock.calls
				.find(call => call[0].type === 'updateQueue');

			expect(lastUpdateCall).toBeTruthy();
			expect(lastUpdateCall[0].data.statistics).toEqual(
				expect.objectContaining({
					currentQueueSize: 2,
					totalProcessed: expect.any(Number),
					successRate: expect.any(Number),
					averageProcessingTime: expect.any(Number),
					throughput: expect.any(Number)
				})
			);
		});
	});

	suite('Persistence Integration', () => {
		test('should persist queue state across webview reloads', async () => {
			// First session: Add files
			webviewProvider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			await fileQueueService.addMultipleToQueue([
				'/test/file1.ts',
				'/test/file2.js'
			], QueueItemPriority.High, 'analyze');

			// Verify files are in queue
			let items = fileQueueService.getQueueItems();
			expect(items.length).toBe(2);

			// Simulate webview reload by creating new provider with same services
			const newWebviewProvider = new FileQueueWebviewProvider(
				mockExtensionContext,
				fileQueueService,
				mockLogService
			);

			const newMockWebviewView = createMockWebviewView();
			newWebviewProvider.resolveWebviewView(newMockWebviewView, {}, new mockVSCode.CancellationToken());

			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify the new webview receives the persisted state
			expect(newMockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'updateQueue',
				data: expect.objectContaining({
					items: expect.arrayContaining([
						expect.objectContaining({ filePath: expect.stringContaining('file1.ts') }),
						expect.objectContaining({ filePath: expect.stringContaining('file2.js') })
					])
				})
			});
		});
	});
});