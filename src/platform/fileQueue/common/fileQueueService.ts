/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';

/**
 * Represents the status of a file in the queue
 */
export const enum FileQueueItemStatus {
	Pending = 'pending',
	Processing = 'processing',
	Completed = 'completed',
	Failed = 'failed',
	Cancelled = 'cancelled'
}

/**
 * Priority levels for queue items
 */
export const enum QueueItemPriority {
	Low = 1,
	Normal = 2,
	High = 3,
	Critical = 4
}

/**
 * Result of processing a file
 */
export interface ProcessingResult {
	success: boolean;
	message?: string;
	data?: any;
	error?: Error;
	duration?: number;
	outputFilePath?: string;
}

/**
 * Individual file item in the queue
 */
export interface FileQueueItem {
	/** Unique identifier for the queue item */
	id: string;

	/** Full file path */
	filePath: string;

	/** Display name for the file */
	fileName: string;

	/** Processing priority */
	priority: QueueItemPriority;

	/** Current status */
	status: FileQueueItemStatus;

	/** When item was added to queue */
	addedAt: Date;

	/** When processing started */
	processedAt?: Date;

	/** When processing completed */
	completedAt?: Date;

	/** Error message if processing failed */
	error?: string;

	/** Result of processing */
	result?: ProcessingResult;

	/** Additional metadata */
	metadata?: Record<string, any>;

	/** Estimated processing time in milliseconds */
	estimatedDuration?: number;

}

/**
 * Overall state of the queue processing
 */
export interface QueueState {
	/** Whether queue is currently processing items */
	isProcessing: boolean;

	/** Whether processing is paused */
	isPaused: boolean;

	/** ID of currently processing item */
	currentItemId?: string;

	/** Number of completed items */
	processedCount: number;

	/** Total number of items in queue */
	totalCount: number;

	/** Number of failed items */
	failedCount: number;

	/** When processing started */
	startedAt?: Date;

	/** Estimated completion time */
	estimatedCompletion?: Date;

	/** Recent errors */
	errors: QueueError[];

	/** Processing throughput (items per minute) */
	throughput?: number;

	/** Average processing time per item */
	averageProcessingTime?: number;
}

/**
 * Error information for queue operations
 */
export interface QueueError {
	id: string;
	message: string;
	itemId?: string;
	timestamp: Date;
	severity: 'warning' | 'error' | 'critical';
	recoverable: boolean;
}

/**
 * Event data for queue changes
 */
export interface QueueChangeEvent {
	type: 'added' | 'removed' | 'updated' | 'reordered' | 'cleared';
	itemIds: string[];
	timestamp: Date;
}

/**
 * Event data for processing state changes
 */
export interface ProcessingStateEvent {
	type: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed';
	timestamp: Date;
	state: QueueState;
}

/**
 * Event data for individual item processing
 */
export interface ItemProcessedEvent {
	item: FileQueueItem;
	timestamp: Date;
	duration?: number;
}

/**
 * Configuration options for queue processing
 */
export interface QueueProcessingOptions {
	/** Maximum number of concurrent processing operations */
	maxConcurrency?: number;

	/** Timeout for individual item processing (ms) */
	itemTimeout?: number;

	/** Whether to continue processing on errors */
	continueOnError?: boolean;

	/** Auto-retry failed items */
	autoRetry?: boolean;

	/** Maximum retry attempts */
	maxRetries?: number;

	/** Delay between retries (ms) */
	retryDelay?: number;
}

/**
 * Service for managing file queues and processing operations
 */
export interface IFileQueueService {
	readonly _serviceBrand: undefined;

	// Queue Management

	/**
	 * Add a file to the processing queue
	 * @param filePath Path to the file to add
	 * @param priority Priority level for processing
	 * @param metadata Optional metadata
	 * @returns Promise resolving to the item ID
	 */
	addToQueue(filePath: string, priority?: QueueItemPriority, metadata?: Record<string, any>): Promise<string>;

	/**
	 * Add multiple files to the queue
	 * @param filePaths Array of file paths to add
	 * @param priority Priority level for all files
	 * @returns Promise resolving to array of item IDs
	 */
	addMultipleToQueue(filePaths: string[], priority?: QueueItemPriority): Promise<string[]>;

	/**
	 * Remove an item from the queue
	 * @param itemId ID of the item to remove
	 * @returns Promise resolving when item is removed
	 */
	removeFromQueue(itemId: string): Promise<void>;

	/**
	 * Remove multiple items from the queue
	 * @param itemIds Array of item IDs to remove
	 * @returns Promise resolving when items are removed
	 */
	removeMultipleFromQueue(itemIds: string[]): Promise<void>;

