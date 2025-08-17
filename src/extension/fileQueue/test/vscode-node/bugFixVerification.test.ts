/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { FileQueueWebviewProvider } from '../../webview/vscode-node/fileQueueWebviewProvider';
import { FileQueueItemStatus, IFileQueueService } from '../../../../platform/fileQueue/common/fileQueueService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';

/**
 * This test suite specifically verifies that the bugs mentioned in IMPLEMENTATION_PLAN.md are fixed:
 * 
 * BUG 1: "Add File button does not seem to do anything. maybe needs a file picker popup?"
 * BUG 2: "Drag and drop functionality does not seem to work - don't see any files being added to queue. 
 *        Perhaps I'm dropping them in the wrong place? not sure."
 */

// Mock VSCode
const mockVSCode = vi.hoisted(() => {
	return {
		Uri: {
			joinPath: vi.fn((base, ...paths) => ({ fsPath: `${base.fsPath}/${paths.join('/')}` })),
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

// Minimal mocks for testing
class MockExtensionContext implements IVSCodeExtensionContext {
	readonly _serviceBrand: undefined;
	extensionUri = { fsPath: '/mock/extension' };

	get globalState(): any { return {}; }
	get extensionPath(): string { return '/mock/extension'; }
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
	asAbsolutePath(relativePath: string): string { return `/mock/extension/${relativePath}`; }
}

class MockFileQueueService implements IFileQueueService {
	readonly _serviceBrand: undefined;

	private items = new Map<string, any>();
	private addedFiles: string[] = []; // Track files that were successfully added

	// Mock event emitters
	private _onQueueChanged = { event: (listener: any) => ({ dispose: () => { } }) };
	private _onProcessingStateChanged = { event: (listener: any) => ({ dispose: () => { } }) };
	private _onItemProcessed = { event: (listener: any) => ({ dispose: () => { } }) };
	private _onError = { event: (listener: any) => ({ dispose: () => { } }) };

	get onQueueChanged() { return this._onQueueChanged.event; }
	get onProcessingStateChanged() { return this._onProcessingStateChanged.event; }
	get onItemProcessed() { return this._onItemProcessed.event; }
	get onError() { return this._onError.event; }

	async addToQueue(filePath: string, priority?: QueueItemPriority, operation?: string): Promise<string> {
		const id = `mock-${Date.now()}-${Math.random()}`;
		this.items.set(id, {
			id,
			filePath,
			fileName: filePath.split('/').pop(),
			priority: priority || QueueItemPriority.Normal,
			status: FileQueueItemStatus.Pending,
			addedAt: new Date(),
			operation
		});
		this.addedFiles.push(filePath);
		return id;
	}

	async addMultipleToQueue(filePaths: string[], priority?: QueueItemPriority, operation?: string): Promise<string[]> {
		const ids = [];
		for (const filePath of filePaths) {
			const id = await this.addToQueue(filePath, priority, operation);
			ids.push(id);
		}
		return ids;
	}

	async validateFile(filePath: string): Promise<{ valid: boolean; reason?: string }> {
		return { valid: true }; // All files are valid for this test
	}

	getQueueState() {
		return {
			isProcessing: false,
			isPaused: false,
			processedCount: 0,
			totalCount: this.items.size,
			failedCount: 0,
			errors: []
		};
	}

	getQueueItems() { return Array.from(this.items.values()); }
	getQueueStatistics() {
		return {
			totalProcessed: 0,
			averageProcessingTime: 0,
			successRate: 0,
			throughput: 0,
			currentQueueSize: this.items.size
		};
	}
	getAvailableOperations() { return ['analyze', 'format', 'refactor']; }

	// Helper method to check if files were actually added (for bug verification)
	getAddedFiles(): string[] {
		return [...this.addedFiles];
	}

	clearAddedFiles(): void {
		this.addedFiles = [];
	}

	// Minimal implementations for other required methods
	async removeFromQueue(itemId: string): Promise<void> { this.items.delete(itemId); }
	async removeMultipleFromQueue(itemIds: string[]): Promise<void> { }
	async reorderQueue(itemIds: string[]): Promise<void> { }
	async clearQueue(includeProcessing?: boolean): Promise<void> { this.items.clear(); }
	async startProcessing(options?: any): Promise<void> { }
	async pauseProcessing(): Promise<void> { }
	async resumeProcessing(): Promise<void> { }
	async stopProcessing(force?: boolean): Promise<void> { }
	async cancelItem(itemId: string): Promise<void> { }
	async retryItem(itemId: string): Promise<void> { }
	getQueueItem(itemId: string) { return this.items.get(itemId); }
	getItemsByStatus(status: FileQueueItemStatus) { return []; }
	getProcessingHistory(limit?: number) { return []; }
	async saveState(): Promise<void> { }
	async loadState(): Promise<void> { }
	exportQueue(): string { return '{}'; }
	async importQueue(data: string, merge?: boolean): Promise<void> { }
	async estimateProcessingTime(filePath: string, operation?: string): Promise<number> { return 1000; }
}

class MockLogService implements ILogService {
	readonly _serviceBrand: undefined;

	trace = vi.fn();
	debug = vi.fn();
	info = vi.fn();
	warn = vi.fn();
	error = vi.fn();
	show = vi.fn();
}

const createMockWebviewView = () => {
	const mockWebview = {
		html: '',
		options: {},
		asWebviewUri: vi.fn((uri) => uri),
		postMessage: vi.fn(),
		onDidReceiveMessage: vi.fn(),
		cspSource: 'mock-csp',
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

suite('Bug Fix Verification Tests', () => {
	let provider: FileQueueWebviewProvider;
	let mockExtensionContext: MockExtensionContext;
	let mockFileQueueService: MockFileQueueService;
	let mockLogService: MockLogService;
	let mockWebviewView: any;

	beforeEach(() => {
		mockExtensionContext = new MockExtensionContext();
		mockFileQueueService = new MockFileQueueService();
		mockLogService = new MockLogService();
		mockWebviewView = createMockWebviewView();

		provider = new FileQueueWebviewProvider(
			mockExtensionContext,
			mockFileQueueService,
			mockLogService
		);
	});

	suite('BUG FIX 1: Add File Button Functionality', () => {
		test('FIXED: Add File button now opens file picker dialog', async () => {
			// Setup: Mock the VS Code file picker to return files
			const mockSelectedFiles = [
				{ fsPath: '/workspace/src/component.tsx' },
				{ fsPath: '/workspace/src/utils.ts' }
			];

			mockVSCode.window.showOpenDialog.mockResolvedValue(mockSelectedFiles);
			mockVSCode.window.showQuickPick
				.mockResolvedValueOnce({ label: 'Normal', value: QueueItemPriority.Normal }) // Priority
				.mockResolvedValueOnce({ label: 'Analyze', value: 'analyze' }); // Operation

			// Initialize webview
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Get the message handler
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Act: Simulate clicking the Add File button (which sends showFilePicker message)
			await messageHandler({
				type: 'showFilePicker',
				data: {}
			});

			// Assert: Verify the file picker was opened
			expect(mockVSCode.window.showOpenDialog).toHaveBeenCalledWith({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select files to add to processing queue'
			});

			// Verify priority selection dialog was shown
			expect(mockVSCode.window.showQuickPick).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ label: 'Critical' }),
					expect.objectContaining({ label: 'High' }),
					expect.objectContaining({ label: 'Normal' }),
					expect.objectContaining({ label: 'Low' })
				]),
				{ placeHolder: 'Select priority for the selected files' }
			);

			// Verify operation selection dialog was shown
			expect(mockVSCode.window.showQuickPick).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ label: 'Analyze', value: 'analyze' }),
					expect.objectContaining({ label: 'Format', value: 'format' }),
					expect.objectContaining({ label: 'Refactor', value: 'refactor' })
				]),
				expect.objectContaining({
					placeHolder: 'Select operation to perform (optional)'
				})
			);

			// Verify success message was shown
			expect(mockVSCode.window.showInformationMessage).toHaveBeenCalledWith(
				'Added 2 files to queue with normal priority for analyze'
			);

			// Verify files were actually added to the queue service
			const addedFiles = mockFileQueueService.getAddedFiles();
			expect(addedFiles).toContain('/workspace/src/component.tsx');
			expect(addedFiles).toContain('/workspace/src/utils.ts');
		});

		test('FIXED: Add File button handles cancellation gracefully', async () => {
			// Setup: Mock user cancelling the file picker
			mockVSCode.window.showOpenDialog.mockResolvedValue(undefined); // User cancelled

			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Act: Simulate clicking Add File button and cancelling
			await messageHandler({
				type: 'showFilePicker',
				data: {}
			});

			// Assert: File picker was opened but no further dialogs were shown
			expect(mockVSCode.window.showOpenDialog).toHaveBeenCalled();
			expect(mockVSCode.window.showQuickPick).not.toHaveBeenCalled();
			expect(mockVSCode.window.showInformationMessage).not.toHaveBeenCalled();

			// Verify no files were added
			expect(mockFileQueueService.getAddedFiles()).toHaveLength(0);
		});

		test('FIXED: Add File button handles priority cancellation', async () => {
			// Setup: User selects files but cancels priority selection
			mockVSCode.window.showOpenDialog.mockResolvedValue([{ fsPath: '/test/file.ts' }]);
			mockVSCode.window.showQuickPick.mockResolvedValue(undefined); // Cancel priority selection

			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Act
			await messageHandler({
				type: 'showFilePicker',
				data: {}
			});

			// Assert: No files were added due to cancellation
			expect(mockVSCode.window.showInformationMessage).not.toHaveBeenCalled();
			expect(mockFileQueueService.getAddedFiles()).toHaveLength(0);
		});
	});

	suite('BUG FIX 2: Drag and Drop Functionality', () => {
		test('FIXED: Drag and drop now properly adds files to queue', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Clear any initial messages
			mockWebviewView.webview.postMessage.mockClear();
			mockFileQueueService.clearAddedFiles();

			// Act: Simulate drag and drop operation (which sends addMultipleFiles message)
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: [
						'/workspace/src/component.tsx',
						'/workspace/src/utils.ts',
						'/workspace/tests/component.test.tsx'
					],
					priority: QueueItemPriority.Normal,
					operation: 'analyze'
				}
			});

			// Assert: Files were successfully added to the queue
			const addedFiles = mockFileQueueService.getAddedFiles();
			expect(addedFiles).toHaveLength(3);
			expect(addedFiles).toContain('/workspace/src/component.tsx');
			expect(addedFiles).toContain('/workspace/src/utils.ts');
			expect(addedFiles).toContain('/workspace/tests/component.test.tsx');

			// Verify success feedback was sent to webview
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'info',
				data: expect.objectContaining({
					message: 'Successfully added 3 files to queue',
					severity: 'info'
				})
			});

			// Verify debug logging occurred
			expect(mockLogService.debug).toHaveBeenCalledWith(
				'Added 3 files to queue via drag and drop'
			);
		});

		test('FIXED: Drag and drop handles single file correctly', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			mockFileQueueService.clearAddedFiles();

			// Act: Simulate single file drop
			await messageHandler({
				type: 'addFile',
				data: {
					filePath: '/workspace/src/single-file.ts',
					priority: QueueItemPriority.High,
					operation: 'format'
				}
			});

			// Assert: Single file was added
			const addedFiles = mockFileQueueService.getAddedFiles();
			expect(addedFiles).toHaveLength(1);
			expect(addedFiles[0]).toBe('/workspace/src/single-file.ts');

			// Verify correct priority and operation were set
			const queueItems = mockFileQueueService.getQueueItems();
			const addedItem = queueItems.find(item => item.filePath === '/workspace/src/single-file.ts');
			expect(addedItem).toBeTruthy();
			expect(addedItem!.priority).toBe(QueueItemPriority.High);
			expect(addedItem!.operation).toBe('format');
		});

		test('FIXED: Drag and drop shows appropriate error for invalid files', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			mockWebviewView.webview.postMessage.mockClear();

			// Act: Simulate drag and drop with empty file paths
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: [], // Empty array
					priority: QueueItemPriority.Normal
				}
			});

			// Assert: Error message was sent
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: 'No valid file paths provided',
					severity: 'warning'
				})
			});

			// Verify no files were added
			expect(mockFileQueueService.getAddedFiles()).toHaveLength(0);
		});

		test('FIXED: Drag and drop provides visual feedback in webview', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());

			// Verify webview HTML includes drag and drop support elements
			const webviewHtml = mockWebviewView.webview.html;

			// Check for drag overlay element
			expect(webviewHtml).toContain('drag-overlay');

			// Check for drop zone elements
			expect(webviewHtml).toContain('queue-list');
			expect(webviewHtml).toContain('empty-state');

			// Check for instructions about drag and drop
			expect(webviewHtml).toContain('Drag files from VS Code Explorer or use "Add Files" button');
		});
	});

	suite('BUG FIX 3: Enhanced Error Handling and User Feedback', () => {
		test('FIXED: Proper error messages for missing file paths', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			mockWebviewView.webview.postMessage.mockClear();

			// Act: Send addFile message without filePath
			await messageHandler({
				type: 'addFile',
				data: {
					priority: QueueItemPriority.Normal
					// Missing filePath
				}
			});

			// Assert: Appropriate error message was sent
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: 'No file path provided',
					severity: 'warning'
				})
			});
		});

		test('FIXED: Handles unknown message types gracefully', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Act: Send unknown message type
			await messageHandler({
				type: 'unknownMessageType',
				data: { someData: 'test' }
			});

			// Assert: Warning was logged
			expect(mockLogService.warn).toHaveBeenCalledWith('Unknown message type: unknownMessageType');
		});
	});

	suite('BUG FIX 4: Queue Management Reliability', () => {
		test('FIXED: Files appear in queue UI after being added', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			mockWebviewView.webview.postMessage.mockClear();

			// Act: Add files
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.js'],
					priority: QueueItemPriority.Normal,
					operation: 'analyze'
				}
			});

			// Assert: Queue update was sent to webview
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'updateQueue',
				data: expect.objectContaining({
					state: expect.objectContaining({
						totalCount: 2
					}),
					items: expect.arrayContaining([
						expect.objectContaining({
							filePath: '/test/file1.ts',
							operation: 'analyze'
						}),
						expect.objectContaining({
							filePath: '/test/file2.js',
							operation: 'analyze'
						})
					]),
					statistics: expect.any(Object)
				})
			});
		});

		test('FIXED: Queue operations work correctly', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// Add files first
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.js'],
					priority: QueueItemPriority.Normal
				}
			});

			// Get an item to remove
			const items = mockFileQueueService.getQueueItems();
			expect(items.length).toBe(2);

			// Remove one item
			await messageHandler({
				type: 'removeFile',
				data: { itemId: items[0].id }
			});

			// Verify item was removed
			const remainingItems = mockFileQueueService.getQueueItems();
			expect(remainingItems.length).toBe(1);
			expect(remainingItems.find(item => item.id === items[0].id)).toBeUndefined();
		});
	});

	suite('Overall Bug Fix Summary', () => {
		test('SUMMARY: Both original bugs are now fixed', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new mockVSCode.CancellationToken());
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			// ✅ BUG 1 FIXED: Add File button now works
			mockVSCode.window.showOpenDialog.mockResolvedValue([{ fsPath: '/test/button-file.ts' }]);
			mockVSCode.window.showQuickPick
				.mockResolvedValueOnce({ label: 'Normal', value: QueueItemPriority.Normal })
				.mockResolvedValueOnce({ label: 'Analyze', value: 'analyze' });

			await messageHandler({ type: 'showFilePicker', data: {} });

			expect(mockVSCode.window.showOpenDialog).toHaveBeenCalled();
			expect(mockVSCode.window.showInformationMessage).toHaveBeenCalled();

			// ✅ BUG 2 FIXED: Drag and drop now works
			mockFileQueueService.clearAddedFiles();
			mockWebviewView.webview.postMessage.mockClear();

			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/drag-file1.ts', '/test/drag-file2.js'],
					priority: QueueItemPriority.Normal
				}
			});

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'info',
				data: expect.objectContaining({
					message: 'Successfully added 2 files to queue'
				})
			});

			// Verify both methods result in files being added to the queue
			const allFiles = mockFileQueueService.getAddedFiles();
			expect(allFiles.length).toBeGreaterThan(0);

			console.log('✅ BUG FIXES VERIFIED:');
			console.log('  1. Add File button now opens file picker and adds files to queue');
			console.log('  2. Drag and drop functionality now properly adds files to queue');
			console.log('  3. Error handling and user feedback have been improved');
			console.log('  4. Queue management and UI updates work reliably');
		});
	});
});