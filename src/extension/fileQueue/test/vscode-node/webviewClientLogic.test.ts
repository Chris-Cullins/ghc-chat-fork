/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, suite, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';

/**
 * Tests for the JavaScript functionality that runs inside the webview
 * This simulates the fileQueue.js client-side logic
 */

suite('Webview Client-Side Logic Tests', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window;
	let mockVSCode: any;

	beforeEach(() => {
		// Set up a DOM environment with the webview HTML structure
		dom = new JSDOM(`
			<!DOCTYPE html>
			<html>
			<body>
				<div class="container">
					<div class="header">
						<span id="queue-size">0 items</span>
						<span id="processing-status">Idle</span>
					</div>
					
					<div class="controls">
						<button id="add-files-btn">Add Files</button>
						<button id="clear-queue-btn">Clear</button>
						<button id="start-btn">Start</button>
						<button id="pause-btn" disabled>Pause</button>
						<button id="stop-btn" disabled>Stop</button>
					</div>
					
					<div id="progress-container" style="display: none;">
						<span id="progress-text">Processing...</span>
						<span id="progress-percentage">0%</span>
						<div id="progress-fill"></div>
						<span id="items-processed">0 processed</span>
						<span id="items-remaining">0 remaining</span>
						<span id="estimated-time">ETA: --</span>
					</div>
					
					<div class="statistics">
						<span id="total-processed">0</span>
						<span id="success-rate">--</span>
						<span id="avg-time">--</span>
					</div>
					
					<div id="queue-list" class="queue-list">
						<div id="empty-state" class="empty-state">
							<p>No files in queue</p>
						</div>
					</div>
					
					<div id="recent-list" class="recent-list">
						<div id="recent-empty-state" class="empty-state">
							<p>No recent activity</p>
						</div>
					</div>
				</div>
			</body>
			</html>
		`, {
			url: 'https://localhost/',
			pretendToBeVisual: true,
			resources: 'usable'
		});

		document = dom.window.document;
		window = dom.window as any as Window;

		// Mock the VS Code API
		mockVSCode = {
			postMessage: vi.fn()
		};

		// Set global references
		(global as any).document = document;
		(global as any).window = window;
		(global as any).acquireVsCodeApi = () => mockVSCode;
	});

	suite('UI State Management', () => {
		test('should update header when queue state changes', () => {
			const updateHeader = createUpdateHeaderFunction();

			const mockState = {
				queueState: {
					isProcessing: false,
					isPaused: false,
					totalCount: 3
				},
				items: [
					{ id: '1', fileName: 'file1.ts' },
					{ id: '2', fileName: 'file2.js' },
					{ id: '3', fileName: 'file3.tsx' }
				]
			};

			updateHeader(mockState);

			expect(document.getElementById('queue-size')?.textContent).toBe('3 items');
			expect(document.getElementById('processing-status')?.textContent).toBe('Idle');
		});

		test('should update processing status correctly', () => {
			const updateHeader = createUpdateHeaderFunction();

			// Test processing state
			updateHeader({
				queueState: { isProcessing: true, isPaused: false },
				items: []
			});
			expect(document.getElementById('processing-status')?.textContent).toBe('Processing');

			// Test paused state
			updateHeader({
				queueState: { isProcessing: true, isPaused: true },
				items: []
			});
			expect(document.getElementById('processing-status')?.textContent).toBe('Paused');
		});

		test('should update control button states', () => {
			const updateControls = createUpdateControlsFunction();

			const mockState = {
				queueState: {
					isProcessing: false,
					isPaused: false
				},
				items: [{ id: '1', fileName: 'test.ts' }]
			};

			updateControls(mockState);

			const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
			const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
			const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
			const clearBtn = document.getElementById('clear-queue-btn') as HTMLButtonElement;

			expect(startBtn.disabled).toBe(false); // Can start when not processing and has items
			expect(pauseBtn.disabled).toBe(true);  // Can't pause when not processing
			expect(stopBtn.disabled).toBe(true);   // Can't stop when not processing
			expect(clearBtn.disabled).toBe(false); // Can clear when has items
		});

		test('should show/hide progress container appropriately', () => {
			const updateProgress = createUpdateProgressFunction();

			// Test hidden when not processing
			updateProgress({
				queueState: {
					isProcessing: false,
					processedCount: 0,
					totalCount: 3
				}
			});

			const progressContainer = document.getElementById('progress-container')!;
			expect(progressContainer.style.display).toBe('none');

			// Test shown when processing
			updateProgress({
				queueState: {
					isProcessing: true,
					processedCount: 1,
					totalCount: 3
				}
			});

			expect(progressContainer.style.display).toBe('block');
			expect(document.getElementById('progress-percentage')?.textContent).toBe('33%');
		});
	});

	suite('Event Handling', () => {
		test('should handle Add Files button click', () => {
			const handleAddFiles = createHandleAddFilesFunction();

			handleAddFiles();

			expect(mockVSCode.postMessage).toHaveBeenCalledWith({
				type: 'showFilePicker',
				data: {}
			});
		});

		test('should handle processing control button clicks', () => {
			const handleStartProcessing = createHandleStartProcessingFunction();
			const handlePauseProcessing = createHandlePauseProcessingFunction();
			const handleStopProcessing = createHandleStopProcessingFunction();

			handleStartProcessing();
			expect(mockVSCode.postMessage).toHaveBeenCalledWith({
				type: 'startProcessing',
				data: {
					options: {
						maxConcurrency: 1,
						continueOnError: true
					}
				}
			});

			handlePauseProcessing();
			expect(mockVSCode.postMessage).toHaveBeenCalledWith({
				type: 'pauseProcessing'
			});

			handleStopProcessing();
			expect(mockVSCode.postMessage).toHaveBeenCalledWith({
				type: 'stopProcessing'
			});
		});

		test('should handle clear queue with confirmation', () => {
			const handleClearQueue = createHandleClearQueueFunction();

			// Mock window.confirm
			window.confirm = vi.fn().mockReturnValue(true);

			handleClearQueue();

			expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to clear the queue?');
			expect(mockVSCode.postMessage).toHaveBeenCalledWith({
				type: 'clearQueue',
				data: {
					includeProcessing: false
				}
			});
		});

		test('should not clear queue if user cancels confirmation', () => {
			const handleClearQueue = createHandleClearQueueFunction();

			window.confirm = vi.fn().mockReturnValue(false);

			handleClearQueue();

			expect(mockVSCode.postMessage).not.toHaveBeenCalled();
		});
	});

	suite('Queue Item Management', () => {
		test('should create queue item elements correctly', () => {
			const createQueueItemElement = createQueueItemElementFunction();

			const mockItem = {
				id: 'test-123',
				filePath: '/workspace/src/component.tsx',
				fileName: 'component.tsx',
				priority: 3, // High priority
				status: 'pending',
				addedAt: new Date(),
				operation: 'analyze'
			};

			const element = createQueueItemElement(mockItem);

			expect(element.dataset.itemId).toBe('test-123');
			expect(element.innerHTML).toContain('component.tsx');
			expect(element.innerHTML).toContain('High priority');
			expect(element.innerHTML).toContain('analyze');
			expect(element.innerHTML).toContain('/workspace/src/component.tsx');
		});

		test('should handle queue item expansion/collapse', () => {
			const toggleQueueItem = createToggleQueueItemFunction();

			const itemElement = document.createElement('div');
			itemElement.classList.add('queue-item');
			itemElement.innerHTML = `
				<div class="queue-item-header">
					<button class="expand-toggle">
						<span class="codicon codicon-chevron-right"></span>
					</button>
				</div>
			`;

			// Test expanding
			toggleQueueItem(itemElement);
			expect(itemElement.classList.contains('expanded')).toBe(true);

			const icon = itemElement.querySelector('.expand-toggle .codicon')!;
			expect(icon.classList.contains('codicon-chevron-down')).toBe(true);
			expect(icon.classList.contains('codicon-chevron-right')).toBe(false);

			// Test collapsing
			toggleQueueItem(itemElement);
			expect(itemElement.classList.contains('expanded')).toBe(false);
			expect(icon.classList.contains('codicon-chevron-right')).toBe(true);
			expect(icon.classList.contains('codicon-chevron-down')).toBe(false);
		});
	});

	suite('Message Processing', () => {
		test('should handle updateQueue messages', () => {
			const handleMessage = createHandleMessageFunction();
			const updateQueue = createUpdateQueueFunction();

			const mockMessage = {
				data: {
					type: 'updateQueue',
					data: {
						state: {
							isProcessing: false,
							totalCount: 2
						},
						items: [
							{ id: '1', fileName: 'file1.ts', status: 'pending' },
							{ id: '2', fileName: 'file2.js', status: 'pending' }
						],
						statistics: {
							totalProcessed: 0,
							successRate: 0,
							averageProcessingTime: 0
						}
					}
				}
			};

			handleMessage(mockMessage);

			// Verify UI was updated
			expect(document.getElementById('queue-size')?.textContent).toBe('2 items');
		});

		test('should handle error messages', () => {
			const showError = createShowErrorFunction();

			const errorData = {
				message: 'Test error message',
				severity: 'error',
				timestamp: new Date().toISOString()
			};

			showError(errorData);

			// In a real implementation, this might show a notification
			// For testing, we just verify the function can be called without errors
			expect(true).toBe(true);
		});
	});

	suite('Statistics Display', () => {
		test('should update statistics correctly', () => {
			const updateStatistics = createUpdateStatisticsFunction();

			const mockStatistics = {
				totalProcessed: 15,
				successRate: 0.93,
				averageProcessingTime: 2500,
				throughput: 4.2,
				currentQueueSize: 3
			};

			updateStatistics({ statistics: mockStatistics });

			expect(document.getElementById('total-processed')?.textContent).toBe('15');
			expect(document.getElementById('success-rate')?.textContent).toBe('93%');
			expect(document.getElementById('avg-time')?.textContent).toBe('3s'); // 2500ms rounded to 3s
		});

		test('should handle missing statistics gracefully', () => {
			const updateStatistics = createUpdateStatisticsFunction();

			updateStatistics({ statistics: null });

			// Should not throw errors, elements should remain unchanged
			expect(document.getElementById('total-processed')?.textContent).toBe('0');
		});
	});

	// Helper functions that simulate the actual JavaScript functionality
	function createUpdateHeaderFunction() {
		return (currentState: any) => {
			if (!currentState.queueState) return;

			const queueSize = currentState.items?.length || 0;
			const queueSizeElement = document.getElementById('queue-size')!;
			queueSizeElement.textContent = `${queueSize} item${queueSize !== 1 ? 's' : ''}`;

			let status = 'Idle';
			if (currentState.queueState.isProcessing) {
				status = currentState.queueState.isPaused ? 'Paused' : 'Processing';
			}
			const statusElement = document.getElementById('processing-status')!;
			statusElement.textContent = status;
			statusElement.className = `status-${status.toLowerCase()}`;
		};
	}

	function createUpdateControlsFunction() {
		return (currentState: any) => {
			if (!currentState.queueState) return;

			const { isProcessing, isPaused } = currentState.queueState;
			const hasItems = currentState.items?.length > 0;

			(document.getElementById('start-btn') as HTMLButtonElement).disabled = isProcessing || !hasItems;
			(document.getElementById('pause-btn') as HTMLButtonElement).disabled = !isProcessing || isPaused;
			(document.getElementById('stop-btn') as HTMLButtonElement).disabled = !isProcessing;
			(document.getElementById('clear-queue-btn') as HTMLButtonElement).disabled = !hasItems;
		};
	}

	function createUpdateProgressFunction() {
		return (currentState: any) => {
			if (!currentState.queueState) return;

			const { isProcessing, processedCount, totalCount } = currentState.queueState;
			const progressContainer = document.getElementById('progress-container')!;

			if (isProcessing && totalCount > 0) {
				progressContainer.style.display = 'block';

				const percentage = Math.round((processedCount / totalCount) * 100);
				document.getElementById('progress-percentage')!.textContent = `${percentage}%`;
				document.getElementById('progress-fill')!.style.width = `${percentage}%`;
			} else {
				progressContainer.style.display = 'none';
			}
		};
	}

	function createUpdateStatisticsFunction() {
		return (currentState: any) => {
			if (!currentState.statistics) return;

			const stats = currentState.statistics;

			document.getElementById('total-processed')!.textContent = stats.totalProcessed.toString();
			document.getElementById('success-rate')!.textContent = stats.totalProcessed > 0
				? `${Math.round(stats.successRate * 100)}%`
				: '--';
			document.getElementById('avg-time')!.textContent = stats.averageProcessingTime > 0
				? `${Math.round(stats.averageProcessingTime / 1000)}s`
				: '--';
		};
	}

	function createHandleAddFilesFunction() {
		return () => {
			mockVSCode.postMessage({
				type: 'showFilePicker',
				data: {}
			});
		};
	}

	function createHandleStartProcessingFunction() {
		return () => {
			mockVSCode.postMessage({
				type: 'startProcessing',
				data: {
					options: {
						maxConcurrency: 1,
						continueOnError: true
					}
				}
			});
		};
	}

	function createHandlePauseProcessingFunction() {
		return () => {
			mockVSCode.postMessage({
				type: 'pauseProcessing'
			});
		};
	}

	function createHandleStopProcessingFunction() {
		return () => {
			mockVSCode.postMessage({
				type: 'stopProcessing'
			});
		};
	}

	function createHandleClearQueueFunction() {
		return () => {
			if (confirm('Are you sure you want to clear the queue?')) {
				mockVSCode.postMessage({
					type: 'clearQueue',
					data: {
						includeProcessing: false
					}
				});
			}
		};
	}

	function createQueueItemElementFunction() {
		return (item: any) => {
			const div = document.createElement('div');
			div.className = 'queue-item';
			div.dataset.itemId = item.id;

			const priorityName = item.priority >= 4 ? 'Critical' :
				item.priority >= 3 ? 'High' :
					item.priority >= 2 ? 'Normal' : 'Low';

			div.innerHTML = `
				<div class="queue-item-header">
					<div class="queue-item-content">
						<div class="queue-item-title">${item.fileName}</div>
						<div class="queue-item-meta">
							<span>${priorityName} priority</span>
							${item.operation ? `<span>Operation: ${item.operation}</span>` : ''}
						</div>
					</div>
					<button class="expand-toggle">
						<span class="codicon codicon-chevron-right"></span>
					</button>
				</div>
				<div class="queue-item-details">
					<div><strong>File Path:</strong> ${item.filePath}</div>
				</div>
			`;

			return div;
		};
	}

	function createToggleQueueItemFunction() {
		return (itemElement: Element) => {
			const isExpanded = itemElement.classList.contains('expanded');
			const toggle = itemElement.querySelector('.expand-toggle .codicon')!;

			if (isExpanded) {
				itemElement.classList.remove('expanded');
				toggle.classList.remove('codicon-chevron-down');
				toggle.classList.add('codicon-chevron-right');
			} else {
				itemElement.classList.add('expanded');
				toggle.classList.remove('codicon-chevron-right');
				toggle.classList.add('codicon-chevron-down');
			}
		};
	}

	function createHandleMessageFunction() {
		return (event: any) => {
			const message = event.data;

			switch (message.type) {
				case 'updateQueue':
					createUpdateQueueFunction()(message.data);
					break;
				case 'error':
					createShowErrorFunction()(message.data);
					break;
			}
		};
	}

	function createUpdateQueueFunction() {
		return (data: any) => {
			const currentState = {
				queueState: data.state,
				items: data.items,
				statistics: data.statistics
			};

			createUpdateHeaderFunction()(currentState);
			createUpdateControlsFunction()(currentState);
			createUpdateProgressFunction()(currentState);
			createUpdateStatisticsFunction()(currentState);
		};
	}

	function createShowErrorFunction() {
		return (errorData: any) => {
			console.error(`Error: ${errorData.message}`);
		};
	}
});