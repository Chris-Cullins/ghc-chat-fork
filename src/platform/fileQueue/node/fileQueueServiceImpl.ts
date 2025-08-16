/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CancellationToken, CancellationTokenSource, Uri } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import {
	FileQueueItem,
	FileQueueItemStatus,
	IFileQueueService,
	ItemProcessedEvent,
	ProcessingResult,
	ProcessingStateEvent,
	QueueChangeEvent,
	QueueError,
	QueueItemPriority,
	QueueProcessingOptions,
	QueueState
} from '../common/fileQueueService';

interface QueueStorage {
	items: FileQueueItem[];
	state: QueueState;
	version: number;
}

export class FileQueueServiceImpl extends Disposable implements IFileQueueService {
	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_KEY = 'github.copilot.fileQueue';
	private static readonly MAX_HISTORY_SIZE = 100;
	private static readonly DEFAULT_TIMEOUT = 60000; // 1 minute
	private static readonly DEFAULT_RETRY_DELAY = 5000; // 5 seconds

	private readonly _items = new Map<string, FileQueueItem>();
	private readonly _processingHistory: FileQueueItem[] = [];
	private _queueState: QueueState;
	private _currentCancellation?: CancellationTokenSource;
	private _processingOptions: QueueProcessingOptions = {};
	private _isInitialized = false;

	// Events
	private readonly _onQueueChanged = this._register(new Emitter<QueueChangeEvent>());
	readonly onQueueChanged: Event<QueueChangeEvent> = this._onQueueChanged.event;

	private readonly _onProcessingStateChanged = this._register(new Emitter<ProcessingStateEvent>());
	readonly onProcessingStateChanged: Event<ProcessingStateEvent> = this._onProcessingStateChanged.event;

	private readonly _onItemProcessed = this._register(new Emitter<ItemProcessedEvent>());
	readonly onItemProcessed: Event<ItemProcessedEvent> = this._onItemProcessed.event;

	private readonly _onError = this._register(new Emitter<QueueError>());
	readonly onError: Event<QueueError> = this._onError.event;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._queueState = {
			isProcessing: false,
			isPaused: false,
			processedCount: 0,
			totalCount: 0,
			failedCount: 0,
			errors: [],
			throughput: 0,
			averageProcessingTime: 0
		};

