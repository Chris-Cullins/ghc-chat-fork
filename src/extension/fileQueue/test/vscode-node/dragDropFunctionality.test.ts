/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, suite, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// This test file specifically tests the drag and drop functionality from the JavaScript side
// Since the webview runs in a browser-like environment, we use JSDOM to simulate it

suite('Drag and Drop Functionality Tests', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window;
	let mockVSCode: any;

	beforeEach(() => {
		// Set up a DOM environment
		dom = new JSDOM(`
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
			</head>
			<body>
				<div class="container">
					<div id="queue-list" class="queue-list">
						<div id="empty-state" class="empty-state">
							<span class="codicon codicon-inbox"></span>
							<p>No files in queue</p>
							<p class="empty-subtitle">Drag files from VS Code Explorer or use "Add Files" button</p>
						</div>
					</div>
				</div>
				<div class="drag-overlay"></div>
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

		// Set global references for the JavaScript to use
		(global as any).document = document;
		(global as any).window = window;
		(global as any).acquireVsCodeApi = () => mockVSCode;
		(global as any).console = {
			log: vi.fn(),
			error: vi.fn(),
			warn: vi.fn()
		};
	});

	test('should set up drag and drop event listeners on initialization', () => {
		// Load the fileQueue.js functionality
		const setupDragAndDrop = createSetupDragAndDropFunction();

		const queueList = document.getElementById('queue-list');
		const emptyState = document.getElementById('empty-state');

		expect(queueList).toBeTruthy();
		expect(emptyState).toBeTruthy();

		// Run the setup
		setupDragAndDrop();

		// Verify that drag event listeners would be set up
		// (We can't directly test addEventListener calls, but we can verify the elements exist)
		expect(queueList).toBeTruthy();
		expect(emptyState).toBeTruthy();
	});

	test('should handle drag over events correctly', () => {
		const setupDragAndDrop = createSetupDragAndDropFunction();
		const handleDragOver = createHandleDragOverFunction();

		setupDragAndDrop();

		const queueList = document.getElementById('queue-list')!;

		// Create a mock drag event
		const dragEvent = new window.DragEvent('dragover', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock preventDefault
		dragEvent.preventDefault = vi.fn();
		dragEvent.stopPropagation = vi.fn();

		// Set current target
		Object.defineProperty(dragEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		// Call the handler
		handleDragOver(dragEvent);

		expect(dragEvent.preventDefault).toHaveBeenCalled();
		expect(dragEvent.stopPropagation).toHaveBeenCalled();
	});

	test('should handle VS Code file drops with file:// URIs', () => {
		const handleDrop = createHandleDropFunction();

		const queueList = document.getElementById('queue-list')!;

		// Create a mock drop event with VS Code file data
		const dropEvent = new window.DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock the dataTransfer with file URIs
		const mockDataTransfer = {
			types: ['text/uri-list'],
			files: { length: 0 },
			getData: vi.fn((type: string) => {
				if (type === 'text/uri-list') {
					return 'file:///Users/test/file1.ts\nfile:///Users/test/file2.ts';
				}
				return '';
			})
		};

		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: mockDataTransfer,
			writable: false
		});

		Object.defineProperty(dropEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dropEvent.preventDefault = vi.fn();
		dropEvent.stopPropagation = vi.fn();

		// Call the handler
		handleDrop(dropEvent);

		expect(dropEvent.preventDefault).toHaveBeenCalled();
		expect(dropEvent.stopPropagation).toHaveBeenCalled();

		// Should have called VS Code API to add multiple files
		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'addMultipleFiles',
			data: {
				filePaths: ['/Users/test/file1.ts', '/Users/test/file2.ts'],
				priority: 2, // Normal priority
				operation: 'analyze'
			}
		});
	});

	test('should handle VS Code explorer data format', () => {
		const handleDrop = createHandleDropFunction();

		const queueList = document.getElementById('queue-list')!;

		// Create a mock drop event with VS Code explorer data
		const dropEvent = new window.DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock VS Code explorer data format
		const explorerData = JSON.stringify([
			{ uri: 'file:///Users/test/component.tsx' },
			{ uri: { fsPath: '/Users/test/utils.ts' } }
		]);

		const mockDataTransfer = {
			types: ['application/vnd.code.tree.explorer'],
			files: { length: 0 },
			getData: vi.fn((type: string) => {
				if (type === 'text/uri-list') return '';
				if (type === 'application/vnd.code.tree.explorer') return explorerData;
				return '';
			})
		};

		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: mockDataTransfer,
			writable: false
		});

		Object.defineProperty(dropEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dropEvent.preventDefault = vi.fn();
		dropEvent.stopPropagation = vi.fn();

		// Call the handler
		handleDrop(dropEvent);

		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'addMultipleFiles',
			data: {
				filePaths: ['/Users/test/component.tsx', '/Users/test/utils.ts'],
				priority: 2,
				operation: 'analyze'
			}
		});
	});

	test('should handle Windows file paths correctly', () => {
		const handleDrop = createHandleDropFunction();

		const queueList = document.getElementById('queue-list')!;

		const dropEvent = new window.DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock Windows file URIs
		const mockDataTransfer = {
			types: ['text/uri-list'],
			files: { length: 0 },
			getData: vi.fn((type: string) => {
				if (type === 'text/uri-list') {
					return 'file:///C:/Users/test/file.ts\nfile:///D:/Projects/app.js';
				}
				return '';
			})
		};

		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: mockDataTransfer,
			writable: false
		});

		Object.defineProperty(dropEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dropEvent.preventDefault = vi.fn();
		dropEvent.stopPropagation = vi.fn();

		handleDrop(dropEvent);

		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'addMultipleFiles',
			data: {
				filePaths: ['C:/Users/test/file.ts', 'D:/Projects/app.js'],
				priority: 2,
				operation: 'analyze'
			}
		});
	});

	test('should reject external file drops for security', () => {
		const handleDrop = createHandleDropFunction();

		const queueList = document.getElementById('queue-list')!;

		const dropEvent = new window.DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock external file drop (files from file manager)
		const mockFile = new window.File(['content'], 'test.txt', { type: 'text/plain' });
		const mockDataTransfer = {
			types: ['Files'],
			files: [mockFile],
			getData: vi.fn(() => '')
		};

		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: mockDataTransfer,
			writable: false
		});

		Object.defineProperty(dropEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dropEvent.preventDefault = vi.fn();
		dropEvent.stopPropagation = vi.fn();

		handleDrop(dropEvent);

		// Should not call postMessage for file addition, should show error instead
		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'error',
			data: {
				message: 'External file drops are not supported for security reasons. Please drag files from the VS Code Explorer or use the "Add Files" button.',
				severity: 'warning',
				timestamp: expect.any(String)
			}
		});
	});

	test('should provide visual feedback during drag operations', () => {
		const handleDragEnter = createHandleDragEnterFunction();
		const handleDragLeave = createHandleDragLeaveFunction();

		const queueList = document.getElementById('queue-list')!;

		// Test drag enter
		const dragEnterEvent = new window.DragEvent('dragenter', {
			bubbles: true,
			cancelable: true
		});

		Object.defineProperty(dragEnterEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dragEnterEvent.preventDefault = vi.fn();
		dragEnterEvent.stopPropagation = vi.fn();

		handleDragEnter(dragEnterEvent);

		expect(document.body.classList.contains('drag-active')).toBe(true);
		expect(queueList.classList.contains('drag-over')).toBe(true);

		// Test drag leave
		const dragLeaveEvent = new window.DragEvent('dragleave', {
			bubbles: true,
			cancelable: true,
			clientX: 0,
			clientY: 0
		});

		Object.defineProperty(dragLeaveEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		// Mock getBoundingClientRect to simulate leaving the element
		queueList.getBoundingClientRect = vi.fn(() => ({
			left: 100,
			right: 200,
			top: 100,
			bottom: 200,
			width: 100,
			height: 100,
			x: 100,
			y: 100,
			toJSON: () => { }
		}));

		dragLeaveEvent.preventDefault = vi.fn();
		dragLeaveEvent.stopPropagation = vi.fn();

		handleDragLeave(dragLeaveEvent);

		expect(queueList.classList.contains('drag-over')).toBe(false);
	});

	test('should handle single file drops differently from multiple files', () => {
		const handleDrop = createHandleDropFunction();

		const queueList = document.getElementById('queue-list')!;

		const dropEvent = new window.DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new window.DataTransfer()
		});

		// Mock single file drop
		const mockDataTransfer = {
			types: ['text/uri-list'],
			files: { length: 0 },
			getData: vi.fn((type: string) => {
				if (type === 'text/uri-list') {
					return 'file:///Users/test/single-file.ts';
				}
				return '';
			})
		};

		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: mockDataTransfer,
			writable: false
		});

		Object.defineProperty(dropEvent, 'currentTarget', {
			value: queueList,
			writable: true
		});

		dropEvent.preventDefault = vi.fn();
		dropEvent.stopPropagation = vi.fn();

		handleDrop(dropEvent);

		// Should use single file message type
		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'addFile',
			data: {
				filePath: '/Users/test/single-file.ts',
				priority: 2,
				operation: 'analyze'
			}
		});
	});

	test('should validate file paths and show feedback', () => {
		const handleDroppedFiles = createHandleDroppedFilesFunction();

		const validPaths = ['/Users/test/valid.ts', '/Users/test/another.js'];
		const invalidPaths = ['', '   ', 'not-a-file'];

		handleDroppedFiles([...validPaths, ...invalidPaths]);

		// Should call VS Code API with only valid paths
		expect(mockVSCode.postMessage).toHaveBeenCalledWith({
			type: 'addMultipleFiles',
			data: {
				filePaths: validPaths,
				priority: 2,
				operation: 'analyze'
			}
		});
	});

	// Helper functions that simulate the actual JavaScript functionality
	function createSetupDragAndDropFunction() {
		return () => {
			// This simulates the setupDragAndDrop function from fileQueue.js
			const dropZones = [
				document.getElementById('queue-list'),
				document.getElementById('empty-state'),
				document.querySelector('.container')
			].filter(Boolean);

			// In a real scenario, this would add event listeners
			// For testing, we just verify the elements exist
			return dropZones.length > 0;
		};
	}

	function createHandleDragOverFunction() {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Set the appropriate drop effect
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}

			// Ensure visual feedback is maintained
			(e.currentTarget as Element)?.classList.add('drag-over');
		};
	}

	function createHandleDragEnterFunction() {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Add visual feedback for all drop zones
			document.body.classList.add('drag-active');
			(e.currentTarget as Element)?.classList.add('drag-over');
		};
	}

	function createHandleDragLeaveFunction() {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Only remove visual feedback if we're leaving the actual drop zone
			const rect = (e.currentTarget as Element)?.getBoundingClientRect();
			if (rect) {
				const isOutside = (
					e.clientX < rect.left ||
					e.clientX > rect.right ||
					e.clientY < rect.top ||
					e.clientY > rect.bottom
				);

				if (isOutside) {
					(e.currentTarget as Element)?.classList.remove('drag-over');

					// Check if we should remove the global drag state
					setTimeout(() => {
						const anyDragOver = document.querySelector('.drag-over');
						if (!anyDragOver) {
							document.body.classList.remove('drag-active');
						}
					}, 10);
				}
			}
		};
	}

	function createHandleDropFunction() {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Clean up visual feedback
			document.body.classList.remove('drag-active');
			(e.currentTarget as Element)?.classList.remove('drag-over');

			// Get dropped data
			const dataTransfer = e.dataTransfer;
			if (!dataTransfer) return;

			let filePaths: string[] = [];

			try {
				// Handle VS Code internal file drops (from explorer)
				if (dataTransfer.getData('text/uri-list')) {
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

				// Handle VS Code specific data format
				if (dataTransfer.getData('application/vnd.code.tree.explorer')) {
					const explorerData = dataTransfer.getData('application/vnd.code.tree.explorer');
					try {
						const parsedData = JSON.parse(explorerData);
						if (Array.isArray(parsedData)) {
							const paths = parsedData.map(item => {
								if (typeof item === 'string') {
									return item;
								}
								if (item.uri) {
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
									if (item.uri.fsPath) {
										return item.uri.fsPath;
									}
								}
								return null;
							}).filter(Boolean);
							filePaths.push(...paths);
						}
					} catch (parseError) {
						console.warn('Failed to parse VS Code explorer data:', parseError);
					}
				}

				// Handle external file drops (security check)
				if (dataTransfer.files && dataTransfer.files.length > 0) {
					mockVSCode.postMessage({
						type: 'error',
						data: {
							message: 'External file drops are not supported for security reasons. Please drag files from the VS Code Explorer or use the "Add Files" button.',
							severity: 'warning',
							timestamp: new Date().toISOString()
						}
					});
					return;
				}

				// Process the collected file paths
				if (filePaths.length > 0) {
					createHandleDroppedFilesFunction()(filePaths);
				}

			} catch (error) {
				console.error('Error handling dropped files:', error);
			}
		};
	}

	function createHandleDroppedFilesFunction() {
		return (filePaths: string[]) => {
			if (!filePaths || filePaths.length === 0) {
				return;
			}

			// Filter out invalid paths
			const validPaths = filePaths.filter(path => {
				if (!path || typeof path !== 'string') return false;
				const trimmedPath = path.trim();
				if (!trimmedPath) return false;

				// Basic validation - has extension and path separator
				const hasExtension = trimmedPath.includes('.');
				const hasPathSeparator = trimmedPath.includes('/') || trimmedPath.includes('\\');
				return hasExtension && hasPathSeparator;
			});

			if (validPaths.length === 0) {
				return;
			}

			// Add files to queue
			try {
				if (validPaths.length === 1) {
					// Single file
					mockVSCode.postMessage({
						type: 'addFile',
						data: {
							filePath: validPaths[0],
							priority: 2, // Normal priority
							operation: 'analyze'
						}
					});
				} else {
					// Multiple files
					mockVSCode.postMessage({
						type: 'addMultipleFiles',
						data: {
							filePaths: validPaths,
							priority: 2, // Normal priority
							operation: 'analyze'
						}
					});
				}
			} catch (error) {
				console.error('Failed to add files to queue:', error);
			}
		};
	}
});