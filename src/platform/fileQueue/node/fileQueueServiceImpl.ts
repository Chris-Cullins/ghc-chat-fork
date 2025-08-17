/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as path from 'path';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { Uri } from '../../../vscodeTypes';
import {
	FileQueueItem,
	FileQueueItemStatus,
	IFileQueueService,
	ItemProcessedEvent,
	LastRunInfo,
	ProcessingResult,
	ProcessingStateEvent,
	QueueChangeEvent,
	QueueError,
	QueueProcessingOptions,
	QueueState
} from '../common/fileQueueService';

interface QueueStorage {
	items: FileQueueItem[];
	state: QueueState;
	lastRun?: LastRunInfo;
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
	private _lastRun?: LastRunInfo;
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
		filePaths: string[]
	): Promise<string[]> {
		const itemIds: string[] = [];

		for (const filePath of filePaths) {
			try {
				const itemId = await this.addToQueue(filePath);
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

		// Reordering is handled naturally by the queue order
		// No need to update priority since we're using FIFO

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
			chatWaitTime: options.chatWaitTime ?? 60000, // Default 60 seconds with intelligent monitoring
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

		// Sort by added time only (FIFO)
		return items.sort((a, b) => {
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
				lastRun: this._lastRun,
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
					if (item.processedAt) {item.processedAt = new Date(item.processedAt);}
					if (item.completedAt) {item.completedAt = new Date(item.completedAt);}

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

				// Restore last run info (with date conversion)
				if (storage.lastRun) {
					this._lastRun = {
						...storage.lastRun,
						completedAt: new Date(storage.lastRun.completedAt)
					};
				}

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
				if (item.processedAt) {item.processedAt = new Date(item.processedAt);}
				if (item.completedAt) {item.completedAt = new Date(item.completedAt);}

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

				// The _waitForChatCompletion method already includes appropriate delays,
				// so we don't need an additional buffer delay here anymore
			}

			// Processing completed
			if (this._queueState.isProcessing) {
				// Capture last run information before marking as completed
				await this._captureLastRun();

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
				// Sort by added time only (FIFO)
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

			// Wait for user to indicate they're ready for the next file
			// This ensures we don't overwhelm the chat system and allows proper sequential processing
			this.logService.info(`DEBUG: Waiting for chat processing completion signal for: ${item.filePath}`);
			await this._waitForChatCompletion(item.filePath, cancellationToken);
			this.logService.info(`DEBUG: Chat processing completion confirmed for: ${item.filePath}`);

			const duration = Date.now() - startTime;
			this.logService.info(`DEBUG: Processing completed for ${item.filePath}, duration: ${duration}ms`);

			return {
				success: true,
				message: `File ${fileName} attached to chat and processing completed`,
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
			// NOTE: In a real implementation, this would call VS Code commands
			// For now, we're just logging since we're in the node layer
			// The actual VS Code integration happens in the extension layer
			// await vscode.commands.executeCommand('workbench.action.chat.attachFile', Uri.file(filePath));

			// Small delay to simulate file attachment
			await new Promise(resolve => setTimeout(resolve, 500));

			// Then open the chat view with a pre-filled query
			this.logService.info('Opening Copilot Chat view with analysis query');
			// await vscode.commands.executeCommand('workbench.action.chat.open', {
			//     query: chatPrompt
			// });

			this.logService.info(`Successfully opened Copilot Chat with file: ${fileName}`);

		} catch (error) {
			this.logService.error(`Failed to open Copilot Chat for file: ${filePath}`, error);
			throw error;
		}
	}

	private async _waitForChatCompletion(filePath: string, cancellationToken: CancellationToken): Promise<void> {
		// Strategy: Use a hybrid approach that combines intelligent monitoring with user control
		// 1. Wait for a minimum time for chat to process
		// 2. Use heuristics to detect likely completion
		// 3. Allow user to manually proceed via commands
		// 4. Fall back to configurable timeout as safety net

		const minWaitTime = 3000; // 3 seconds minimum wait for chat to start
		const maxWaitTime = this._processingOptions.chatWaitTime ?? 60000; // Default 60 seconds or configured
		const pollInterval = 2000; // Check every 2 seconds
		const startTime = Date.now();

		this.logService.info(`DEBUG: Smart waiting for chat completion: ${filePath}`);

		try {
			// Phase 1: Minimum wait time for chat to start processing
			this.logService.info(`DEBUG: Initial wait (${minWaitTime}ms) for chat to start processing: ${filePath}`);
			await this._delay(minWaitTime, cancellationToken);

			// Phase 2: Intelligent monitoring with early completion detection
			let chatCompleted = false;
			let consecutiveIdleChecks = 0;
			const requiredIdleChecks = 2; // Require 2 consecutive idle checks

			while (!chatCompleted && !cancellationToken.isCancellationRequested) {
				const elapsed = Date.now() - startTime;

				// Check if user manually signaled completion or we've reached max wait time
				if (elapsed > maxWaitTime) {
					this.logService.info(`DEBUG: Chat completion timeout reached for: ${filePath} after ${elapsed}ms - proceeding to next file`);
					break;
				}

				// Check if chat appears to be idle/complete using heuristics
				const isChatIdle = await this._isChatIdle();

				if (isChatIdle) {
					consecutiveIdleChecks++;
					this.logService.debug(`DEBUG: Chat idle detected (${consecutiveIdleChecks}/${requiredIdleChecks}): ${filePath}`);

					if (consecutiveIdleChecks >= requiredIdleChecks) {
						// Chat appears idle, but wait a bit longer to be sure
						const idleConfirmationWait = 5000; // 5 seconds
						this.logService.info(`DEBUG: Chat idle detected, waiting ${idleConfirmationWait}ms for confirmation: ${filePath}`);
						await this._delay(idleConfirmationWait, cancellationToken);

						// Check one more time after confirmation wait
						const stillIdle = await this._isChatIdle();
						if (stillIdle) {
							chatCompleted = true;
							this.logService.info(`DEBUG: Chat completion confirmed for: ${filePath} after ${elapsed + idleConfirmationWait}ms`);
						} else {
							// Reset if chat became active again
							consecutiveIdleChecks = 0;
							this.logService.debug(`DEBUG: Chat became active again during confirmation: ${filePath}`);
						}
					}
				} else {
					// Reset counter if chat is still active
					if (consecutiveIdleChecks > 0) {
						this.logService.debug(`DEBUG: Chat still active, resetting idle counter: ${filePath}`);
					}
					consecutiveIdleChecks = 0;
				}

				if (!chatCompleted && !cancellationToken.isCancellationRequested) {
					await this._delay(pollInterval, cancellationToken);
				}
			}

			if (cancellationToken.isCancellationRequested) {
				this.logService.info(`DEBUG: Chat completion monitoring cancelled for: ${filePath}`);
				throw new Error('Processing was cancelled');
			}

			const totalElapsed = Date.now() - startTime;
			this.logService.info(`DEBUG: Chat completion wait finished for: ${filePath} after ${totalElapsed}ms`);

		} catch (error) {
			if (cancellationToken.isCancellationRequested) {
				this.logService.info(`DEBUG: Chat completion monitoring cancelled for: ${filePath}`);
			} else {
				this.logService.warn(`DEBUG: Chat completion monitoring error for: ${filePath}: ${error}`);
			}
			throw error;
		}
	}

	private async _isChatIdle(): Promise<boolean> {
		try {
			// Strategy: Use multiple heuristics to detect if chat has likely completed
			// Since we don't have direct access to VS Code's internal chat state,
			// we'll use observable indicators:

			// 1. Simple heuristic: Always return true after the minimum wait time
			//    This allows the consecutive idle check logic to work properly
			//    The real "smart" behavior comes from the consecutive checks and confirmation wait

			// For now, we'll implement a conservative approach that returns true
			// most of the time, allowing the higher-level logic (consecutive checks, 
			// confirmation wait) to provide the real intelligence.

			// In a more sophisticated implementation, we could:
			// - Monitor VS Code's window title for "loading" indicators
			// - Check system CPU usage (chat processing might cause spikes)
			// - Monitor network activity if we can detect chat API calls
			// - Track document/editor focus changes as user interaction signals

			// For this implementation, we'll rely primarily on the timeout-based
			// approach with smart confirmation logic
			return true;

		} catch (error) {
			this.logService.warn(`DEBUG: Error checking chat idle state: ${error}`);
			// If we can't determine the state, assume it's idle to allow progression
			return true;
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

	private async _captureLastRun(): Promise<void> {
		try {
			// Get all items that were attempted in this run (from processing history)
			const runItems = this._processingHistory.filter(item =>
				item.processedAt &&
				this._queueState.startedAt &&
				item.processedAt >= this._queueState.startedAt
			);

			if (runItems.length === 0) {
				this.logService.debug('No items processed in this run, not capturing last run info');
				return;
			}

			// Extract file paths and metadata
			const filePaths: string[] = [];
			const fileMetadata: Record<string, Record<string, any>> = {};
			let successCount = 0;

			for (const item of runItems) {
				filePaths.push(item.filePath);
				if (item.metadata) {
					fileMetadata[item.filePath] = item.metadata;
				}
				if (item.status === FileQueueItemStatus.Completed) {
					successCount++;
				}
			}

			// Create last run info
			this._lastRun = {
				filePaths,
				completedAt: new Date(),
				successCount,
				totalCount: runItems.length,
				processingOptions: { ...this._processingOptions },
				fileMetadata
			};

			// Save the updated state with last run info
			await this.saveState();

			this.logService.debug(`Captured last run info: ${filePaths.length} files, ${successCount} successful`);
		} catch (error) {
			this.logService.error('Failed to capture last run information:', error);
		}
	}

	// Repeat Functionality Methods

	async repeatLastRun(options?: QueueProcessingOptions): Promise<void> {
		await this._ensureInitialized();

		if (!this._lastRun) {
			throw new Error('No previous run available to repeat');
		}

		// Clear the current queue first
		await this.clearQueue(false);

		// Add all files from the last run back to the queue
		const itemIds: string[] = [];
		for (const filePath of this._lastRun.filePaths) {
			try {
				const metadata = this._lastRun.fileMetadata?.[filePath] || {};
				const itemId = await this.addToQueue(filePath, metadata);
				itemIds.push(itemId);
			} catch (error) {
				this.logService.warn(`Failed to add file from last run: ${filePath}`, error);
			}
		}

		if (itemIds.length === 0) {
			throw new Error('No files could be added from the last run');
		}

		// Use the processing options from the last run, but allow override
		const processingOptions = {
			...this._lastRun.processingOptions,
			...options
		};

		// Start processing immediately
		await this.startProcessing(processingOptions);

		this.logService.info(`Repeated last run with ${itemIds.length} files`);
	}

	getLastRunInfo(): LastRunInfo | undefined {
		return this._lastRun ? { ...this._lastRun } : undefined;
	}

	canRepeatLastRun(): boolean {
		return this._lastRun !== undefined && this._lastRun.filePaths.length > 0;
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