	/**
	 * Reorder items in the queue
	 * @param itemIds Array of item IDs in new order
	 * @returns Promise resolving when reordering is complete
	 */
	reorderQueue(itemIds: string[]): Promise<void>;

	/**
	 * Clear all items from the queue
	 * @param includeProcessing Whether to also cancel currently processing items
	 * @returns Promise resolving when queue is cleared
	 */
	clearQueue(includeProcessing?: boolean): Promise<void>;

	// Processing Control

	/**
	 * Start processing the queue
	 * @param options Optional processing configuration
	 * @returns Promise resolving when processing starts
	 */
	startProcessing(options?: QueueProcessingOptions): Promise<void>;

	/**
	 * Pause queue processing
	 * @returns Promise resolving when processing is paused
	 */
	pauseProcessing(): Promise<void>;

	/**
	 * Resume paused processing
	 * @returns Promise resolving when processing resumes
	 */
	resumeProcessing(): Promise<void>;

	/**
	 * Stop queue processing
	 * @param force Whether to force stop current operations
	 * @returns Promise resolving when processing stops
	 */
	stopProcessing(force?: boolean): Promise<void>;

	/**
	 * Cancel processing of a specific item
	 * @param itemId ID of the item to cancel
	 * @returns Promise resolving when item is cancelled
	 */
	cancelItem(itemId: string): Promise<void>;

	/**
	 * Retry a failed item
	 * @param itemId ID of the item to retry
	 * @returns Promise resolving when retry is queued
	 */
	retryItem(itemId: string): Promise<void>;

	// State Queries

	/**
	 * Get current queue state
	 * @returns Current processing state
	 */
	getQueueState(): QueueState;

	/**
	 * Get all items in the queue
	 * @param includeCompleted Whether to include completed items
	 * @returns Array of queue items
	 */
	getQueueItems(includeCompleted?: boolean): FileQueueItem[];

	/**
	 * Get a specific queue item
	 * @param itemId ID of the item to retrieve
	 * @returns Queue item or undefined if not found
	 */
	getQueueItem(itemId: string): FileQueueItem | undefined;

	/**
	 * Get items by status
	 * @param status Status to filter by
	 * @returns Array of items with the specified status
	 */
	getItemsByStatus(status: FileQueueItemStatus): FileQueueItem[];

	/**
	 * Get processing history
	 * @param limit Maximum number of items to return
	 * @returns Array of completed processing results
	 */
	getProcessingHistory(limit?: number): FileQueueItem[];

	/**
	 * Get queue statistics
	 * @returns Statistics about queue performance
	 */
	getQueueStatistics(): {
		totalProcessed: number;
		averageProcessingTime: number;
		successRate: number;
		throughput: number;
		currentQueueSize: number;
	};

	// Persistence

	/**
	 * Save current queue state to persistent storage
	 * @returns Promise resolving when state is saved
	 */
	saveState(): Promise<void>;

	/**
	 * Load queue state from persistent storage
	 * @returns Promise resolving when state is loaded
	 */
	loadState(): Promise<void>;

	/**
	 * Export queue data for backup/sharing
	 * @returns JSON representation of queue
	 */
	exportQueue(): string;

	/**
	 * Import queue data from backup
	 * @param data JSON data to import
	 * @param merge Whether to merge with existing queue
	 * @returns Promise resolving when import is complete
	 */
	importQueue(data: string, merge?: boolean): Promise<void>;

	// Events

	/**
	 * Fired when queue content changes (items added, removed, etc.)
	 */
	readonly onQueueChanged: Event<QueueChangeEvent>;

	/**
	 * Fired when processing state changes (started, paused, etc.)
	 */
	readonly onProcessingStateChanged: Event<ProcessingStateEvent>;

	/**
	 * Fired when an individual item is processed
	 */
	readonly onItemProcessed: Event<ItemProcessedEvent>;

	/**
	 * Fired when an error occurs during processing
	 */
	readonly onError: Event<QueueError>;

	// Utility

	/**
	 * Validate that a file can be added to the queue
	 * @param filePath Path to validate
	 * @returns Promise resolving to validation result
	 */
	validateFile(filePath: string): Promise<{ valid: boolean; reason?: string }>;

	/**
	 * Estimate processing time for a file
	 * @param filePath Path to estimate
	 * @returns Estimated duration in milliseconds
	 */
	estimateProcessingTime(filePath: string): Promise<number>;

}

export const IFileQueueService = createServiceIdentifier<IFileQueueService>('IFileQueueService');