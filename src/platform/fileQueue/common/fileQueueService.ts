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
 * Information about a completed queue run for repeat functionality
 */
export interface LastRunInfo {
	/** File paths that were processed in the last run */
	filePaths: string[];

	/** When the last run was completed */
	completedAt: Date;

	/** Number of successfully processed files */
	successCount: number;

	/** Total number of files that were attempted */
	totalCount: number;

	/** Processing options used for the last run */
	processingOptions?: QueueProcessingOptions;

	/** Metadata about files from the last run */
	fileMetadata?: Record<string, Record<string, any>>;
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

	/** 
	 * Maximum time to wait for chat processing completion between files (ms)
	 * The system will use intelligent monitoring to detect when chat responses
	 * are likely complete, but will fall back to this timeout as a safety net.
	 * Default: 60000ms (60 seconds)
	 */
	chatWaitTime?: number;
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
	 * @param metadata Optional metadata
	 * @returns Promise resolving to the item ID
	 */
	addToQueue(filePath: string, metadata?: Record<string, any>): Promise<string>;

	/**
	 * Add multiple files to the queue
	 * @param filePaths Array of file paths to add
	 * @returns Promise resolving to array of item IDs
	 */
	addMultipleToQueue(filePaths: string[]): Promise<string[]>;

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

	// Repeat Functionality

	/**
	 * Repeat the last successful queue run
	 * @param options Optional processing configuration for the repeat run
	 * @returns Promise resolving when repeat queue is started
	 */
	repeatLastRun(options?: QueueProcessingOptions): Promise<void>;

	/**
	 * Get information about the last run that can be repeated
	 * @returns Information about the last run or undefined if none available
	 */
	getLastRunInfo(): LastRunInfo | undefined;

	/**
	 * Check if there is a last run available to repeat
	 * @returns True if a last run is available to repeat
	 */
	canRepeatLastRun(): boolean;

}

export const IFileQueueService = createServiceIdentifier<IFileQueueService>('IFileQueueService');