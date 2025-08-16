/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Example usage of the FileQueueService in a VS Code extension
 * 
 * This file demonstrates how to use the FileQueueService for managing
 * file processing operations in a VS Code extension context.
 */

import * as vscode from 'vscode';
import { IFileQueueService, QueueItemPriority, FileQueueItemStatus } from '../common/fileQueueService';

/**
 * Example: Basic File Queue Operations
 * 
 * Shows how to add files to the queue, start processing, and monitor progress
 */
export async function basicFileQueueExample(
	fileQueueService: IFileQueueService,
	filePaths: string[]
): Promise<void> {
	try {
		console.log('=== Basic File Queue Example ===');

		// Add multiple files to the queue with different priorities
		const itemIds: string[] = [];

		for (const filePath of filePaths) {
			const priority = filePath.endsWith('.ts') ? QueueItemPriority.High : QueueItemPriority.Normal;
			const operation = filePath.endsWith('.test.ts') ? 'test' : 'analyze';

			const itemId = await fileQueueService.addToQueue(filePath, priority, operation, {
				source: 'example',
				timestamp: new Date().toISOString()
			});

			itemIds.push(itemId);
			console.log(`Added ${filePath} to queue with ID: ${itemId}`);
		}

		// Display current queue state
		const state = fileQueueService.getQueueState();
		console.log(`Queue state: ${state.totalCount} items, processing: ${state.isProcessing}`);

		// Start processing with custom options
		await fileQueueService.startProcessing({
			maxConcurrency: 2,
			itemTimeout: 30000, // 30 seconds
			continueOnError: true,
			autoRetry: true,
			maxRetries: 2
		});

		console.log('Processing started...');

		// Monitor processing progress
		await monitorProcessingProgress(fileQueueService);

	} catch (error) {
		console.error('Error in basic file queue example:', error);
	}
}

/**
 * Example: Advanced Queue Management
 * 
 * Demonstrates advanced features like reordering, filtering, and event handling
 */
export async function advancedQueueManagementExample(
	fileQueueService: IFileQueueService
): Promise<void> {
	console.log('=== Advanced Queue Management Example ===');

	// Set up event listeners for reactive updates
	const disposables: vscode.Disposable[] = [];

	// Listen to queue changes
	disposables.push(
		fileQueueService.onQueueChanged((event) => {
			console.log(`Queue changed: ${event.type}, affected items: ${event.itemIds.length}`);
		})
	);

	// Listen to processing state changes
	disposables.push(
		fileQueueService.onProcessingStateChanged((event) => {
			console.log(`Processing state: ${event.type} at ${event.timestamp}`);

			if (event.type === 'completed') {
				console.log('All items processed!');
				showProcessingResults(fileQueueService);
			}
		})
	);

	// Listen to individual item completion
	disposables.push(
		fileQueueService.onItemProcessed((event) => {
			const status = event.item.status === FileQueueItemStatus.Completed ? 'SUCCESS' : 'FAILED';
			console.log(`Item processed: ${event.item.fileName} - ${status} (${event.duration}ms)`);
		})
	);

	// Listen to errors
	disposables.push(
		fileQueueService.onError((error) => {
			console.error(`Queue error [${error.severity}]: ${error.message}`);

			if (error.severity === 'critical') {
				vscode.window.showErrorMessage(`Critical queue error: ${error.message}`);
			}
		})
	);

	try {
		// Demonstrate queue manipulation
		const testFiles = [
			'/workspace/src/components/Button.tsx',
			'/workspace/src/utils/helpers.ts',
			'/workspace/tests/Button.test.tsx',
			'/workspace/src/types/index.ts'
		];

		// Add files to queue
		const itemIds = await fileQueueService.addMultipleToQueue(
			testFiles,
			QueueItemPriority.Normal,
			'review'
		);

		// Reorder queue to prioritize test files
		const items = fileQueueService.getQueueItems();
		const testItems = items.filter(item => item.fileName.includes('.test.'));
		const nonTestItems = items.filter(item => !item.fileName.includes('.test.'));

		const reorderedIds = [...testItems.map(item => item.id), ...nonTestItems.map(item => item.id)];
		await fileQueueService.reorderQueue(reorderedIds);

		console.log('Queue reordered to prioritize test files');

		// Start processing
		await fileQueueService.startProcessing({
			maxConcurrency: 1,
			continueOnError: true
		});

	} catch (error) {
		console.error('Error in advanced queue management example:', error);
	} finally {
		// Clean up event listeners
		disposables.forEach(d => d.dispose());
	}
}

