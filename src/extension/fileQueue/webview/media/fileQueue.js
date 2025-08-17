/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * @typedef {Object} FileQueueItem
 * @property {string} id
 * @property {string} filePath
 * @property {string} fileName
 * @property {number} priority
 * @property {string} status
 * @property {Date} addedAt
 * @property {Date} [processedAt]
 * @property {Date} [completedAt]
 * @property {string} [error]
 * @property {Object} [result]
 * @property {Object} [metadata]
 * @property {number} [estimatedDuration]
 * @property {string} [operation]
 */

/**
 * @typedef {Object} QueueState
 * @property {boolean} isProcessing
 * @property {boolean} isPaused
 * @property {string} [currentItemId]
 * @property {number} processedCount
 * @property {number} totalCount
 * @property {number} failedCount
 * @property {Date} [startedAt]
 * @property {Date} [estimatedCompletion]
 * @property {Array} errors
 * @property {number} [throughput]
 * @property {number} [averageProcessingTime]
 */

/**
 * @typedef {Object} QueueStatistics
 * @property {number} totalProcessed
 * @property {number} averageProcessingTime
 * @property {number} successRate
 * @property {number} throughput
 * @property {number} currentQueueSize
 */

(function () {
	'use strict';

	// VS Code API
	const vscode = acquireVsCodeApi();

	// State
	const currentState = {
		/** @type {QueueState} */
		queueState: null,
		/** @type {FileQueueItem[]} */
		items: [],
		/** @type {QueueStatistics} */
		statistics: null,
		/** @type {boolean} */
		canRepeat: false
	};

	// DOM Elements
	const elements = {
		// Header
		queueSize: document.getElementById('queue-size'),
		processingStatus: document.getElementById('processing-status'),

		// Controls
		addFilesBtn: document.getElementById('add-files-btn'),
		clearQueueBtn: document.getElementById('clear-queue-btn'),
		startBtn: document.getElementById('start-btn'),
		repeatBtn: document.getElementById('repeat-btn'),
		pauseBtn: document.getElementById('pause-btn'),
		stopBtn: document.getElementById('stop-btn'),

		// Progress
		progressContainer: document.getElementById('progress-container'),
		progressText: document.getElementById('progress-text'),
		progressPercentage: document.getElementById('progress-percentage'),
		progressFill: document.getElementById('progress-fill'),
		itemsProcessed: document.getElementById('items-processed'),
		itemsRemaining: document.getElementById('items-remaining'),
		estimatedTime: document.getElementById('estimated-time'),

		// Statistics
		totalProcessed: document.getElementById('total-processed'),
		successRate: document.getElementById('success-rate'),
		avgTime: document.getElementById('avg-time'),

		// Queue
		queueList: document.getElementById('queue-list'),
		emptyState: document.getElementById('empty-state'),
		expandAllBtn: document.getElementById('expand-all-btn'),
		collapseAllBtn: document.getElementById('collapse-all-btn'),

		// Recent
		recentList: document.getElementById('recent-list'),
		recentEmptyState: document.getElementById('recent-empty-state'),
		clearHistoryBtn: document.getElementById('clear-history-btn')
	};

	// Initialize
	function initialize() {
		setupEventListeners();
		updateUI();
	}

	function setupEventListeners() {
		// Control buttons
		elements.addFilesBtn.addEventListener('click', handleAddFiles);
		elements.clearQueueBtn.addEventListener('click', handleClearQueue);
		elements.startBtn.addEventListener('click', handleStartProcessing);
		elements.repeatBtn.addEventListener('click', handleRepeatLastRun);
		elements.pauseBtn.addEventListener('click', handlePauseProcessing);
		elements.stopBtn.addEventListener('click', handleStopProcessing);

		// Queue actions
		elements.expandAllBtn.addEventListener('click', handleExpandAll);
		elements.collapseAllBtn.addEventListener('click', handleCollapseAll);
		elements.clearHistoryBtn.addEventListener('click', handleClearHistory);

		// Listen for messages from extension
		window.addEventListener('message', handleMessage);

		// Drag and drop
		setupDragAndDrop();
	}

	function setupDragAndDrop() {
		// Setup drag and drop on both the queue list and the entire container
		const dropZones = [elements.queueList, elements.emptyState, document.querySelector('.container')];

		dropZones.forEach(zone => {
			if (zone) {
				zone.addEventListener('dragover', handleDragOver);
				zone.addEventListener('drop', handleDrop);
				zone.addEventListener('dragleave', handleDragLeave);
				zone.addEventListener('dragenter', handleDragEnter);
			}
		});

		// Prevent default drag behavior on the entire document
		document.addEventListener('dragover', (e) => {
			e.preventDefault();
		});

		document.addEventListener('drop', (e) => {
			e.preventDefault();
		});

		// Add visual cues to the empty state
		if (elements.emptyState) {
			const emptyStateText = elements.emptyState.querySelector('p');
			if (emptyStateText && emptyStateText.textContent === 'No files in queue') {
				emptyStateText.textContent = 'No files in queue - Drag files here to add them';
			}
		}
	}

	// Event handlers
	function handleAddFiles() {
		// Request file picker from extension
		vscode.postMessage({
			type: 'showFilePicker',
			data: {}
		});
	}

	function handleClearQueue() {
		if (confirm('Are you sure you want to clear the queue?')) {
			vscode.postMessage({
				type: 'clearQueue',
				data: {
					includeProcessing: false
				}
			});
		}
	}

	function handleStartProcessing() {
		vscode.postMessage({
			type: 'startProcessing',
			data: {
				options: {
					maxConcurrency: 1,
					continueOnError: true,
					chatWaitTime: 60000 // 60 seconds max wait with intelligent monitoring
				}
			}
		});
	}

	function handlePauseProcessing() {
		vscode.postMessage({
			type: 'pauseProcessing'
		});
	}

	function handleRepeatLastRun() {
		vscode.postMessage({
			type: 'repeatLastRun',
			data: {
				options: {
					maxConcurrency: 1,
					continueOnError: true,
					chatWaitTime: 60000 // 60 seconds max wait with intelligent monitoring
				}
			}
		});
	}

	function handleStopProcessing() {
		vscode.postMessage({
			type: 'stopProcessing'
		});
	}

	function handleExpandAll() {
		const items = elements.queueList.querySelectorAll('.queue-item');
		items.forEach(item => {
			item.classList.add('expanded');
			const toggle = item.querySelector('.expand-toggle .codicon');
			if (toggle) {
				toggle.classList.remove('codicon-chevron-right');
				toggle.classList.add('codicon-chevron-down');
			}
		});
	}

	function handleCollapseAll() {
		const items = elements.queueList.querySelectorAll('.queue-item');
		items.forEach(item => {
			item.classList.remove('expanded');
			const toggle = item.querySelector('.expand-toggle .codicon');
			if (toggle) {
				toggle.classList.remove('codicon-chevron-down');
				toggle.classList.add('codicon-chevron-right');
			}
		});
	}

	function handleClearHistory() {
		if (confirm('Are you sure you want to clear the processing history?')) {
			// This would need to be implemented in the service
			console.log('Clear history not yet implemented');
		}
	}

	function handleDragEnter(e) {
		e.preventDefault();
		e.stopPropagation();

		// Add visual feedback for all drop zones
		document.body.classList.add('drag-active');
		e.currentTarget.classList.add('drag-over');
	}

	function handleDragOver(e) {
		e.preventDefault();
		e.stopPropagation();

		// Set the appropriate drop effect
		e.dataTransfer.dropEffect = 'copy';

		// Ensure visual feedback is maintained
		e.currentTarget.classList.add('drag-over');
	}

	function handleDrop(e) {
		e.preventDefault();
		e.stopPropagation();

		// Clean up visual feedback
		document.body.classList.remove('drag-active');
		e.currentTarget.classList.remove('drag-over');

		// Get dropped data
		const dataTransfer = e.dataTransfer;
		let filePaths = [];

		// Debug logging
		console.log('Drag and drop data received:');
		console.log('- Types:', dataTransfer.types);
		console.log('- Files count:', dataTransfer.files ? dataTransfer.files.length : 0);
		console.log('- URI list:', dataTransfer.getData('text/uri-list'));
		console.log('- VS Code explorer data:', dataTransfer.getData('application/vnd.code.tree.explorer'));
		console.log('- Plain text:', dataTransfer.getData('text/plain'));

		// Log all available data transfer types and their content for debugging
		for (let i = 0; i < dataTransfer.types.length; i++) {
			const type = dataTransfer.types[i];
			const data = dataTransfer.getData(type);
			console.log(`- Type "${type}":`, data);
		}

		try {
			// Handle VS Code internal file drops (from explorer) - primary method
			// VS Code typically puts URIs in the text/uri-list format
			if (dataTransfer.types.includes('text/uri-list') && dataTransfer.getData('text/uri-list')) {
				const uriList = dataTransfer.getData('text/uri-list');
				const uris = uriList.split('\n').filter(uri => uri.trim());

				filePaths = uris.map(uri => {
					// Convert file:// URIs to local paths with proper decoding
					if (uri.startsWith('file://')) {
						let decodedPath = decodeURIComponent(uri.replace('file://', ''));
						// Handle Windows paths that start with /C:/ 
						if (decodedPath.match(/^\/[A-Za-z]:/)) {
							decodedPath = decodedPath.substring(1);
						}
						return decodedPath;
					}
					return uri;
				}).filter(path => path && path.trim());
			}

			// Handle VS Code specific data format (primary method for VS Code Explorer)
			if (dataTransfer.getData('application/vnd.code.tree.explorer')) {
				const explorerData = dataTransfer.getData('application/vnd.code.tree.explorer');
				try {
					const parsedData = JSON.parse(explorerData);
					if (Array.isArray(parsedData)) {
						const paths = parsedData.map(item => {
							// Handle different VS Code data formats
							if (typeof item === 'string') {
								return item;
							}
							if (item.uri) {
								// Parse VS Code URI format
								if (typeof item.uri === 'string') {
									if (item.uri.startsWith('file://')) {
										let decodedPath = decodeURIComponent(item.uri.replace('file://', ''));
										if (decodedPath.match(/^\/[A-Za-z]:/)) {
											decodedPath = decodedPath.substring(1);
										}
										return decodedPath;
									}
									return item.uri;
								}
								// Handle URI object format
								if (item.uri.fsPath) {
									return item.uri.fsPath;
								}
								if (item.uri.path) {
									return item.uri.path;
								}
							}
							if (item.path) {
								return item.path;
							}
							if (item.fsPath) {
								return item.fsPath;
							}
							return null;
						}).filter(Boolean);
						filePaths.push(...paths);
					}
				} catch (parseError) {
					console.warn('Failed to parse VS Code explorer data:', parseError);
				}
			}

			// Handle VS Code resource data (alternative format)
			if (dataTransfer.getData('application/vnd.code.tree.file') || dataTransfer.getData('application/vnd.code.tree.folder')) {
				const resourceData = dataTransfer.getData('application/vnd.code.tree.file') || dataTransfer.getData('application/vnd.code.tree.folder');
				try {
					const parsedData = JSON.parse(resourceData);
					if (parsedData && (parsedData.uri || parsedData.path)) {
						const resourcePath = parsedData.uri || parsedData.path;
						if (resourcePath.startsWith('file://')) {
							let decodedPath = decodeURIComponent(resourcePath.replace('file://', ''));
							if (decodedPath.match(/^\/[A-Za-z]:/)) {
								decodedPath = decodedPath.substring(1);
							}
							filePaths.push(decodedPath);
						} else {
							filePaths.push(resourcePath);
						}
					}
				} catch (parseError) {
					console.warn('Failed to parse VS Code resource data:', parseError);
				}
			}

			// Handle external file drops (from file manager)
			// Note: For security reasons, webviews can't access full file paths from external drops
			// We need to inform the user about this limitation
			if (dataTransfer.files && dataTransfer.files.length > 0) {
				showDropError('External file drops are not supported for security reasons. Please drag files from the VS Code Explorer or use the "Add Files" button.');
				return;
			}

			// Handle text drops (file paths as text) - common fallback
			if (dataTransfer.types.includes('text/plain') && dataTransfer.getData('text/plain')) {
				const textData = dataTransfer.getData('text/plain');
				console.log('Processing text/plain data:', textData);
				const lines = textData.split('\n').map(line => line.trim()).filter(Boolean);

				// Check if the text looks like file paths
				const potentialPaths = lines.filter(line => {
					// More robust path detection
					return (line.includes('/') || line.includes('\\')) &&
						(line.includes('.') || line.endsWith('/') || line.endsWith('\\'));
				});

				if (potentialPaths.length > 0) {
					console.log('Found potential file paths in text data:', potentialPaths);
					filePaths.push(...potentialPaths);
				}
			}

			// Fallback: Try to extract file paths from any data transfer type that might contain them
			if (filePaths.length === 0) {
				console.log('No files found in standard formats, trying fallback methods...');
				for (const type of dataTransfer.types) {
					if (type.includes('uri') || type.includes('file') || type.includes('resource')) {
						const data = dataTransfer.getData(type);
						if (data) {
							console.log(`Attempting to extract paths from ${type}:`, data);

							// Try to extract file:// URIs from any format
							const fileUriMatches = data.match(/file:\/\/[^\s\n\r]+/g);
							if (fileUriMatches) {
								const extractedPaths = fileUriMatches.map(uri => {
									let decodedPath = decodeURIComponent(uri.replace('file://', ''));
									if (decodedPath.match(/^\/[A-Za-z]:/)) {
										decodedPath = decodedPath.substring(1);
									}
									return decodedPath;
								});
								filePaths.push(...extractedPaths);
								console.log('Extracted paths from URI matches:', extractedPaths);
							}
						}
					}
				}
			}

			// Process the collected file paths
			if (filePaths.length > 0) {
				console.log('Final file paths to process:', filePaths);
				handleDroppedFiles(filePaths);
			} else {
				console.warn('No valid files found in dropped content. Available types were:', dataTransfer.types);
				const errorMessage = dataTransfer.types.length > 0
					? `No valid files found in the dropped content. Detected data types: ${dataTransfer.types.join(', ')}. Please try dragging files directly from the VS Code Explorer.`
					: 'No valid files found in the dropped content. Please try dragging files from the VS Code Explorer.';
				showDropError(errorMessage);
			}

		} catch (error) {
			console.error('Error handling dropped files:', error);
			showDropError('Failed to process dropped files: ' + error.message);
		}
	}

	function handleDragLeave(e) {
		e.preventDefault();
		e.stopPropagation();

		// Only remove visual feedback if we're leaving the actual drop zone
		// Check if the mouse is actually leaving the element
		const rect = e.currentTarget.getBoundingClientRect();
		const isOutside = (
			e.clientX < rect.left ||
			e.clientX > rect.right ||
			e.clientY < rect.top ||
			e.clientY > rect.bottom
		);

		if (isOutside) {
			e.currentTarget.classList.remove('drag-over');

			// Check if we should remove the global drag state
			setTimeout(() => {
				const anyDragOver = document.querySelector('.drag-over');
				if (!anyDragOver) {
					document.body.classList.remove('drag-active');
				}
			}, 10);
		}
	}

	function handleDroppedFiles(filePaths) {
		if (!filePaths || filePaths.length === 0) {
			showDropError('No files found in the dropped content.');
			return;
		}

		// Filter out invalid paths with detailed logging
		const validationResults = filePaths.map(path => {
			if (!path || typeof path !== 'string') {
				return { path, valid: false, reason: 'Invalid path format' };
			}

			const trimmedPath = path.trim();
			if (!trimmedPath) {
				return { path, valid: false, reason: 'Empty path' };
			}

			// More comprehensive path validation
			const hasExtension = trimmedPath.includes('.');
			const hasPathSeparator = trimmedPath.includes('/') || trimmedPath.includes('\\');
			const looksLikeFile = hasExtension && (hasPathSeparator || !trimmedPath.includes(' ') || trimmedPath.length < 100);

			if (!looksLikeFile) {
				return { path: trimmedPath, valid: false, reason: 'Does not appear to be a valid file path' };
			}

			return { path: trimmedPath, valid: true };
		});

		const validPaths = validationResults.filter(result => result.valid).map(result => result.path);
		const invalidPaths = validationResults.filter(result => !result.valid);

		// Log invalid paths for debugging
		if (invalidPaths.length > 0) {
			console.warn('Invalid paths detected during drop:', invalidPaths);
		}

		if (validPaths.length === 0) {
			const reasons = [...new Set(invalidPaths.map(item => item.reason))];
			showDropError(`No valid file paths found. Common issues: ${reasons.join(', ')}`);
			return;
		}

		// Show partial success if some paths were invalid
		if (invalidPaths.length > 0 && validPaths.length > 0) {
			console.warn(`${invalidPaths.length} invalid paths were skipped. Processing ${validPaths.length} valid files.`);
		}

		// Add files to queue using batch operation for better performance and feedback
		try {
			if (validPaths.length === 1) {
				// Single file - use existing addFile message
				vscode.postMessage({
					type: 'addFile',
					data: {
						filePath: validPaths[0],
						priority: 2 // Normal priority
					}
				});
			} else {
				// Multiple files - use new batch message
				vscode.postMessage({
					type: 'addMultipleFiles',
					data: {
						filePaths: validPaths,
						priority: 2 // Normal priority
					}
				});
			}

			// Show detailed feedback
			let message = `Adding ${validPaths.length} file${validPaths.length !== 1 ? 's' : ''} to queue...`;
			if (invalidPaths.length > 0) {
				message += ` (${invalidPaths.length} invalid path${invalidPaths.length !== 1 ? 's' : ''} skipped)`;
			}
			showDropSuccess(message);

		} catch (error) {
			console.error('Failed to add files to queue:', error);
			showDropError(`Failed to add files to queue: ${error.message}`);
		}
	}

	function showDropSuccess(message) {
		console.log('Drop success:', message);

		// Create temporary success indicator
		showTemporaryFeedback(message, 'success');

		// Send info message to extension for better logging
		vscode.postMessage({
			type: 'info',
			data: {
				message: message,
				severity: 'info',
				timestamp: new Date().toISOString()
			}
		});
	}

	function showDropError(message) {
		console.error('Drop error:', message);

		// Create temporary error indicator
		showTemporaryFeedback(message, 'error');

		// Send error message to extension
		vscode.postMessage({
			type: 'error',
			data: {
				message: message,
				severity: 'warning',
				timestamp: new Date().toISOString()
			}
		});
	}

	function showTemporaryFeedback(message, type) {
		// Remove any existing feedback
		const existingFeedback = document.querySelector('.drop-feedback');
		if (existingFeedback) {
			existingFeedback.remove();
		}

		// Create feedback element
		const feedback = document.createElement('div');
		feedback.className = `drop-feedback drop-feedback-${type}`;
		feedback.textContent = message;

		// Position it at the top of the container
		const container = document.querySelector('.container');
		container.insertBefore(feedback, container.firstChild);

		// Add fade-in animation
		feedback.classList.add('fade-in');

		// Remove after 4 seconds
		setTimeout(() => {
			if (feedback.parentNode) {
				feedback.classList.add('fade-out');
				setTimeout(() => {
					if (feedback.parentNode) {
						feedback.remove();
					}
				}, 300);
			}
		}, 4000);
	}

	function handleMessage(event) {
		const message = event.data;

		switch (message.type) {
			case 'updateQueue':
				updateQueue(message.data);
				break;
			case 'error':
				showError(message.data);
				break;
			case 'info':
				showInfo(message.data);
				break;
			default:
				console.warn('Unknown message type:', message.type);
		}
	}

	function updateQueue(data) {
		currentState.queueState = data.state;
		currentState.items = data.items;
		currentState.statistics = data.statistics;
		currentState.canRepeat = data.canRepeat || false;

		updateUI();
	}

	function showError(errorData) {
		// Show error notification
		const errorMsg = `Error: ${errorData.message}`;
		console.error(errorMsg);

		// You could implement a toast notification system here
		// For now, we'll just log it
	}

	function showInfo(infoData) {
		// Show info notification
		const infoMsg = `Info: ${infoData.message}`;
		console.log(infoMsg);

		// You could implement a toast notification system here
		// For now, we'll just log it
	}

	// UI Update functions
	function updateUI() {
		updateHeader();
		updateControls();
		updateProgress();
		updateStatistics();
		updateQueueList();
		updateRecentList();
	}

	function updateHeader() {
		if (!currentState.queueState) {return;}

		const queueSize = currentState.items?.length || 0;
		elements.queueSize.textContent = `${queueSize} item${queueSize !== 1 ? 's' : ''}`;

		let status = 'Idle';
		if (currentState.queueState.isProcessing) {
			status = currentState.queueState.isPaused ? 'Paused' : 'Processing';
		}
		elements.processingStatus.textContent = status;
		elements.processingStatus.className = `status-${status.toLowerCase()}`;
	}

	function updateControls() {
		if (!currentState.queueState) {return;}

		const { isProcessing, isPaused } = currentState.queueState;
		const hasItems = currentState.items?.length > 0;

		elements.startBtn.disabled = isProcessing || !hasItems;
		elements.repeatBtn.disabled = isProcessing || !currentState.canRepeat;
		elements.pauseBtn.disabled = !isProcessing || isPaused;
		elements.stopBtn.disabled = !isProcessing;
		elements.clearQueueBtn.disabled = !hasItems;
	}

	function updateProgress() {
		if (!currentState.queueState) {return;}

		const { isProcessing, processedCount, totalCount } = currentState.queueState;

		if (isProcessing && totalCount > 0) {
			elements.progressContainer.style.display = 'block';

			const percentage = Math.round((processedCount / totalCount) * 100);
			elements.progressPercentage.textContent = `${percentage}%`;
			elements.progressFill.style.width = `${percentage}%`;

			elements.itemsProcessed.textContent = `${processedCount} processed`;
			elements.itemsRemaining.textContent = `${totalCount - processedCount} remaining`;

			// Update ETA
			if (currentState.queueState.estimatedCompletion) {
				const eta = new Date(currentState.queueState.estimatedCompletion);
				const now = new Date();
				const diffMinutes = Math.round((eta.getTime() - now.getTime()) / (1000 * 60));
				elements.estimatedTime.textContent = `ETA: ${diffMinutes > 0 ? diffMinutes + 'm' : 'Now'}`;
			} else {
				elements.estimatedTime.textContent = 'ETA: --';
			}
		} else {
			elements.progressContainer.style.display = 'none';
		}
	}

	function updateStatistics() {
		if (!currentState.statistics) {return;}

		const stats = currentState.statistics;

		elements.totalProcessed.textContent = stats.totalProcessed.toString();
		elements.successRate.textContent = stats.totalProcessed > 0
			? `${Math.round(stats.successRate * 100)}%`
			: '--';
		elements.avgTime.textContent = stats.averageProcessingTime > 0
			? `${Math.round(stats.averageProcessingTime / 1000)}s`
			: '--';
	}

	function updateQueueList() {
		if (!currentState.items) {return;}

		const activeItems = currentState.items.filter(item =>
			item.status === 'pending' || item.status === 'processing'
		);

		if (activeItems.length === 0) {
			elements.emptyState.style.display = 'block';
			elements.queueList.innerHTML = '';
			elements.queueList.appendChild(elements.emptyState);
			return;
		}

		elements.emptyState.style.display = 'none';
		elements.queueList.innerHTML = '';

		activeItems.forEach(item => {
			const itemElement = createQueueItemElement(item);
			elements.queueList.appendChild(itemElement);
		});
	}

	function updateRecentList() {
		if (!currentState.items) {return;}

		const completedItems = currentState.items.filter(item =>
			item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
		).slice(-10); // Show last 10

		if (completedItems.length === 0) {
			elements.recentEmptyState.style.display = 'block';
			elements.recentList.innerHTML = '';
			elements.recentList.appendChild(elements.recentEmptyState);
			return;
		}

		elements.recentEmptyState.style.display = 'none';
		elements.recentList.innerHTML = '';

		completedItems.reverse().forEach(item => {
			const itemElement = createRecentItemElement(item);
			elements.recentList.appendChild(itemElement);
		});
	}

	function createQueueItemElement(item) {
		const div = document.createElement('div');
		div.className = 'queue-item';
		div.dataset.itemId = item.id;

		const statusIcon = getStatusIcon(item.status);
		const priorityClass = getPriorityClass(item.priority);

		div.innerHTML = `
            <div class="queue-item-header">
                <div class="queue-item-icon">
                    <span class="codicon ${statusIcon} status-${item.status}"></span>
                </div>
                <div class="queue-item-content">
                    <div class="queue-item-title" title="${item.filePath}">${item.fileName}</div>
                    <div class="queue-item-meta">
                        <span class="priority-${getPriorityName(item.priority)} ${priorityClass}">
                            ${getPriorityName(item.priority)} priority
                        </span>
                        <span>Added: ${formatTime(item.addedAt)}</span>
                        ${item.estimatedDuration ? `<span>~${Math.round(item.estimatedDuration / 1000)}s</span>` : ''}
                    </div>
                </div>
                <div class="queue-item-actions">
                    <button class="btn btn-icon remove-btn" title="Remove from queue" data-item-id="${item.id}">
                        <span class="codicon codicon-trash"></span>
                    </button>
                </div>
                <button class="expand-toggle">
                    <span class="codicon codicon-chevron-right"></span>
                </button>
            </div>
            <div class="queue-item-details">
                <div><strong>File Path:</strong> ${item.filePath}</div>
                ${item.metadata ? `<div><strong>Metadata:</strong> ${JSON.stringify(item.metadata)}</div>` : ''}
                ${item.error ? `<div class="status-failed"><strong>Error:</strong> ${item.error}</div>` : ''}
            </div>
        `;

		// Add event listeners
		const header = div.querySelector('.queue-item-header');
		const expandToggle = div.querySelector('.expand-toggle');
		const removeBtn = div.querySelector('.remove-btn');

		expandToggle.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleQueueItem(div);
		});

		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			removeQueueItem(item.id);
		});

		return div;
	}

	function createRecentItemElement(item) {
		const div = document.createElement('div');
		div.className = 'recent-item';

		const statusIcon = getStatusIcon(item.status);
		const completedTime = item.completedAt ? formatTime(item.completedAt) : '';

		div.innerHTML = `
            <div class="recent-item-icon">
                <span class="codicon ${statusIcon} status-${item.status}"></span>
            </div>
            <div class="recent-item-content">
                <div class="recent-item-title" title="${item.filePath}">${item.fileName}</div>
                <div class="recent-item-time">${completedTime}</div>
            </div>
        `;

		return div;
	}

	function toggleQueueItem(itemElement) {
		const isExpanded = itemElement.classList.contains('expanded');
		const toggle = itemElement.querySelector('.expand-toggle .codicon');

		if (isExpanded) {
			itemElement.classList.remove('expanded');
			toggle.classList.remove('codicon-chevron-down');
			toggle.classList.add('codicon-chevron-right');
		} else {
			itemElement.classList.add('expanded');
			toggle.classList.remove('codicon-chevron-right');
			toggle.classList.add('codicon-chevron-down');
		}
	}

	function removeQueueItem(itemId) {
		vscode.postMessage({
			type: 'removeFile',
			data: { itemId }
		});
	}

	// Utility functions
	function getStatusIcon(status) {
		const icons = {
			pending: 'codicon-clock',
			processing: 'codicon-loading',
			completed: 'codicon-check',
			failed: 'codicon-error',
			cancelled: 'codicon-close'
		};
		return icons[status] || 'codicon-file';
	}

	function getPriorityClass(priority) {
		if (priority >= 4) {return 'priority-critical';}
		if (priority >= 3) {return 'priority-high';}
		if (priority >= 2) {return 'priority-normal';}
		return 'priority-low';
	}

	function getPriorityName(priority) {
		if (priority >= 4) {return 'Critical';}
		if (priority >= 3) {return 'High';}
		if (priority >= 2) {return 'Normal';}
		return 'Low';
	}

	function formatTime(date) {
		if (!date) {return '';}
		const d = new Date(date);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// Start the application
	initialize();
})();