		// Initialize the service
		void this._initialize();
	}

	private async _initialize(): Promise<void> {
		try {
			await this.loadState();
			this._isInitialized = true;
			this.logService.debug('FileQueueService initialized successfully');
		} catch (error) {
			this.logService.error('Failed to initialize FileQueueService:', error);
			this._handleError('initialization', 'Failed to initialize queue service', 'critical', false);
		}
	}

	// Queue Management Methods

	async addToQueue(
		filePath: string,
		priority: QueueItemPriority = QueueItemPriority.Normal,
		metadata?: Record<string, any>
	): Promise<string> {
		await this._ensureInitialized();

		// Validate file
		const validation = await this.validateFile(filePath);
		if (!validation.valid) {
			throw new Error(`Cannot add file to queue: ${validation.reason}`);
		}

		const item: FileQueueItem = {
			id: randomUUID(),
			filePath: path.resolve(filePath),
			fileName: path.basename(filePath),
			priority,
			status: FileQueueItemStatus.Pending,
			addedAt: new Date(),
			metadata: { ...metadata }
		};

		// Estimate processing time
		try {
			item.estimatedDuration = await this.estimateProcessingTime(filePath);
		} catch (error) {
			this.logService.warn(`Failed to estimate processing time for file: ${filePath}`);
		}

		this._items.set(item.id, item);
		this._updateQueueState();

		await this.saveState();

		this._onQueueChanged.fire({
			type: 'added',
			itemIds: [item.id],
			timestamp: new Date()
		});

		this.logService.debug(`Added file to queue: ${filePath} (ID: ${item.id})`);
		return item.id;
	}

	async addMultipleToQueue(
		filePaths: string[],
		priority: QueueItemPriority = QueueItemPriority.Normal
	): Promise<string[]> {
		const itemIds: string[] = [];

		for (const filePath of filePaths) {
			try {
				const itemId = await this.addToQueue(filePath, priority);
				itemIds.push(itemId);
			} catch (error) {
				this.logService.error(`Failed to add file to queue: ${filePath}`, error);
				this._handleError('add_file', `Failed to add file: ${filePath}`, 'error', true);
			}
		}

		return itemIds;
	}

	async removeFromQueue(itemId: string): Promise<void> {
		await this._ensureInitialized();

		const item = this._items.get(itemId);
		if (!item) {
			throw new Error(`Queue item not found: ${itemId}`);
		}

		// Cancel if currently processing
		if (item.status === FileQueueItemStatus.Processing) {
			await this.cancelItem(itemId);
		}

		this._items.delete(itemId);
		this._updateQueueState();
		await this.saveState();

		this._onQueueChanged.fire({
			type: 'removed',
			itemIds: [itemId],
			timestamp: new Date()
		});

		this.logService.debug(`Removed item from queue: ${itemId}`);
	}

	async removeMultipleFromQueue(itemIds: string[]): Promise<void> {
		for (const itemId of itemIds) {
			try {
				await this.removeFromQueue(itemId);
			} catch (error) {
				this.logService.error(`Failed to remove item from queue: ${itemId}`, error);
			}
		}
	}

	async reorderQueue(itemIds: string[]): Promise<void> {
		await this._ensureInitialized();

		// Validate that all items exist
		for (const itemId of itemIds) {
			if (!this._items.has(itemId)) {
				throw new Error(`Queue item not found: ${itemId}`);
			}
		}

		// Update priority based on new order
		itemIds.forEach((itemId, index) => {
			const item = this._items.get(itemId);
			if (item && item.status === FileQueueItemStatus.Pending) {
				// Higher index = lower priority for processing order
				item.priority = QueueItemPriority.Critical - Math.floor(index / itemIds.length * 3);
			}
		});

		await this.saveState();

		this._onQueueChanged.fire({
			type: 'reordered',
			itemIds,
			timestamp: new Date()
		});

		this.logService.debug('Queue reordered');
	}

	async clearQueue(includeProcessing: boolean = false): Promise<void> {
		await this._ensureInitialized();

		if (includeProcessing && this._queueState.isProcessing) {
			await this.stopProcessing(true);
		}

		const itemsToRemove = Array.from(this._items.values())
			.filter(item => includeProcessing || item.status !== FileQueueItemStatus.Processing)
			.map(item => item.id);

		for (const itemId of itemsToRemove) {
			this._items.delete(itemId);
		}

		this._updateQueueState();
		await this.saveState();

		this._onQueueChanged.fire({
			type: 'cleared',
			itemIds: itemsToRemove,
			timestamp: new Date()
		});

		this.logService.debug('Queue cleared');
	}

	// Processing Control Methods

	async startProcessing(options: QueueProcessingOptions = {}): Promise<void> {
		await this._ensureInitialized();

		if (this._queueState.isProcessing) {
			throw new Error('Queue processing is already running');
		}

		this._processingOptions = {
			maxConcurrency: options.maxConcurrency ?? 1,
			itemTimeout: options.itemTimeout ?? FileQueueServiceImpl.DEFAULT_TIMEOUT,
			continueOnError: options.continueOnError ?? true,
			autoRetry: options.autoRetry ?? false,
			maxRetries: options.maxRetries ?? 3,
			retryDelay: options.retryDelay ?? FileQueueServiceImpl.DEFAULT_RETRY_DELAY,
			...options
		};

		this._queueState.isProcessing = true;
		this._queueState.isPaused = false;
		this._queueState.startedAt = new Date();
		this._currentCancellation = new CancellationTokenSource();

		this._onProcessingStateChanged.fire({
			type: 'started',
			timestamp: new Date(),
			state: { ...this._queueState }
		});

		this.logService.debug('Queue processing started');

		// Start processing in background
		this._processQueue(this._currentCancellation.token).catch(error => {
			this.logService.error('Queue processing failed:', error);
			this._handleError('processing', 'Queue processing failed', 'critical', false);
		});
	}

	async pauseProcessing(): Promise<void> {
		if (!this._queueState.isProcessing) {
			throw new Error('Queue processing is not running');
		}

		this._queueState.isPaused = true;

		this._onProcessingStateChanged.fire({
			type: 'paused',
			timestamp: new Date(),
			state: { ...this._queueState }
		});

		this.logService.debug('Queue processing paused');
	}

	async resumeProcessing(): Promise<void> {
		if (!this._queueState.isProcessing || !this._queueState.isPaused) {
			throw new Error('Queue processing is not paused');
		}

		this._queueState.isPaused = false;

		this._onProcessingStateChanged.fire({
			type: 'resumed',
			timestamp: new Date(),
			state: { ...this._queueState }
		});

		this.logService.debug('Queue processing resumed');
	}

	async stopProcessing(force: boolean = false): Promise<void> {
		if (!this._queueState.isProcessing) {
			return; // Already stopped
		}

		this._queueState.isProcessing = false;
		this._queueState.isPaused = false;

		if (this._currentCancellation) {
			this._currentCancellation.cancel();
			this._currentCancellation.dispose();
			this._currentCancellation = undefined;
		}

		// Reset currently processing items if forced
		if (force) {
			const items = Array.from(this._items.values());
			for (const item of items) {
				if (item.status === FileQueueItemStatus.Processing) {
					item.status = FileQueueItemStatus.Pending;
					delete item.processedAt;
				}
			}
		}

		await this.saveState();

		this._onProcessingStateChanged.fire({
			type: 'stopped',
			timestamp: new Date(),
			state: { ...this._queueState }
		});

		this.logService.debug('Queue processing stopped');
	}

	async cancelItem(itemId: string): Promise<void> {
		const item = this._items.get(itemId);
		if (!item) {
			throw new Error(`Queue item not found: ${itemId}`);
		}

		if (item.status === FileQueueItemStatus.Processing) {
			// Cancel the operation (implementation would depend on actual processing logic)
			item.status = FileQueueItemStatus.Cancelled;
			item.completedAt = new Date();

			if (this._queueState.currentItemId === itemId) {
				delete this._queueState.currentItemId;
			}
		} else if (item.status === FileQueueItemStatus.Pending) {
			item.status = FileQueueItemStatus.Cancelled;
		}

		await this.saveState();

		this._onItemProcessed.fire({
			item: { ...item },
			timestamp: new Date()
		});

		this.logService.debug(`Cancelled item: ${itemId}`);
	}

	async retryItem(itemId: string): Promise<void> {
		const item = this._items.get(itemId);
		if (!item) {
			throw new Error(`Queue item not found: ${itemId}`);
		}

		if (item.status !== FileQueueItemStatus.Failed) {
			throw new Error(`Item is not in failed state: ${itemId}`);
		}

		item.status = FileQueueItemStatus.Pending;
		delete item.error;
		delete item.processedAt;
		delete item.completedAt;
		delete item.result;

		await this.saveState();

		this._onQueueChanged.fire({
			type: 'updated',
			itemIds: [itemId],
			timestamp: new Date()
		});

		this.logService.debug(`Retrying item: ${itemId}`);
	}

	// State Query Methods

	getQueueState(): QueueState {
		return { ...this._queueState };
	}

	getQueueItems(includeCompleted: boolean = false): FileQueueItem[] {
		const items = Array.from(this._items.values());

		if (!includeCompleted) {
			return items.filter(item =>
				item.status !== FileQueueItemStatus.Completed &&
				item.status !== FileQueueItemStatus.Failed &&
				item.status !== FileQueueItemStatus.Cancelled
			);
		}

		// Sort by priority and then by added time
		return items.sort((a, b) => {
			if (a.priority !== b.priority) {
				return b.priority - a.priority; // Higher priority first
			}
			return a.addedAt.getTime() - b.addedAt.getTime(); // Earlier first
		});
	}

	getQueueItem(itemId: string): FileQueueItem | undefined {
		const item = this._items.get(itemId);
		return item ? { ...item } : undefined;
	}

	getItemsByStatus(status: FileQueueItemStatus): FileQueueItem[] {
		return Array.from(this._items.values())
			.filter(item => item.status === status)
			.map(item => ({ ...item }));
	}

	getProcessingHistory(limit: number = FileQueueServiceImpl.MAX_HISTORY_SIZE): FileQueueItem[] {
		return this._processingHistory
			.slice(-limit)
			.map(item => ({ ...item }));
	}

	getQueueStatistics() {
		const completedItems = this._processingHistory.filter(item =>
			item.status === FileQueueItemStatus.Completed
		);

		const totalProcessed = this._processingHistory.length;
		const successCount = completedItems.length;
		const successRate = totalProcessed > 0 ? successCount / totalProcessed : 0;

		const processingTimes = completedItems
			.filter(item => item.processedAt && item.completedAt)
			.map(item => item.completedAt!.getTime() - item.processedAt!.getTime());

		const averageProcessingTime = processingTimes.length > 0
			? processingTimes.reduce((sum, time) => sum + time, 0) / processingTimes.length
			: 0;

		const currentQueueSize = this.getQueueItems().length;

		return {
			totalProcessed,
			averageProcessingTime,
			successRate,
			throughput: this._queueState.throughput || 0,
			currentQueueSize
		};
	}

	// Persistence Methods

	async saveState(): Promise<void> {
		if (!this._isInitialized) {
			return; // Don't save until fully initialized
		}

		try {
			const storage: QueueStorage = {
				items: Array.from(this._items.values()),
				state: this._queueState,
				version: 1
			};

			await this.extensionContext.globalState.update(
				FileQueueServiceImpl.STORAGE_KEY,
				storage
			);

			this.logService.debug('Queue state saved successfully');
		} catch (error) {
			this.logService.error('Failed to save queue state:', error);
			this._handleError('persistence', 'Failed to save queue state', 'error', true);
		}
	}

	async loadState(): Promise<void> {
		try {
			const storage = this.extensionContext.globalState.get<QueueStorage>(
				FileQueueServiceImpl.STORAGE_KEY
			);

			if (storage) {
				// Restore items
				this._items.clear();
				for (const item of storage.items) {
					// Convert date strings back to Date objects
					item.addedAt = new Date(item.addedAt);
					if (item.processedAt) item.processedAt = new Date(item.processedAt);
					if (item.completedAt) item.completedAt = new Date(item.completedAt);

					this._items.set(item.id, item);
				}

				// Restore state (but reset processing flags)
				this._queueState = {
					...storage.state,
					isProcessing: false,
					isPaused: false,
					currentItemId: undefined,
					// Convert date strings back to Date objects
					startedAt: storage.state.startedAt ? new Date(storage.state.startedAt) : undefined,
					estimatedCompletion: storage.state.estimatedCompletion ? new Date(storage.state.estimatedCompletion) : undefined
				};

				// Move completed items to history
				await this._moveCompletedToHistory();
			}

			this._updateQueueState();
			this.logService.debug('Queue state loaded successfully');
		} catch (error) {
			this.logService.error('Failed to load queue state:', error);
			this._handleError('persistence', 'Failed to load queue state', 'error', true);
		}
	}

	exportQueue(): string {
		const data = {
			items: Array.from(this._items.values()),
			state: this._queueState,
			exportedAt: new Date(),
			version: 1
		};

		return JSON.stringify(data, null, 2);
	}

	async importQueue(data: string, merge: boolean = false): Promise<void> {
		try {
			const imported = JSON.parse(data);

			if (!merge) {
				this._items.clear();
			}

			for (const item of imported.items) {
				// Convert date strings back to Date objects
				item.addedAt = new Date(item.addedAt);
				if (item.processedAt) item.processedAt = new Date(item.processedAt);
				if (item.completedAt) item.completedAt = new Date(item.completedAt);

				// Generate new ID if merging to avoid conflicts
				if (merge) {
					item.id = randomUUID();
				}

				this._items.set(item.id, item);
			}

			this._updateQueueState();
			await this.saveState();

			this._onQueueChanged.fire({
				type: 'added',
				itemIds: imported.items.map((item: FileQueueItem) => item.id),
				timestamp: new Date()
			});

			this.logService.debug('Queue imported successfully');
		} catch (error) {
			this.logService.error('Failed to import queue:', error);
			throw new Error(`Failed to import queue: ${error}`);
		}
	}

	// Utility Methods

	async validateFile(filePath: string): Promise<{ valid: boolean; reason?: string }> {
		try {
			// Check if file exists and get stat info
			const fileUri = Uri.file(filePath);
			let stat;
			try {
				stat = await this.fileSystemService.stat(fileUri);
			} catch {
				return { valid: false, reason: 'File does not exist' };
			}

			// Check if it's a file (not directory)
			if (stat.type !== 1) { // FileType.File = 1
				return { valid: false, reason: 'Path is not a file' };
			}

			// Check file size (limit to 10MB for now)
			const maxSize = 10 * 1024 * 1024; // 10MB
			if (stat.size > maxSize) {
				return { valid: false, reason: `File too large (max ${maxSize / 1024 / 1024}MB)` };
			}

			// Check if already in queue
			const existingItem = Array.from(this._items.values())
				.find(item => path.resolve(item.filePath) === path.resolve(filePath));

			if (existingItem && existingItem.status !== FileQueueItemStatus.Completed) {
				return { valid: false, reason: 'File already in queue' };
			}

			return { valid: true };
		} catch (error) {
			this.logService.error(error, `Error validating file: ${filePath}`);
			return { valid: false, reason: `Validation error: ${error}` };
		}
	}

	async estimateProcessingTime(filePath: string): Promise<number> {
		try {
			const fileUri = Uri.file(filePath);
			const stat = await this.fileSystemService.stat(fileUri);

			// Basic estimation based on file size for text injection
			const baseTime = 500; // 0.5 second base time for reading and injecting
			const sizeMultiplier = Math.min(stat.size / 1024, 5); // Up to 5x for file size

			return Math.round(baseTime * sizeMultiplier);
		} catch (error) {
			this.logService.warn('Failed to estimate processing time');
			return FileQueueServiceImpl.DEFAULT_TIMEOUT / 2; // Default estimate
		}
	}


	// Private Helper Methods

	private async _ensureInitialized(): Promise<void> {
		if (!this._isInitialized) {
			await this._initialize();
		}
	}

	private async _processQueue(cancellationToken: CancellationToken): Promise<void> {
		try {
			while (this._queueState.isProcessing && !cancellationToken.isCancellationRequested) {
				// Wait if paused
				if (this._queueState.isPaused) {
					await this._delay(1000);
					continue;
				}

				// Get next item to process
				const nextItem = this._getNextItemToProcess();
				if (!nextItem) {
					// No more items to process
					break;
				}

				await this._processItem(nextItem, cancellationToken);

				// Update queue state
				this._updateQueueState();
				await this.saveState();

				// Add a small buffer between files to ensure chat system is ready for next operation
				if (!cancellationToken.isCancellationRequested && this._getNextItemToProcess()) {
					this.logService.debug('Adding buffer delay between file processing');
					await this._delay(2000, cancellationToken); // 2 second buffer between files
				}
			}

			// Processing completed
			if (this._queueState.isProcessing) {
				this._queueState.isProcessing = false;
				this._queueState.isPaused = false;
				delete this._queueState.currentItemId;

				this._onProcessingStateChanged.fire({
					type: 'completed',
					timestamp: new Date(),
					state: { ...this._queueState }
				});

				this.logService.debug('Queue processing completed');
			}
		} catch (error) {
			this.logService.error('Error in queue processing:', error);
			this._handleError('processing', 'Queue processing error', 'critical', false);
		}
	}

	private _getNextItemToProcess(): FileQueueItem | undefined {
		const pendingItems = Array.from(this._items.values())
			.filter(item => item.status === FileQueueItemStatus.Pending)
			.sort((a, b) => {
				// Sort by priority first, then by added time
				if (a.priority !== b.priority) {
					return b.priority - a.priority;
				}
				return a.addedAt.getTime() - b.addedAt.getTime();
			});

		return pendingItems[0];
	}

	private async _processItem(item: FileQueueItem, cancellationToken: CancellationToken): Promise<void> {
		const startTime = Date.now();

		try {
			// Update item status
			item.status = FileQueueItemStatus.Processing;
			item.processedAt = new Date();
			this._queueState.currentItemId = item.id;

			this.logService.debug(`Processing item: ${item.filePath} (${item.id})`);

			// Process the file and inject content into Copilot Chat
			const result = await this._processFileItem(item, cancellationToken);

			// Update item with result
			item.status = result.success ? FileQueueItemStatus.Completed : FileQueueItemStatus.Failed;
			item.completedAt = new Date();
			item.result = result;

			if (!result.success && result.error) {
				item.error = result.error.message;
			}

			// Move to history if completed or failed
			if (item.status === FileQueueItemStatus.Completed || item.status === FileQueueItemStatus.Failed) {
				this._processingHistory.push({ ...item });
				this._items.delete(item.id);

				// Limit history size
				if (this._processingHistory.length > FileQueueServiceImpl.MAX_HISTORY_SIZE) {
					this._processingHistory.splice(0, this._processingHistory.length - FileQueueServiceImpl.MAX_HISTORY_SIZE);
				}
			}

			// Fire events
			this._onItemProcessed.fire({
				item: { ...item },
				timestamp: new Date(),
				duration: Date.now() - startTime
			});

			this.logService.debug(`Completed processing item: ${item.id} (${result.success ? 'success' : 'failed'})`);

		} catch (error) {
			// Handle processing error
			item.status = FileQueueItemStatus.Failed;
			item.completedAt = new Date();
			item.error = error instanceof Error ? error.message : String(error);

			this._processingHistory.push({ ...item });
			this._items.delete(item.id);

			this._handleError('item_processing', `Failed to process item: ${item.filePath}`, 'error', true);

			this.logService.error(`Failed to process item ${item.id}:`, error);
		} finally {
			delete this._queueState.currentItemId;
		}
	}

	private async _processFileItem(item: FileQueueItem, cancellationToken: CancellationToken): Promise<ProcessingResult> {
		const startTime = Date.now();

		try {
			this.logService.info(`DEBUG: Starting _processFileItem for: ${item.filePath}`);

			// Read the file content
			const fileUri = Uri.file(item.filePath);
			let fileContent: string;

			try {
				this.logService.info(`DEBUG: Reading file: ${item.filePath}`);
				const fileData = await this.fileSystemService.readFile(fileUri);
				fileContent = fileData.toString();
				this.logService.info(`DEBUG: File read successfully, content length: ${fileContent.length}`);
			} catch (error) {
				this.logService.error(`DEBUG: Failed to read file: ${item.filePath}`, error);
				throw new Error(`Failed to read file: ${error}`);
			}

			if (cancellationToken.isCancellationRequested) {
				this.logService.info(`DEBUG: Processing cancelled for: ${item.filePath}`);
				throw new Error('Processing was cancelled');
			}

			// Create a chat message that includes the file content
			const operation = item.metadata?.operation || 'analyze';
			const fileName = item.fileName;
			this.logService.info(`DEBUG: Creating chat query for operation: ${operation}, fileName: ${fileName}`);
			const chatQuery = this._createChatQuery(operation, fileName, fileContent);
			this.logService.info(`DEBUG: Chat query created, length: ${chatQuery.length}`);

			// Attach file to chat and open with processing instruction
			try {
				this.logService.info(`DEBUG: About to call _openChatWithFile`);
				await this._openChatWithFile(item.filePath, item.fileName, chatQuery);
				this.logService.info(`DEBUG: _openChatWithFile completed successfully`);
			} catch (error) {
				this.logService.error(`DEBUG: _openChatWithFile failed:`, error);
				throw new Error(`Failed to attach file to chat: ${error}`);
			}

			const duration = Date.now() - startTime;
			this.logService.info(`DEBUG: Processing completed for ${item.filePath}, duration: ${duration}ms`);

			return {
				success: true,
				message: `File ${fileName} attached to chat and processing initiated`,
				duration,
				data: {
					operation,
					fileName,
					fileSize: fileContent.length,
					filePath: item.filePath
				}
			};

		} catch (error) {
			const duration = Date.now() - startTime;
			return {
				success: false,
				message: `Failed to process file: ${error instanceof Error ? error.message : String(error)}`,
				duration,
				error: error instanceof Error ? error : new Error(String(error))
			};
		}
	}

	private _createChatQuery(operation: string, fileName: string, fileContent: string): string {
		// Per the requirement: only inject the file content, nothing else
		return `${fileName} is your prompt`;
	}

	private async _openChatWithFile(filePath: string, fileName: string, chatPrompt: string): Promise<void> {
		try {
			this.logService.info(`Opening Copilot Chat for file: ${filePath}`);

			// First, attach the file to chat
			this.logService.info(`${filePath} is your prompt`);
			await vscode.commands.executeCommand('workbench.action.chat.attachFile', Uri.file(filePath));

			// Small delay to ensure the file is attached
			await new Promise(resolve => setTimeout(resolve, 500));

			// Then open the chat view with a pre-filled query
			this.logService.info('Opening Copilot Chat view with analysis query');
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: chatPrompt
			});

			this.logService.info(`Successfully opened Copilot Chat with file: ${fileName}`);

		} catch (error) {
			this.logService.error(`Failed to open Copilot Chat for file: ${filePath}`, error);
			throw error;
		}
	}


	private async _delay(ms: number, cancellationToken?: CancellationToken): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(resolve, ms);

			if (cancellationToken) {
				const listener = cancellationToken.onCancellationRequested(() => {
					clearTimeout(timeout);
					listener.dispose();
					reject(new Error('Operation was cancelled'));
				});
			}
		});
	}

	private _updateQueueState(): void {
		const items = Array.from(this._items.values());

		this._queueState.totalCount = items.length;
		this._queueState.processedCount = this._processingHistory.length;
		this._queueState.failedCount = this._processingHistory.filter(item =>
			item.status === FileQueueItemStatus.Failed
		).length;

		// Update estimated completion
		if (this._queueState.isProcessing && this._queueState.startedAt && this._queueState.startedAt instanceof Date) {
			const pendingItems = items.filter(item => item.status === FileQueueItemStatus.Pending);
			const avgProcessingTime = this._calculateAverageProcessingTime();

			if (pendingItems.length > 0 && avgProcessingTime > 0) {
				const estimatedRemainingTime = pendingItems.length * avgProcessingTime;
				this._queueState.estimatedCompletion = new Date(Date.now() + estimatedRemainingTime);
			}
		}

		// Update throughput
		if (this._queueState.startedAt && this._queueState.startedAt instanceof Date) {
			const elapsedMinutes = (Date.now() - this._queueState.startedAt.getTime()) / (1000 * 60);
			if (elapsedMinutes > 0) {
				this._queueState.throughput = this._queueState.processedCount / elapsedMinutes;
			}
		}

		// Update average processing time
		this._queueState.averageProcessingTime = this._calculateAverageProcessingTime();
	}

	private _calculateAverageProcessingTime(): number {
		const completedItems = this._processingHistory.filter(item =>
			item.status === FileQueueItemStatus.Completed &&
			item.processedAt &&
			item.completedAt
		);

		if (completedItems.length === 0) {
			return 0;
		}

		const totalTime = completedItems.reduce((sum, item) => {
			const processingTime = item.completedAt!.getTime() - item.processedAt!.getTime();
			return sum + processingTime;
		}, 0);

		return totalTime / completedItems.length;
	}

	private async _moveCompletedToHistory(): Promise<void> {
		const completedItems = Array.from(this._items.values()).filter(item =>
			item.status === FileQueueItemStatus.Completed ||
			item.status === FileQueueItemStatus.Failed ||
			item.status === FileQueueItemStatus.Cancelled
		);

		for (const item of completedItems) {
			this._processingHistory.push({ ...item });
			this._items.delete(item.id);
		}

		// Limit history size
		if (this._processingHistory.length > FileQueueServiceImpl.MAX_HISTORY_SIZE) {
			this._processingHistory.splice(0, this._processingHistory.length - FileQueueServiceImpl.MAX_HISTORY_SIZE);
		}
	}

	private _handleError(context: string, message: string, severity: 'warning' | 'error' | 'critical', recoverable: boolean): void {
		const error: QueueError = {
			id: randomUUID(),
			message,
			timestamp: new Date(),
			severity,
			recoverable
		};

		this._queueState.errors.push(error);

		// Limit error history
		if (this._queueState.errors.length > 20) {
			this._queueState.errors = this._queueState.errors.slice(-20);
		}

		this._onError.fire(error);
	}
}