/**
 * Example: Queue Persistence and Recovery
 * 
 * Shows how to save and restore queue state across VS Code sessions
 */
export async function queuePersistenceExample(
	fileQueueService: IFileQueueService
): Promise<void> {
	console.log('=== Queue Persistence Example ===');

	try {
		// Load any previously saved queue state
		await fileQueueService.loadState();
		console.log('Previous queue state loaded');

		// Check if there are any items from previous session
		const existingItems = fileQueueService.getQueueItems(true); // Include completed
		if (existingItems.length > 0) {
			console.log(`Found ${existingItems.length} items from previous session`);

			// Show items by status
			const pendingItems = fileQueueService.getItemsByStatus(FileQueueItemStatus.Pending);
			const failedItems = fileQueueService.getItemsByStatus(FileQueueItemStatus.Failed);

			console.log(`Pending: ${pendingItems.length}, Failed: ${failedItems.length}`);

			// Retry failed items
			for (const item of failedItems) {
				await fileQueueService.retryItem(item.id);
				console.log(`Retrying failed item: ${item.fileName}`);
			}
		}

		// Export queue for backup
		const exportData = fileQueueService.exportQueue();
		console.log('Queue exported for backup:', exportData.length, 'characters');

		// Save current state (this happens automatically, but can be done manually)
		await fileQueueService.saveState();
		console.log('Queue state saved');

	} catch (error) {
		console.error('Error in queue persistence example:', error);
	}
}

/**
 * Example: File Validation and Processing Estimation
 * 
 * Demonstrates file validation and processing time estimation
 */
export async function fileValidationExample(
	fileQueueService: IFileQueueService,
	candidateFiles: string[]
): Promise<string[]> {
	console.log('=== File Validation Example ===');

	const validFiles: string[] = [];
	const estimates: { [filePath: string]: number } = {};

	for (const filePath of candidateFiles) {
		try {
			// Validate file before adding to queue
			const validation = await fileQueueService.validateFile(filePath);

			if (validation.valid) {
				validFiles.push(filePath);

				// Get processing time estimate
				const estimate = await fileQueueService.estimateProcessingTime(filePath, 'analyze');
				estimates[filePath] = estimate;

				console.log(`✓ ${filePath} - valid (estimated: ${estimate}ms)`);
			} else {
				console.log(`✗ ${filePath} - invalid: ${validation.reason}`);
			}
		} catch (error) {
			console.log(`✗ ${filePath} - error: ${error}`);
		}
	}

	// Show total estimated processing time
	const totalEstimate = Object.values(estimates).reduce((sum, time) => sum + time, 0);
	console.log(`Total estimated processing time: ${totalEstimate}ms (${(totalEstimate / 1000).toFixed(1)}s)`);

	// Show available operations
	const operations = fileQueueService.getAvailableOperations();
	console.log('Available operations:', operations.join(', '));

	return validFiles;
}

/**
 * Monitor processing progress and display updates
 */
async function monitorProcessingProgress(fileQueueService: IFileQueueService): Promise<void> {
	return new Promise((resolve) => {
		const disposable = fileQueueService.onProcessingStateChanged((event) => {
			if (event.type === 'completed' || event.type === 'stopped') {
				disposable.dispose();
				resolve();
			}
		});

		// Show progress updates every few seconds
		const progressInterval = setInterval(() => {
			const state = fileQueueService.getQueueState();
			const stats = fileQueueService.getQueueStatistics();

			if (state.isProcessing) {
				console.log(`Progress: ${state.processedCount}/${state.totalCount + state.processedCount} ` +
					`(${stats.successRate * 100}% success rate, ${stats.throughput.toFixed(1)} items/min)`);
			} else {
				clearInterval(progressInterval);
			}
		}, 2000);
	});
}

/**
 * Display processing results and statistics
 */
