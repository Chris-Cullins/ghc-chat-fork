/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, suite, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { FileQueueWebviewProvider } from '../../webview/fileQueueWebviewProvider';
import { FileQueueItemStatus, IFileQueueService } from '../../../../platform/fileQueue/common/fileQueueService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';

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
	};
});

vi.mock('vscode', () => mockVSCode);

// Mock implementations
class MockExtensionContext implements IVSCodeExtensionContext {
	readonly _serviceBrand: undefined;
	extensionUri = { fsPath: '/mock/extension' };

	// Minimal implementation for testing
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
	private state = {
		isProcessing: false,
		isPaused: false,
		processedCount: 0,
		totalCount: 0,
		failedCount: 0,
		errors: []
	};

	// Mock event emitters
	private _onQueueChanged = new MockEventEmitter();
	private _onProcessingStateChanged = new MockEventEmitter();
	private _onItemProcessed = new MockEventEmitter();
	private _onError = new MockEventEmitter();

	get onQueueChanged() { return this._onQueueChanged.event; }
	get onProcessingStateChanged() { return this._onProcessingStateChanged.event; }
	get onItemProcessed() { return this._onItemProcessed.event; }
	get onError() { return this._onError.event; }

	async addToQueue(filePath: string, priority?: QueueItemPriority, operation?: string): Promise<string> {
		const id = `mock-${Date.now()}`;
		this.items.set(id, {
			id,
			filePath,
			fileName: filePath.split('/').pop(),
			priority: priority || QueueItemPriority.Normal,
			status: FileQueueItemStatus.Pending,
			addedAt: new Date(),
			operation
		});
		this.state.totalCount = this.items.size;
		this._onQueueChanged.fire({ type: 'added', itemIds: [id], timestamp: new Date() });
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

	async removeFromQueue(itemId: string): Promise<void> {
		this.items.delete(itemId);
		this.state.totalCount = this.items.size;
		this._onQueueChanged.fire({ type: 'removed', itemIds: [itemId], timestamp: new Date() });
	}

	async validateFile(filePath: string): Promise<{ valid: boolean; reason?: string }> {
		if (filePath.includes('invalid')) {
			return { valid: false, reason: 'Mock validation failure' };
		}
		return { valid: true };
	}

	getQueueState() { return this.state; }
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

	// Mock implementations for required methods
	async removeMultipleFromQueue(itemIds: string[]): Promise<void> { }
	async reorderQueue(itemIds: string[]): Promise<void> { }
	async clearQueue(includeProcessing?: boolean): Promise<void> { this.items.clear(); }
	async startProcessing(options?: any): Promise<void> { this.state.isProcessing = true; }
	async pauseProcessing(): Promise<void> { this.state.isPaused = true; }
	async resumeProcessing(): Promise<void> { this.state.isPaused = false; }
	async stopProcessing(force?: boolean): Promise<void> { this.state.isProcessing = false; }
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

class MockEventEmitter {
	private listeners: Array<(event: any) => void> = [];

	get event() {
		return (listener: (event: any) => void) => {
			this.listeners.push(listener);
			return { dispose: () => { } };
		};
	}

	fire(event: any) {
		this.listeners.forEach(listener => listener(event));
	}
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

// Mock webview and webview view
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

suite('FileQueueWebviewProvider Tests', () => {
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

	suite('Webview Initialization', () => {
		test('should initialize webview with correct options', () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			expect(mockWebviewView.webview.options.enableScripts).toBe(true);
			expect(mockWebviewView.webview.options.localResourceRoots).toContain(mockExtensionContext.extensionUri);
		});

		test('should generate HTML with required elements', () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			expect(mockWebviewView.webview.html).toContain('File Processing Queue');
			expect(mockWebviewView.webview.html).toContain('add-files-btn');
			expect(mockWebviewView.webview.html).toContain('queue-list');
			expect(mockWebviewView.webview.html).toContain('drag-overlay');
		});

		test('should include security CSP headers', () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			expect(mockWebviewView.webview.html).toContain('Content-Security-Policy');
			expect(mockWebviewView.webview.html).toContain("script-src 'nonce-");
		});
	});

	suite('Add File Button Functionality', () => {
		test('should handle showFilePicker message', async () => {
			const mockFiles = [
				{ fsPath: '/test/file1.ts' },
				{ fsPath: '/test/file2.ts' }
			];

			mockVSCode.window.showOpenDialog.mockResolvedValue(mockFiles);
			mockVSCode.window.showQuickPick
				.mockResolvedValueOnce({ label: 'Normal', value: QueueItemPriority.Normal })
				.mockResolvedValueOnce({ label: 'Analyze', value: 'analyze' });

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			// Simulate the showFilePicker message
			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'showFilePicker', data: {} });

			expect(mockVSCode.window.showOpenDialog).toHaveBeenCalledWith({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select files to add to processing queue'
			});

			expect(mockVSCode.window.showQuickPick).toHaveBeenCalledTimes(2);
			expect(mockVSCode.window.showInformationMessage).toHaveBeenCalled();
		});

		test('should handle file picker cancellation gracefully', async () => {
			mockVSCode.window.showOpenDialog.mockResolvedValue(undefined);

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'showFilePicker', data: {} });

			expect(mockVSCode.window.showQuickPick).not.toHaveBeenCalled();
			expect(mockVSCode.window.showInformationMessage).not.toHaveBeenCalled();
		});

		test('should handle priority selection cancellation', async () => {
			const mockFiles = [{ fsPath: '/test/file1.ts' }];

			mockVSCode.window.showOpenDialog.mockResolvedValue(mockFiles);
			mockVSCode.window.showQuickPick.mockResolvedValue(undefined);

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'showFilePicker', data: {} });

			expect(mockVSCode.window.showInformationMessage).not.toHaveBeenCalled();
		});

		test('should show available operations in picker', async () => {
			const mockFiles = [{ fsPath: '/test/file1.ts' }];

			mockVSCode.window.showOpenDialog.mockResolvedValue(mockFiles);
			mockVSCode.window.showQuickPick
				.mockResolvedValueOnce({ label: 'Normal', value: QueueItemPriority.Normal })
				.mockResolvedValueOnce({ label: 'Analyze', value: 'analyze' });

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'showFilePicker', data: {} });

			// Check that operation picker was called with available operations
			const operationCall = mockVSCode.window.showQuickPick.mock.calls[1];
			expect(operationCall[0]).toContainEqual({ label: 'Analyze', value: 'analyze' });
			expect(operationCall[0]).toContainEqual({ label: 'Format', value: 'format' });
			expect(operationCall[0]).toContainEqual({ label: 'Refactor', value: 'refactor' });
		});
	});

	suite('Message Handling', () => {
		test('should handle addFile message with validation', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addFile',
				data: {
					filePath: '/test/valid-file.ts',
					priority: QueueItemPriority.High,
					operation: 'analyze'
				}
			});

			expect(mockLogService.debug).toHaveBeenCalledWith(
				expect.stringContaining('Added file to queue: /test/valid-file.ts')
			);
		});

		test('should reject invalid files in addFile message', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addFile',
				data: {
					filePath: '/test/invalid-file.ts',
					priority: QueueItemPriority.Normal
				}
			});

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: expect.stringContaining('Cannot add file to queue: Mock validation failure'),
					severity: 'warning'
				})
			});
		});

		test('should handle addMultipleFiles message', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: ['/test/file1.ts', '/test/file2.ts'],
					priority: QueueItemPriority.Normal,
					operation: 'analyze'
				}
			});

			expect(mockLogService.debug).toHaveBeenCalledWith(
				expect.stringContaining('Added 2 files to queue via drag and drop')
			);

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'info',
				data: expect.objectContaining({
					message: 'Successfully added 2 files to queue',
					severity: 'info'
				})
			});
		});

		test('should handle empty file paths in addMultipleFiles', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addMultipleFiles',
				data: {
					filePaths: [],
					priority: QueueItemPriority.Normal
				}
			});

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: 'No valid file paths provided',
					severity: 'warning'
				})
			});
		});

		test('should handle processing control messages', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];

			await messageHandler({ type: 'startProcessing' });
			expect(mockFileQueueService.getQueueState().isProcessing).toBe(true);

			await messageHandler({ type: 'pauseProcessing' });
			expect(mockFileQueueService.getQueueState().isPaused).toBe(true);

			await messageHandler({ type: 'resumeProcessing' });
			expect(mockFileQueueService.getQueueState().isPaused).toBe(false);

			await messageHandler({ type: 'stopProcessing' });
			expect(mockFileQueueService.getQueueState().isProcessing).toBe(false);
		});

		test('should handle unknown message types gracefully', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'unknownMessageType', data: {} });

			expect(mockLogService.warn).toHaveBeenCalledWith('Unknown message type: unknownMessageType');
		});
	});

	suite('Queue State Updates', () => {
		test('should update webview when queue changes', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			// Clear any initial messages
			mockWebviewView.webview.postMessage.mockClear();

			// Add a file to trigger queue change
			await mockFileQueueService.addToQueue('/test/file.ts', QueueItemPriority.Normal);

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'updateQueue',
				data: expect.objectContaining({
					state: expect.any(Object),
					items: expect.any(Array),
					statistics: expect.any(Object)
				})
			});
		});

		test('should handle queue service errors', () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			mockWebviewView.webview.postMessage.mockClear();

			// Simulate an error from the service
			const mockError = {
				message: 'Test error',
				severity: 'error' as const,
				timestamp: new Date()
			};

			mockFileQueueService._onError.fire(mockError);

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: 'Test error',
					severity: 'error',
					timestamp: expect.any(String)
				})
			});
		});
	});

	suite('Error Handling', () => {
		test('should handle errors in message processing', async () => {
			// Mock the service to throw an error
			mockFileQueueService.addToQueue = vi.fn().mockRejectedValue(new Error('Service error'));

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addFile',
				data: {
					filePath: '/test/file.ts',
					priority: QueueItemPriority.Normal
				}
			});

			expect(mockLogService.error).toHaveBeenCalledWith('Failed to add file to queue:', expect.any(Error));
			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: expect.stringContaining('Failed to add file to queue: Service error'),
					severity: 'error'
				})
			});
		});

		test('should handle missing data in messages', async () => {
			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({
				type: 'addFile',
				data: {} // Missing filePath
			});

			expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
				type: 'error',
				data: expect.objectContaining({
					message: 'No file path provided',
					severity: 'warning'
				})
			});
		});
	});

	suite('File Picker Integration', () => {
		test('should handle file picker errors gracefully', async () => {
			mockVSCode.window.showOpenDialog.mockRejectedValue(new Error('File picker error'));

			provider.resolveWebviewView(mockWebviewView, {}, new vscode.CancellationToken());

			const messageHandler = mockWebviewView.webview.onDidReceiveMessage.mock.calls[0][0];
			await messageHandler({ type: 'showFilePicker', data: {} });

			expect(mockLogService.error).toHaveBeenCalledWith('Failed to show file picker:', expect.any(Error));
			expect(mockVSCode.window.showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining('Failed to add files to queue: File picker error')
			);
		});
	});
});