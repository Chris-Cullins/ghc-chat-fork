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
	IFileProcessor,
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
	resetChatBetweenFiles?: boolean;
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

	// Chat completion tracking
	private _chatCompletionCallbacks = new Map<string, () => void>();
	private _chatStartTimestamps = new Map<string, number>();

	// File processor (injected from extension layer)
	private _fileProcessor?: IFileProcessor;

	// Chat context reset setting
	private _resetChatBetweenFiles = false;

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
				resetChatBetweenFiles: this._resetChatBetweenFiles,
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
					if (item.processedAt) { item.processedAt = new Date(item.processedAt); }
					if (item.completedAt) { item.completedAt = new Date(item.completedAt); }

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

				// Restore reset chat between files setting
				if (storage.resetChatBetweenFiles !== undefined) {
					this._resetChatBetweenFiles = storage.resetChatBetweenFiles;
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
				if (item.processedAt) { item.processedAt = new Date(item.processedAt); }
				if (item.completedAt) { item.completedAt = new Date(item.completedAt); }

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
		// Record the start of chat interaction for this file
		this._chatStartTimestamps.set(item.filePath, Date.now());

		// Delegate to the processor (will be injected from extension layer)
		if (this._fileProcessor) {
			return await this._fileProcessor.processFile(item, cancellationToken);
		} else {
			// Fallback for when no processor is available (shouldn't happen in normal operation)
			this.logService.warn(`No file processor available for: ${item.filePath}`);
			return {
				success: false,
				message: 'No file processor available - this indicates a configuration issue',
				duration: 0,
				error: new Error('No file processor available')
			};
		}
	}


	private async _waitForChatCompletion(filePath: string, cancellationToken: CancellationToken): Promise<void> {
		// Strategy: Use a promise-based approach with multiple completion detection mechanisms
		// 1. Wait for explicit completion signal (if available)
		// 2. Monitor for extended inactivity periods
		// 3. Use configurable maximum wait time as safety net
		// 4. Allow for long-running operations (20+ minute jobs)

		const minWaitTime = 5000; // 5 seconds minimum wait for chat to start
		const maxWaitTime = this._processingOptions.chatWaitTime ?? 25 * 60 * 1000; // Default 25 minutes (handle 20min+ jobs)
		const inactivityThreshold = 3600000; // 1 hour of inactivity before considering completion (backup only)
		const pollInterval = 5000; // Check every 5 seconds
		const startTime = Date.now();

		this.logService.info(`DEBUG: Enhanced waiting for chat completion: ${filePath} (maxWait: ${maxWaitTime}ms)`);

		try {
			// Phase 1: Minimum wait time for chat to initialize
			this.logService.info(`DEBUG: Initial wait (${minWaitTime}ms) for chat to initialize: ${filePath}`);
			await this._delay(minWaitTime, cancellationToken);

			// Phase 2: Wait for completion with multiple detection mechanisms
			const completionPromise = new Promise<void>((resolve, reject) => {
				let lastActivityTime = Date.now();
				let pollTimer: NodeJS.Timeout | undefined;
				let maxTimeoutTimer: NodeJS.Timeout | undefined;

				// Set up callback for explicit completion signal
				this._chatCompletionCallbacks.set(filePath, () => {
					this.logService.info(`DEBUG: Explicit completion signal received for: ${filePath}`);
					cleanup();
					resolve();
				});

				const cleanup = () => {
					if (pollTimer) {
						clearTimeout(pollTimer);
						pollTimer = undefined;
					}
					if (maxTimeoutTimer) {
						clearTimeout(maxTimeoutTimer);
						maxTimeoutTimer = undefined;
					}
					this._chatCompletionCallbacks.delete(filePath);
					this._chatStartTimestamps.delete(filePath);
				};

				// Set up maximum timeout
				maxTimeoutTimer = setTimeout(() => {
					const elapsed = Date.now() - startTime;
					this.logService.info(`DEBUG: Maximum wait time reached for: ${filePath} after ${elapsed}ms`);
					cleanup();
					resolve(); // Don't reject, just proceed to next file
				}, maxWaitTime);

				// Set up polling for inactivity detection
				const poll = async () => {
					try {
						if (cancellationToken.isCancellationRequested) {
							cleanup();
							reject(new Error('Processing was cancelled'));
							return;
						}

						const elapsed = Date.now() - startTime;
						const timeSinceActivity = Date.now() - lastActivityTime;

						// Check if we've had sufficient inactivity and enough total time has passed
						const minimumProcessingTime = 10000; // At least 10 seconds total processing
						if (elapsed >= minimumProcessingTime && timeSinceActivity >= inactivityThreshold) {
							this.logService.info(`DEBUG: Inactivity-based completion detected for: ${filePath} after ${elapsed}ms (${timeSinceActivity}ms since last activity)`);
							cleanup();
							resolve();
							return;
						}

						// Check for signs of activity (this is where we'd add more sophisticated detection)
						const hasActivity = await this._detectChatActivity(filePath);
						if (hasActivity) {
							lastActivityTime = Date.now();
							this.logService.debug(`DEBUG: Chat activity detected for: ${filePath}, resetting inactivity timer`);
						}

						// Schedule next poll
						pollTimer = setTimeout(poll, pollInterval);

					} catch (error) {
						cleanup();
						reject(error);
					}
				};

				// Start polling
				pollTimer = setTimeout(poll, pollInterval);

				// Handle cancellation
				if (cancellationToken.isCancellationRequested) {
					cleanup();
					reject(new Error('Processing was cancelled'));
				} else {
					const cancelListener = cancellationToken.onCancellationRequested(() => {
						cleanup();
						cancelListener.dispose();
						reject(new Error('Processing was cancelled'));
					});
				}
			});

			await completionPromise;

			const totalElapsed = Date.now() - startTime;
			this.logService.info(`DEBUG: Chat completion monitoring finished for: ${filePath} after ${totalElapsed}ms`);

		} catch (error) {
			if (cancellationToken.isCancellationRequested) {
				this.logService.info(`DEBUG: Chat completion monitoring cancelled for: ${filePath}`);
			} else {
				this.logService.warn(`DEBUG: Chat completion monitoring error for: ${filePath}: ${error}`);
			}
			// Clean up any lingering callbacks
			this._chatCompletionCallbacks.delete(filePath);
			this._chatStartTimestamps.delete(filePath);
			throw error;
		}
	}

	private async _detectChatActivity(filePath: string): Promise<boolean> {
		try {
			// Strategy: Use multiple heuristics to detect ongoing chat activity
			// Since we don't have direct access to VS Code's internal chat state,
			// we use observable indicators and statistical patterns

			const chatStartTime = this._chatStartTimestamps.get(filePath);
			if (!chatStartTime) {
				return false; // No record of chat start, assume no activity
			}

			const timeSinceStart = Date.now() - chatStartTime;

			// Heuristic 1: Very recent chat starts are likely active
			if (timeSinceStart < 15000) { // First 15 seconds
				return true;
			}

			// Heuristic 2: For longer-running operations, use statistical patterns
			// Most chat responses complete within certain time windows, but some can be very long

			// Short operations (< 2 minutes) - likely completed if no explicit signals
			if (timeSinceStart > 120000) { // 2 minutes
				// For operations longer than 2 minutes, we assume they might be long-running
				// and require more sophisticated detection or user intervention

				// Heuristic 3: Check if this is likely a long-running operation
				// (this is where we could add file-type-specific logic)
				const isLikelyLongRunning = this._isLikelyLongRunningOperation(filePath);

				if (isLikelyLongRunning) {
					// For long-running operations, be more conservative about activity detection
					// Assume activity for up to 20 minutes, then rely on inactivity timeout
					return timeSinceStart < 20 * 60 * 1000; // 20 minutes
				} else {
					// For normal operations, assume they're done after 2 minutes without explicit completion
					return false;
				}
			}

			// Default: assume activity for the first 2 minutes
			return true;

		} catch (error) {
			this.logService.warn(`DEBUG: Error detecting chat activity for ${filePath}: ${error}`);
			// If we can't determine activity, err on the side of caution and assume activity
			return true;
		}
	}

	private _isLikelyLongRunningOperation(filePath: string): boolean {
		// Heuristics to determine if this file/operation is likely to take a long time
		const fileName = path.basename(filePath).toLowerCase();
		const fileExt = path.extname(filePath).toLowerCase();

		// File patterns that often indicate long-running operations
		const longRunningPatterns = [
			// Large data files
			/\.json$/, /\.csv$/, /\.xml$/, /\.sql$/,
			// Documentation that might require extensive generation
			/readme/i, /documentation/i, /spec/i, /requirements/i,
			// Complex code files
			/\.py$/, /\.java$/, /\.cpp$/, /\.c$/,
			// Configuration files that might require extensive analysis
			/config/i, /settings/i, /\.yaml$/, /\.yml$/
		];

		// Check file size if available (larger files often take longer)
		// This would require file stat info, which we could add if needed

		return longRunningPatterns.some(pattern =>
			pattern.test(fileName) || pattern.test(fileExt)
		);
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
				this.logService.warn(`Failed to add file from last run: ${filePath}. Error: ${error}`);
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

	// Chat completion signaling methods (for extension layer integration)

	/**
	 * Signal that chat processing has completed for a specific file.
	 * This allows the queue to immediately proceed to the next file.
	 */
	signalChatCompletion(filePath: string): void {
		const callback = this._chatCompletionCallbacks.get(filePath);
		if (callback) {
			this.logService.info(`Received explicit chat completion signal for: ${filePath}`);
			callback();
		} else {
			this.logService.debug(`No active chat completion listener for: ${filePath}`);
		}
	}

	/**
	 * Signal that chat processing has completed for the currently processing file.
	 * This is a convenience method when the caller doesn't know the specific file path.
	 */
	signalCurrentChatCompletion(): void {
		const currentItemId = this._queueState.currentItemId;
		if (currentItemId) {
			const currentItem = this._items.get(currentItemId);
			if (currentItem) {
				this.signalChatCompletion(currentItem.filePath);
			} else {
				this.logService.warn(`Could not find current item for chat completion signal: ${currentItemId}`);
			}
		} else {
			this.logService.debug(`No current item for chat completion signal`);
		}
	}

	/**
	 * Get information about active chat sessions being monitored.
	 */
	getActiveChatSessions(): Array<{ filePath: string; startTime: number; duration: number }> {
		const now = Date.now();
		return Array.from(this._chatStartTimestamps.entries()).map(([filePath, startTime]) => ({
			filePath,
			startTime,
			duration: now - startTime
		}));
	}

	setFileProcessor(processor: IFileProcessor): void {
		this._fileProcessor = processor;
		this.logService.debug('File processor set for queue service');
	}

	getResetChatBetweenFiles(): boolean {
		return this._resetChatBetweenFiles;
	}

	setResetChatBetweenFiles(reset: boolean): void {
		this._resetChatBetweenFiles = reset;
		this.logService.debug(`Chat context reset between files set to: ${reset}`);
		
		// Persist this setting
		void this.saveState();
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