function showProcessingResults(fileQueueService: IFileQueueService): void {
	console.log('=== Processing Results ===');

	const stats = fileQueueService.getQueueStatistics();
	const history = fileQueueService.getProcessingHistory(10); // Last 10 items

	console.log(`Total processed: ${stats.totalProcessed}`);
	console.log(`Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
	console.log(`Average processing time: ${stats.averageProcessingTime.toFixed(0)}ms`);
	console.log(`Throughput: ${stats.throughput.toFixed(1)} items/minute`);

	if (history.length > 0) {
		console.log('\nRecent processing history:');
		history.forEach((item, index) => {
			const status = item.status === FileQueueItemStatus.Completed ? '✓' : '✗';
			const duration = item.result?.duration || 0;
			console.log(`  ${index + 1}. ${status} ${item.fileName} (${duration}ms)`);
		});
	}

	// Show any recent errors
	const state = fileQueueService.getQueueState();
	if (state.errors.length > 0) {
		console.log('\nRecent errors:');
		state.errors.slice(-3).forEach((error, index) => {
			console.log(`  ${index + 1}. [${error.severity}] ${error.message}`);
		});
	}
}

/**
 * Command handler example for VS Code extension
 * 
 * This would be registered as a command in package.json and called from VS Code
 */
export async function handleFileQueueCommand(
	fileQueueService: IFileQueueService,
	command: string,
	...args: any[]
): Promise<void> {
	switch (command) {
		case 'addCurrentFile':
			await addCurrentFileToQueue(fileQueueService);
			break;

		case 'addWorkspaceFiles':
			await addWorkspaceFilesToQueue(fileQueueService);
			break;

		case 'showQueueStatus':
			await showQueueStatusPanel(fileQueueService);
			break;

		case 'startProcessing':
			await fileQueueService.startProcessing();
			vscode.window.showInformationMessage('File queue processing started');
			break;

		case 'stopProcessing':
			await fileQueueService.stopProcessing();
			vscode.window.showInformationMessage('File queue processing stopped');
			break;

		case 'clearQueue':
			await fileQueueService.clearQueue();
			vscode.window.showInformationMessage('File queue cleared');
			break;

		default:
			vscode.window.showErrorMessage(`Unknown command: ${command}`);
	}
}

async function addCurrentFileToQueue(fileQueueService: IFileQueueService): Promise<void> {
	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor) {
		vscode.window.showWarningMessage('No active file to add to queue');
		return;
	}

	const filePath = activeEditor.document.uri.fsPath;
	try {
		const itemId = await fileQueueService.addToQueue(filePath, QueueItemPriority.High, 'review');
		vscode.window.showInformationMessage(`Added ${activeEditor.document.fileName} to processing queue`);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to add file to queue: ${error}`);
	}
}

async function addWorkspaceFilesToQueue(fileQueueService: IFileQueueService): Promise<void> {
	const files = await vscode.workspace.findFiles('**/*.{ts,js,tsx,jsx}', '**/node_modules/**');

	if (files.length === 0) {
		vscode.window.showInformationMessage('No files found in workspace');
		return;
	}

	const filePaths = files.map(uri => uri.fsPath);

	try {
		const itemIds = await fileQueueService.addMultipleToQueue(filePaths, QueueItemPriority.Normal, 'analyze');
		vscode.window.showInformationMessage(`Added ${itemIds.length} files to processing queue`);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to add files to queue: ${error}`);
	}
}

async function showQueueStatusPanel(fileQueueService: IFileQueueService): Promise<void> {
	const state = fileQueueService.getQueueState();
	const stats = fileQueueService.getQueueStatistics();
	const items = fileQueueService.getQueueItems(true);

	const statusMessage = `
Queue Status:
• Total items: ${state.totalCount}
• Processed: ${state.processedCount}
• Failed: ${state.failedCount}
• Processing: ${state.isProcessing ? 'Yes' : 'No'}
• Success rate: ${(stats.successRate * 100).toFixed(1)}%
• Average time: ${stats.averageProcessingTime.toFixed(0)}ms

Recent items:
${items.slice(-5).map(item => `• ${item.fileName} - ${item.status}`).join('\n')}
	`.trim();

	vscode.window.showInformationMessage(statusMessage, { modal: true });
}